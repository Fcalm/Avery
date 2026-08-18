"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
// @ts-nocheck
const fs = require('node:fs');
const path = require('node:path');
const { GetNow, WriteAudit } = require('../../repositories/helpers.js');
const SevenDaysMs = 7 * 24 * 60 * 60 * 1000;
const OwnerTypes = new Set(['conversation', 'message', 'profile', 'resume']);
function ExtractAttachmentIds(value) {
    const ids = new Set();
    const visit = (current, depth = 0) => {
        if (depth > 20 || current == null)
            return;
        if (typeof current === 'string') {
            for (const match of current.matchAll(/attachment:\/\/([^/\s"'<>]+)/g))
                ids.add(match[1]);
            return;
        }
        if (Array.isArray(current)) {
            for (const item of current)
                visit(item, depth + 1);
            return;
        }
        if (typeof current === 'object')
            for (const item of Object.values(current))
                visit(item, depth + 1);
    };
    visit(value);
    return [...ids];
}
/** attachment_links 是唯一引用事实源；最后引用移除后开始 7 天宽限，清理只触碰工作空间副本与派生缓存。 */
class AttachmentLifecycleService {
    constructor({ db, workspacePath }) {
        this.db = db;
        this.workspacePath = path.resolve(workspacePath);
    }
    ReplaceLinks(ownerType, ownerId, value) {
        if (!OwnerTypes.has(ownerType))
            throw new Error('Attachment owner type is invalid.');
        if (typeof ownerId !== 'string' || ownerId.length === 0 || ownerId.length > 200)
            throw new Error('Attachment owner id is invalid.');
        const ids = ExtractAttachmentIds(value);
        const run = this.db.transaction(() => {
            const previous = this.db.prepare('SELECT attachment_id FROM attachment_links WHERE owner_type = ? AND owner_id = ?').all(ownerType, ownerId).map((row) => row.attachment_id);
            if (ids.length) {
                const placeholders = ids.map(() => '?').join(',');
                const rows = this.db.prepare(`SELECT id FROM attachments WHERE id IN (${placeholders}) AND deleted_at IS NULL`).all(...ids);
                if (rows.length !== ids.length)
                    throw new Error('An attachment reference is unavailable.');
            }
            this.db.prepare('DELETE FROM attachment_links WHERE owner_type = ? AND owner_id = ?').run(ownerType, ownerId);
            const insert = this.db.prepare('INSERT INTO attachment_links(attachment_id, owner_type, owner_id, created_at) VALUES(?, ?, ?, ?)');
            const now = GetNow();
            for (const id of ids) {
                insert.run(id, ownerType, ownerId, now);
                this.db.prepare('UPDATE attachments SET orphaned_at = NULL, cleanup_error = NULL WHERE id = ?').run(id);
            }
            for (const id of previous)
                this.MarkOrphanIfUnreferenced(id, now);
        });
        run();
        return ids;
    }
    RemoveLinks(ownerType, ownerId) { return this.ReplaceLinks(ownerType, ownerId, null); }
    RemoveConversationLinks(conversationId) {
        const messageIds = this.db.prepare('SELECT id FROM conversation_messages WHERE conversation_id = ?').all(conversationId).map((row) => row.id);
        const run = this.db.transaction(() => {
            this.RemoveLinks('conversation', conversationId);
            for (const id of messageIds)
                this.RemoveLinks('message', id);
        });
        run();
    }
    MarkOrphanIfUnreferenced(attachmentId, now = GetNow()) {
        const referenced = this.db.prepare('SELECT 1 FROM attachment_links WHERE attachment_id = ? LIMIT 1').get(attachmentId);
        if (!referenced)
            this.db.prepare('UPDATE attachments SET orphaned_at = COALESCE(orphaned_at, ?) WHERE id = ? AND deleted_at IS NULL').run(now, attachmentId);
    }
    SafeWorkspaceFile(rootName, fileName) {
        if (!/^[a-f0-9]{64}(?:-[A-Za-z0-9._-]+)?$/.test(fileName))
            throw new Error('Unsafe attachment storage key.');
        const root = path.resolve(this.workspacePath, rootName);
        const rootStat = fs.lstatSync(root, { throwIfNoEntry: false });
        if (!rootStat || !rootStat.isDirectory() || rootStat.isSymbolicLink())
            throw new Error('Attachment cleanup root is unsafe.');
        const workspaceReal = fs.realpathSync(this.workspacePath);
        const rootReal = fs.realpathSync(root);
        const rootRelative = path.relative(workspaceReal, rootReal);
        if (!rootRelative || rootRelative.startsWith('..') || path.isAbsolute(rootRelative))
            throw new Error('Attachment cleanup root escapes workspace.');
        const target = path.resolve(root, fileName);
        const relative = path.relative(root, target);
        if (!relative || relative.startsWith('..') || path.isAbsolute(relative))
            throw new Error('Attachment cleanup target escapes workspace.');
        return target;
    }
    RemoveRegularFile(target) {
        const stat = fs.lstatSync(target, { throwIfNoEntry: false });
        if (!stat)
            return false;
        if (!stat.isFile() || stat.isSymbolicLink())
            throw new Error('Attachment cleanup target is not a regular file.');
        fs.unlinkSync(target);
        return true;
    }
    Cleanup({ now = GetNow(), limit = 50 } = {}) {
        if (!Number.isFinite(now))
            throw new Error('Attachment cleanup time is invalid.');
        const safeLimit = Math.max(1, Math.min(500, Math.trunc(limit)));
        const cutoff = now - SevenDaysMs;
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
                }
                else
                    this.db.prepare('UPDATE attachments SET cleanup_attempted_at = ? WHERE id = ?').run(now, item.id);
                const expectedStorage = `attachments/${item.sha256}`;
                if (String(item.storage_key).replace(/\\/g, '/') !== expectedStorage)
                    throw new Error('Attachment storage key does not match content address.');
                if (this.RemoveRegularFile(this.SafeWorkspaceFile('attachments', item.sha256)))
                    result.filesDeleted += 1;
                const cacheRoot = path.join(this.workspacePath, 'derived', 'ocr');
                if (fs.existsSync(cacheRoot)) {
                    const rootStat = fs.lstatSync(cacheRoot);
                    if (!rootStat.isDirectory() || rootStat.isSymbolicLink())
                        throw new Error('OCR cache root is unsafe.');
                    for (const entry of fs.readdirSync(cacheRoot)) {
                        if (!entry.startsWith(`${item.sha256}-`))
                            continue;
                        if (this.RemoveRegularFile(this.SafeWorkspaceFile(path.join('derived', 'ocr'), entry)))
                            result.cacheFilesDeleted += 1;
                    }
                }
                this.db.prepare('UPDATE attachments SET cleanup_error = NULL WHERE id = ?').run(item.id);
            }
            catch (error) {
                result.failed += 1;
                this.db.prepare('UPDATE attachments SET cleanup_error = ? WHERE id = ?').run(String(error?.message || 'cleanup failed').slice(0, 300), item.id);
            }
        }
        result.pending = this.db.prepare(`SELECT COUNT(*) AS count FROM attachments WHERE deleted_at IS NOT NULL AND cleanup_error IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM attachment_links WHERE attachment_id = attachments.id)`).get().count;
        if (candidates.length)
            WriteAudit(this.db, 'system', 'cleanup', 'attachment', null, result);
        return result;
    }
}
module.exports = { AttachmentLifecycleService, ExtractAttachmentIds, SevenDaysMs };
