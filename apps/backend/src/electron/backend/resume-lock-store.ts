/** 简历互斥锁信息；与 agent-sdk 的 ResumeWritePort 锁形状保持一致，Backend 内部单独声明避免 SDK 类型漂移。 */
export interface ResumeEditLock {
  resumeId: string;
  owner: 'user' | 'agent';
  ownerId: string;
  baseRevision?: number;
  acquiredAt: number;
  leaseExpiresAt: number;
}

/** 简历互斥锁租约；超时后其他方（用户或 Agent）可重新获取。 */
export class ResumeLockStore {
  private locks = new Map<string, ResumeEditLock>();
  private leaseMs: number;

  /** @param leaseMs 锁租约时长（毫秒）；默认 5 分钟。 */
  constructor({ leaseMs = 5 * 60 * 1000 }: { leaseMs?: number } = {}) {
    this.leaseMs = leaseMs;
  }

  /** 清理所有已过租约的锁；每次操作前惰性调用，避免定时器泄漏。 */
  ExpireLeases(): void {
    const now = Date.now();
    for (const [resumeId, lock] of this.locks) {
      if (lock.leaseExpiresAt < now) this.locks.delete(resumeId);
    }
  }

  /** 尝试获取锁；同 ownerId 重复获取刷新租约；被其他 owner 占用时返回 null。 */
  Acquire(resumeId: string, owner: 'user' | 'agent', ownerId: string, baseRevision?: number): ResumeEditLock | null {
    this.ExpireLeases();
    const existing = this.locks.get(resumeId);
    if (existing && existing.ownerId !== ownerId) return null;
    const lock: ResumeEditLock = { resumeId, owner, ownerId, baseRevision, acquiredAt: Date.now(), leaseExpiresAt: Date.now() + this.leaseMs };
    this.locks.set(resumeId, lock);
    return lock;
  }

  /** 释放指定 owner 持有的锁；仅当 ownerId 匹配时删除。 */
  Release(resumeId: string, ownerId: string): boolean {
    this.ExpireLeases();
    const lock = this.locks.get(resumeId);
    if (lock && lock.ownerId === ownerId) {
      this.locks.delete(resumeId);
      return true;
    }
    return false;
  }

  /** 返回当前锁（含过期清理）；无锁或已过期返回 null。 */
  GetLock(resumeId: string): ResumeEditLock | null {
    this.ExpireLeases();
    return this.locks.get(resumeId) ?? null;
  }
}
