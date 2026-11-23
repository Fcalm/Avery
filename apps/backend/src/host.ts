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
  timer?: NodeJS.Timeout;
  runId?: string;
}

// 这些调用返回整轮运行结果，等待期由模型/工具截止时间、取消与进程退出管理。
// 普通 IPC 的固定超时不能在前台结束后，留下仍执行外部动作的后台 Run。
const LongRunningAgentChannels = new Set(['agent:send', 'agent:respond-interaction', 'agent:compact-session']);
// 会话删除要等待在途运行和资源落盘结算；固定超时会使界面报失败而后台继续删除。
const SettlingConversationChannels = new Set(['workspace:conversations-delete', 'workspace:conversations-delete-archived']);

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
  const activeRuns = new Map<string, { sessionId: string; terminal: boolean }>();

  function FailAll(code: string, message: string, settleRuns = true): void {
    const error = Object.assign(new Error(message), { code, retryable: false, details: { statusUnknown: true } });
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    pending.clear();
    for (const [requestId, run] of activeRuns) {
      if (!settleRuns) break;
      const publish = (event: unknown) => { try { eventListener?.(event); } catch { console.error('Backend failure event could not be delivered.'); } };
      if (!run.terminal) publish({ type: 'error', requestId, sessionId: run.sessionId, message: '后台异常退出，本轮任务已结束。请核对已执行操作的实际结果后继续，原操作不会自动重放。' });
      publish({ type: 'run_released', requestId, sessionId: run.sessionId });
    }
    activeRuns.clear();
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
    const spawned = utilityProcess.fork(backendPath, [], { serviceName: 'avery-backend' });
    child = spawned;
    let failed = false;

    spawned.once('spawn', () => {
      spawned.stdout?.on('data', (chunk: Buffer) => process.stdout.write(chunk));
      spawned.stderr?.on('data', (chunk: Buffer) => process.stderr.write(chunk));
    });

    spawned.on('message', async (message: any) => {
      if (child !== spawned || stopped || failed) return;
      const typed = message;
      if (!typed || typeof typed.kind !== 'string') return;
      if (typed.kind === 'backend-fatal') {
        failed = true;
        state = 'restarting'; StopPing();
        FailAll('INTERNAL_ERROR', `Backend terminated: ${String(typed.code ?? 'UNCAUGHT')}`);
        try { spawned.kill(); } catch { /* 故障处理器也会自行退出；由 exit 统一安排重启。 */ }
        return;
      }
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
        if (entry.runId && typed.result?.ok === false) activeRuns.delete(entry.runId);
        entry.resolve(typed.result);
        return;
      }
      if (typed.kind === 'event') {
        const event = typed.payload;
        const run = event?.requestId ? activeRuns.get(event.requestId) : undefined;
        if (run && ['completed', 'error', 'cancelled'].includes(event.type)) run.terminal = true;
        if (event?.type === 'run_released') activeRuns.delete(event.requestId);
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
            spawned.postMessage({ kind: 'desktop-result', id: typed.id, ok: false, error: 'Desktop capability is unknown.' });
          } catch { /* 子进程已退出时丢弃。 */ }
          return;
        }
        try {
          const data = await capability(...(Array.isArray(typed.args) ? typed.args : []));
          // 旧后端等待的人工对话框/导出可能晚于重启完成；回执只能回到发起它的那一代。
          if (child !== spawned || stopped) return;
          try {
            spawned.postMessage({ kind: 'desktop-result', id: typed.id, ok: true, data });
          } catch { /* 子进程已退出时丢弃。 */ }
        } catch (error) {
          if (child !== spawned || stopped) return;
          try {
            spawned.postMessage({ kind: 'desktop-result', id: typed.id, ok: false, error: error instanceof Error ? error.message : 'Desktop capability failed.' });
          } catch { /* 子进程已退出时丢弃。 */ }
        }
        return;
      }
    });

    spawned.on('exit', (code: number) => {
      if (child !== spawned) return;
      child = null;
      FailAll('INTERNAL_ERROR', `Backend exited with code ${code}.`);
      StopPing();
      state = 'restarting';
      if (!stopped) {
        const delay = RestartDelayMs(restartAttempt++);
        restartTimer = setTimeout(Spawn, delay);
      }
    });

    spawned.postMessage({ kind: 'hello', app: appContext });
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
      const timeout = LongRunningAgentChannels.has(channel) || SettlingConversationChannels.has(channel) ? undefined
        : channel === 'cron:run-due' ? 30 * 60 * 1000
        : channel === 'workspace:migrate' ? 2 * 60 * 1000
          : 30000;
      return new Promise((resolve, reject) => {
        const run = args[0] as { requestId?: unknown; sessionId?: unknown } | undefined;
        if (LongRunningAgentChannels.has(channel) && typeof run?.requestId === 'string' && typeof run.sessionId === 'string') {
          activeRuns.set(run.requestId, { sessionId: run.sessionId, terminal: false });
        }
        const timer = timeout === undefined ? undefined : setTimeout(() => {
          if (pending.has(requestId)) {
            pending.delete(requestId);
            reject(Object.assign(new Error('Backend request timed out.'), { code: 'INTERNAL_ERROR', retryable: true, details: { backendState: state } }));
          }
        }, timeout);
        const runId = LongRunningAgentChannels.has(channel) && typeof run?.requestId === 'string' ? run.requestId : undefined;
        pending.set(requestId, { resolve, reject, timer, runId });
        try { child?.postMessage({ kind: 'command', requestId, idempotencyKey, channel, payload: args }); }
        catch (error) {
          pending.delete(requestId); clearTimeout(timer);
          if (runId) activeRuns.delete(runId);
          reject(error instanceof Error ? error : new Error('Backend command could not be sent.'));
        }
      });
    },
    Shutdown(): void {
      stopped = true;
      StopPing();
      if (restartTimer) clearTimeout(restartTimer);
      FailAll('INTERNAL_ERROR', 'Backend is shutting down.', false);
      try { child?.postMessage({ kind: 'shutdown' }); } catch { /* 子进程已退出时忽略。 */ }
      setTimeout(() => {
        try { child?.kill(); } catch { /* 终止阶段无需额外处理。 */ }
      }, 800);
    },
    GetChild(): Electron.UtilityProcess | null { return child; },
  };
}
