import type { ArchivedConversationDeleteResult, ArchivedConversationSelection } from '@avery/contracts';

interface RetentionPorts {
  business: {
    SetConversationArchived(id: string, archived: boolean, revision?: number): Promise<unknown>;
    DeleteConversation(id: string): Promise<{ id: string }>;
    DeleteArchivedConversation(id: string, revision: number, dueBefore?: number): Promise<{ id: string; deleted: boolean; reason?: 'not_found' | 'changed' }>;
    ListExpiredConversations(now: number): Promise<ArchivedConversationSelection[]>;
    ListPendingConversationCleanup(): Promise<string[]>;
    CompleteConversationCleanup(id: string): Promise<void>;
    GetWorkspaceRecoveryStatus(): Promise<{ blocked?: boolean }>;
  };
  agent: {
    WithSessionDeletion<T>(id: string, operation: () => Promise<T>): Promise<T>;
    DeleteSessionResources(id: string): Promise<void>;
  };
  changed(): void;
  report(error: unknown): void;
}

/** 归档、恢复与清理按会话串行；删除校验和持久清理任务由同一业务事务提交。 */
export class ConversationRetentionService {
  private locks = new Map<string, Promise<unknown>>();
  private sweep?: Promise<void>;
  private timer?: ReturnType<typeof setInterval>;
  private closed = false;
  private suspended = false;

  constructor(private readonly ports: RetentionPorts) {}

  private async Serial<T>(id: string, operation: () => Promise<T>): Promise<T> {
    if (this.closed || this.suspended) throw Object.assign(new Error('会话维护暂不可用，请稍后重试。'), { code: 'WORKSPACE_BUSY' });
    const previous = this.locks.get(id);
    const work = (previous ?? Promise.resolve()).catch(() => undefined).then(operation);
    this.locks.set(id, work);
    try { return await work; }
    finally { if (this.locks.get(id) === work) this.locks.delete(id); }
  }

  async SetConversationArchived(id: string, archived: boolean, revision?: number): Promise<unknown> {
    return this.Serial(id, async () => {
      const result = await this.ports.business.SetConversationArchived(id, archived, revision);
      this.ports.changed();
      return result;
    });
  }

  private async FinishCleanup(id: string): Promise<void> {
    await this.ports.agent.DeleteSessionResources(id);
    await this.ports.business.CompleteConversationCleanup(id);
  }

  async DeleteConversation(id: string): Promise<{ id: string }> {
    return this.Serial(id, () => this.ports.agent.WithSessionDeletion(id, async () => {
      const result = await this.ports.business.DeleteConversation(id);
      // 数据库已删除就同步列表；后续清理失败保留持久任务，下一次维护继续。
      this.ports.changed();
      await this.FinishCleanup(id);
      return result;
    }));
  }

  /** 用户只能删除确认快照；逐项返回真实结果，某一条失败不冒充整批成功。 */
  async DeleteArchivedConversations(items: ArchivedConversationSelection[], dueBefore?: number): Promise<ArchivedConversationDeleteResult> {
    if (!Array.isArray(items) || items.length < 1 || items.length > 10000 || new Set(items.map(item => item?.id)).size !== items.length
      || items.some(item => !item || typeof item.id !== 'string' || !item.id.length || item.id.length > 200 || !Number.isSafeInteger(item.expectedRevision) || item.expectedRevision < 1)) {
      throw Object.assign(new Error('归档删除快照无效。'), { code: 'VALIDATION_ERROR' });
    }
    const result: ArchivedConversationDeleteResult = { deletedIds: [], skipped: [], failed: [] };
    let changed = false;
    for (const item of items) {
      try {
        await this.Serial(item.id, () => this.ports.agent.WithSessionDeletion(item.id, async () => {
          const deletion = await this.ports.business.DeleteArchivedConversation(item.id, item.expectedRevision, dueBefore);
          if (!deletion.deleted) { result.skipped.push({ id: item.id, reason: deletion.reason ?? 'changed' }); return; }
          changed = true;
          await this.FinishCleanup(item.id);
          result.deletedIds.push(item.id);
        }));
      } catch (error) {
        result.failed.push({ id: item.id, message: error instanceof Error ? error.message : '会话清理失败，请重试。' });
      }
    }
    if (changed) this.ports.changed();
    return result;
  }

  /** 启动补扫及每分钟维护：离线到期在下次启动补清理，后台异常明确记录且不会产生未处理拒绝。 */
  Start(): void {
    if (this.timer || this.closed) return;
    const Run = () => { void this.Sweep().catch(this.ports.report); };
    Run();
    this.timer = setInterval(Run, 60_000);
    this.timer.unref?.();
  }

  Sweep(now = Date.now()): Promise<void> {
    if (this.sweep) return this.sweep;
    if (this.closed || this.suspended) return Promise.resolve();
    if (!Number.isSafeInteger(now) || now < 0) return Promise.reject(new Error('会话清理时间无效。'));
    const work = this.RunSweep(now).finally(() => { if (this.sweep === work) this.sweep = undefined; });
    this.sweep = work;
    return work;
  }

  private async RunSweep(now: number): Promise<void> {
    if ((await this.ports.business.GetWorkspaceRecoveryStatus()).blocked) return;
    for (const id of await this.ports.business.ListPendingConversationCleanup()) {
      if (this.closed || this.suspended) return;
      try { await this.Serial(id, () => this.ports.agent.WithSessionDeletion(id, () => this.FinishCleanup(id))); }
      catch (error) { this.ports.report(error); }
    }
    if (this.closed || this.suspended) return;
    const items = await this.ports.business.ListExpiredConversations(now);
    if (this.closed || this.suspended) return;
    if (items.length) {
      const result = await this.DeleteArchivedConversations(items, now);
      for (const failure of result.failed) this.ports.report(new Error(`归档会话清理失败 (${failure.id}): ${failure.message}`));
    }
  }

  /** 工作空间切换前先停止进入并结算维护，防止旧空间快照作用于新数据库。 */
  async Suspend(): Promise<void> {
    this.suspended = true;
    await this.sweep;
    await Promise.allSettled([...this.locks.values()]);
  }
  Resume(): void { this.suspended = false; }

  async Close(): Promise<void> {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    await Promise.allSettled([this.sweep]);
    await Promise.allSettled([...this.locks.values()]);
  }
}
