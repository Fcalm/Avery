import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import * as path from 'node:path';
import { GetNow, CreateId, WriteAudit } from '../../repositories/helpers';

const KnownTypes = new Set(['import_attachment', 'save_profiles', 'create_backup', 'copy_workspace']);
const ActiveStates = new Set(['prepared', 'file_written', 'db_committed', 'rollback_required']);

/** 持久化本地 Saga 状态并在启动时串行恢复；未知类型/高版本操作会阻止写入而非猜测处理。 */
export class WorkspaceOperationService {
  private db: any;
  private workspacePath: string;
  private recovering = false;
  private blocked = false;
  private lastRecovery = { recovered: 0, failed: 0, blocked: 0 };

  constructor({ db, workspacePath }: { db: any; workspacePath: string }) {
    this.db = db;
    this.workspacePath = path.resolve(workspacePath);
  }

  Begin(operationType: string, payload: unknown): string {
    if (!KnownTypes.has(operationType)) throw new Error('Workspace operation type is invalid.');
    const serialized = JSON.stringify(payload ?? {});
    if (serialized.length > 100000) throw new Error('Workspace operation payload is too large.');
    const id = CreateId();
    const now = GetNow();
    this.db.prepare(`INSERT INTO workspace_operations(id, operation_type, operation_version, state, payload_json, created_at, updated_at)
      VALUES(?, ?, 1, 'prepared', ?, ?, ?)`).run(id, operationType, serialized, now, now);
    return id;
  }

  Advance(id: string, state: string): void {
    if (!['file_written', 'db_committed', 'completed'].includes(state)) throw new Error('Workspace operation state is invalid.');
    const now = GetNow();
    this.db.prepare('UPDATE workspace_operations SET state = ?, error_code = NULL, updated_at = ?, completed_at = ? WHERE id = ?')
      .run(state, now, state === 'completed' ? now : null, id);
  }

  RequireWritable(): void {
    if (this.recovering || this.blocked) throw Object.assign(new Error('Workspace recovery is not complete.'), { code: 'WORKSPACE_BUSY' });
  }

  MarkRollback(id: string, code = 'OPERATION_FAILED'): void {
    this.db.prepare("UPDATE workspace_operations SET state = 'rollback_required', error_code = ?, updated_at = ? WHERE id = ? AND state != 'completed'")
      .run(String(code).slice(0, 100), GetNow(), id);
  }

  MarkFailed(id: string, code: string): void {
    this.db.prepare("UPDATE workspace_operations SET state = 'failed', error_code = ?, updated_at = ?, completed_at = ? WHERE id = ?")
      .run(String(code).slice(0, 100), GetNow(), GetNow(), id);
  }

  private Parse(row: any): any {
    try {
      return JSON.parse(row.payload_json);
    } catch {
      throw new Error('Workspace operation payload is invalid.');
    }
  }

  private ResolveWorkspaceRelative(relativePath: string): string {
    if (typeof relativePath !== 'string' || !relativePath || path.isAbsolute(relativePath)) throw new Error('Workspace operation path is invalid.');
    const target = path.resolve(this.workspacePath, relativePath);
    const relative = path.relative(this.workspacePath, target);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Workspace operation path escapes workspace.');
    return target;
  }

  private VerifyFileHash(filePath: string, expected: string): boolean {
    const stat = lstatSync(filePath, { throwIfNoEntry: false });
    if (!stat || !stat.isFile() || stat.isSymbolicLink()) return false;
    const actual = createHash('sha256').update(readFileSync(filePath)).digest('hex');
    return actual === expected;
  }

  RemoveDirectorySafely(target: string, expectedParent: string): void {
    const stat = lstatSync(target, { throwIfNoEntry: false });
    if (!stat) return;
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Workspace operation cleanup target is unsafe.');
    const parentReal = realpathSync(expectedParent);
    const targetReal = realpathSync(target);
    if (path.dirname(targetReal) !== parentReal) throw new Error('Workspace operation cleanup target escapes its parent.');
    rmSync(target, { recursive: true, force: true });
  }

  Recover({ synchronizeProfiles }: { synchronizeProfiles?: (items: any[]) => void } = {}): any {
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
        } catch {
          this.MarkFailed(row.id, 'RECOVERY_FAILED');
          summary.failed += 1;
        }
      }
      this.lastRecovery = summary;
      if (rows.length) WriteAudit(this.db, 'system', 'recover', 'workspace_operation', null, summary);
      return { ...summary, writable: !this.blocked };
    } finally {
      this.recovering = false;
    }
  }

  private RecoverOne(row: any, { synchronizeProfiles }: { synchronizeProfiles?: (items: any[]) => void } = {}): void {
    const payload = this.Parse(row);
    if (row.state === 'prepared') {
      if (row.operation_type === 'import_attachment') {
        const filePath = this.ResolveWorkspaceRelative(payload.storageKey);
        const snapshotValid = !payload.snapshotKey || this.VerifyFileHash(this.ResolveWorkspaceRelative(payload.snapshotKey), payload.snapshotSha256);
        if (this.VerifyFileHash(filePath, payload.sha256) && snapshotValid) row.state = 'file_written';
        else {
          this.MarkFailed(row.id, 'INTERRUPTED_BEFORE_FILE_WRITE');
          return;
        }
      } else if (row.operation_type === 'save_profiles') {
        const profilePath = this.ResolveWorkspaceRelative('profile.json');
        if (!existsSync(profilePath)) {
          this.MarkFailed(row.id, 'INTERRUPTED_BEFORE_FILE_WRITE');
          return;
        }
        row.state = 'file_written';
      } else if (row.operation_type === 'create_backup') {
        const directory = this.ResolveWorkspaceRelative(path.join('backups', payload.directoryName));
        if (existsSync(path.join(directory, 'manifest.json')) && existsSync(path.join(directory, 'avery.db'))) row.state = 'file_written';
        else {
          if (existsSync(directory)) this.RemoveDirectorySafely(directory, path.join(this.workspacePath, 'backups'));
          this.MarkFailed(row.id, 'INTERRUPTED_BEFORE_FILE_WRITE');
          return;
        }
      } else if (row.operation_type === 'copy_workspace') {
        const target = path.resolve(payload.destinationPath);
        if (existsSync(path.join(target, 'migration-manifest.json')) && existsSync(path.join(target, 'avery.db'))) row.state = 'file_written';
        else {
          const temporary = `${target}.avery-migration-${row.id}`;
          if (existsSync(temporary)) this.RemoveDirectorySafely(temporary, path.dirname(target));
          this.MarkFailed(row.id, 'INTERRUPTED_BEFORE_FILE_WRITE');
          return;
        }
      }
    }
    if (row.operation_type === 'import_attachment') {
      const filePath = this.ResolveWorkspaceRelative(payload.storageKey);
      if (!this.VerifyFileHash(filePath, payload.sha256)) throw new Error('Recovered attachment file is unavailable.');
      if (payload.snapshotKey && !this.VerifyFileHash(this.ResolveWorkspaceRelative(payload.snapshotKey), payload.snapshotSha256)) throw new Error('Recovered attachment snapshot is unavailable.');
      this.db.prepare(`INSERT INTO attachments(id, sha256, original_name, mime_type, byte_size, storage_key, parse_status, created_at, orphaned_at)
        VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(sha256) DO UPDATE SET parse_status = excluded.parse_status, deleted_at = NULL, cleanup_error = NULL`)
        .run(payload.attachmentId, payload.sha256, payload.originalName, payload.mimeType, payload.byteSize, payload.storageKey, payload.snapshotKey ? 'ready' : 'pending', payload.createdAt, payload.createdAt);
      this.Advance(row.id, 'db_committed');
      this.Advance(row.id, 'completed');
      return;
    }
    if (row.operation_type === 'save_profiles') {
      const profilePath = this.ResolveWorkspaceRelative('profile.json');
      const parsed = JSON.parse(readFileSync(profilePath, 'utf8'));
      if (!Array.isArray(parsed.items)) throw new Error('Recovered profile is invalid.');
      if (typeof synchronizeProfiles === 'function') synchronizeProfiles(parsed.items);
      this.Advance(row.id, 'db_committed');
      this.Advance(row.id, 'completed');
      return;
    }
    if (row.operation_type === 'create_backup') {
      const directory = this.ResolveWorkspaceRelative(path.join('backups', payload.directoryName));
      const backupDb = path.join(directory, 'avery.db');
      const manifest = path.join(directory, 'manifest.json');
      if (!existsSync(manifest)) throw new Error('Recovered backup manifest is unavailable.');
      const Database = require('better-sqlite3') as any;
      const verification = new Database(backupDb, { readonly: true });
      const integrity = verification.pragma('integrity_check', { simple: true });
      verification.close();
      if (integrity !== 'ok') throw new Error('Recovered backup is invalid.');
      this.Advance(row.id, 'completed');
      return;
    }
    if (row.operation_type === 'copy_workspace') {
      const target = path.resolve(payload.destinationPath);
      const manifest = path.join(target, 'migration-manifest.json');
      if (!existsSync(manifest)) throw new Error('Recovered workspace copy is incomplete.');
      const Database = require('better-sqlite3') as any;
      const verification = new Database(path.join(target, 'avery.db'), { readonly: true });
      const integrity = verification.pragma('integrity_check', { simple: true });
      verification.close();
      if (integrity !== 'ok') throw new Error('Recovered workspace copy is invalid.');
      this.Advance(row.id, 'completed');
    }
  }

  GetStatus(): any {
    return { recovering: this.recovering, blocked: this.blocked, recovered: this.lastRecovery.recovered, failed: this.lastRecovery.failed, blockedCount: this.lastRecovery.blocked };
  }
}

export { KnownTypes, ActiveStates };
