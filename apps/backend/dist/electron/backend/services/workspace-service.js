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
exports.WorkspaceService = void 0;
exports.EnsureWorkspaceDirectories = EnsureWorkspaceDirectories;
const node_crypto_1 = require("node:crypto");
const node_fs_1 = require("node:fs");
const path = __importStar(require("node:path"));
const helpers_1 = require("../../repositories/helpers");
/** 原子创建工作空间内需要的目录，避免附件和备份服务各自处理目录初始化。 */
function EnsureWorkspaceDirectories(workspacePath) {
    for (const directory of ['attachments', 'exports', 'backups', path.join('derived', 'ocr')]) {
        (0, node_fs_1.mkdirSync)(path.join(workspacePath, directory), { recursive: true });
    }
}
/** 工作空间的应用服务：状态、聚合视图、附件导入、备份、迁移与审计，持有业务数据库的唯一写句柄。 */
class WorkspaceService {
    db;
    conversations;
    resumes;
    jobs;
    applications;
    workspacePath;
    profilePath;
    attachmentLifecycle;
    workspaceOperations;
    databasePath;
    integrityCache = null;
    constructor({ db, conversationService, resumeService, jobService, applicationService, workspacePath, profilePath, attachmentLifecycle, workspaceOperations }) {
        this.db = db;
        this.conversations = conversationService;
        this.resumes = resumeService;
        this.jobs = jobService;
        this.applications = applicationService;
        this.workspacePath = workspacePath;
        this.profilePath = profilePath;
        this.attachmentLifecycle = attachmentLifecycle;
        this.workspaceOperations = workspaceOperations;
        this.databasePath = path.join(workspacePath, 'offerget.db');
    }
    /** 执行完整 integrity_check 并缓存 30 秒；未过期直接返回缓存结果，避免高频状态查询触发全库扫描。 */
    RunIntegrityCheck() {
        const now = (0, helpers_1.GetNow)();
        if (this.integrityCache && now - this.integrityCache.at < 30000)
            return this.integrityCache.result;
        const result = this.db.pragma('integrity_check', { simple: true });
        this.integrityCache = { at: now, result };
        return result;
    }
    /** 返回不含敏感配置的工作空间健康状态；只暴露目录名掩码，绝不包含绝对路径。 */
    GetStatus() {
        const metadata = this.db.prepare("SELECT workspace_id, schema_version, created_at, last_opened_at FROM workspace_meta WHERE id = 'workspace'").get();
        return { name: path.basename(this.workspacePath), metadata, integrity: this.RunIntegrityCheck() };
    }
    /** 从各领域 Application Service 聚合页面所需的业务 ViewModel；空库返回空集合而非种子。 */
    LoadViewModel() {
        return {
            conversations: this.conversations.ListAll(),
            resumes: this.resumes.ListAll(),
            jobs: this.jobs.ListAll(),
            applications: this.applications.ListAll(),
        };
    }
    /** 复制、校验并准备切换到空目标目录；源工作空间保持不变以便发生故障时回退；拒绝符号链接/Junction 目标。 */
    CopyWorkspaceTo(destinationPath) {
        this.workspaceOperations.RequireWritable();
        const sourcePath = path.resolve(this.workspacePath);
        const targetPath = path.resolve(destinationPath);
        try {
            const targetStat = (0, node_fs_1.lstatSync)(targetPath, { throwIfNoEntry: false });
            if (targetStat && (targetStat.isSymbolicLink() || targetStat.isDirectory() === false))
                throw new Error('The destination workspace must be a real directory, not a symbolic link.');
        }
        catch (error) {
            if (error instanceof Error && error.message.startsWith('The destination workspace must be a real directory'))
                throw error;
        }
        const relativeTarget = path.relative(sourcePath, targetPath);
        const relativeSource = path.relative(targetPath, sourcePath);
        if (!relativeTarget || (!relativeTarget.startsWith('..') && !path.isAbsolute(relativeTarget)) || (!relativeSource.startsWith('..') && !path.isAbsolute(relativeSource))) {
            throw new Error('The destination workspace must not contain or be contained by the current workspace.');
        }
        if ((0, node_fs_1.existsSync)(targetPath) && (0, node_fs_1.readdirSync)(targetPath).length > 0)
            throw new Error('The destination directory must be empty before migration.');
        const operationId = this.workspaceOperations.Begin('copy_workspace', { destinationPath: targetPath });
        const temporaryPath = `${targetPath}.offerget-migration-${operationId}`;
        (0, node_fs_1.mkdirSync)(temporaryPath, { recursive: true });
        try {
            EnsureWorkspaceDirectories(temporaryPath);
            const copiedDatabasePath = path.join(temporaryPath, 'offerget.db');
            this.db.exec(`VACUUM INTO '${copiedDatabasePath.replace(/'/g, "''")}'`);
            if ((0, node_fs_1.existsSync)(this.profilePath))
                (0, node_fs_1.copyFileSync)(this.profilePath, path.join(temporaryPath, 'profile.json'));
            for (const directory of ['attachments', 'exports', 'backups']) {
                const sourceDirectory = path.join(sourcePath, directory);
                if ((0, node_fs_1.existsSync)(sourceDirectory))
                    (0, node_fs_1.cpSync)(sourceDirectory, path.join(temporaryPath, directory), { recursive: true, force: true });
            }
            const Database = require('better-sqlite3');
            const verification = new Database(copiedDatabasePath);
            const integrity = verification.pragma('integrity_check', { simple: true });
            verification.prepare("UPDATE workspace_operations SET state = 'completed', completed_at = ?, updated_at = ?, error_code = NULL WHERE id = ?").run((0, helpers_1.GetNow)(), (0, helpers_1.GetNow)(), operationId);
            verification.close();
            if (integrity !== 'ok')
                throw new Error('The copied workspace database failed integrity verification.');
            (0, node_fs_1.writeFileSync)(path.join(temporaryPath, 'migration-manifest.json'), JSON.stringify({ migratedAt: (0, helpers_1.GetNow)(), sourceWorkspace: path.basename(sourcePath), databaseIntegrity: integrity }, null, 2), 'utf8');
            if (!(0, node_fs_1.existsSync)(targetPath)) {
                (0, node_fs_1.renameSync)(temporaryPath, targetPath);
            }
            else {
                for (const entry of (0, node_fs_1.readdirSync)(temporaryPath))
                    (0, node_fs_1.renameSync)(path.join(temporaryPath, entry), path.join(targetPath, entry));
                (0, node_fs_1.rmdirSync)(temporaryPath);
            }
            this.workspaceOperations.Advance(operationId, 'file_written');
            this.workspaceOperations.Advance(operationId, 'db_committed');
            this.workspaceOperations.Advance(operationId, 'completed');
            return { workspacePath: targetPath, integrity };
        }
        catch (error) {
            this.workspaceOperations.RemoveDirectorySafely(temporaryPath, path.dirname(targetPath));
            this.workspaceOperations.MarkRollback(operationId, 'COPY_WORKSPACE_FAILED');
            throw error;
        }
    }
    /** 复制用户主动选择的附件至工作空间内容寻址目录，并禁止向模型暴露源文件路径。 */
    ImportAttachment(sourcePath, mimeType = 'application/octet-stream') {
        this.workspaceOperations.RequireWritable();
        const stat = (0, node_fs_1.statSync)(sourcePath);
        if (!stat.isFile() || stat.size <= 0 || stat.size > 5 * 1024 * 1024)
            throw new Error('Attachment must be a non-empty file no larger than 5 MB.');
        const content = (0, node_fs_1.readFileSync)(sourcePath);
        const sha256 = (0, node_crypto_1.createHash)('sha256').update(content).digest('hex');
        const storageKey = path.join('attachments', sha256);
        const destination = path.join(this.workspacePath, storageKey);
        const existing = this.db.prepare('SELECT id, original_name, deleted_at FROM attachments WHERE sha256 = ?').get(sha256);
        const id = existing?.id ?? (0, helpers_1.CreateId)();
        const name = path.basename(sourcePath);
        const createdAt = (0, helpers_1.GetNow)();
        const normalizedStorageKey = storageKey.replace(/\\/g, '/');
        const operationId = this.workspaceOperations.Begin('import_attachment', { attachmentId: id, sha256, originalName: name, mimeType, byteSize: stat.size, storageKey: normalizedStorageKey, createdAt });
        try {
            if (!(0, node_fs_1.existsSync)(destination))
                (0, node_fs_1.writeFileSync)(destination, content, { flag: 'wx' });
            else {
                const destinationStat = (0, node_fs_1.lstatSync)(destination);
                if (!destinationStat.isFile() || destinationStat.isSymbolicLink())
                    throw new Error('Attachment storage entry is unsafe.');
            }
            this.workspaceOperations.Advance(operationId, 'file_written');
            if (!existing) {
                this.db.prepare('INSERT INTO attachments(id, sha256, original_name, mime_type, byte_size, storage_key, created_at, orphaned_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?)')
                    .run(id, sha256, name, mimeType, stat.size, normalizedStorageKey, createdAt, createdAt);
            }
            else {
                this.db.prepare(`UPDATE attachments SET original_name = ?, mime_type = ?, byte_size = ?, storage_key = ?,
          deleted_at = NULL, orphaned_at = ?, cleanup_attempted_at = NULL, cleanup_error = NULL WHERE id = ?`)
                    .run(name, mimeType, stat.size, normalizedStorageKey, createdAt, id);
            }
            this.workspaceOperations.Advance(operationId, 'db_committed');
            this.workspaceOperations.Advance(operationId, 'completed');
            return { id, name, uri: `attachment://${id}/${encodeURIComponent(name)}` };
        }
        catch (error) {
            this.workspaceOperations.MarkRollback(operationId, 'IMPORT_ATTACHMENT_FAILED');
            throw error;
        }
    }
    /** 将虚拟附件 URI 解析为受控工作空间文件，拒绝任意物理路径输入。 */
    ResolveAttachmentUri(uri) {
        const matched = /^attachment:\/\/([^/]+)\//.exec(String(uri));
        if (!matched)
            throw new Error('The attachment URI is invalid.');
        const attachment = this.db.prepare('SELECT id, original_name, mime_type, storage_key FROM attachments WHERE id = ? AND deleted_at IS NULL').get(matched[1]);
        if (!attachment)
            throw new Error('The attachment is unavailable.');
        const attachmentRoot = (0, node_fs_1.realpathSync)(path.resolve(this.workspacePath, 'attachments'));
        const candidatePath = path.resolve(this.workspacePath, attachment.storage_key);
        const lexicalRelative = path.relative(attachmentRoot, candidatePath);
        if (!lexicalRelative || lexicalRelative.startsWith('..') || path.isAbsolute(lexicalRelative) || !(0, node_fs_1.existsSync)(candidatePath))
            throw new Error('The attachment storage entry is unavailable.');
        const physicalPath = (0, node_fs_1.realpathSync)(candidatePath);
        const realRelative = path.relative(attachmentRoot, physicalPath);
        if (!realRelative || realRelative.startsWith('..') || path.isAbsolute(realRelative))
            throw new Error('The attachment storage entry escapes the workspace.');
        return { id: attachment.id, name: attachment.original_name, mimeType: attachment.mime_type, physicalPath };
    }
    /** 创建一致性的业务数据库和档案备份；附件以原始内容寻址文件继续由 manifest 引用；只返回掩码结果，不含备份目录路径。 */
    CreateBackup() {
        this.workspaceOperations.RequireWritable();
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const directoryName = `daily-${stamp}`;
        const operationId = this.workspaceOperations.Begin('create_backup', { directoryName });
        const directory = path.join(this.workspacePath, 'backups', directoryName);
        try {
            (0, node_fs_1.mkdirSync)(directory, { recursive: true });
            const databaseBackupPath = path.join(directory, 'offerget.db');
            const escapedPath = databaseBackupPath.replace(/'/g, "''");
            this.db.exec(`VACUUM INTO '${escapedPath}'`);
            const Database = require('better-sqlite3');
            const backupDatabase = new Database(databaseBackupPath);
            backupDatabase.prepare("UPDATE workspace_operations SET state = 'completed', completed_at = ?, updated_at = ?, error_code = NULL WHERE id = ?").run((0, helpers_1.GetNow)(), (0, helpers_1.GetNow)(), operationId);
            backupDatabase.close();
            const profileBackupPath = path.join(directory, 'profile.json');
            if ((0, node_fs_1.existsSync)(this.profilePath))
                (0, node_fs_1.copyFileSync)(this.profilePath, profileBackupPath);
            const attachments = this.db.prepare('SELECT sha256, storage_key FROM attachments WHERE deleted_at IS NULL ORDER BY sha256').all();
            (0, node_fs_1.writeFileSync)(path.join(directory, 'manifest.json'), JSON.stringify({ createdAt: (0, helpers_1.GetNow)(), database: 'offerget.db', profile: (0, node_fs_1.existsSync)(profileBackupPath) ? 'profile.json' : null, attachments }, null, 2), 'utf8');
            this.workspaceOperations.Advance(operationId, 'file_written');
            this.workspaceOperations.Advance(operationId, 'db_committed');
            this.PruneDailyBackups();
            const retainedCount = (0, node_fs_1.readdirSync)(path.join(this.workspacePath, 'backups')).filter((name) => name.startsWith('daily-')).length;
            this.workspaceOperations.Advance(operationId, 'completed');
            return { created: true, timestamp: (0, helpers_1.GetNow)(), retainedCount };
        }
        catch (error) {
            this.workspaceOperations.MarkRollback(operationId, 'CREATE_BACKUP_FAILED');
            throw error;
        }
    }
    /** 只删除本服务生成且超出 7 份限制的日备份目录。 */
    PruneDailyBackups() {
        const backupRoot = path.join(this.workspacePath, 'backups');
        const directories = (0, node_fs_1.readdirSync)(backupRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory() && !entry.isSymbolicLink() && entry.name.startsWith('daily-'))
            .map((entry) => ({ name: entry.name, path: path.join(backupRoot, entry.name), time: (0, node_fs_1.statSync)(path.join(backupRoot, entry.name)).mtimeMs }))
            .sort((left, right) => right.time - left.time);
        for (const directory of directories.slice(7))
            this.workspaceOperations.RemoveDirectorySafely(directory.path, backupRoot);
    }
    /** 关闭数据库句柄，供应用退出或后续工作空间迁移时安全调用。 */
    Close() {
        try {
            this.db?.close();
        }
        catch {
            // 退出阶段重复关闭原生句柄无需额外处理。
        }
    }
}
exports.WorkspaceService = WorkspaceService;
