import { existsSync, lstatSync, readdirSync, realpathSync, unlinkSync } from 'node:fs';
import * as path from 'node:path';
import { GetNow, WriteAudit } from '../../repositories/helpers';

/** 无引用附件默认保留 30 天，符合产品数据保护约束。 */
export const ThirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
const OwnerTypes = new Set(['conversation', 'message', 'profile', 'resume']);

export function ExtractAttachmentIds(value: unknown): string[] {
  const ids = new Set<string>();
  const visit = (current: unknown, depth = 0): void => {
    if (depth > 20 || current == null) return;
    if (typeof current === 'string') {
      for (const match of current.matchAll(/attachment:\/\/([^/\s"'<>]+)/g)) ids.add(match[1]);
      return;
    }
    if (Array.isArray(current)) {
      for (const item of current) visit(item, depth + 1);
      return;
    }
    if (typeof current === 'object') {
      for (const item of Object.values(current as Record<string, unknown>)) visit(item, depth + 1);
    }
  };
  visit(value);
  return [...ids];
}

/** attachment_links 是唯一引用事实源；最后引用移除后开始 30 天宽限，清理只触碰工作空间副本与派生缓存。 */
export class AttachmentLifecycleService {
  private db: any;
  private workspacePath: string;

  constructor({ db, workspacePath }: { db: any; workspacePath: string }) {
    this.db = db;
    this.workspacePath = path.resolve(workspacePath);
  }

  ReplaceLinks(ownerType: string, ownerId: string, value: unknown): string[] {
    if (!OwnerTypes.has(ownerType)) throw new Error('Attachment owner type is invalid.');
    if (typeof ownerId !== 'string' || ownerId.length === 0 || ownerId.length > 200) throw new Error('Attachment owner id is invalid.');
    const ids = ExtractAttachmentIds(value);
    const run = this.db.transaction(() => {
      const previous = this.db.prepare('SELECT attachment_id FROM attachment_links WHERE owner_type = ? AND owner_id = ?').all(ownerType, ownerId).map((row: any) => row.attachment_id);
      if (ids.length) {
        const placeholders = ids.map(() => '?').join(',');
        const rows = this.db.prepare(`SELECT id FROM attachments WHERE id IN (${placeholders}) AND deleted_at IS NULL`).all(...ids);
        if (rows.length !== ids.length) throw new Error('An attachment reference is unavailable.');
      }
      this.db.prepare('DELETE FROM attachment_links WHERE owner_type = ? AND owner_id = ?').run(ownerType, ownerId);
      const insert = this.db.prepare('INSERT INTO attachment_links(attachment_id, owner_type, owner_id, created_at) VALUES(?, ?, ?, ?)');
      const now = GetNow();
      for (const id of ids) {
        insert.run(id, ownerType, ownerId, now);
        this.db.prepare('UPDATE attachments SET orphaned_at = NULL, cleanup_error = NULL WHERE id = ?').run(id);
      }
      for (const id of previous) this.MarkOrphanIfUnreferenced(id, now);
    });
    run();
    return ids;
  }

  RemoveLinks(ownerType: string, ownerId: string): string[] {
    return this.ReplaceLinks(ownerType, ownerId, null);
  }

  RemoveConversationLinks(conversationId: string): void {
    const messageIds = this.db.prepare('SELECT id FROM conversation_messages WHERE conversation_id = ?').all(conversationId).map((row: any) => row.id);
    const run = this.db.transaction(() => {
      this.RemoveLinks('conversation', conversationId);
      for (const id of messageIds) this.RemoveLinks('message', id);
    });
    run();
  }

  MarkOrphanIfUnreferenced(attachmentId: string, now: number = GetNow()): void {
    const referenced = this.db.prepare('SELECT 1 FROM attachment_links WHERE attachment_id = ? LIMIT 1').get(attachmentId);
    if (!referenced) this.db.prepare('UPDATE attachments SET orphaned_at = COALESCE(orphaned_at, ?) WHERE id = ? AND deleted_at IS NULL').run(now, attachmentId);
  }

  SafeWorkspaceFile(rootName: string, fileName: string): string {
    if (!/^[a-f0-9]{64}(?:-[A-Za-z0-9._-]+)?$/.test(fileName)) throw new Error('Unsafe attachment storage key.');
    const root = path.resolve(this.workspacePath, rootName);
    const rootStat = lstatSync(root, { throwIfNoEntry: false });
    if (!rootStat || !rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('Attachment cleanup root is unsafe.');
    const workspaceReal = realpathSync(this.workspacePath);
    const rootReal = realpathSync(root);
    const rootRelative = path.relative(workspaceReal, rootReal);
    if (!rootRelative || rootRelative.startsWith('..') || path.isAbsolute(rootRelative)) throw new Error('Attachment cleanup root escapes workspace.');
    const target = path.resolve(root, fileName);
    const relative = path.relative(root, target);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Attachment cleanup target escapes workspace.');
    return target;
  }

  RemoveRegularFile(target: string): boolean {
    const stat = lstatSync(target, { throwIfNoEntry: false });
    if (!stat) return false;
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Attachment cleanup target is not a regular file.');
    unlinkSync(target);
    return true;
  }

  Cleanup({ now = GetNow(), limit = 50 }: { now?: number; limit?: number } = {}): any {
    if (!Number.isFinite(now)) throw new Error('Attachment cleanup time is invalid.');
    const safeLimit = Math.max(1, Math.min(500, Math.trunc(limit)));
    const cutoff = now - ThirtyDaysMs;
    const candidates = this.db.prepare(`SELECT id, sha256, storage_key, deleted_at FROM attachments
      WHERE NOT EXISTS (SELECT 1 FROM attachment_links WHERE attachment_id = attachments.id)
        AND ((deleted_at IS NULL AND orphaned_at IS NOT NULL AND orphaned_at <= ?) OR deleted_at IS NOT NULL)
      ORDER BY COALESCE(deleted_at, orphaned_at), id LIMIT ?`).all(cutoff, safeLimit);
    const result = { scanned: candidates.length, logicallyDeleted: 0, filesDeleted: 0, cacheFilesDeleted: 0, failed: 0, pending: 0 };
    for (const item of candidates) {
      try {
        if (item.deleted_at == null) {
          this.db.prepare('UPDATE attachments SET deleted_at = ?, cleanup_attempted_at = ?, cleanup_error = NULL WHERE id = ? AND deleted_at IS NULL').run(now, now, item.id);
          result.logicallyDeleted += 1;
        } else {
          this.db.prepare('UPDATE attachments SET cleanup_attempted_at = ? WHERE id = ?').run(now, item.id);
        }
        const expectedStorage = `attachments/${item.sha256}`;
        if (String(item.storage_key).replace(/\\/g, '/') !== expectedStorage) throw new Error('Attachment storage key does not match content address.');
        if (this.RemoveRegularFile(this.SafeWorkspaceFile('attachments', item.sha256))) result.filesDeleted += 1;
        const cacheRoot = path.join(this.workspacePath, 'derived', 'ocr');
        if (existsSync(cacheRoot)) {
          const rootStat = lstatSync(cacheRoot);
          if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('OCR cache root is unsafe.');
          for (const entry of readdirSync(cacheRoot)) {
            if (!entry.startsWith(`${item.sha256}-`)) continue;
            if (this.RemoveRegularFile(this.SafeWorkspaceFile(path.join('derived', 'ocr'), entry))) result.cacheFilesDeleted += 1;
          }
        }
        this.db.prepare('UPDATE attachments SET cleanup_error = NULL WHERE id = ?').run(item.id);
      } catch (error) {
        result.failed += 1;
        this.db.prepare('UPDATE attachments SET cleanup_error = ? WHERE id = ?').run(String((error as Error)?.message || 'cleanup failed').slice(0, 300), item.id);
      }
    }
    result.pending = this.db.prepare(`SELECT COUNT(*) AS count FROM attachments WHERE deleted_at IS NOT NULL AND cleanup_error IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM attachment_links WHERE attachment_id = attachments.id)`).get().count;
    if (candidates.length) WriteAudit(this.db, 'system', 'cleanup', 'attachment', null, result);
    return result;
  }
}
