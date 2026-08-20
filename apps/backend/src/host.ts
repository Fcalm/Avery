import { utilityProcess } from 'electron';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { MethodRoutes, FunctionRouteChannels } from './router';

/** 返回崩溃退避重启延迟：1s/2s/4s/…/30s 封顶，attempt 从 0 开始累计。 */
export function RestartDelayMs(attempt: number): number {
  return Math.min(1000 * 2 ** attempt, 30000);
}

export interface BackendHostOptions {
  appContext: any;
  desktopCapabilities?: Record<string, (...args: any[]) => any>;
  onEvent?: (payload: unknown) => void;
}

interface PendingCommand {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: NodeJS.Timeout;
}

/** 管理 Backend Utility Process 生命周期：fork、握手、健康检查、请求超时、取消、崩溃退避重启与在途拒绝。 */
export function CreateBackendHost({ appContext, desktopCapabilities = {}, onEvent }: BackendHostOptions) {
  const channels = [...Object.keys(MethodRoutes), ...FunctionRouteChannels];
  let child: Electron.UtilityProcess | null = null;
  let state: 'starting' | 'ready' | 'restarting' | 'stopped' = 'starting';
  let stopped = false;
  let restartAttempt = 0;
  let restartTimer: NodeJS.Timeout | null = null;
  let readyResolve: (() => void) | null = null;
  let eventListener = onEvent;
  let pingTimer: NodeJS.Timeout | null = null;
  let missedPongs = 0;
  const commandSessionId = randomUUID();
  let nextRequestId = 1;
  const pending = new Map<string, PendingCommand>();

  function FailAll(code: string, message: string): void {
    const error = Object.assign(new Error(message), { code, retryable: true }) as Error & { code: string; retryable: boolean };
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    pending.clear();
  }

  function StartPing(): void {
    pingTimer = setInterval(() => {
      if (state !== 'ready' || !child) return;
      try {
        child.postMessage({ kind: 'ping', seq: nextRequestId++ });
      } catch {
        return;
      }
      missedPongs += 1;
      if (missedPongs >= 3) {
        try { child.kill(); } catch { /* 已退出的进程无需重复终止。 */ }
      }
    }, 15000);
  }

  function StopPing(): void {
    if (pingTimer) {
      clearInterval(pingTimer);
      pingTimer = null;
    }
  }

  function Spawn(): void {
    state = 'starting';
    const backendPath = join(__dirname, 'index.js');
    child = utilityProcess.fork(backendPath, [], { serviceName: 'offerget-backend' });

    child.once('spawn', () => {
      child?.stdout?.on('data', (chunk: Buffer) => process.stdout.write(chunk));
      child?.stderr?.on('data', (chunk: Buffer) => process.stderr.write(chunk));
    });

    child.on('message', async (message: any) => {
      const typed = message;
      if (!typed || typeof typed.kind !== 'string') return;
      if (typed.kind === 'backend-error') {
        console.error(`[backend-error] code=${typed.code} message=${typed.message}`);
        return;
      }
      if (typed.kind === 'debug') return;
      if (typed.kind === 'ready') {
        state = 'ready';
        restartAttempt = 0;
        missedPongs = 0;
        readyResolve?.();
        readyResolve = null;
        StartPing();
        return;
      }
      if (typed.kind === 'result') {
        const entry = typed.requestId ? pending.get(typed.requestId) : undefined;
        if (!entry) return;
        pending.delete(typed.requestId);
        clearTimeout(entry.timer);
        entry.resolve(typed.result);
        return;
      }
      if (typed.kind === 'event') {
        eventListener?.(typed.payload);
        return;
      }
      if (typed.kind === 'pong') {
        missedPongs = 0;
        return;
      }
      if (typed.kind === 'desktop') {
        const capability = typed.capability ? desktopCapabilities[typed.capability] : undefined;
        if (typeof capability !== 'function') {
          try {
            child?.postMessage({ kind: 'desktop-result', id: typed.id, ok: false, error: 'Desktop capability is unknown.' });
          } catch { /* 子进程已退出时丢弃。 */ }
          return;
        }
        try {
          const data = await capability(...(Array.isArray(typed.args) ? typed.args : []));
          try {
            child?.postMessage({ kind: 'desktop-result', id: typed.id, ok: true, data });
          } catch { /* 子进程已退出时丢弃。 */ }
        } catch (error) {
          try {
            child?.postMessage({ kind: 'desktop-result', id: typed.id, ok: false, error: error instanceof Error ? error.message : 'Desktop capability failed.' });
          } catch { /* 子进程已退出时丢弃。 */ }
        }
        return;
      }
    });

    child.on('exit', (code: number) => {
      FailAll('INTERNAL_ERROR', `Backend exited with code ${code}.`);
      StopPing();
      state = 'restarting';
      if (!stopped) {
        const delay = RestartDelayMs(restartAttempt++);
        restartTimer = setTimeout(Spawn, delay);
      }
    });

    child.postMessage({ kind: 'hello', app: appContext });
  }

  Spawn();

  return {
    state: (): string => state,
    HandleChannels(): string[] { return [...channels]; },
    OnEvent(listener: (payload: unknown) => void): void { eventListener = listener; },
    async Command(channel: string, idempotencyKey: string | undefined, ...args: unknown[]): Promise<unknown> {
      if (state !== 'ready') throw Object.assign(new Error(`Backend is ${state}.`), { code: 'INTERNAL_ERROR', retryable: true, details: { backendState: state } });
      if (!channels.includes(channel)) throw Object.assign(new Error(`Unknown IPC channel: ${channel}.`), { code: 'INTERNAL_ERROR' });
      const requestId = `req-${commandSessionId}-${nextRequestId++}`;
      const timeout = channel === 'agent:send' ? 5 * 60 * 1000
        : channel === 'workspace:migrate' ? 2 * 60 * 1000
          : 30000;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          if (pending.has(requestId)) {
            pending.delete(requestId);
            reject(Object.assign(new Error('Backend request timed out.'), { code: 'INTERNAL_ERROR', retryable: true, details: { backendState: state } }));
          }
        }, timeout);
        pending.set(requestId, { resolve, reject, timer });
        child?.postMessage({ kind: 'command', requestId, idempotencyKey, channel, payload: args });
      });
    },
    Shutdown(): void {
      stopped = true;
      StopPing();
      if (restartTimer) clearTimeout(restartTimer);
      FailAll('INTERNAL_ERROR', 'Backend is shutting down.');
      try { child?.postMessage({ kind: 'shutdown' }); } catch { /* 子进程已退出时忽略。 */ }
      setTimeout(() => {
        try { child?.kill(); } catch { /* 终止阶段无需额外处理。 */ }
      }, 800);
    },
    GetChild(): Electron.UtilityProcess | null { return child; },
  };
}
