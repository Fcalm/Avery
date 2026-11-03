import { Worker } from 'node:worker_threads';

interface WorkerReadyMessage {
  type: 'ready';
  methods: string[];
}

interface WorkerErrorMessage {
  type: 'error';
  code?: string;
  message?: string;
}

interface WorkerResponseMessage {
  type: 'response';
  id: string;
  ok: boolean;
  data?: unknown;
  error?: { code?: string; message?: string; details?: unknown; retryable?: boolean };
}

type WorkerMessage = WorkerReadyMessage | WorkerErrorMessage | WorkerResponseMessage;

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: NodeJS.Timeout;
}

export interface RpcWorker {
  Methods(): string[];
  Ready(): Promise<{ methods: string[] }>;
  OnExit(listener: (code: number) => void): void;
  Call(method: string, args?: unknown[]): Promise<unknown>;
  Close(): void;
}

/** 返回崩溃退避重启延迟：1s/2s/4s/…/30s 封顶，attempt 从 0 开始累计。 */
export function RestartDelayMs(attempt: number): number {
  return Math.min(1000 * 2 ** attempt, 30000);
}

/**
 * 创建一个绑定单个 Worker 的 RPC 客户端：启动握手、请求-响应往返、错误归一与崩溃退避重启。
 * transport-agnostic——workerPath 指向任意持有统一消息协议（type: ready/error/response）的入口文件，
 * 因此 DB Worker 从 worker_threads 切到 utilityProcess 时只需替换本模块的 Worker 实现。
 */
export function CreateRpcWorker({ workerPath, workerData, startupTimeoutMs = 30_000, requestTimeoutMs = 30_000 }: {
  workerPath: string; workerData: Record<string, unknown>; startupTimeoutMs?: number; requestTimeoutMs?: number;
}): RpcWorker {
  let worker: Worker | null = null;
  let nextId = 1;
  let methods: string[] = [];
  let readyPromise: Promise<{ methods: string[] }> | null = null;
  let resolveReady: ((value: { methods: string[] }) => void) | null = null;
  let rejectReady: ((reason: Error) => void) | null = null;
  let closed = false;
  let restartAttempt = 0;
  let restartTimer: NodeJS.Timeout | null = null;
  let state: 'starting' | 'ready' | 'restarting' | 'failed' | 'closed' = 'starting';
  let bootTimer: NodeJS.Timeout | undefined;
  let readyAt = 0;
  let exitListener: ((code: number) => void) | null = null;
  const pending = new Map<string, PendingRequest>();

  function FailAll(code: string, message: string): void {
    const error = Object.assign(new Error(message), { code }) as Error & { code: string };
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(error); }
    pending.clear();
  }

  function RejectReady(code: string, message: string): void {
    rejectReady?.(Object.assign(new Error(message), { code }));
    rejectReady = null;
    resolveReady = null;
  }

  function PrepareReady(): void {
    readyPromise = new Promise<{ methods: string[] }>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    // 没有调用方等待启动时，失败也不能变成进程级 unhandledRejection。
    void readyPromise.catch(() => undefined);
  }

  /** 一代退出先结算所有等待，再准备下一代；任何原请求都不会自动重放。 */
  function LoseGeneration(current: Worker, message: string, permanent = false, code = 'STORAGE_ERROR'): void {
    if (worker !== current) return;
    clearTimeout(bootTimer);
    if (readyAt && Date.now() - readyAt >= 30_000) restartAttempt = 0;
    readyAt = 0; methods = []; worker = null;
    RejectReady(code, message);
    FailAll(code, message);
    void current.terminate().catch(() => undefined);
    if (closed || permanent) { state = closed ? 'closed' : 'failed'; return; }
    state = 'restarting';
    PrepareReady();
    restartTimer = setTimeout(Spawn, RestartDelayMs(restartAttempt++));
  }

  function Spawn(): void {
    if (closed) return;
    state = 'starting';
    let current: Worker;
    try { current = new Worker(workerPath, { workerData }); }
    catch (error) {
      state = 'failed';
      RejectReady('STORAGE_ERROR', error instanceof Error ? error.message : 'Worker could not start.');
      return;
    }
    worker = current;
    bootTimer = setTimeout(() => LoseGeneration(current, '存储 Worker 启动超时，请稍后继续。'), startupTimeoutMs);

    current.on('message', (message: WorkerMessage) => {
      if (worker !== current || closed) return;
      if (!message || typeof message.type !== 'string') return;
      if (message.type === 'ready') {
        methods = Array.isArray(message.methods) ? message.methods : [];
        clearTimeout(bootTimer); state = 'ready'; readyAt = Date.now();
        resolveReady?.({ methods });
        resolveReady = null;
        return;
      }
      if (message.type === 'error') {
        // 显式的初始化失败通常需要修复配置或数据库，不能无限重启掩盖错误。
        LoseGeneration(current, message.message ? String(message.message) : 'Worker failed to initialize.', state !== 'ready', message.code || 'STORAGE_ERROR');
        return;
      }
      if (message.type === 'response') {
        const id = message.id === undefined || message.id === null ? '' : String(message.id);
        const entry = pending.get(id);
        if (!entry) return;
        pending.delete(id);
        clearTimeout(entry.timer);
        if (message.ok) {
          entry.resolve(message.data);
        } else {
          const workerError = Object.assign(
            new Error(message.error?.message ? String(message.error.message) : 'Worker method failed.'),
            { code: message.error?.code ? String(message.error.code) : 'STORAGE_ERROR' },
          ) as Error & { code: string; details?: unknown; retryable?: boolean };
          if (message.error?.details && typeof message.error.details === 'object') workerError.details = message.error.details;
          if (message.error?.retryable === true) workerError.retryable = true;
          entry.reject(workerError);
        }
      }
    });

    current.on('error', (error: Error) => {
      LoseGeneration(current, error?.message || 'Worker thread crashed.');
    });

    current.on('exit', (code: number) => {
      LoseGeneration(current, `Worker exited with code ${code}.`);
      exitListener?.(code);
    });
  }

  PrepareReady(); Spawn();

  return {
    Methods(): string[] {
      return [...methods];
    },
    Ready(): Promise<{ methods: string[] }> {
      return readyPromise as Promise<{ methods: string[] }>;
    },
    OnExit(listener: (code: number) => void): void {
      exitListener = listener;
    },
    async Call(method: string, args: unknown[] = []): Promise<unknown> {
      if (closed) throw Object.assign(new Error('Worker is closed.'), { code: 'STORAGE_ERROR' });
      const awaitedReady = readyPromise;
      const ready = await awaitedReady!;
      if (closed || state !== 'ready' || !worker || awaitedReady !== readyPromise) throw Object.assign(new Error('存储 Worker 已断开，原请求没有重放，请稍后继续。'), { code: 'STORAGE_ERROR' });
      if (!ready.methods.includes(method)) {
        throw Object.assign(new Error(`Worker method "${method}" is not exposed.`), { code: 'INTERNAL_ERROR' });
      }
      const id = String(nextId++);
      return new Promise<unknown>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          // 超时并不证明写入没发生；迟到回执忽略，禁止重新投递原操作。
          reject(Object.assign(new Error('存储请求超时，结果尚未确认，请核对后继续。'), { code: 'STORAGE_ERROR', details: { reason: 'WORKER_RPC_TIMEOUT', statusUnknown: true }, retryable: false }));
        }, requestTimeoutMs);
        pending.set(id, { resolve, reject, timer });
        try { worker!.postMessage({ type: 'request', id, method, args }); }
        catch (error) { clearTimeout(timer); pending.delete(id); reject(error instanceof Error ? error : new Error('Worker message could not be sent.')); }
      });
    },
    Close(): void {
      closed = true;
      state = 'closed'; clearTimeout(bootTimer);
      RejectReady('STORAGE_ERROR', 'Worker is closing.');
      if (restartTimer) clearTimeout(restartTimer);
      FailAll('STORAGE_ERROR', 'Worker is closing.');
      try {
        void worker?.terminate().catch(() => undefined);
      } catch {
        // 终止阶段重复关闭无需额外处理。
      }
    },
  };
}
