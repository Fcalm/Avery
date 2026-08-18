"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.BusinessStore = void 0;
const node_crypto_1 = require("node:crypto");
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
const manifest_json_1 = __importDefault(require("../../../migrations/business/manifest.json"));
// better-sqlite3 为原生模块，仅 Worker 进程加载（组合根不持有连接）；require 形态返回 any。
const Database = require('better-sqlite3');
// 领域实现同属 apps/backend TypeScript 构建产物；组合根仅负责装配。
const { GetNow, CreateId } = require('./electron/repositories/helpers.js');
const { ConversationRepository } = require('./electron/repositories/conversation-repository.js');
const { ResumeRepository } = require('./electron/repositories/resume-repository.js');
const { JobRepository } = require('./electron/repositories/job-repository.js');
const { ApplicationRepository } = require('./electron/repositories/application-repository.js');
const { ProfileRepository } = require('./electron/repositories/profile-repository.js');
const { ConversationService } = require('./electron/backend/services/conversation-service.js');
const { ResumeService } = require('./electron/backend/services/resume-service.js');
const { JobService } = require('./electron/backend/services/job-service.js');
const { ApplicationService } = require('./electron/backend/services/application-service.js');
const { ProfileService } = require('./electron/backend/services/profile-service.js');
const { SettingsService } = require('./electron/backend/services/settings-service.js');
const { WorkspaceService, EnsureWorkspaceDirectories } = require('./electron/backend/services/workspace-service.js');
const { AttachmentLifecycleService } = require('./electron/backend/services/attachment-lifecycle-service.js');
const { WorkspaceOperationService } = require('./electron/backend/services/workspace-operation-service.js');
/** 业务迁移文件目录：从 dist 回退三级到仓库根，再进入 migrations/business。 */
const MigrationRoot = (0, node_path_1.join)(__dirname, '..', '..', '..', 'migrations', 'business');
/** 业务工作空间的 Infrastructure：持有单一数据库与各领域 Repository，组装各 Application Service 编排跨资源写入。 */
class BusinessStore {
    workspacePath;
    databasePath;
    profilePath;
    db;
    conversations;
    resumes;
    jobs;
    applications;
    profiles;
    conversationService;
    resumeService;
    jobService;
    applicationService;
    profileService;
    settingsService;
    workspaceService;
    attachmentLifecycle;
    workspaceOperations;
    /** 初始化业务数据库，并确保每个工作空间只存在一个数据库事实源。 */
    constructor(workspacePath, options = {}) {
        this.workspacePath = workspacePath;
        (0, node_fs_1.mkdirSync)(workspacePath, { recursive: true });
        EnsureWorkspaceDirectories(workspacePath);
        this.databasePath = (0, node_path_1.join)(workspacePath, 'offerget.db');
        this.profilePath = (0, node_path_1.join)(workspacePath, 'profile.json');
        if ((0, node_fs_1.existsSync)(this.databasePath) && (0, node_fs_1.statSync)(this.databasePath).size === 0)
            throw new Error('Existing business database is empty or truncated.');
        this.db = new Database(this.databasePath);
        this.db.pragma('journal_mode = WAL');
        this.db.pragma('foreign_keys = ON');
        try {
            this.PreflightDatabase();
            this.CreatePreUpgradeBackupIfNeeded();
            if (options.upgradeFailure === 'disk_full') {
                throw Object.assign(new Error('Insufficient disk space before workspace migration.'), { code: 'ENOSPC' });
            }
            if (options.upgradeFailure === 'migration') {
                throw Object.assign(new Error('Injected migration failure before schema changes.'), { code: 'SQLITE_ERROR' });
            }
            this.RunMigrations();
        }
        catch (error) {
            try {
                this.db.close();
            }
            catch { /* 启动校验失败时尽力释放句柄，交由恢复门面接管。 */ }
            throw error;
        }
        this.workspaceOperations = new WorkspaceOperationService({ db: this.db, workspacePath });
        this.attachmentLifecycle = new AttachmentLifecycleService({ db: this.db, workspacePath });
        this.conversations = new ConversationRepository({ db: this.db, attachmentLifecycle: this.attachmentLifecycle });
        this.resumes = new ResumeRepository({ db: this.db, attachmentLifecycle: this.attachmentLifecycle });
        this.jobs = new JobRepository({ db: this.db });
        this.applications = new ApplicationRepository({ db: this.db });
        this.profiles = new ProfileRepository({ profilePath: this.profilePath });
        this.conversationService = new ConversationService({ repository: this.conversations });
        this.resumeService = new ResumeService({ repository: this.resumes });
        this.jobService = new JobService({ repository: this.jobs });
        this.applicationService = new ApplicationService({ repository: this.applications });
        this.profileService = new ProfileService({ repository: this.profiles, db: this.db, attachmentLifecycle: this.attachmentLifecycle, workspaceOperations: this.workspaceOperations });
        this.settingsService = new SettingsService({ db: this.db });
        this.workspaceService = new WorkspaceService({
            db: this.db,
            conversationService: this.conversationService,
            resumeService: this.resumeService,
            jobService: this.jobService,
            applicationService: this.applicationService,
            workspacePath,
            profilePath: this.profilePath,
            attachmentLifecycle: this.attachmentLifecycle,
            workspaceOperations: this.workspaceOperations,
        });
        this.workspaceOperations.Recover({ synchronizeProfiles: (items) => this.profileService.SynchronizeAttachmentLinks(items) });
    }
    /** 迁移前轻量检查：拒绝损坏页、未知更高 schema 和已登记 checksum 异常，绝不以空库覆盖。 */
    PreflightDatabase() {
        if (this.db.pragma('quick_check', { simple: true }) !== 'ok')
            throw new Error('Business database quick check failed.');
        const hasMigrations = this.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'").get();
        if (!hasMigrations)
            return;
        const expected = new Map(manifest_json_1.default.migrations
            .map((entry) => [entry.version, (0, node_crypto_1.createHash)('sha256').update(entry.checksumSeed).digest('hex')]));
        const appliedRows = this.db.prepare('SELECT version, checksum FROM schema_migrations ORDER BY version').all();
        for (const row of appliedRows) {
            if (!expected.has(row.version) || expected.get(row.version) !== row.checksum)
                throw new Error('Business database migration checksum mismatch.');
        }
        const expectedVersions = [...expected.keys()].sort((left, right) => left - right);
        const appliedVersions = appliedRows.map((row) => row.version);
        if (appliedVersions.some((version, index) => version !== expectedVersions[index])) {
            throw new Error('Business database migration history is not a contiguous manifest prefix.');
        }
        const hasMetadata = this.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'workspace_meta'").get();
        const metadata = hasMetadata ? this.db.prepare("SELECT schema_version FROM workspace_meta WHERE id = 'workspace'").get() : null;
        const maximum = Math.max(...expected.keys());
        if (metadata?.schema_version > maximum)
            throw new Error('Business database schema version is newer than this application.');
    }
    /**
     * 现有工作空间存在待执行迁移时，先创建可由恢复服务识别的完整备份。
     * 备份在任何 schema 写入前完成并复验，避免升级失败后只能依赖已被部分修改的数据库。
     */
    CreatePreUpgradeBackupIfNeeded() {
        const hasMigrations = this.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'").get();
        if (!hasMigrations)
            return null;
        const appliedVersions = new Set(this.db.prepare('SELECT version FROM schema_migrations').all().map((row) => row.version));
        const versions = manifest_json_1.default.migrations.map((entry) => entry.version);
        const pending = versions.filter((version) => !appliedVersions.has(version));
        if (pending.length === 0)
            return null;
        const fromVersion = Math.max(0, ...appliedVersions);
        const toVersion = Math.max(...versions);
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const directoryName = `daily-pre-upgrade-v${fromVersion}-to-v${toVersion}-${stamp}-${(0, node_crypto_1.randomUUID)()}`;
        const directory = (0, node_path_1.join)(this.workspacePath, 'backups', directoryName);
        (0, node_fs_1.mkdirSync)(directory, { recursive: false });
        try {
            const databaseBackupPath = (0, node_path_1.join)(directory, 'offerget.db');
            this.db.exec(`VACUUM INTO '${databaseBackupPath.replace(/'/g, "''")}'`);
            const backupDb = new Database(databaseBackupPath, { readonly: true, fileMustExist: true });
            try {
                if (backupDb.pragma('integrity_check', { simple: true }) !== 'ok')
                    throw new Error('Pre-upgrade database backup failed integrity verification.');
                const metadata = backupDb.prepare("SELECT schema_version FROM workspace_meta WHERE id = 'workspace'").get();
                // 早期候选只登记 schema_migrations、未同步 workspace_meta.schema_version；迁移事实以不可变迁移表为准。
                if (!metadata || metadata.schema_version > fromVersion)
                    throw new Error('Pre-upgrade database backup schema is newer than the applied migration set.');
            }
            finally {
                backupDb.close();
            }
            const profileBackupPath = (0, node_path_1.join)(directory, 'profile.json');
            if ((0, node_fs_1.existsSync)(this.profilePath)) {
                const profile = JSON.parse((0, node_fs_1.readFileSync)(this.profilePath, 'utf8'));
                if (!profile || !Array.isArray(profile.items))
                    throw new Error('Pre-upgrade profile backup source is invalid.');
                (0, node_fs_1.copyFileSync)(this.profilePath, profileBackupPath);
            }
            const databaseBytes = (0, node_fs_1.readFileSync)(databaseBackupPath);
            const profileBytes = (0, node_fs_1.existsSync)(profileBackupPath) ? (0, node_fs_1.readFileSync)(profileBackupPath) : null;
            const hasAttachments = this.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'attachments'").get();
            const attachments = hasAttachments
                ? this.db.prepare('SELECT sha256, storage_key FROM attachments WHERE deleted_at IS NULL ORDER BY sha256').all()
                : [];
            (0, node_fs_1.writeFileSync)((0, node_path_1.join)(directory, 'manifest.json'), JSON.stringify({
                createdAt: GetNow(), type: 'pre_upgrade', fromSchemaVersion: fromVersion, toSchemaVersion: toVersion,
                database: { file: 'offerget.db', sha256: (0, node_crypto_1.createHash)('sha256').update(databaseBytes).digest('hex') },
                profile: profileBytes ? { file: 'profile.json', sha256: (0, node_crypto_1.createHash)('sha256').update(profileBytes).digest('hex') } : null,
                attachments,
            }, null, 2), 'utf8');
            return { directoryName, fromVersion, toVersion };
        }
        catch (error) {
            // 只清理由本次备份创建的固定文件，避免递归删除在竞争条件下被替换的目录或链接。
            for (const name of ['manifest.json', 'profile.json', 'offerget.db']) {
                const candidate = (0, node_path_1.join)(directory, name);
                try {
                    if ((0, node_fs_1.existsSync)(candidate))
                        (0, node_fs_1.unlinkSync)(candidate);
                }
                catch { /* 保留原始升级错误；残留由安全清理流程处理。 */ }
            }
            try {
                (0, node_fs_1.rmdirSync)(directory);
            }
            catch { /* 非空或被替换时拒绝扩大删除范围。 */ }
            throw error;
        }
    }
    /** 按 manifest 读取不可变迁移文件执行，并用 checksum 防止同版本迁移被静默改写；既有迁移的 checksum 基于版本标识，存量库保持一致。 */
    RunMigrations() {
        // 迁移跟踪表先行就绪；v1 建表语句中的同名 CREATE 幂等跳过，不影响既有库。
        this.db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, checksum TEXT NOT NULL UNIQUE, applied_at INTEGER NOT NULL);');
        for (const entry of manifest_json_1.default.migrations) {
            const checksum = (0, node_crypto_1.createHash)('sha256').update(entry.checksumSeed).digest('hex');
            const applied = this.db.prepare('SELECT checksum FROM schema_migrations WHERE version = ?').get(entry.version);
            if (applied && applied.checksum !== checksum)
                throw new Error(`Business database migration ${entry.version} checksum mismatch.`);
            if (!applied) {
                if (entry.kind === 'js') {
                    const migration = require((0, node_path_1.join)(MigrationRoot, entry.file));
                    migration.up(this.db);
                }
                else {
                    const sql = (0, node_fs_1.readFileSync)((0, node_path_1.join)(MigrationRoot, entry.file), 'utf8');
                    this.db.exec(sql);
                }
                this.db.prepare('INSERT INTO schema_migrations(version, checksum, applied_at) VALUES(?, ?, ?)').run(entry.version, checksum, GetNow());
            }
        }
        const metadata = this.db.prepare("SELECT workspace_id FROM workspace_meta WHERE id = 'workspace'").get();
        const now = GetNow();
        const schemaVersion = Math.max(...manifest_json_1.default.migrations.map((entry) => entry.version));
        if (!metadata) {
            this.db.prepare("INSERT INTO workspace_meta(id, workspace_id, created_at, updated_at, last_opened_at, app_version, schema_version) VALUES('workspace', ?, ?, ?, ?, ?, ?)")
                .run(CreateId(), now, now, now, '0.1.0', schemaVersion);
        }
        else {
            this.db.prepare("UPDATE workspace_meta SET last_opened_at = ?, updated_at = ?, schema_version = ? WHERE id = 'workspace'").run(now, now, schemaVersion);
        }
    }
    /** 返回不含敏感配置的工作空间健康状态，供受限 IPC 与设置页展示。 */
    GetStatus() {
        return this.workspaceService.GetStatus();
    }
    /** 从各领域 Application Service 聚合页面所需的业务 ViewModel；空库返回空集合而非种子。 */
    LoadViewModel() {
        return this.workspaceService.LoadViewModel();
    }
    /** 新建会话并持久化；返回带应用层 ID 的会话记录供页面立即使用。 */
    CreateConversation(conversation) {
        return this.conversationService.Create(conversation);
    }
    /** 重命名会话；透传期望版本供外部修改冲突检测。 */
    RenameConversation(id, title, expectedRevision) {
        return this.conversationService.Rename(id, title, expectedRevision);
    }
    /** 删除会话并级联清理其消息。 */
    DeleteConversation(id) {
        return this.conversationService.Delete(id);
    }
    /** 向会话追加消息，按消息 ID 幂等写入。 */
    AppendConversationMessages(conversationId, messages) {
        return this.conversationService.AppendMessages(conversationId, messages);
    }
    /** 写入流式占位消息的最终正文。 */
    CompleteConversationMessage(conversationId, messageId, content, thinkingContent) {
        return this.conversationService.CompleteMessage(conversationId, messageId, content, thinkingContent);
    }
    /** 移除未完成请求的临时占位消息。 */
    RemoveConversationMessage(conversationId, messageId) {
        return this.conversationService.RemoveMessage(conversationId, messageId);
    }
    /** 同时写入会话上下文与 Tool Array 两类快照，供 /reload-session 原子更新。 */
    SetConversationSnapshots(conversationId, snapshots) {
        return this.conversationService.SetSnapshots(conversationId, snapshots);
    }
    /** 读取会话上下文与 Tool Array 快照，供重启后恢复与原子重载基线。 */
    GetConversationSnapshots(conversationId) {
        return this.conversationService.GetSnapshots(conversationId);
    }
    /** 创建或更新简历，并在正文变化时追加版本快照；透传期望版本供冲突检测。 */
    UpsertResume(resume, expectedRevision) {
        return this.resumeService.Upsert(resume, expectedRevision);
    }
    /** 重命名简历，不产生内容版本；透传期望版本供冲突检测。 */
    RenameResume(id, name, expectedRevision) {
        return this.resumeService.Rename(id, name, expectedRevision);
    }
    /** 逻辑删除简历。 */
    DeleteResume(id) {
        return this.resumeService.Delete(id);
    }
    /** 返回一份简历的版本历史。 */
    GetResumeRevisions(resumeId) {
        return this.resumeService.GetRevisions(resumeId);
    }
    /** 标记或取消标记重要简历版本。 */
    SetResumeRevisionPinned(revisionId, pinned) {
        return this.resumeService.SetRevisionPinned(revisionId, pinned);
    }
    /** 创建或编辑岗位；透传期望版本供外部修改冲突检测。 */
    UpsertJob(job, expectedRevision) {
        return this.jobService.Upsert(job, expectedRevision);
    }
    /** 切换岗位收藏状态；透传期望版本供外部修改冲突检测。 */
    SetJobFavorite(id, favorite, expectedRevision) {
        return this.jobService.SetFavorite(id, favorite, expectedRevision);
    }
    /** 逻辑删除岗位。 */
    DeleteJob(id) {
        return this.jobService.Delete(id);
    }
    /** 创建或编辑投递；透传期望版本供外部修改冲突检测。 */
    UpsertApplication(application, expectedRevision) {
        return this.applicationService.Upsert(application, expectedRevision);
    }
    /** 推进投递状态并记录迁移事件；透传期望版本供外部修改冲突检测。 */
    MoveApplicationStatus(id, status, expectedRevision) {
        return this.applicationService.MoveStatus(id, status, expectedRevision);
    }
    /** 删除投递并级联清理事件。 */
    DeleteApplication(id) {
        return this.applicationService.Delete(id);
    }
    /** 读取档案唯一事实源；缺失或损坏时返回安全回退值，并认可磁盘内容为哈希基线。 */
    LoadProfiles(fallback) {
        return this.profileService.Load(fallback);
    }
    /** 读取档案及外部修改状态，供启动恢复与冲突界面使用。 */
    GetProfiles() {
        return this.profileService.Get();
    }
    /** 原子写入档案；检测到外部修改时除非强制覆盖（保留应用版本）否则拒绝。 */
    SaveProfiles(items, force = false) {
        return this.profileService.Save(items, force);
    }
    /** 重新加载磁盘档案版本并更新基线，供冲突界面「重新加载磁盘版本」使用。 */
    ReloadProfiles() {
        return this.profileService.Reload();
    }
    /** 返回档案最近一次读写维护的哈希基线，供外部修改检测使用。 */
    GetProfileHash() {
        return this.profileService.GetHash();
    }
    /** 读取已持久化的非敏感设置，并注入当前工作空间目录名掩码；未初始化时返回空对象。 */
    GetStoredSettings() {
        return { ...this.settingsService.GetStoredSettings(), workspaceName: (0, node_path_1.basename)(this.workspacePath) };
    }
    /** 持久化非敏感设置；app_state 仅作为设置兼容载体，不再承载业务实体。 */
    SaveSettings(settings) {
        return this.settingsService.Save(settings);
    }
    /** 复制、校验并准备切换到空目标目录；源工作空间保持不变以便发生故障时回退。 */
    CopyWorkspaceTo(destinationPath) {
        return this.workspaceService.CopyWorkspaceTo(destinationPath);
    }
    /** 复制用户主动选择的附件至工作空间内容寻址目录，并禁止向模型暴露源文件路径。 */
    ImportAttachment(sourcePath, mimeType = 'application/octet-stream') {
        return this.workspaceService.ImportAttachment(sourcePath, mimeType);
    }
    /** 扫描并清理已连续 7 天无引用的工作空间附件副本与 OCR 派生缓存；失败项保留墓碑供下次重试。 */
    CleanupAttachments(options) {
        return this.attachmentLifecycle.Cleanup(options);
    }
    /** 返回启动 Saga 恢复状态；blocked 时 Main 仅开放只读命令。 */
    GetWorkspaceRecoveryStatus() {
        return this.workspaceOperations.GetStatus();
    }
    /** 健康工作空间的数据库恢复状态。 */
    GetDatabaseRecoveryStatus() {
        return { mode: 'healthy', readOnly: false, reason: null, backups: [], canRestore: false };
    }
    RestoreLatestBackup() { throw new Error('Database recovery is not required.'); }
    RestoreBackup(_backupId) { throw new Error('Database recovery is not required.'); }
    ExportRecoveryDiagnostic() { throw new Error('Database recovery is not required.'); }
    /** 重新串行扫描未完成 Saga，供恢复界面重试。 */
    RecoverWorkspaceOperations() {
        return this.workspaceOperations.Recover({ synchronizeProfiles: (items) => this.profileService.SynchronizeAttachmentLinks(items) });
    }
    /** 将虚拟附件 URI 解析为受控工作空间文件，拒绝任意物理路径输入。 */
    ResolveAttachmentUri(uri) {
        return this.workspaceService.ResolveAttachmentUri(uri);
    }
    /** 创建一致性的业务数据库和档案备份；附件以原始内容寻址文件继续由 manifest 引用。 */
    CreateBackup() {
        return this.workspaceService.CreateBackup();
    }
    /** 关闭数据库句柄，供应用退出或后续工作空间迁移时安全调用。 */
    Close() {
        return this.workspaceService.Close();
    }
}
exports.BusinessStore = BusinessStore;
