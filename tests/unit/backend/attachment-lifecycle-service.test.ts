import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AttachmentLifecycleService, ExtractAttachmentIds, ThirtyDaysMs } from '../../../apps/backend/src/electron/backend/services/attachment-lifecycle-service';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const hash = 'a'.repeat(64);
const workspaces: string[] = [];

function createService(): { db: any; service: AttachmentLifecycleService; workspace: string } {
  const workspace = mkdtempSync(join(tmpdir(), 'offerget-attachment-'));
  workspaces.push(workspace);
  mkdirSync(join(workspace, 'attachments'));
  writeFileSync(join(workspace, 'attachments', hash), 'attachment');
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE attachments (id TEXT PRIMARY KEY, sha256 TEXT, original_name TEXT, mime_type TEXT, byte_size INTEGER, storage_key TEXT, created_at INTEGER, orphaned_at INTEGER, deleted_at INTEGER, cleanup_attempted_at INTEGER, cleanup_error TEXT);
    CREATE TABLE attachment_links (attachment_id TEXT, owner_type TEXT, owner_id TEXT, created_at INTEGER);
    CREATE TABLE audit_events (id TEXT, actor_type TEXT, action TEXT, entity_type TEXT, entity_id TEXT, metadata_json TEXT, created_at INTEGER);
  `);
  db.prepare('INSERT INTO attachments(id, sha256, original_name, mime_type, byte_size, storage_key, created_at) VALUES(?, ?, ?, ?, ?, ?, ?)')
    .run('attachment-1', hash, 'test.txt', 'text/plain', 10, `attachments/${hash}`, Date.now());
  return { db, service: new AttachmentLifecycleService({ db, workspacePath: workspace }), workspace };
}

afterEach(() => {
  vi.useRealTimers();
  for (const workspace of workspaces.splice(0)) rmSync(workspace, { recursive: true, force: true });
});

describe('AttachmentLifecycleService', () => {
  it('从嵌套内容去重提取附件引用', () => {
    expect(ExtractAttachmentIds({ a: 'attachment://one/a', b: ['attachment://one/b', 'attachment://two/c'] })).toEqual(['one', 'two']);
  });

  it('最后一个引用移除后保护满 30 天才清理', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    const { db, service, workspace } = createService();

    service.ReplaceLinks('conversation', 'conversation-1', { body: 'attachment://attachment-1/test.txt' });
    expect(db.prepare('SELECT COUNT(*) AS count FROM attachment_links WHERE attachment_id = ?').get('attachment-1').count).toBe(1);
    service.RemoveLinks('conversation', 'conversation-1');
    const orphanedAt = db.prepare('SELECT orphaned_at FROM attachments WHERE id = ?').get('attachment-1').orphaned_at;

    const protectedResult = service.Cleanup({ now: orphanedAt + ThirtyDaysMs - 1 });
    expect(protectedResult.scanned).toBe(0);
    expect(() => require('node:fs').statSync(join(workspace, 'attachments', hash))).not.toThrow();

    const cleaned = service.Cleanup({ now: orphanedAt + ThirtyDaysMs });
    expect(cleaned).toMatchObject({ scanned: 1, logicallyDeleted: 1, filesDeleted: 1, failed: 0 });
    expect(db.prepare('SELECT deleted_at FROM attachments WHERE id = ?').get('attachment-1').deleted_at).toBe(orphanedAt + ThirtyDaysMs);
  });
});
