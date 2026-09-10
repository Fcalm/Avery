/**
 * 确认卡可能早于旧 Run 的等待终态或 IPC 收尾；这里把确认结果排队到两者都释放后，
 * 再复用标准发送链路写入真实 user 消息，避免后端锁尚未释放时丢弃答案。
 */
export class UserContinuationQueue {
  private pending: string[] = [];
  private flushScheduled = false;

  constructor(
    private readonly isBusy: () => boolean,
    private readonly send: (message: string) => void,
    private readonly schedule: (callback: () => void) => void = queueMicrotask,
  ) {}

  Submit(message: string): 'queued' | 'scheduled' {
    this.pending.push(message);
    const queued = this.isBusy();
    this.Flush();
    return queued ? 'queued' : 'scheduled';
  }

  /** 由旧 Run 的流式终态和 IPC 收尾调用；只有 isBusy 真正解除时才会发送。 */
  Release(): void { this.Flush(); }

  Clear(): void {
    this.pending = [];
    this.flushScheduled = false;
  }

  PendingCount(): number { return this.pending.length; }

  private Flush(): void {
    if (this.flushScheduled || this.isBusy() || this.pending.length === 0) return;
    this.flushScheduled = true;
    this.schedule(() => {
      this.flushScheduled = false;
      if (this.isBusy()) return;
      const message = this.pending.shift();
      if (message) this.send(message);
    });
  }
}
