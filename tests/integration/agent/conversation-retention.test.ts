import { createRequire } from 'node:module';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConversationRetentionService } from '../../../apps/backend/src/electron/backend/services/conversation-retention-service';
import { AgentHost } from '../../../apps/backend/src/electron/backend/agent-host';
import { CompactionArchive } from '../../../apps/backend/src/electron/backend/compaction-archive';
import { CreateBackend } from '../../../apps/backend/src/router';

const require = createRequire(import.meta.url);
const { CreateBusinessStoreClient } = require(resolve('apps/backend/dist/infra/business-store-client.js')) as typeof import('../../../apps/backend/src/infra/business-store-client');
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

async function Fixture() {
  const parent = process.env.AVERY_TEST_ARTIFACT_DIR ?? tmpdir();
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, 'archive-retention-')); roots.push(root);
  const business = CreateBusinessStoreClient({ workspacePath: join(root, 'workspace'), smoke: true });
  await business.ready;
  const cleanup = vi.fn(async (_id: string) => undefined);
  const agent = { WithSessionDeletion: async <T>(_id: string, run: () => Promise<T>) => run(), DeleteSessionResources: cleanup };
  const changed = vi.fn(), report = vi.fn();
  const service = new ConversationRetentionService({ business, agent, changed, report });
  const Create = async (id: string) => { await business.CreateConversation({ id, title: id }); return business.SetConversationArchived(id, true, 1); };
  return { root, business, agent, cleanup, changed, report, service, Create };
}

describe('归档生命周期真实业务 Worker', () => {
  it('v18 工作空间升级后保留旧归档和消息且不追溯计时，迁移前产生可恢复备份', async () => {
    const f = await Fixture(); let business = f.business;
    try {
      await business.CreateConversation({ id: 'old', title: '升级前归档' });
      await business.AppendConversationMessages('old', [{ id: 'old-message', role: 'user', content: '应保留的正文' }]);
      await business.Query("UPDATE conversations SET archived=1 WHERE id='old' RETURNING id");
      await business.Close(); business.close();
      const Database = require('better-sqlite3');
      const db = new Database(join(f.root, 'workspace', 'avery.db'));
      try {
        db.exec(`DROP INDEX idx_conversations_archive_expiry;
          ALTER TABLE conversations DROP COLUMN archived_at;
          ALTER TABLE conversations DROP COLUMN auto_delete_at;
          DROP TABLE conversation_cleanup;
          DELETE FROM schema_migrations WHERE version=19;
          UPDATE workspace_meta SET schema_version=18;`);
      } finally { db.close(); }
      business = CreateBusinessStoreClient({ workspacePath: join(f.root, 'workspace'), smoke: true }); await business.ready;
      expect((await business.LoadViewModel()).conversations[0]).toMatchObject({ id: 'old', archived: true, archivedAt: null, autoDeleteAt: null, messages: [{ content: '应保留的正文' }] });
      expect(await business.ListExpiredConversations(Date.now() + 100 * 86_400_000)).toEqual([]);
      const { readdir } = await import('node:fs/promises');
      expect((await readdir(join(f.root, 'workspace', 'backups'))).some(name => name.startsWith('daily-pre-upgrade-v18-to-v19-'))).toBe(true);
    } finally { await f.service.Close(); await business.Close(); business.close(); }
  });
  it('时间由后端保存，重复归档不续期，恢复清空期限且重启保持；旧归档不猜测时间', async () => {
    const f = await Fixture();
    let business = f.business;
    try {
      const first = await f.Create('timed');
      expect(first.autoDeleteAt - first.archivedAt).toBe(30 * 86_400_000);
      expect(await business.SetConversationArchived('timed', true, first.revision)).toEqual(first);
      expect((await business.LoadViewModel()).conversations[0]).toMatchObject(first);
      const restored = await f.service.SetConversationArchived('timed', false, first.revision);
      expect(restored).toMatchObject({ archived: false, archivedAt: null, autoDeleteAt: null });
      const next = await business.SetConversationArchived('timed', true, first.revision + 1);
      expect(next.revision).toBe(first.revision + 2);
      await business.CreateConversation({ id: 'legacy', title: '旧归档' });
      await business.Query("UPDATE conversations SET archived=1 WHERE id='legacy' RETURNING id");
      await business.Close(); business.close();
      business = CreateBusinessStoreClient({ workspacePath: join(f.root, 'workspace'), smoke: true }); await business.ready;
      const rows = (await business.LoadViewModel()).conversations;
      expect(rows.find((row: { id: string }) => row.id === 'timed')).toMatchObject(next);
      expect(rows.find((row: { id: string }) => row.id === 'legacy')).toMatchObject({ archived: true, archivedAt: null, autoDeleteAt: null });
      expect(await business.ListExpiredConversations(next.autoDeleteAt - 1)).toEqual([]);
      expect(await business.ListExpiredConversations(next.autoDeleteAt)).toEqual([{ id: 'timed', expectedRevision: next.revision }]);
    } finally { await f.service.Close(); await business.Close(); business.close(); }
  });

  it('确认后的恢复、重新归档和版本变化均跳过，只删除快照内有效项，新增归档不受影响', async () => {
    const f = await Fixture();
    try {
      const selected = [];
      for (const id of ['delete', 'restored', 'rearchived', 'renamed']) {
        const item = await f.Create(id); selected.push({ id, expectedRevision: item.revision });
      }
      await f.service.SetConversationArchived('restored', false, 2);
      await f.service.SetConversationArchived('rearchived', false, 2);
      await f.service.SetConversationArchived('rearchived', true, 3);
      await f.business.RenameConversation('renamed', '新标题', 2);
      await f.Create('later');
      const result = await f.service.DeleteArchivedConversations([...selected, { id: 'missing', expectedRevision: 1 }]);
      expect(result).toEqual({ deletedIds: ['delete'], skipped: [
        { id: 'restored', reason: 'changed' }, { id: 'rearchived', reason: 'changed' }, { id: 'renamed', reason: 'changed' }, { id: 'missing', reason: 'not_found' },
      ], failed: [] });
      expect(f.cleanup.mock.calls).toEqual([['delete']]);
      expect((await f.business.LoadViewModel()).conversations.map((row: { id: string }) => row.id).sort()).toEqual(['later', 'rearchived', 'renamed', 'restored']);
      expect(await f.business.ListPendingConversationCleanup()).toEqual([]);
    } finally { await f.service.Close(); await f.business.Close(); f.business.close(); }
  });

  it('到期事务再次校验期限，失败保留清理任务，重启补清理；未到期与旧归档保持', async () => {
    const f = await Fixture();
    let business = f.business;
    try {
      const expired = await f.Create('expired'); await f.Create('future');
      await business.CreateConversation({ id: 'legacy', title: '旧会话' });
      await business.Query("UPDATE conversations SET archived=1 WHERE id='legacy' RETURNING id");
      await business.Query("UPDATE conversations SET auto_delete_at=? WHERE id='expired' RETURNING id", [100]);
      expect(await business.DeleteArchivedConversation('expired', expired.revision, 99)).toMatchObject({ deleted: false, reason: 'changed' });
      f.cleanup.mockRejectedValueOnce(new Error('模拟归档磁盘暂时不可读'));
      await f.service.Sweep(100);
      expect(f.report).toHaveBeenCalled();
      expect(await business.ListPendingConversationCleanup()).toEqual(['expired']);
      expect((await business.LoadViewModel()).conversations.map((row: { id: string }) => row.id).sort()).toEqual(['future', 'legacy']);
      await expect(business.CreateConversation({ id: 'expired', title: '复用' })).rejects.toMatchObject({ code: 'RESOURCE_LOCKED' });
      await f.service.Close(); await business.Close(); business.close();
      business = CreateBusinessStoreClient({ workspacePath: join(f.root, 'workspace'), smoke: true }); await business.ready;
      const retry = new ConversationRetentionService({ business, agent: f.agent, changed: f.changed, report: f.report });
      try { await retry.Sweep(101); expect(await business.ListPendingConversationCleanup()).toEqual([]); }
      finally { await retry.Close(); }
    } finally { await f.service.Close(); await business.Close(); business.close(); }
  });

  it('批量负载缺版本、重复 ID、超量和注入字段在路由层拒绝，不调用删除', async () => {
    const call = vi.fn();
    const backend = CreateBackend({ container: { conversations: { DeleteArchivedConversations: call } } });
    for (const items of [[], [{ id: 'x' }], [{ id: 'x', expectedRevision: 0 }], [{ id: 'x', expectedRevision: 1, archived: true }], [{ id: 'x', expectedRevision: 1 }, { id: 'x', expectedRevision: 1 }], Array.from({ length: 10001 }, (_, n) => ({ id: String(n), expectedRevision: 1 }))]) {
      expect(await backend.HandleCommand('workspace:conversations-delete-archived', 'validation', undefined, items)).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } });
    }
    expect(call).not.toHaveBeenCalled();
  });

  it('删除等待在途资源清理，阻止新运行，清除真实 Agent 历史、压缩归档及图片引用', async () => {
    const f = await Fixture();
    const host = new AgentHost({ userDataPath: join(f.root, 'host'), workspacePath: join(f.root, 'workspace'), business: f.business, Emit: () => undefined });
    await host.Ready();
    const state = host as any;
    const archives = new CompactionArchive(join(f.root, 'host', 'compaction-archives'));
    const retention = new ConversationRetentionService({ business: f.business, agent: host, changed: f.changed, report: f.report });
    try {
      await f.Create('real');
      state.histories.set('real', [{ role: 'user', content: '需要清理的历史' }]); await state.SaveState();
      const summary = { summaryId: 'summary-deleted', messages: [{ role: 'user' as const, content: '压缩前历史' }] };
      await archives.Save('real', summary);
      await archives.Save('kept', summary);
      const image = await f.business.ImportAgentImage('real', 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZl8AAAAASUVORK5CYII=');
      expect(image.uri).toContain('attachment://');
      let release!: () => void;
      const gate = new Promise<void>(resolveGate => { release = resolveGate; });
      state.executingRunSessions.set('in-flight', 'real'); state.controllers.set('in-flight', new AbortController()); state.runReleases.set('in-flight', gate);
      const deletion = retention.DeleteArchivedConversations([{ id: 'real', expectedRevision: 2 }]);
      await vi.waitFor(() => expect(state.controllers.get('in-flight').signal.aborted).toBe(true));
      await expect(host.Send({ sessionId: 'real', requestId: 'new-run', content: '继续' })).rejects.toMatchObject({ code: 'RESOURCE_LOCKED' });
      let suspended = false;
      const suspend = retention.Suspend().then(() => { suspended = true; });
      await Promise.resolve(); expect(suspended).toBe(false);
      release();
      expect(await deletion).toEqual({ deletedIds: ['real'], skipped: [], failed: [] }); await suspend;
      expect(state.histories.has('real')).toBe(false);
      const compressed = [{ role: 'assistant' as const, content: '摘要', metadata: { kind: 'context_summary' as const, summaryId: summary.summaryId } }];
      await expect(archives.Expand('real', compressed, new AbortController().signal)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await archives.Expand('kept', compressed, new AbortController().signal)).toEqual(summary.messages);
      expect(await f.business.Query("SELECT * FROM attachment_links WHERE owner_type='agent' AND owner_id='real'")).toEqual([]);
      expect(await f.business.ListPendingConversationCleanup()).toEqual([]);
      expect((await f.business.LoadViewModel()).conversations).toEqual([]);
      await expect(host.Send({ sessionId: 'real', requestId: 'late-run', content: '继续' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
      // RemoveSession 在不存在目录时也必须幂等，不能阻断重启补清理。
      await archives.RemoveSession('real');
    } finally { await retention.Close(); await host.Close(); await f.service.Close(); await f.business.Close(); f.business.close(); }
  });
});
