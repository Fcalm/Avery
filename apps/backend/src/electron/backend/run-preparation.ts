/** 只用于可丢弃结果的准备阶段读取；写操作必须等待真实结算，不能通过此处取消猜测其结果。 */
export async function AwaitPreparation<T>(read: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    // 调用方可能已经创建了读取 Promise；即使不再等待，也必须接住它的迟到拒绝。
    void read.catch(() => undefined);
    signal.throwIfAborted();
  }
  let abort!: () => void;
  const cancelled = new Promise<never>((_resolve, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
  try { return await Promise.race([read, cancelled]); }
  finally { signal.removeEventListener('abort', abort); }
}
