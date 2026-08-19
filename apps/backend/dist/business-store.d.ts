import { ConversationRepository } from './electron/repositories/conversation-repository';
import { ResumeRepository } from './electron/repositories/resume-repository';
import { JobRepository } from './electron/repositories/job-repository';
import { ApplicationRepository } from './electron/repositories/application-repository';
import { ProfileRepository } from './electron/repositories/profile-repository';
import { ConversationService } from './electron/backend/services/conversation-service';
import { ResumeService } from './electron/backend/services/resume-service';
import { JobService } from './electron/backend/services/job-service';
import { ApplicationService } from './electron/backend/services/application-service';
import { ProfileService } from './electron/backend/services/profile-service';
import { SettingsService } from './electron/backend/services/settings-service';
import { WorkspaceService } from './electron/backend/services/workspace-service';
import { AttachmentLifecycleService } from './electron/backend/services/attachment-lifecycle-service';
import { WorkspaceOperationService } from './electron/backend/services/workspace-operation-service';
interface BusinessStoreOptions {
    upgradeFailure?: string;
}
/** 业务工作空间的 Infrastructure：持有单一数据库与各领域 Repository，组装各 Application Service 编排跨资源写入。 */
export declare class BusinessStore {
    workspacePath: string;
    databasePath: string;
    profilePath: string;
    db: any;
    conversations: ConversationRepository;
    resumes: ResumeRepository;
    jobs: JobRepository;
    applications: ApplicationRepository;
    profiles: ProfileRepository;
    conversationService: ConversationService;
    resumeService: ResumeService;
    jobService: JobService;
    applicationService: ApplicationService;
    profileService: ProfileService;
    settingsService: SettingsService;
    workspaceService: WorkspaceService;
    attachmentLifecycle: AttachmentLifecycleService;
    workspaceOperations: WorkspaceOperationService;
    /** 初始化业务数据库，并确保每个工作空间只存在一个数据库事实源。 */
    constructor(workspacePath: string, options?: BusinessStoreOptions);
    /** 迁移前轻量检查：拒绝损坏页、未知更高 schema 和已登记 checksum 异常，绝不以空库覆盖。 */
    private PreflightDatabase;
    private ReadManifest;
    /**
     * 现有工作空间存在待执行迁移时，先创建可由恢复服务识别的完整备份。
     * 备份在任何 schema 写入前完成并复验，避免升级失败后只能依赖已被部分修改的数据库。
     */
    private CreatePreUpgradeBackupIfNeeded;
    /** 按 manifest 读取不可变迁移文件执行，并用 checksum 防止同版本迁移被静默改写；既有迁移的 checksum 基于版本标识，存量库保持一致。 */
    private RunMigrations;
    /** 返回不含敏感配置的工作空间健康状态，供受限 IPC 与设置页展示。 */
    GetStatus(): any;
    /** 从各领域 Application Service 聚合页面所需的业务 ViewModel；空库返回空集合而非种子。 */
    LoadViewModel(): any;
    /** 新建会话并持久化；返回带应用层 ID 的会话记录供页面立即使用。 */
    CreateConversation(conversation: any): any;
    /** 重命名会话；透传期望版本供外部修改冲突检测。 */
    RenameConversation(id: string, title: string, expectedRevision?: number): any;
    /** 删除会话并级联清理其消息。 */
    DeleteConversation(id: string): any;
    /** 向会话追加消息，按消息 ID 幂等写入。 */
    AppendConversationMessages(conversationId: string, messages: any[]): any;
    /** 写入流式占位消息的最终正文。 */
    CompleteConversationMessage(conversationId: string, messageId: string, content: string, thinkingContent?: string): any;
    /** 移除未完成请求的临时占位消息。 */
    RemoveConversationMessage(conversationId: string, messageId: string): any;
    /** 同时写入会话上下文与 Tool Array 两类快照，供 /reload-session 原子更新。 */
    SetConversationSnapshots(conversationId: string, snapshots: any): any;
    /** 读取会话上下文与 Tool Array 快照，供重启后恢复与原子重载基线。 */
    GetConversationSnapshots(conversationId: string): any;
    /** 创建或更新简历，并在正文变化时追加版本快照；透传期望版本供冲突检测。 */
    UpsertResume(resume: any, expectedRevision?: number): any;
    /** 重命名简历，不产生内容版本；透传期望版本供冲突检测。 */
    RenameResume(id: string, name: string, expectedRevision?: number): any;
    /** 逻辑删除简历。 */
    DeleteResume(id: string): any;
    /** 返回一份简历的版本历史。 */
    GetResumeRevisions(resumeId: string): any;
    /** 标记或取消标记重要简历版本。 */
    SetResumeRevisionPinned(revisionId: string, pinned: boolean): any;
    /** 创建或编辑岗位；透传期望版本供外部修改冲突检测。 */
    UpsertJob(job: any, expectedRevision?: number): any;
    /** 切换岗位收藏状态；透传期望版本供外部修改冲突检测。 */
    SetJobFavorite(id: string, favorite: boolean, expectedRevision?: number): any;
    /** 逻辑删除岗位。 */
    DeleteJob(id: string): any;
    /** 创建或编辑投递；透传期望版本供外部修改冲突检测。 */
    UpsertApplication(application: any, expectedRevision?: number): any;
    /** 推进投递状态并记录迁移事件；透传期望版本供外部修改冲突检测。 */
    MoveApplicationStatus(id: string, status: string, expectedRevision?: number): any;
    /** 删除投递并级联清理事件。 */
    DeleteApplication(id: string): any;
    /** 读取档案唯一事实源；缺失或损坏时返回安全回退值，并认可磁盘内容为哈希基线。 */
    LoadProfiles(fallback: any): any;
    /** 读取档案及外部修改状态，供启动恢复与冲突界面使用。 */
    GetProfiles(): any;
    /** 原子写入档案；检测到外部修改时除非强制覆盖（保留应用版本）否则拒绝。 */
    SaveProfiles(items: any[], force?: boolean): any;
    /** 重新加载磁盘档案版本并更新基线，供冲突界面「重新加载磁盘版本」使用。 */
    ReloadProfiles(): any;
    /** 返回档案最近一次读写维护的哈希基线，供外部修改检测使用。 */
    GetProfileHash(): any;
    /** 读取已持久化的非敏感设置，并注入当前工作空间目录名掩码；未初始化时返回空对象。 */
    GetStoredSettings(): any;
    /** 持久化非敏感设置；app_state 仅作为设置兼容载体，不再承载业务实体。 */
    SaveSettings(settings: any): any;
    /** 复制、校验并准备切换到空目标目录；源工作空间保持不变以便发生故障时回退。 */
    CopyWorkspaceTo(destinationPath: string): any;
    /** 复制用户主动选择的附件至工作空间内容寻址目录，并禁止向模型暴露源文件路径。 */
    ImportAttachment(sourcePath: string, mimeType?: string): any;
    /** 扫描并清理已连续 7 天无引用的工作空间附件副本与 OCR 派生缓存；失败项保留墓碑供下次重试。 */
    CleanupAttachments(options?: any): any;
    /** 返回启动 Saga 恢复状态；blocked 时 Main 仅开放只读命令。 */
    GetWorkspaceRecoveryStatus(): any;
    /** 健康工作空间的数据库恢复状态。 */
    GetDatabaseRecoveryStatus(): any;
    RestoreLatestBackup(): any;
    RestoreBackup(_backupId: string): any;
    ExportRecoveryDiagnostic(): any;
    /** 重新串行扫描未完成 Saga，供恢复界面重试。 */
    RecoverWorkspaceOperations(): any;
    /** 将虚拟附件 URI 解析为受控工作空间文件，拒绝任意物理路径输入。 */
    ResolveAttachmentUri(uri: string): any;
    /** 创建一致性的业务数据库和档案备份；附件以原始内容寻址文件继续由 manifest 引用。 */
    CreateBackup(): any;
    /** 关闭数据库句柄，供应用退出或后续工作空间迁移时安全调用。 */
    Close(): any;
}
export {};
