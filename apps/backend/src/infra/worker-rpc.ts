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
export function CreateRpcWorker({ workerPath, workerData }: { workerPath: string; workerData: Record<string, unknown> }): RpcWorker {
  let worker: Worker | null = null;
  let nextId = 1;
  let methods: string[] = [];
  let readyPromise: Promise<{ methods: string[] }> | null = null;
  let resolveReady: ((value: { methods: string[] }) => void) | null = null;
  let rejectReady: ((reason: Error) => void) | null = null;
  let closed = false;
  let restartAttempt = 0;
  let restartTimer: NodeJS.Timeout | null = null;
  let bootError: Error | null = null;
  let exitListener: ((code: number) => void) | null = null;
  const pending = new Map<string, PendingRequest>();

  function FailAll(code: string, message: string): void {
    const error = Object.assign(new Error(message), { code }) as Error & { code: string };
    for (const entry of pending.values()) entry.reject(error);
    pending.clear();
  }

  function RejectReady(code: string, message: string): void {
    bootError = Object.assign(new Error(message), { code }) as Error & { code: string };
    rejectReady?.(bootError);
    rejectReady = null;
  }

  function Spawn(): void {
    readyPromise = new Promise<{ methods: string[] }>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    bootError = null;
    worker = new Worker(workerPath, { workerData });

    worker.on('message', (message: WorkerMessage) => {
      if (!message || typeof message.type !== 'string') return;
      if (message.type === 'ready') {
        methods = Array.isArray(message.methods) ? message.methods : [];
        restartAttempt = 0;
        resolveReady?.({ methods });
        resolveReady = null;
        return;
      }
      if (message.type === 'error') {
        RejectReady(message.code ? String(message.code) : 'STORAGE_ERROR', message.message ? String(message.message) : 'Worker failed to initialize.');
        return;
      }
      if (message.type === 'response') {
        const id = message.id === undefined || message.id === null ? '' : String(message.id);
        const entry = pending.get(id);
        if (!entry) return;
        pending.delete(id);
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

    worker.on('error', (error: Error) => {
      RejectReady('STORAGE_ERROR', error?.message || 'Worker thread crashed.');
      FailAll('STORAGE_ERROR', error?.message || 'Worker thread crashed.');
    });

    worker.on('exit', (code: number) => {
      FailAll('STORAGE_ERROR', `Worker exited with code ${code}.`);
      if (!closed && code !== 0 && !bootError) {
        const delay = RestartDelayMs(restartAttempt++);
        restartTimer = setTimeout(Spawn, delay);
      }
      exitListener?.(code);
    });
  }

  Spawn();

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
      const ready = await readyPromise!;
      if (!ready.methods.includes(method)) {
        throw Object.assign(new Error(`Worker method "${method}" is not exposed.`), { code: 'INTERNAL_ERROR' });
      }
      const id = String(nextId++);
      return new Promise<unknown>((resolve, reject) => {
        pending.set(id, { resolve, reject });
        worker?.postMessage({ type: 'request', id, method, args });
      });
    },
    Close(): void {
      closed = true;
      if (restartTimer) clearTimeout(restartTimer);
      FailAll('STORAGE_ERROR', 'Worker is closing.');
      try {
        void worker?.terminate();
      } catch {
        // 终止阶段重复关闭无需额外处理。
      }
    },
  };
}
