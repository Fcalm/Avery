import { createHash, randomUUID } from 'node:crypto';
import {
  copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import * as path from 'node:path';
import { ResolveBusinessMigrationRoot } from '../../../migration-paths';

const MigrationManifest = JSON.parse(readFileSync(path.join(ResolveBusinessMigrationRoot(__dirname), 'manifest.json'), 'utf8')) as {
  migrations: Array<{ version: number; checksumSeed: string; kind: string; file: string }>;
};

const CoreTables = ['workspace_meta', 'schema_migrations', 'conversations', 'attachments'];

function ExpectedChecksums(): Map<number, string> {
  return new Map(MigrationManifest.migrations.map((entry) => [entry.version, createHash('sha256').update(entry.checksumSeed).digest('hex')]));
}

function ValidateProfile(profilePath: string): boolean {
  if (!existsSync(profilePath)) return true;
  const stat = lstatSync(profilePath);
  if (!stat.isFile() || stat.isSymbolicLink()) return false;
  const parsed = JSON.parse(readFileSync(profilePath, 'utf8'));
  return parsed && Array.isArray(parsed.items);
}

function FileSha256(filePath: string): string {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

function ValidateBackupManifest(manifestPath: string | null, databasePath: string, profilePath: string): void {
  if (!manifestPath || !existsSync(manifestPath)) return;
  const stat = lstatSync(manifestPath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Recovery manifest is unsafe.');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as any;
  if (manifest?.database && typeof manifest.database === 'object') {
    if (manifest.database.file !== 'offerget.db' || !/^[a-f0-9]{64}$/.test(manifest.database.sha256 || '') || FileSha256(databasePath) !== manifest.database.sha256) {
      throw new Error('Recovery database hash does not match its manifest.');
    }
  }
  if (manifest?.profile && typeof manifest.profile === 'object') {
    if (manifest.profile.file !== 'profile.json' || !existsSync(profilePath) || !/^[a-f0-9]{64}$/.test(manifest.profile.sha256 || '') || FileSha256(profilePath) !== manifest.profile.sha256) {
      throw new Error('Recovery profile hash does not match its manifest.');
    }
  }
}

/** 校验候选数据库的 integrity、迁移 checksum、核心表和 profile；只读打开，绝不触发隐式建库。 */
export function ValidateRecoverySet(databasePath: string, profilePath: string, manifestPath: string | null = null): any {
  if (!existsSync(databasePath) || statSync(databasePath).size === 0) throw new Error('Recovery database is unavailable.');
  const databaseStat = lstatSync(databasePath);
  if (!databaseStat.isFile() || databaseStat.isSymbolicLink()) throw new Error('Recovery database is unsafe.');
  ValidateBackupManifest(manifestPath, databasePath, profilePath);
  const Database = require('better-sqlite3') as any;
  const db = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    if (db.pragma('integrity_check', { simple: true }) !== 'ok') throw new Error('Recovery database integrity check failed.');
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row: any) => row.name));
    for (const table of CoreTables) if (!tables.has(table)) throw new Error('Recovery database is missing a core table.');
    const expected = ExpectedChecksums();
    const rows = db.prepare('SELECT version, checksum FROM schema_migrations ORDER BY version').all();
    for (const row of rows) if (!expected.has(row.version) || expected.get(row.version) !== row.checksum) throw new Error('Recovery database migration checksum is invalid.');
    const maximum = Math.max(...expected.keys());
    const metadata = db.prepare("SELECT schema_version FROM workspace_meta WHERE id = 'workspace'").get();
    if (!metadata || metadata.schema_version > maximum) throw new Error('Recovery database schema version is unsupported.');
    if (!ValidateProfile(profilePath)) throw new Error('Recovery profile is invalid.');
    return { integrity: 'ok', schemaVersion: metadata.schema_version };
  } finally {
    db.close();
  }
}

export class DatabaseRecoveryStore {
  private workspacePath: string;
  private databasePath: string;
  private profilePath: string;
  private reason: string;

  constructor({ workspacePath, cause }: { workspacePath: string; cause: Error }) {
    this.workspacePath = path.resolve(workspacePath);
    this.databasePath = path.join(this.workspacePath, 'offerget.db');
    this.profilePath = path.join(this.workspacePath, 'profile.json');
    this.reason = String(cause?.message || 'Database startup validation failed.').replaceAll(this.workspacePath, '[WORKSPACE]').slice(0, 300).replace(/[A-Za-z]:\\[^\r\n]+/g, '[PATH]');
    mkdirSync(path.join(this.workspacePath, 'backups'), { recursive: true });
    mkdirSync(path.join(this.workspacePath, 'exports'), { recursive: true });
    this.AssertDirectoryWithin(path.join(this.workspacePath, 'backups'), this.workspacePath);
    this.AssertDirectoryWithin(path.join(this.workspacePath, 'exports'), this.workspacePath);
  }

  private AssertDirectoryWithin(directory: string, parent: string): void {
    const stat = lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Recovery directory is unsafe.');
    const relative = path.relative(realpathSync(parent), realpathSync(directory));
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Recovery directory escapes workspace.');
  }

  ListBackups(): any[] {
    const root = path.join(this.workspacePath, 'backups');
    return readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory() && !entry.isSymbolicLink() && entry.name.startsWith('daily-'))
      .map((entry) => {
        const directory = path.join(root, entry.name);
        try {
          const validation = ValidateRecoverySet(path.join(directory, 'offerget.db'), path.join(directory, 'profile.json'), path.join(directory, 'manifest.json'));
          return { id: entry.name, valid: true, schemaVersion: validation.schemaVersion, createdAt: statSync(directory).mtimeMs };
        } catch {
          return { id: entry.name, valid: false, schemaVersion: null, createdAt: statSync(directory).mtimeMs };
        }
      }).sort((left, right) => right.createdAt - left.createdAt);
  }

  GetDatabaseRecoveryStatus(): any {
    const backups = this.ListBackups();
    return { mode: 'recovery', readOnly: true, reason: this.reason, backups, canRestore: backups.some((item) => item.valid) };
  }

  GetStatus(): any {
    return { name: path.basename(this.workspacePath), metadata: { workspace_id: 'recovery', schema_version: 0, created_at: 0, last_opened_at: 0 }, integrity: 'recovery_required' };
  }

  LoadViewModel(): any { return { conversations: [], resumes: [], jobs: [], applications: [] }; }
  GetStoredSettings(): any { return { workspaceName: path.basename(this.workspacePath) }; }
  GetProfiles(): any { return { items: [], hash: null, modified: false }; }
  GetWorkspaceRecoveryStatus(): any { return { recovering: false, blocked: true, recovered: 0, failed: 1, blockedCount: 1 }; }

  RestoreLatestBackup(): any {
    const candidate = this.ListBackups().find((item) => item.valid);
    if (!candidate) throw Object.assign(new Error('No valid workspace backup is available.'), { code: 'STORAGE_ERROR' });
    return this.RestoreBackup(candidate.id);
  }

  RestoreBackup(backupId: string): any {
    if (typeof backupId !== 'string' || !/^daily-[A-Za-z0-9._-]+$/.test(backupId)) throw new Error('Backup id is invalid.');
    const backupRoot = path.resolve(this.workspacePath, 'backups');
    const backupDirectory = path.resolve(backupRoot, backupId);
    if (path.dirname(backupDirectory) !== backupRoot) throw new Error('Backup path escapes workspace.');
    const backupStat = lstatSync(backupDirectory, { throwIfNoEntry: false });
    if (!backupStat || !backupStat.isDirectory() || backupStat.isSymbolicLink()) throw new Error('Backup directory is unsafe.');
    const backupReal = realpathSync(backupDirectory);
    if (path.dirname(backupReal) !== realpathSync(backupRoot)) throw new Error('Backup directory escapes workspace.');
    ValidateRecoverySet(path.join(backupDirectory, 'offerget.db'), path.join(backupDirectory, 'profile.json'), path.join(backupDirectory, 'manifest.json'));
    const recoveryId = randomUUID();
    const staging = path.join(this.workspacePath, `.database-recovery-${recoveryId}`);
    const sceneRoot = path.join(backupRoot, 'recovery-scenes');
    const scene = path.join(sceneRoot, `scene-${Date.now()}-${recoveryId}`);
    mkdirSync(staging);
    mkdirSync(sceneRoot, { recursive: true });
    this.AssertDirectoryWithin(sceneRoot, backupRoot);
    mkdirSync(scene);
    this.AssertDirectoryWithin(staging, this.workspacePath);
    this.AssertDirectoryWithin(scene, sceneRoot);
    let originalsMoved = false;
    try {
      copyFileSync(path.join(backupDirectory, 'offerget.db'), path.join(staging, 'offerget.db'));
      if (existsSync(path.join(backupDirectory, 'profile.json'))) copyFileSync(path.join(backupDirectory, 'profile.json'), path.join(staging, 'profile.json'));
      ValidateRecoverySet(path.join(staging, 'offerget.db'), path.join(staging, 'profile.json'));
      for (const name of ['offerget.db', 'offerget.db-wal', 'offerget.db-shm', 'profile.json']) {
        const current = path.join(this.workspacePath, name);
        if (existsSync(current)) renameSync(current, path.join(scene, name));
      }
      originalsMoved = true;
      renameSync(path.join(staging, 'offerget.db'), this.databasePath);
      if (existsSync(path.join(staging, 'profile.json'))) renameSync(path.join(staging, 'profile.json'), this.profilePath);
      writeFileSync(path.join(scene, 'diagnostic.json'), JSON.stringify({ reason: this.reason, restoredFrom: backupId, sceneId: path.basename(scene) }, null, 2), 'utf8');
      rmSync(staging, { recursive: true, force: true });
      ValidateRecoverySet(this.databasePath, this.profilePath);
      return { restored: true, backupId, sceneId: path.basename(scene) };
    } catch (error) {
      if (originalsMoved) {
        for (const name of ['offerget.db', 'offerget.db-wal', 'offerget.db-shm', 'profile.json']) {
          const current = path.join(this.workspacePath, name);
          const original = path.join(scene, name);
          if (existsSync(current)) renameSync(current, path.join(scene, `failed-recovery-${name}`));
          if (existsSync(original)) renameSync(original, current);
        }
      }
      if (existsSync(staging)) rmSync(staging, { recursive: true, force: true });
      throw error;
    }
  }

  ExportRecoveryDiagnostic(): any {
    const fileName = `recovery-diagnostic-${Date.now()}.json`;
    writeFileSync(path.join(this.workspacePath, 'exports', fileName), JSON.stringify({ reason: this.reason, backups: this.ListBackups().map(({ id, valid, schemaVersion }) => ({ id, valid, schemaVersion })) }, null, 2), 'utf8');
    return { exported: true, fileName };
  }

  Close(): void { }
}
