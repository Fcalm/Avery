import { randomUUID } from 'node:crypto';

export interface DesktopCapabilityCallOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

interface PendingCapability {
  capability: string;
  resolve(value: unknown): void;
  reject(error: Error): void;
  dispose(): void;
}

/** 人工目录选择需要较长窗口，但所有能力均须有界，不能拖住对话或启动。 */
function CapabilityTimeout(capability: string): number {
  if (['SelectModuleDirectory', 'SelectWorkspaceDirectory', 'SelectProjectDirectory'].includes(capability)) return 300_000;
  if (['ExportResumeAsset', 'ExportResume', 'PreviewResumePdf'].includes(capability)) return 120_000;
  return 30_000;
}

function CapabilityError(capability: string, reason: string): Error {
  const cancelled = reason === 'CANCELLED';
  // 超时/取消不能证明主进程没有执行；只读能力之外必须保留未知结果，且绝不自动重发。
  const statusUnknown = !['CredentialLoad', 'SelectModuleDirectory', 'SelectWorkspaceDirectory', 'SelectProjectDirectory'].includes(capability);
  return Object.assign(new Error(cancelled ? '桌面能力请求已取消。' : reason === 'DESKTOP_CAPABILITY_TIMEOUT'
    ? '桌面能力响应超时，请核对结果后继续。' : '桌面能力连接已关闭或无法发送请求。'), {
    code: cancelled ? 'CANCELLED' : 'INTERNAL_ERROR', retryable: false,
    details: { reason, capability, statusUnknown },
  });
}

/** Backend → Main 反向 RPC；每次等待均可结算，进程换代与迟到回执不能命中新请求。 */
export function CreateDesktopCapabilityClient(postMessage: (message: unknown) => void) {
  const pending = new Map<string, PendingCapability>();
  const sessionId = randomUUID();
  let nextId = 1;
  let closed = false;

  function Settle(id: string, error?: Error, value?: unknown): void {
    const entry = pending.get(id);
    if (!entry) return;
    pending.delete(id);
    entry.dispose();
    if (error) entry.reject(error);
    else entry.resolve(value);
  }

  return {
    /** 只接收当前代、当前在途调用的回执；不复制参数或凭据到错误结构。 */
    OnMessage(message: unknown): void {
      if (!message || typeof message !== 'object') return;
      const result = message as { kind?: unknown; id?: unknown; ok?: unknown; data?: unknown; error?: unknown };
      if (result.kind !== 'desktop-result' || typeof result.id !== 'string' || typeof result.ok !== 'boolean') return;
      const entry = pending.get(result.id);
      if (!entry) return;
      const failure = result.ok ? undefined : Object.assign(new Error(typeof result.error === 'string' ? result.error : 'Desktop capability failed.'), {
        code: 'INTERNAL_ERROR', retryable: false, details: { reason: 'DESKTOP_CAPABILITY_FAILED', capability: entry.capability },
      });
      Settle(result.id, failure, result.data);
    },
    /** 期限仅结束等待，不声称主进程副作用已撤销；超时、取消和关闭均不重放原请求。 */
    Call(capability: string, args: unknown[] = [], options: DesktopCapabilityCallOptions = {}): Promise<unknown> {
      if (closed) return Promise.reject(CapabilityError(capability, 'DESKTOP_CAPABILITY_CLOSED'));
      if (options.signal?.aborted) return Promise.reject(CapabilityError(capability, 'CANCELLED'));
      const configuredTimeout = options.timeoutMs ?? CapabilityTimeout(capability);
      if (!Number.isSafeInteger(configuredTimeout) || configuredTimeout <= 0 || configuredTimeout > 300_000) {
        return Promise.reject(Object.assign(new Error('桌面能力等待期限无效。'), { code: 'VALIDATION_ERROR', retryable: false }));
      }
      const id = `desktop-${sessionId}-${nextId++}`;
      return new Promise((resolve, reject) => {
        const abort = () => Settle(id, CapabilityError(capability, 'CANCELLED'));
        const timer = setTimeout(() => Settle(id, CapabilityError(capability, 'DESKTOP_CAPABILITY_TIMEOUT')), configuredTimeout);
        pending.set(id, { capability, resolve, reject, dispose: () => {
          clearTimeout(timer);
          options.signal?.removeEventListener('abort', abort);
        } });
        options.signal?.addEventListener('abort', abort, { once: true });
        if (options.signal?.aborted) { abort(); return; }
        try { postMessage({ kind: 'desktop', id, capability, args }); }
        catch { Settle(id, CapabilityError(capability, 'DESKTOP_CAPABILITY_SEND_FAILED')); }
      });
    },
    /** 必须先结算等待再关闭业务服务，避免关闭流程自己等在失联的主进程回执上。 */
    Close(): void {
      closed = true;
      for (const [id, entry] of pending) Settle(id, CapabilityError(entry.capability, 'DESKTOP_CAPABILITY_CLOSED'));
    },
  };
}
