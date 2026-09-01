import { createHash, randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync, unlinkSync, rmdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { ResolveBusinessMigrationRoot } from './migration-paths';
import { GetNow, CreateId } from './electron/repositories/helpers';
import { ConversationRepository } from './electron/repositories/conversation-repository';
import { ResumeRepository } from './electron/repositories/resume-repository';
import { JobRepository } from './electron/repositories/job-repository';
import { ApplicationRepository } from './electron/repositories/application-repository';
import { ProfileRepository } from './electron/repositories/profile-repository';
import { CronTaskRepository } from './electron/repositories/cron-task-repository';
import { ConversationService } from './electron/backend/services/conversation-service';
import { ResumeService } from './electron/backend/services/resume-service';
import { JobService } from './electron/backend/services/job-service';
import { ApplicationService } from './electron/backend/services/application-service';
import { ProfileService } from './electron/backend/services/profile-service';
import { SettingsService } from './electron/backend/services/settings-service';
import { CronTaskService } from './electron/backend/services/cron-task-service';
import { WorkspaceService, EnsureWorkspaceDirectories } from './electron/backend/services/workspace-service';
import { AttachmentLifecycleService } from './electron/backend/services/attachment-lifecycle-service';
import { WorkspaceOperationService } from './electron/backend/services/workspace-operation-service';

// better-sqlite3 为原生模块，仅 Worker 进程加载（组合根不持有连接）；require 形态返回 any。
const Database = require('better-sqlite3') as any;

/** 业务迁移文件目录兼容仓库和打包后的 workspace 依赖位置。 */
const MigrationRoot = ResolveBusinessMigrationRoot(__dirname);

interface MigrationManifestEntry {
  version: number;
  checksumSeed: string;
  kind: string;
  file: string;
}

interface BusinessStoreOptions {
  upgradeFailure?: string;
}

/** 业务工作空间的 Infrastructure：持有单一数据库与各领域 Repository，组装各 Application Service 编排跨资源写入。 */
export class BusinessStore {
  workspacePath: string;
  databasePath: string;
  profilePath: string;
  db: any;
  conversations: ConversationRepository;
  resumes: ResumeRepository;
  jobs: JobRepository;
  applications: ApplicationRepository;
  profiles: ProfileRepository;
  cronTasks: CronTaskRepository;
  conversationService: ConversationService;
  resumeService: ResumeService;
  jobService: JobService;
  applicationService: ApplicationService;
  profileService: ProfileService;
  settingsService: SettingsService;
  cronTaskService: CronTaskService;
  workspaceService: WorkspaceService;
  attachmentLifecycle: AttachmentLifecycleService;
  workspaceOperations: WorkspaceOperationService;

  /** 初始化业务数据库，并确保每个工作空间只存在一个数据库事实源。 */
  constructor(workspacePath: string, options: BusinessStoreOptions = {}) {
    this.workspacePath = workspacePath;
    mkdirSync(workspacePath, { recursive: true });
    EnsureWorkspaceDirectories(workspacePath);
    this.databasePath = join(workspacePath, 'offerget.db');
    this.profilePath = join(workspacePath, 'profile.json');
    if (existsSync(this.databasePath) && statSync(this.databasePath).size === 0) throw new Error('Existing business database is empty or truncated.');
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
    } catch (error) {
      try {
        this.db.close();
      } catch {
        // 启动校验失败时尽力释放句柄，交由恢复门面接管。
      }
      throw error;
    }
    this.workspaceOperations = new WorkspaceOperationService({ db: this.db, workspacePath });
    this.attachmentLifecycle = new AttachmentLifecycleService({ db: this.db, workspacePath });
    this.conversations = new ConversationRepository({ db: this.db, attachmentLifecycle: this.attachmentLifecycle });
    this.resumes = new ResumeRepository({ db: this.db, attachmentLifecycle: this.attachmentLifecycle });
    this.jobs = new JobRepository({ db: this.db });
    this.applications = new ApplicationRepository({ db: this.db });
    this.profiles = new ProfileRepository({ profilePath: this.profilePath });
    this.cronTasks = new CronTaskRepository(this.db);
    this.conversationService = new ConversationService({ repository: this.conversations });
    this.resumeService = new ResumeService({ repository: this.resumes });
    this.jobService = new JobService({ repository: this.jobs });
    this.applicationService = new ApplicationService({ repository: this.applications });
    this.profileService = new ProfileService({ repository: this.profiles, db: this.db, attachmentLifecycle: this.attachmentLifecycle, workspaceOperations: this.workspaceOperations });
    this.settingsService = new SettingsService({ db: this.db });
    this.cronTaskService = new CronTaskService(this.cronTasks);
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
  private PreflightDatabase(): void {
    if (this.db.pragma('quick_check', { simple: true }) !== 'ok') throw new Error('Business database quick check failed.');
    const hasMigrations = this.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'").get();
    if (!hasMigrations) return;
    const manifest = this.ReadManifest();
    const expected = new Map(manifest.migrations.map((entry) => [entry.version, createHash('sha256').update(entry.checksumSeed).digest('hex')]));
    const appliedRows = this.db.prepare('SELECT version, checksum FROM schema_migrations ORDER BY version').all();
    for (const row of appliedRows) {
      if (!expected.has(row.version) || expected.get(row.version) !== row.checksum) throw new Error('Business database migration checksum mismatch.');
    }
    const expectedVersions = [...expected.keys()].sort((left, right) => left - right);
    const appliedVersions = appliedRows.map((row: any) => row.version);
    if (appliedVersions.some((version: number, index: number) => version !== expectedVersions[index])) {
      throw new Error('Business database migration history is not a contiguous manifest prefix.');
    }
    const hasMetadata = this.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'workspace_meta'").get();
    const metadata = hasMetadata ? this.db.prepare("SELECT schema_version FROM workspace_meta WHERE id = 'workspace'").get() : null;
    const maximum = Math.max(...expected.keys());
    if (metadata?.schema_version > maximum) throw new Error('Business database schema version is newer than this application.');
  }

  private ReadManifest(): { migrations: MigrationManifestEntry[] } {
    return JSON.parse(readFileSync(join(MigrationRoot, 'manifest.json'), 'utf8')) as { migrations: MigrationManifestEntry[] };
  }

  /**
   * 现有工作空间存在待执行迁移时，先创建可由恢复服务识别的完整备份。
   * 备份在任何 schema 写入前完成并复验，避免升级失败后只能依赖已被部分修改的数据库。
   */
  private CreatePreUpgradeBackupIfNeeded(): any {
    const manifest = this.ReadManifest();
    const hasMigrations = this.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'").get();
    if (!hasMigrations) return null;
    const appliedVersions = new Set<number>(this.db.prepare('SELECT version FROM schema_migrations').all().map((row: any) => row.version as number));
    const versions = manifest.migrations.map((entry) => entry.version);
    const pending = versions.filter((version) => !appliedVersions.has(version));
    if (pending.length === 0) return null;
    const fromVersion = Math.max(0, ...appliedVersions);
    const toVersion = Math.max(...versions);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const directoryName = `daily-pre-upgrade-v${fromVersion}-to-v${toVersion}-${stamp}-${randomUUID()}`;
    const directory = join(this.workspacePath, 'backups', directoryName);
    mkdirSync(directory, { recursive: false });
    try {
      const databaseBackupPath = join(directory, 'offerget.db');
      this.db.exec(`VACUUM INTO '${databaseBackupPath.replace(/'/g, "''")}'`);
      const backupDb = new Database(databaseBackupPath, { readonly: true, fileMustExist: true });
      try {
        if (backupDb.pragma('integrity_check', { simple: true }) !== 'ok') throw new Error('Pre-upgrade database backup failed integrity verification.');
        const metadata = backupDb.prepare("SELECT schema_version FROM workspace_meta WHERE id = 'workspace'").get();
        if (!metadata || metadata.schema_version > fromVersion) throw new Error('Pre-upgrade database backup schema is newer than the applied migration set.');
      } finally {
        backupDb.close();
      }
      const profileBackupPath = join(directory, 'profile.json');
      if (existsSync(this.profilePath)) {
        const profile = JSON.parse(readFileSync(this.profilePath, 'utf8'));
        if (!profile || !Array.isArray(profile.items)) throw new Error('Pre-upgrade profile backup source is invalid.');
        copyFileSync(this.profilePath, profileBackupPath);
      }
      const databaseBytes = readFileSync(databaseBackupPath);
      const profileBytes = existsSync(profileBackupPath) ? readFileSync(profileBackupPath) : null;
      const hasAttachments = this.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'attachments'").get();
      const attachments = hasAttachments ? this.db.prepare('SELECT sha256, storage_key FROM attachments WHERE deleted_at IS NULL ORDER BY sha256').all() : [];
      writeFileSync(join(directory, 'manifest.json'), JSON.stringify({
        createdAt: GetNow(), type: 'pre_upgrade', fromSchemaVersion: fromVersion, toSchemaVersion: toVersion,
        database: { file: 'offerget.db', sha256: createHash('sha256').update(databaseBytes).digest('hex') },
        profile: profileBytes ? { file: 'profile.json', sha256: createHash('sha256').update(profileBytes).digest('hex') } : null,
        attachments,
      }, null, 2), 'utf8');
      return { directoryName, fromVersion, toVersion };
    } catch (error) {
      for (const name of ['manifest.json', 'profile.json', 'offerget.db']) {
        const candidate = join(directory, name);
        try {
          if (existsSync(candidate)) unlinkSync(candidate);
        } catch {
          // 保留原始升级错误；残留由安全清理流程处理。
        }
      }
      try {
        rmdirSync(directory);
      } catch {
        // 非空或被替换时拒绝扩大删除范围。
      }
      throw error;
    }
  }

  /** 按 manifest 读取不可变迁移文件执行，并用 checksum 防止同版本迁移被静默改写；既有迁移的 checksum 基于版本标识，存量库保持一致。 */
  private RunMigrations(): void {
    const manifest = this.ReadManifest();
    this.db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, checksum TEXT NOT NULL UNIQUE, applied_at INTEGER NOT NULL);');
    for (const entry of manifest.migrations) {
      const checksum = createHash('sha256').update(entry.checksumSeed).digest('hex');
      const applied = this.db.prepare('SELECT checksum FROM schema_migrations WHERE version = ?').get(entry.version);
      if (applied && applied.checksum !== checksum) throw new Error(`Business database migration ${entry.version} checksum mismatch.`);
      if (!applied) {
        if (entry.kind === 'js') {
          const migration = require(join(MigrationRoot, entry.file));
          migration.up(this.db);
        } else {
          const sql = readFileSync(join(MigrationRoot, entry.file), 'utf8');
          this.db.exec(sql);
        }
        this.db.prepare('INSERT INTO schema_migrations(version, checksum, applied_at) VALUES(?, ?, ?)').run(entry.version, checksum, GetNow());
      }
    }
    const metadata = this.db.prepare("SELECT workspace_id FROM workspace_meta WHERE id = 'workspace'").get();
    const now = GetNow();
    const schemaVersion = Math.max(...manifest.migrations.map((entry) => entry.version));
    if (!metadata) {
      this.db.prepare("INSERT INTO workspace_meta(id, workspace_id, created_at, updated_at, last_opened_at, app_version, schema_version) VALUES('workspace', ?, ?, ?, ?, ?, ?)")
        .run(CreateId(), now, now, now, '0.1.0', schemaVersion);
    } else {
      this.db.prepare("UPDATE workspace_meta SET last_opened_at = ?, updated_at = ?, schema_version = ? WHERE id = 'workspace'").run(now, now, schemaVersion);
    }
  }

  /** 返回不含敏感配置的工作空间健康状态，供受限 IPC 与设置页展示。 */
  GetStatus(): any { return this.workspaceService.GetStatus(); }

  /** 从各领域 Application Service 聚合页面所需的业务 ViewModel；空库返回空集合而非种子。 */
  LoadViewModel(): any { return this.workspaceService.LoadViewModel(); }

  /** 新建会话并持久化；返回带应用层 ID 的会话记录供页面立即使用。 */
  CreateConversation(conversation: any): any { return this.conversationService.Create(conversation); }
  /** 重命名会话；透传期望版本供外部修改冲突检测。 */
  RenameConversation(id: string, title: string, expectedRevision?: number): any { return this.conversationService.Rename(id, title, expectedRevision); }
  /** 删除会话并级联清理其消息。 */
  DeleteConversation(id: string): any { return this.conversationService.Delete(id); }
  /** 向会话追加消息，按消息 ID 幂等写入。 */
  AppendConversationMessages(conversationId: string, messages: any[]): any { return this.conversationService.AppendMessages(conversationId, messages); }
  /** 写入流式占位消息的最终正文。 */
  CompleteConversationMessage(conversationId: string, messageId: string, content: string, thinkingContent?: string): any { return this.conversationService.CompleteMessage(conversationId, messageId, content, thinkingContent); }
  /** 移除未完成请求的临时占位消息。 */
  RemoveConversationMessage(conversationId: string, messageId: string): any { return this.conversationService.RemoveMessage(conversationId, messageId); }
  /** 同时写入会话上下文与 Tool Array 两类快照，供 /reload-session 原子更新。 */
  SetConversationSnapshots(conversationId: string, snapshots: any): any { return this.conversationService.SetSnapshots(conversationId, snapshots); }
  /** 读取会话上下文与 Tool Array 快照，供重启后恢复与原子重载基线。 */
  GetConversationSnapshots(conversationId: string): any { return this.conversationService.GetSnapshots(conversationId); }
  /** 创建或更新简历，并在正文变化时追加版本快照；透传期望版本供冲突检测。 */
  UpsertResume(resume: any, expectedRevision?: number): any { return this.resumeService.Upsert(resume, expectedRevision); }
  /** 重命名简历，不产生内容版本；透传期望版本供冲突检测。 */
  RenameResume(id: string, name: string, expectedRevision?: number): any { return this.resumeService.Rename(id, name, expectedRevision); }
  /** 逻辑删除简历。 */
  DeleteResume(id: string): any { return this.resumeService.Delete(id); }
  /** 返回一份简历的版本历史。 */
  GetResumeRevisions(resumeId: string): any { return this.resumeService.GetRevisions(resumeId); }
  /** 标记或取消标记重要简历版本。 */
  SetResumeRevisionPinned(revisionId: string, pinned: boolean): any { return this.resumeService.SetRevisionPinned(revisionId, pinned); }
  /** 创建或编辑岗位；透传期望版本供外部修改冲突检测。 */
  UpsertJob(job: any, expectedRevision?: number): any { return this.jobService.Upsert(job, expectedRevision); }
  /** 切换岗位收藏状态；透传期望版本供外部修改冲突检测。 */
  SetJobFavorite(id: string, favorite: boolean, expectedRevision?: number): any { return this.jobService.SetFavorite(id, favorite, expectedRevision); }
  /** 逻辑删除岗位。 */
  DeleteJob(id: string): any { return this.jobService.Delete(id); }
  /** 创建或编辑投递；透传期望版本供外部修改冲突检测。 */
  UpsertApplication(application: any, expectedRevision?: number): any { return this.applicationService.Upsert(application, expectedRevision); }
  /** 推进投递状态并记录迁移事件；透传期望版本供外部修改冲突检测。 */
  MoveApplicationStatus(id: string, status: string, expectedRevision?: number): any { return this.applicationService.MoveStatus(id, status, expectedRevision); }
  /** 删除投递并级联清理事件。 */
  DeleteApplication(id: string): any { return this.applicationService.Delete(id); }
  /** Agent 投递状态写入：岗位和投递在同一数据库事务中更新，避免只保存其中一半。 */
  UpdateApplicationTracking(input: any): any {
    if (!input || typeof input !== 'object') throw new Error('Application tracking input is invalid.');
    const run = this.db.transaction(() => {
      const job = {
        id: input.jobId, company: input.company, title: input.title, city: input.city ?? '', experience: input.experience ?? '',
        employmentType: input.employmentType ?? 'full_time', channel: input.channel ?? 'company_website', favorite: false,
        url: input.url, jd: input.jd ?? '',
      };
      const existingJob = this.jobs.ListAll().find((item: any) => item.id === input.jobId);
      const savedJob = this.jobService.Upsert({ ...(existingJob ?? {}), ...job }, existingJob?.revision);
      const existingApplication = this.applications.ListAll().find((item: any) => item.id === input.applicationId);
      const savedApplication = this.applicationService.Upsert({
        ...(existingApplication ?? {}), id: input.applicationId, jobId: input.jobId, resumeId: input.resumeId,
        status: input.status, note: input.note ?? existingApplication?.note ?? '', ...(input.appliedAt ? { appliedAt: input.appliedAt } : {}),
      }, existingApplication?.revision);
      return { jobId: savedJob.id, applicationId: savedApplication.id, jobRevision: savedJob.revision, applicationRevision: savedApplication.revision, status: input.status };
    });
    return run();
  }
  /** 创建已由交互 Harness 确认的定时任务。 */
  CreateCronTask(input: unknown, resourceContext?: { resumeId?: string }): any { return this.cronTaskService.Create(input, resourceContext); }
  /** 读取定时任务及可选运行历史。 */
  ReadCronTask(input?: { cronTaskId?: string; includeRuns?: boolean }): any { return this.cronTaskService.Read(input); }
  /** 修改计划内容、调度或暂停状态。 */
  UpdateCronTask(input: unknown, expectedRevision?: number): any { return this.cronTaskService.Update(input, expectedRevision); }
  /** 软删除定时任务，保留已经产生的会话和 CronRun。 */
  DeleteCronTask(id: string): any { return this.cronTaskService.Delete(id); }
  /** 原子领取到期 occurrence；只返回每个任务最近一次可执行项。 */
  ClaimDueCronTasks(now?: number): any { return this.cronTaskService.ClaimDue(now); }
  AttachCronRunConversation(runId: string, conversationId: string): any { this.cronTaskService.AttachConversation(runId, conversationId); return { runId, conversationId }; }
  FinishCronRun(runId: string, state: string, reason?: string): any { return this.cronTaskService.FinishRun(runId, state, reason); }
  RecoverInterruptedCronRuns(): any { return { recovered: this.cronTaskService.RecoverInterruptedRuns() }; }
  GetEarliestCronRunAt(): any { return { nextRunAt: this.cronTaskService.EarliestNextRunAt() }; }
  /** 读取档案唯一事实源；缺失或损坏时返回安全回退值，并认可磁盘内容为哈希基线。 */
  LoadProfiles(fallback: any): any { return this.profileService.Load(fallback); }
  /** 读取档案及外部修改状态，供启动恢复与冲突界面使用。 */
  GetProfiles(): any { return this.profileService.Get(); }
  /** 原子写入档案；检测到外部修改时除非强制覆盖（保留应用版本）否则拒绝。 */
  SaveProfiles(items: any[], force = false): any { return this.profileService.Save(items, force); }
  /** 重新加载磁盘档案版本并更新基线，供冲突界面「重新加载磁盘版本」使用。 */
  ReloadProfiles(): any { return this.profileService.Reload(); }
  /** 返回档案最近一次读写维护的哈希基线，供外部修改检测使用。 */
  GetProfileHash(): any { return this.profileService.GetHash(); }
  /** 读取已持久化的非敏感设置，并注入当前工作空间目录名掩码；未初始化时返回空对象。 */
  GetStoredSettings(): any { return { ...this.settingsService.GetStoredSettings(), workspaceName: basename(this.workspacePath) }; }
  /** 持久化非敏感设置；app_state 仅作为设置兼容载体，不再承载业务实体。 */
  SaveSettings(settings: any): any { return this.settingsService.Save(settings); }
  /** 复制、校验并准备切换到空目标目录；源工作空间保持不变以便发生故障时回退。 */
  CopyWorkspaceTo(destinationPath: string): any { return this.workspaceService.CopyWorkspaceTo(destinationPath); }
  /** 复制用户主动选择的附件至工作空间内容寻址目录，并禁止向模型暴露源文件路径。 */
  ImportAttachment(sourcePath: string, mimeType = 'application/octet-stream'): Promise<any> { return this.workspaceService.ImportAttachment(sourcePath, mimeType); }
  /** 扫描并清理已连续 7 天无引用的工作空间附件副本与 OCR 派生缓存；失败项保留墓碑供下次重试。 */
  CleanupAttachments(options?: any): any { return this.attachmentLifecycle.Cleanup(options); }
  /** 返回启动 Saga 恢复状态；blocked 时 Main 仅开放只读命令。 */
  GetWorkspaceRecoveryStatus(): any { return this.workspaceOperations.GetStatus(); }
  /** 健康工作空间的数据库恢复状态。 */
  GetDatabaseRecoveryStatus(): any { return { mode: 'healthy', readOnly: false, reason: null, backups: [], canRestore: false }; }
  RestoreLatestBackup(): any { throw new Error('Database recovery is not required.'); }
  RestoreBackup(_backupId: string): any { throw new Error('Database recovery is not required.'); }
  ExportRecoveryDiagnostic(): any { throw new Error('Database recovery is not required.'); }
  /** 重新串行扫描未完成 Saga，供恢复界面重试。 */
  RecoverWorkspaceOperations(): any { return this.workspaceOperations.Recover({ synchronizeProfiles: (items) => this.profileService.SynchronizeAttachmentLinks(items) }); }
  /** 将虚拟附件 URI 解析为受控工作空间文件，拒绝任意物理路径输入。 */
  ResolveAttachmentUri(uri: string): any { return this.workspaceService.ResolveAttachmentUri(uri); }
  ResolveAttachmentMarkdownUri(uri: string): Promise<any> { return this.workspaceService.ResolveAttachmentMarkdownUri(uri); }
  /** 创建一致性的业务数据库和档案备份；附件以原始内容寻址文件继续由 manifest 引用。 */
  CreateBackup(): any { return this.workspaceService.CreateBackup(); }
  /** 关闭数据库句柄，供应用退出或后续工作空间迁移时安全调用。 */
  Close(): any { return this.workspaceService.Close(); }
}
