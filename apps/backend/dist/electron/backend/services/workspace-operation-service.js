"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.ActiveStates = exports.KnownTypes = exports.WorkspaceOperationService = void 0;
const node_crypto_1 = require("node:crypto");
const node_fs_1 = require("node:fs");
const path = __importStar(require("node:path"));
const helpers_1 = require("../../repositories/helpers");
const KnownTypes = new Set(['import_attachment', 'save_profiles', 'create_backup', 'copy_workspace']);
exports.KnownTypes = KnownTypes;
const ActiveStates = new Set(['prepared', 'file_written', 'db_committed', 'rollback_required']);
exports.ActiveStates = ActiveStates;
/** 持久化本地 Saga 状态并在启动时串行恢复；未知类型/高版本操作会阻止写入而非猜测处理。 */
class WorkspaceOperationService {
    db;
    workspacePath;
    recovering = false;
    blocked = false;
    lastRecovery = { recovered: 0, failed: 0, blocked: 0 };
    constructor({ db, workspacePath }) {
        this.db = db;
        this.workspacePath = path.resolve(workspacePath);
    }
    Begin(operationType, payload) {
        if (!KnownTypes.has(operationType))
            throw new Error('Workspace operation type is invalid.');
        const serialized = JSON.stringify(payload ?? {});
        if (serialized.length > 100000)
            throw new Error('Workspace operation payload is too large.');
        const id = (0, helpers_1.CreateId)();
        const now = (0, helpers_1.GetNow)();
        this.db.prepare(`INSERT INTO workspace_operations(id, operation_type, operation_version, state, payload_json, created_at, updated_at)
      VALUES(?, ?, 1, 'prepared', ?, ?, ?)`).run(id, operationType, serialized, now, now);
        return id;
    }
    Advance(id, state) {
        if (!['file_written', 'db_committed', 'completed'].includes(state))
            throw new Error('Workspace operation state is invalid.');
        const now = (0, helpers_1.GetNow)();
        this.db.prepare('UPDATE workspace_operations SET state = ?, error_code = NULL, updated_at = ?, completed_at = ? WHERE id = ?')
            .run(state, now, state === 'completed' ? now : null, id);
    }
    RequireWritable() {
        if (this.recovering || this.blocked)
            throw Object.assign(new Error('Workspace recovery is not complete.'), { code: 'WORKSPACE_BUSY' });
    }
    MarkRollback(id, code = 'OPERATION_FAILED') {
        this.db.prepare("UPDATE workspace_operations SET state = 'rollback_required', error_code = ?, updated_at = ? WHERE id = ? AND state != 'completed'")
            .run(String(code).slice(0, 100), (0, helpers_1.GetNow)(), id);
    }
    MarkFailed(id, code) {
        this.db.prepare("UPDATE workspace_operations SET state = 'failed', error_code = ?, updated_at = ?, completed_at = ? WHERE id = ?")
            .run(String(code).slice(0, 100), (0, helpers_1.GetNow)(), (0, helpers_1.GetNow)(), id);
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
        const stat = (0, node_fs_1.lstatSync)(filePath, { throwIfNoEntry: false });
        if (!stat || !stat.isFile() || stat.isSymbolicLink())
            return false;
        const actual = (0, node_crypto_1.createHash)('sha256').update((0, node_fs_1.readFileSync)(filePath)).digest('hex');
        return actual === expected;
    }
    RemoveDirectorySafely(target, expectedParent) {
        const stat = (0, node_fs_1.lstatSync)(target, { throwIfNoEntry: false });
        if (!stat)
            return;
        if (!stat.isDirectory() || stat.isSymbolicLink())
            throw new Error('Workspace operation cleanup target is unsafe.');
        const parentReal = (0, node_fs_1.realpathSync)(expectedParent);
        const targetReal = (0, node_fs_1.realpathSync)(target);
        if (path.dirname(targetReal) !== parentReal)
            throw new Error('Workspace operation cleanup target escapes its parent.');
        (0, node_fs_1.rmSync)(target, { recursive: true, force: true });
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
                (0, helpers_1.WriteAudit)(this.db, 'system', 'recover', 'workspace_operation', null, summary);
            return { ...summary, writable: !this.blocked };
        }
        finally {
            this.recovering = false;
        }
    }
    RecoverOne(row, { synchronizeProfiles } = {}) {
        const payload = this.Parse(row);
        if (row.state === 'prepared') {
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
                if (!(0, node_fs_1.existsSync)(profilePath)) {
                    this.MarkFailed(row.id, 'INTERRUPTED_BEFORE_FILE_WRITE');
                    return;
                }
                row.state = 'file_written';
            }
            else if (row.operation_type === 'create_backup') {
                const directory = this.ResolveWorkspaceRelative(path.join('backups', payload.directoryName));
                if ((0, node_fs_1.existsSync)(path.join(directory, 'manifest.json')) && (0, node_fs_1.existsSync)(path.join(directory, 'offerget.db')))
                    row.state = 'file_written';
                else {
                    if ((0, node_fs_1.existsSync)(directory))
                        this.RemoveDirectorySafely(directory, path.join(this.workspacePath, 'backups'));
                    this.MarkFailed(row.id, 'INTERRUPTED_BEFORE_FILE_WRITE');
                    return;
                }
            }
            else if (row.operation_type === 'copy_workspace') {
                const target = path.resolve(payload.destinationPath);
                if ((0, node_fs_1.existsSync)(path.join(target, 'migration-manifest.json')) && (0, node_fs_1.existsSync)(path.join(target, 'offerget.db')))
                    row.state = 'file_written';
                else {
                    const temporary = `${target}.offerget-migration-${row.id}`;
                    if ((0, node_fs_1.existsSync)(temporary))
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
            const parsed = JSON.parse((0, node_fs_1.readFileSync)(profilePath, 'utf8'));
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
            if (!(0, node_fs_1.existsSync)(manifest))
                throw new Error('Recovered backup manifest is unavailable.');
            const Database = require('better-sqlite3');
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
            if (!(0, node_fs_1.existsSync)(manifest))
                throw new Error('Recovered workspace copy is incomplete.');
            const Database = require('better-sqlite3');
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
exports.WorkspaceOperationService = WorkspaceOperationService;
