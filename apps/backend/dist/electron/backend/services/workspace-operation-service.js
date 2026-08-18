"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
// @ts-nocheck
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const { GetNow, CreateId, WriteAudit } = require('../../repositories/helpers.js');
const KnownTypes = new Set(['import_attachment', 'save_profiles', 'create_backup', 'copy_workspace']);
const ActiveStates = new Set(['prepared', 'file_written', 'db_committed', 'rollback_required']);
/** 持久化本地 Saga 状态并在启动时串行恢复；未知类型/高版本操作会阻止写入而非猜测处理。 */
class WorkspaceOperationService {
    constructor({ db, workspacePath }) {
        this.db = db;
        this.workspacePath = path.resolve(workspacePath);
        this.recovering = false;
        this.blocked = false;
        this.lastRecovery = { recovered: 0, failed: 0, blocked: 0 };
    }
    Begin(operationType, payload) {
        if (!KnownTypes.has(operationType))
            throw new Error('Workspace operation type is invalid.');
        const serialized = JSON.stringify(payload ?? {});
        if (serialized.length > 100000)
            throw new Error('Workspace operation payload is too large.');
        const id = CreateId();
        const now = GetNow();
        this.db.prepare(`INSERT INTO workspace_operations(id, operation_type, operation_version, state, payload_json, created_at, updated_at)
      VALUES(?, ?, 1, 'prepared', ?, ?, ?)`).run(id, operationType, serialized, now, now);
        return id;
    }
    Advance(id, state) {
        if (!['file_written', 'db_committed', 'completed'].includes(state))
            throw new Error('Workspace operation state is invalid.');
        const now = GetNow();
        this.db.prepare('UPDATE workspace_operations SET state = ?, error_code = NULL, updated_at = ?, completed_at = ? WHERE id = ?')
            .run(state, now, state === 'completed' ? now : null, id);
    }
    RequireWritable() {
        if (this.recovering || this.blocked)
            throw Object.assign(new Error('Workspace recovery is not complete.'), { code: 'WORKSPACE_BUSY' });
    }
    MarkRollback(id, code = 'OPERATION_FAILED') {
        this.db.prepare("UPDATE workspace_operations SET state = 'rollback_required', error_code = ?, updated_at = ? WHERE id = ? AND state != 'completed'")
            .run(String(code).slice(0, 100), GetNow(), id);
    }
    MarkFailed(id, code) {
        this.db.prepare("UPDATE workspace_operations SET state = 'failed', error_code = ?, updated_at = ?, completed_at = ? WHERE id = ?")
            .run(String(code).slice(0, 100), GetNow(), GetNow(), id);
    }
    Parse(row) {
        try {
            return JSON.parse(row.payload_json);
        }
        catch {
            throw new Error('Workspace operation payload is invalid.');
        }
    }
    ResolveWorkspaceRelative(relativePath) {
        if (typeof relativePath !== 'string' || !relativePath || path.isAbsolute(relativePath))
            throw new Error('Workspace operation path is invalid.');
        const target = path.resolve(this.workspacePath, relativePath);
        const relative = path.relative(this.workspacePath, target);
        if (!relative || relative.startsWith('..') || path.isAbsolute(relative))
            throw new Error('Workspace operation path escapes workspace.');
        return target;
    }
    VerifyFileHash(filePath, expected) {
        const stat = fs.lstatSync(filePath, { throwIfNoEntry: false });
        if (!stat || !stat.isFile() || stat.isSymbolicLink())
            return false;
        const actual = crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
        return actual === expected;
    }
    RemoveDirectorySafely(target, expectedParent) {
        const stat = fs.lstatSync(target, { throwIfNoEntry: false });
        if (!stat)
            return;
        if (!stat.isDirectory() || stat.isSymbolicLink())
            throw new Error('Workspace operation cleanup target is unsafe.');
        const parentReal = fs.realpathSync(expectedParent);
        const targetReal = fs.realpathSync(target);
        if (path.dirname(targetReal) !== parentReal)
            throw new Error('Workspace operation cleanup target escapes its parent.');
        fs.rmSync(target, { recursive: true, force: true });
    }
    Recover({ synchronizeProfiles } = {}) {
        this.recovering = true;
        this.blocked = false;
        const summary = { recovered: 0, failed: 0, blocked: 0 };
        try {
            const rows = this.db.prepare("SELECT * FROM workspace_operations WHERE state NOT IN ('completed','failed') ORDER BY created_at, id").all();
            for (const row of rows) {
                if (!KnownTypes.has(row.operation_type) || row.operation_version !== 1) {
                    summary.blocked += 1;
                    this.blocked = true;
                    continue;
                }
                try {
                    this.RecoverOne(row, { synchronizeProfiles });
                    summary.recovered += 1;
                }
                catch {
                    this.MarkFailed(row.id, 'RECOVERY_FAILED');
                    summary.failed += 1;
                }
            }
            this.lastRecovery = summary;
            if (rows.length)
                WriteAudit(this.db, 'system', 'recover', 'workspace_operation', null, summary);
            return { ...summary, writable: !this.blocked };
        }
        finally {
            this.recovering = false;
        }
    }
    RecoverOne(row, { synchronizeProfiles } = {}) {
        const payload = this.Parse(row);
        if (row.state === 'prepared') {
            // 写文件与推进状态之间也可能崩溃：先检查确定性落盘结果，存在则前滚，不存在才补偿。
            if (row.operation_type === 'import_attachment') {
                const filePath = this.ResolveWorkspaceRelative(payload.storageKey);
                if (this.VerifyFileHash(filePath, payload.sha256))
                    row.state = 'file_written';
                else {
                    this.MarkFailed(row.id, 'INTERRUPTED_BEFORE_FILE_WRITE');
                    return;
                }
            }
            else if (row.operation_type === 'save_profiles') {
                const profilePath = this.ResolveWorkspaceRelative('profile.json');
                if (!fs.existsSync(profilePath)) {
                    this.MarkFailed(row.id, 'INTERRUPTED_BEFORE_FILE_WRITE');
                    return;
                }
                row.state = 'file_written';
            }
            else if (row.operation_type === 'create_backup') {
                const directory = this.ResolveWorkspaceRelative(path.join('backups', payload.directoryName));
                if (fs.existsSync(path.join(directory, 'manifest.json')) && fs.existsSync(path.join(directory, 'offerget.db')))
                    row.state = 'file_written';
                else {
                    if (fs.existsSync(directory))
                        this.RemoveDirectorySafely(directory, path.join(this.workspacePath, 'backups'));
                    this.MarkFailed(row.id, 'INTERRUPTED_BEFORE_FILE_WRITE');
                    return;
                }
            }
            else if (row.operation_type === 'copy_workspace') {
                const target = path.resolve(payload.destinationPath);
                if (fs.existsSync(path.join(target, 'migration-manifest.json')) && fs.existsSync(path.join(target, 'offerget.db')))
                    row.state = 'file_written';
                else {
                    const temporary = `${target}.offerget-migration-${row.id}`;
                    if (fs.existsSync(temporary))
                        this.RemoveDirectorySafely(temporary, path.dirname(target));
                    this.MarkFailed(row.id, 'INTERRUPTED_BEFORE_FILE_WRITE');
                    return;
                }
            }
        }
        if (row.operation_type === 'import_attachment') {
            const filePath = this.ResolveWorkspaceRelative(payload.storageKey);
            if (!this.VerifyFileHash(filePath, payload.sha256))
                throw new Error('Recovered attachment file is unavailable.');
            this.db.prepare(`INSERT INTO attachments(id, sha256, original_name, mime_type, byte_size, storage_key, created_at, orphaned_at)
        VALUES(?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(sha256) DO UPDATE SET deleted_at = NULL, cleanup_error = NULL`)
                .run(payload.attachmentId, payload.sha256, payload.originalName, payload.mimeType, payload.byteSize, payload.storageKey, payload.createdAt, payload.createdAt);
            this.Advance(row.id, 'db_committed');
            this.Advance(row.id, 'completed');
            return;
        }
        if (row.operation_type === 'save_profiles') {
            const profilePath = this.ResolveWorkspaceRelative('profile.json');
            const parsed = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
            if (!Array.isArray(parsed.items))
                throw new Error('Recovered profile is invalid.');
            if (typeof synchronizeProfiles === 'function')
                synchronizeProfiles(parsed.items);
            this.Advance(row.id, 'db_committed');
            this.Advance(row.id, 'completed');
            return;
        }
        if (row.operation_type === 'create_backup') {
            const directory = this.ResolveWorkspaceRelative(path.join('backups', payload.directoryName));
            const backupDb = path.join(directory, 'offerget.db');
            const manifest = path.join(directory, 'manifest.json');
            if (!fs.existsSync(manifest))
                throw new Error('Recovered backup manifest is unavailable.');
            const verification = new Database(backupDb, { readonly: true });
            const integrity = verification.pragma('integrity_check', { simple: true });
            verification.close();
            if (integrity !== 'ok')
                throw new Error('Recovered backup is invalid.');
            this.Advance(row.id, 'completed');
            return;
        }
        if (row.operation_type === 'copy_workspace') {
            const target = path.resolve(payload.destinationPath);
            const manifest = path.join(target, 'migration-manifest.json');
            if (!fs.existsSync(manifest))
                throw new Error('Recovered workspace copy is incomplete.');
            const verification = new Database(path.join(target, 'offerget.db'), { readonly: true });
            const integrity = verification.pragma('integrity_check', { simple: true });
            verification.close();
            if (integrity !== 'ok')
                throw new Error('Recovered workspace copy is invalid.');
            this.Advance(row.id, 'completed');
        }
    }
    GetStatus() {
        return { recovering: this.recovering, blocked: this.blocked, recovered: this.lastRecovery.recovered, failed: this.lastRecovery.failed, blockedCount: this.lastRecovery.blocked };
    }
}
module.exports = { WorkspaceOperationService, KnownTypes, ActiveStates };
