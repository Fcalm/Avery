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
exports.DatabaseRecoveryStore = void 0;
exports.ValidateRecoverySet = ValidateRecoverySet;
const node_crypto_1 = require("node:crypto");
const node_fs_1 = require("node:fs");
const path = __importStar(require("node:path"));
const MigrationManifest = JSON.parse((0, node_fs_1.readFileSync)(path.join(__dirname, '..', '..', '..', '..', '..', '..', 'migrations', 'business', 'manifest.json'), 'utf8'));
const CoreTables = ['workspace_meta', 'schema_migrations', 'conversations', 'attachments'];
function ExpectedChecksums() {
    return new Map(MigrationManifest.migrations.map((entry) => [entry.version, (0, node_crypto_1.createHash)('sha256').update(entry.checksumSeed).digest('hex')]));
}
function ValidateProfile(profilePath) {
    if (!(0, node_fs_1.existsSync)(profilePath))
        return true;
    const stat = (0, node_fs_1.lstatSync)(profilePath);
    if (!stat.isFile() || stat.isSymbolicLink())
        return false;
    const parsed = JSON.parse((0, node_fs_1.readFileSync)(profilePath, 'utf8'));
    return parsed && Array.isArray(parsed.items);
}
function FileSha256(filePath) {
    return (0, node_crypto_1.createHash)('sha256').update((0, node_fs_1.readFileSync)(filePath)).digest('hex');
}
function ValidateBackupManifest(manifestPath, databasePath, profilePath) {
    if (!manifestPath || !(0, node_fs_1.existsSync)(manifestPath))
        return;
    const stat = (0, node_fs_1.lstatSync)(manifestPath);
    if (!stat.isFile() || stat.isSymbolicLink())
        throw new Error('Recovery manifest is unsafe.');
    const manifest = JSON.parse((0, node_fs_1.readFileSync)(manifestPath, 'utf8'));
    if (manifest?.database && typeof manifest.database === 'object') {
        if (manifest.database.file !== 'offerget.db' || !/^[a-f0-9]{64}$/.test(manifest.database.sha256 || '') || FileSha256(databasePath) !== manifest.database.sha256) {
            throw new Error('Recovery database hash does not match its manifest.');
        }
    }
    if (manifest?.profile && typeof manifest.profile === 'object') {
        if (manifest.profile.file !== 'profile.json' || !(0, node_fs_1.existsSync)(profilePath) || !/^[a-f0-9]{64}$/.test(manifest.profile.sha256 || '') || FileSha256(profilePath) !== manifest.profile.sha256) {
            throw new Error('Recovery profile hash does not match its manifest.');
        }
    }
}
/** 校验候选数据库的 integrity、迁移 checksum、核心表和 profile；只读打开，绝不触发隐式建库。 */
function ValidateRecoverySet(databasePath, profilePath, manifestPath = null) {
    if (!(0, node_fs_1.existsSync)(databasePath) || (0, node_fs_1.statSync)(databasePath).size === 0)
        throw new Error('Recovery database is unavailable.');
    const databaseStat = (0, node_fs_1.lstatSync)(databasePath);
    if (!databaseStat.isFile() || databaseStat.isSymbolicLink())
        throw new Error('Recovery database is unsafe.');
    ValidateBackupManifest(manifestPath, databasePath, profilePath);
    const Database = require('better-sqlite3');
    const db = new Database(databasePath, { readonly: true, fileMustExist: true });
    try {
        if (db.pragma('integrity_check', { simple: true }) !== 'ok')
            throw new Error('Recovery database integrity check failed.');
        const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name));
        for (const table of CoreTables)
            if (!tables.has(table))
                throw new Error('Recovery database is missing a core table.');
        const expected = ExpectedChecksums();
        const rows = db.prepare('SELECT version, checksum FROM schema_migrations ORDER BY version').all();
        for (const row of rows)
            if (!expected.has(row.version) || expected.get(row.version) !== row.checksum)
                throw new Error('Recovery database migration checksum is invalid.');
        const maximum = Math.max(...expected.keys());
        const metadata = db.prepare("SELECT schema_version FROM workspace_meta WHERE id = 'workspace'").get();
        if (!metadata || metadata.schema_version > maximum)
            throw new Error('Recovery database schema version is unsupported.');
        if (!ValidateProfile(profilePath))
            throw new Error('Recovery profile is invalid.');
        return { integrity: 'ok', schemaVersion: metadata.schema_version };
    }
    finally {
        db.close();
    }
}
class DatabaseRecoveryStore {
    workspacePath;
    databasePath;
    profilePath;
    reason;
    constructor({ workspacePath, cause }) {
        this.workspacePath = path.resolve(workspacePath);
        this.databasePath = path.join(this.workspacePath, 'offerget.db');
        this.profilePath = path.join(this.workspacePath, 'profile.json');
        this.reason = String(cause?.message || 'Database startup validation failed.').replaceAll(this.workspacePath, '[WORKSPACE]').slice(0, 300).replace(/[A-Za-z]:\\[^\r\n]+/g, '[PATH]');
        (0, node_fs_1.mkdirSync)(path.join(this.workspacePath, 'backups'), { recursive: true });
        (0, node_fs_1.mkdirSync)(path.join(this.workspacePath, 'exports'), { recursive: true });
        this.AssertDirectoryWithin(path.join(this.workspacePath, 'backups'), this.workspacePath);
        this.AssertDirectoryWithin(path.join(this.workspacePath, 'exports'), this.workspacePath);
    }
    AssertDirectoryWithin(directory, parent) {
        const stat = (0, node_fs_1.lstatSync)(directory);
        if (!stat.isDirectory() || stat.isSymbolicLink())
            throw new Error('Recovery directory is unsafe.');
        const relative = path.relative((0, node_fs_1.realpathSync)(parent), (0, node_fs_1.realpathSync)(directory));
        if (!relative || relative.startsWith('..') || path.isAbsolute(relative))
            throw new Error('Recovery directory escapes workspace.');
    }
    ListBackups() {
        const root = path.join(this.workspacePath, 'backups');
        return (0, node_fs_1.readdirSync)(root, { withFileTypes: true }).filter((entry) => entry.isDirectory() && !entry.isSymbolicLink() && entry.name.startsWith('daily-'))
            .map((entry) => {
            const directory = path.join(root, entry.name);
            try {
                const validation = ValidateRecoverySet(path.join(directory, 'offerget.db'), path.join(directory, 'profile.json'), path.join(directory, 'manifest.json'));
                return { id: entry.name, valid: true, schemaVersion: validation.schemaVersion, createdAt: (0, node_fs_1.statSync)(directory).mtimeMs };
            }
            catch {
                return { id: entry.name, valid: false, schemaVersion: null, createdAt: (0, node_fs_1.statSync)(directory).mtimeMs };
            }
        }).sort((left, right) => right.createdAt - left.createdAt);
    }
    GetDatabaseRecoveryStatus() {
        const backups = this.ListBackups();
        return { mode: 'recovery', readOnly: true, reason: this.reason, backups, canRestore: backups.some((item) => item.valid) };
    }
    GetStatus() {
        return { name: path.basename(this.workspacePath), metadata: { workspace_id: 'recovery', schema_version: 0, created_at: 0, last_opened_at: 0 }, integrity: 'recovery_required' };
    }
    LoadViewModel() { return { conversations: [], resumes: [], jobs: [], applications: [] }; }
    GetStoredSettings() { return { workspaceName: path.basename(this.workspacePath) }; }
    GetProfiles() { return { items: [], hash: null, modified: false }; }
    GetWorkspaceRecoveryStatus() { return { recovering: false, blocked: true, recovered: 0, failed: 1, blockedCount: 1 }; }
    RestoreLatestBackup() {
        const candidate = this.ListBackups().find((item) => item.valid);
        if (!candidate)
            throw Object.assign(new Error('No valid workspace backup is available.'), { code: 'STORAGE_ERROR' });
        return this.RestoreBackup(candidate.id);
    }
    RestoreBackup(backupId) {
        if (typeof backupId !== 'string' || !/^daily-[A-Za-z0-9._-]+$/.test(backupId))
            throw new Error('Backup id is invalid.');
        const backupRoot = path.resolve(this.workspacePath, 'backups');
        const backupDirectory = path.resolve(backupRoot, backupId);
        if (path.dirname(backupDirectory) !== backupRoot)
            throw new Error('Backup path escapes workspace.');
        const backupStat = (0, node_fs_1.lstatSync)(backupDirectory, { throwIfNoEntry: false });
        if (!backupStat || !backupStat.isDirectory() || backupStat.isSymbolicLink())
            throw new Error('Backup directory is unsafe.');
        const backupReal = (0, node_fs_1.realpathSync)(backupDirectory);
        if (path.dirname(backupReal) !== (0, node_fs_1.realpathSync)(backupRoot))
            throw new Error('Backup directory escapes workspace.');
        ValidateRecoverySet(path.join(backupDirectory, 'offerget.db'), path.join(backupDirectory, 'profile.json'), path.join(backupDirectory, 'manifest.json'));
        const recoveryId = (0, node_crypto_1.randomUUID)();
        const staging = path.join(this.workspacePath, `.database-recovery-${recoveryId}`);
        const sceneRoot = path.join(backupRoot, 'recovery-scenes');
        const scene = path.join(sceneRoot, `scene-${Date.now()}-${recoveryId}`);
        (0, node_fs_1.mkdirSync)(staging);
        (0, node_fs_1.mkdirSync)(sceneRoot, { recursive: true });
        this.AssertDirectoryWithin(sceneRoot, backupRoot);
        (0, node_fs_1.mkdirSync)(scene);
        this.AssertDirectoryWithin(staging, this.workspacePath);
        this.AssertDirectoryWithin(scene, sceneRoot);
        let originalsMoved = false;
        try {
            (0, node_fs_1.copyFileSync)(path.join(backupDirectory, 'offerget.db'), path.join(staging, 'offerget.db'));
            if ((0, node_fs_1.existsSync)(path.join(backupDirectory, 'profile.json')))
                (0, node_fs_1.copyFileSync)(path.join(backupDirectory, 'profile.json'), path.join(staging, 'profile.json'));
            ValidateRecoverySet(path.join(staging, 'offerget.db'), path.join(staging, 'profile.json'));
            for (const name of ['offerget.db', 'offerget.db-wal', 'offerget.db-shm', 'profile.json']) {
                const current = path.join(this.workspacePath, name);
                if ((0, node_fs_1.existsSync)(current))
                    (0, node_fs_1.renameSync)(current, path.join(scene, name));
            }
            originalsMoved = true;
            (0, node_fs_1.renameSync)(path.join(staging, 'offerget.db'), this.databasePath);
            if ((0, node_fs_1.existsSync)(path.join(staging, 'profile.json')))
                (0, node_fs_1.renameSync)(path.join(staging, 'profile.json'), this.profilePath);
            (0, node_fs_1.writeFileSync)(path.join(scene, 'diagnostic.json'), JSON.stringify({ reason: this.reason, restoredFrom: backupId, sceneId: path.basename(scene) }, null, 2), 'utf8');
            (0, node_fs_1.rmSync)(staging, { recursive: true, force: true });
            ValidateRecoverySet(this.databasePath, this.profilePath);
            return { restored: true, backupId, sceneId: path.basename(scene) };
        }
        catch (error) {
            if (originalsMoved) {
                for (const name of ['offerget.db', 'offerget.db-wal', 'offerget.db-shm', 'profile.json']) {
                    const current = path.join(this.workspacePath, name);
                    const original = path.join(scene, name);
                    if ((0, node_fs_1.existsSync)(current))
                        (0, node_fs_1.renameSync)(current, path.join(scene, `failed-recovery-${name}`));
                    if ((0, node_fs_1.existsSync)(original))
                        (0, node_fs_1.renameSync)(original, current);
                }
            }
            if ((0, node_fs_1.existsSync)(staging))
                (0, node_fs_1.rmSync)(staging, { recursive: true, force: true });
            throw error;
        }
    }
    ExportRecoveryDiagnostic() {
        const fileName = `recovery-diagnostic-${Date.now()}.json`;
        (0, node_fs_1.writeFileSync)(path.join(this.workspacePath, 'exports', fileName), JSON.stringify({ reason: this.reason, backups: this.ListBackups().map(({ id, valid, schemaVersion }) => ({ id, valid, schemaVersion })) }, null, 2), 'utf8');
        return { exported: true, fileName };
    }
    Close() { }
}
exports.DatabaseRecoveryStore = DatabaseRecoveryStore;
