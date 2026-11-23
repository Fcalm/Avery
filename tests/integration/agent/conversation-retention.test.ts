import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
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

async function CreateFixtureRoot() {
  const parent = process.env.AVERY_TEST_ARTIFACT_DIR ?? tmpdir();
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, 'archive-retention-')); roots.push(root);
  return root;
}

async function Fixture() {
  const root = await CreateFixtureRoot();
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
    const workspacePath = join(await CreateFixtureRoot(), 'workspace');
    await mkdir(workspacePath);
    const migrationRoot = resolve('migrations', 'business');
    const { migrations } = JSON.parse(await readFile(join(migrationRoot, 'manifest.json'), 'utf8')) as {
      migrations: Array<{ version: number; kind: 'sql' | 'js'; file: string; checksumSeed: string }>;
    };
    const v18Migrations = migrations.filter(entry => entry.version <= 18);
    const targetVersion = Math.max(...migrations.map(entry => entry.version));
    const message = { id: 'old-message', role: 'user', content: '应保留的正文' };
    const Database = require('better-sqlite3');
    const oldDb = new Database(join(workspacePath, 'avery.db'));
    try {
      oldDb.pragma('foreign_keys = ON');
      // 从空库正向应用历史迁移，保留 v18 当时的表结构和校验记录。
      for (const entry of v18Migrations) {
        const file = join(migrationRoot, entry.file);
        if (entry.kind === 'sql') oldDb.exec(await readFile(file, 'utf8'));
        else require(file).up(oldDb);
        oldDb.prepare('INSERT INTO schema_migrations(version, checksum, applied_at) VALUES (?, ?, ?)')
          .run(entry.version, createHash('sha256').update(entry.checksumSeed).digest('hex'), 1);
      }
      oldDb.exec(`
        INSERT INTO workspace_meta(id, workspace_id, created_at, updated_at, last_opened_at, app_version, schema_version)
        VALUES ('workspace', 'legacy-workspace', 1, 1, 1, '0.2.5', 18);
        INSERT INTO conversations(id, title, archived, created_at, updated_at, last_used_at)
        VALUES ('old', '升级前归档', 1, 1, 1, 1);
      `);
      oldDb.prepare('INSERT INTO conversation_messages(id, conversation_id, role, content, created_at, updated_at) VALUES (?, ?, ?, ?, 1, 1)')
        .run(message.id, 'old', message.role, message.content);
    } finally { oldDb.close(); }

    const business = CreateBusinessStoreClient({ workspacePath, smoke: true });
    try {
      await business.ready;
      expect(await business.GetDatabaseRecoveryStatus()).toMatchObject({ mode: 'healthy' });
      expect(await business.Query("SELECT schema_version FROM workspace_meta WHERE id = 'workspace'"))
        .toEqual([{ schema_version: targetVersion }]);
      const { conversations } = await business.LoadViewModel();
      expect(conversations.find((row: { id: string }) => row.id === 'old'))
        .toMatchObject({ id: 'old', title: '升级前归档', archived: true, archivedAt: null, autoDeleteAt: null, messages: [message] });
      expect(await business.ListExpiredConversations(Date.now() + 100 * 86_400_000)).toEqual([]);

      const backupsPath = join(workspacePath, 'backups');
      const backups = await readdir(backupsPath);
      expect(backups).toEqual([expect.stringContaining(`daily-pre-upgrade-v18-to-v${targetVersion}-`)]);
      const backupPath = join(backupsPath, backups[0]);
      const databasePath = join(backupPath, 'avery.db');
      const checksum = createHash('sha256').update(await readFile(databasePath)).digest('hex');
      expect(JSON.parse(await readFile(join(backupPath, 'manifest.json'), 'utf8'))).toMatchObject({
        type: 'pre_upgrade', fromSchemaVersion: 18, toSchemaVersion: targetVersion, database: { file: 'avery.db', sha256: checksum },
      });
      const backupDb = new Database(databasePath, { readonly: true, fileMustExist: true });
      try {
        expect(backupDb.pragma('integrity_check', { simple: true })).toBe('ok');
        expect(backupDb.prepare('SELECT schema_version FROM workspace_meta').get()).toEqual({ schema_version: 18 });
        expect(backupDb.prepare('SELECT version FROM schema_migrations ORDER BY version').all())
          .toEqual(v18Migrations.map(({ version }) => ({ version })));
        expect(backupDb.prepare('SELECT archived FROM conversations WHERE id = ?').get('old')).toEqual({ archived: 1 });
        expect(backupDb.prepare('SELECT id, role, content FROM conversation_messages WHERE conversation_id = ?').all('old'))
          .toEqual([message]);
      } finally { backupDb.close(); }
    } finally {
      try { await business.Close(); } finally { business.close(); }
    }
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
