/** 模型阶段的恢复只重发尚未交给工具调度器的请求，不包含任何业务动作重放。 */
export interface ProviderRecovery {
  attempt: number;
  maxAttempts: number;
  delayMs: number;
  mode: 'stream' | 'nonstream';
  code: string;
}

export interface ProviderTransportPolicy {
  maxAttempts: number;
  initialDelayMs: number;
  maxDelayMs: number;
  connectionTimeoutMs: number;
  idleTimeoutMs: number;
  nonstreamTimeoutMs: number;
}

export const DefaultProviderTransportPolicy: ProviderTransportPolicy = {
  maxAttempts: 3, initialDelayMs: 1000, maxDelayMs: 10_000,
  connectionTimeoutMs: 60_000, idleTimeoutMs: 90_000, nonstreamTimeoutMs: 180_000,
};

/** 只携带稳定诊断码与脱敏消息；原始 cause 留给宿主，不复制请求体或凭据。 */
export class ProviderTransportError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly allowFallback: boolean;
  readonly retryAfterMs?: number;
  readonly status?: number;
  constructor(code: string, message: string, options: { cause?: unknown; retryable?: boolean; allowFallback?: boolean; retryAfterMs?: number; status?: number } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'ProviderTransportError'; this.code = code;
    this.retryable = options.retryable ?? false; this.allowFallback = options.allowFallback ?? false;
    this.retryAfterMs = options.retryAfterMs; this.status = options.status;
  }
}

export function ProtocolError(code: string, message: string, cause?: unknown): ProviderTransportError {
  return new ProviderTransportError(code, message, { retryable: true, allowFallback: true, cause });
}

/** 每次尝试独立管理取消与阶段超时；即使适配器忽略 signal，等待也必须结束。 */
export class ProviderAttempt {
  private controller = new AbortController();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly abortParent = () => this.controller.abort(this.parent?.reason);
  readonly signal: AbortSignal = this.controller.signal;
  constructor(private readonly parent?: AbortSignal) {
    parent?.addEventListener('abort', this.abortParent, { once: true });
    if (parent?.aborted) this.abortParent();
  }
  Arm(milliseconds: number, code: string): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.controller.abort(new ProviderTransportError(code,
      code === 'PROVIDER_IDLE_TIMEOUT' ? '模型响应长时间没有新内容，连接已中止。' : '模型连接等待超时。',
      { retryable: true, allowFallback: code === 'PROVIDER_IDLE_TIMEOUT' })), milliseconds);
  }
  async Wait<T>(work: () => Promise<T>): Promise<T> {
    this.signal.throwIfAborted();
    let abort!: () => void;
    const cancelled = new Promise<never>((_resolve, reject) => {
      abort = () => reject(this.signal.reason);
      this.signal.addEventListener('abort', abort, { once: true });
      if (this.signal.aborted) abort();
    });
    try { return await Promise.race([Promise.resolve().then(work), cancelled]); }
    finally { this.signal.removeEventListener('abort', abort); }
  }
  Dispose(): void {
    clearTimeout(this.timer); this.parent?.removeEventListener('abort', this.abortParent);
    // 尚未结束的响应不能在下一次尝试期间继续占用连接或回调。
    this.controller.abort();
  }
}

function NormalizeTransportError(error: unknown): ProviderTransportError {
  if (error instanceof ProviderTransportError) return error;
  const record = error && typeof error === 'object' ? error as { name?: unknown; code?: unknown; message?: unknown; cause?: { code?: unknown } } : {};
  if (/ECONN|ETIMEDOUT|EAI_AGAIN|UND_ERR/.test(String(record.code ?? record.cause?.code ?? '')) || /fetch failed|failed to fetch|terminated|network/i.test(String(record.message ?? ''))) {
    return new ProviderTransportError('PROVIDER_CONNECTION_INTERRUPTED', '模型连接中断，请检查网络或稍后继续。', { cause: error, retryable: true, allowFallback: record.message === 'terminated' });
  }
  return new ProviderTransportError('PROVIDER_REQUEST_FAILED', error instanceof Error ? error.message : '模型请求失败。', { cause: error });
}

/** 指数退避等待可随用户取消立即结束；不使用无界的后台重连循环。 */
async function Backoff(milliseconds: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  let timer: ReturnType<typeof setTimeout>;
  let abort!: () => void;
  try {
    await new Promise<void>((resolve, reject) => {
      abort = () => { clearTimeout(timer); reject(signal?.reason); };
      timer = setTimeout(resolve, milliseconds);
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
    });
  } finally { clearTimeout(timer!); signal?.removeEventListener('abort', abort); }
}

export async function WithProviderRecovery<T>(perform: (scope: ProviderAttempt, mode: 'stream' | 'nonstream', attempt: number) => Promise<T>, options: {
  signal?: AbortSignal; policy: ProviderTransportPolicy; stream: boolean;
  onRecovery?: (recovery: ProviderRecovery) => void;
}): Promise<T> {
  let mode: 'stream' | 'nonstream' = options.stream ? 'stream' : 'nonstream';
  const attempts = Number.isSafeInteger(options.policy.maxAttempts) ? Math.max(1, Math.min(5, options.policy.maxAttempts)) : DefaultProviderTransportPolicy.maxAttempts;
  for (let attempt = 1; ; attempt++) {
    options.signal?.throwIfAborted();
    const scope = new ProviderAttempt(options.signal);
    try { return await perform(scope, mode, attempt); }
    catch (error) {
      options.signal?.throwIfAborted();
      const failure = NormalizeTransportError(scope.signal.aborted ? scope.signal.reason : error);
      if (!failure.retryable) throw failure;
      // 阶段重试耗尽后不再把整个 Send 标为可自动重试，避免调用方重放已执行工具。
      if (attempt >= attempts) throw new ProviderTransportError(failure.code, `模型连接恢复失败（已尝试 ${attempts} 次），请稍后继续。${failure.message}`, { cause: failure, status: failure.status });
      if (mode === 'stream' && failure.allowFallback && attempt >= attempts - 1) mode = 'nonstream';
      const delayMs = Math.max(0, Math.min(options.policy.maxDelayMs,
        Math.max(options.policy.initialDelayMs * 2 ** (attempt - 1), failure.retryAfterMs ?? 0)));
      // 先撤销本次未完成输出，再展示重连状态；工具调用尚未离开 Provider。
      options.onRecovery?.({ attempt: attempt + 1, maxAttempts: attempts, delayMs, mode, code: failure.code });
      scope.Dispose();
      await Backoff(delayMs, options.signal);
    } finally { scope.Dispose(); }
  }
}
