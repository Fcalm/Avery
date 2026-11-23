import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConversationRetentionService } from '../../../apps/backend/src/electron/backend/services/conversation-retention-service';

function Fixture() {
  const business = {
    SetConversationArchived: vi.fn(async () => ({ id: 'one', archived: false, revision: 3 })),
    DeleteConversation: vi.fn(async () => ({ id: 'one' })),
    DeleteArchivedConversation: vi.fn(async () => ({ id: 'one', deleted: true })),
    ListExpiredConversations: vi.fn(async () => [] as Array<{ id: string; expectedRevision: number }>),
    ListPendingConversationCleanup: vi.fn(async () => [] as string[]),
    CompleteConversationCleanup: vi.fn(async () => undefined),
    GetWorkspaceRecoveryStatus: vi.fn(async () => ({ blocked: false })),
  };
  const agent = { WithSessionDeletion: async <T>(_id: string, run: () => Promise<T>) => run(), DeleteSessionResources: vi.fn(async () => undefined) };
  const changed = vi.fn(), report = vi.fn();
  return { business, agent, changed, report, service: new ConversationRetentionService({ business, agent, changed, report }) };
}
afterEach(() => vi.useRealTimers());

describe('归档维护调度与并发边界', () => {
  it('启动补扫，每分钟维护，关闭后不再调度', async () => {
    vi.useFakeTimers(); const f = Fixture();
    f.service.Start(); await f.service.Sweep();
    expect(f.business.ListExpiredConversations).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(f.business.ListExpiredConversations).toHaveBeenCalledTimes(2);
    await f.service.Close(); await vi.advanceTimersByTimeAsync(120_000);
    expect(f.business.ListExpiredConversations).toHaveBeenCalledTimes(2);
  });

  it('工作空间恢复受阻时不删除任何数据库或私有资源', async () => {
    const f = Fixture(); f.business.GetWorkspaceRecoveryStatus.mockResolvedValue({ blocked: true });
    try { await f.service.Sweep(); expect(f.business.ListExpiredConversations).not.toHaveBeenCalled(); expect(f.agent.DeleteSessionResources).not.toHaveBeenCalled(); }
    finally { await f.service.Close(); }
  });

  it('重叠维护复用同一 Promise，迁移等待在途检查并在切换前停止删除', async () => {
    const f = Fixture(); let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    f.business.ListExpiredConversations.mockImplementation(async () => { await gate; return [{ id: 'old-workspace', expectedRevision: 2 }]; });
    const sweep = f.service.Sweep(); expect(f.service.Sweep()).toBe(sweep);
    await vi.waitFor(() => expect(f.business.ListExpiredConversations).toHaveBeenCalled());
    const suspended = f.service.Suspend(); release(); await suspended;
    expect(f.business.DeleteArchivedConversation).not.toHaveBeenCalled();
    await expect(f.service.SetConversationArchived('one', false, 2)).rejects.toMatchObject({ code: 'WORKSPACE_BUSY' });
    f.service.Resume(); await f.service.SetConversationArchived('one', false, 2);
    expect(f.changed).toHaveBeenCalledOnce(); await f.service.Close();
  });

  it('单条失败不阻塞其他条，批量变更只发一次刷新事件', async () => {
    const f = Fixture(); f.agent.DeleteSessionResources.mockRejectedValueOnce(new Error('落盘失败'));
    try {
      const result = await f.service.DeleteArchivedConversations([{ id: 'one', expectedRevision: 2 }, { id: 'two', expectedRevision: 2 }]);
      expect(result).toEqual({ deletedIds: ['two'], skipped: [], failed: [{ id: 'one', message: '落盘失败' }] });
      expect(f.business.CompleteConversationCleanup).toHaveBeenCalledExactlyOnceWith('two');
      expect(f.changed).toHaveBeenCalledOnce();
    } finally { await f.service.Close(); }
  });

  it('同一会话的恢复先结算后删除校验，不抢越正在处理的操作', async () => {
    const f = Fixture(); let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    f.business.SetConversationArchived.mockImplementation(async () => { await gate; return { id: 'one', archived: false, revision: 3 }; });
    const restore = f.service.SetConversationArchived('one', false, 2);
    const deletion = f.service.DeleteArchivedConversations([{ id: 'one', expectedRevision: 2 }]);
    await Promise.resolve(); expect(f.business.DeleteArchivedConversation).not.toHaveBeenCalled();
    release(); await restore; await deletion;
    expect(f.business.DeleteArchivedConversation).toHaveBeenCalledAfter(f.business.SetConversationArchived);
    await f.service.Close();
  });
});
