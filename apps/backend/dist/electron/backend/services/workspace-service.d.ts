/** 原子创建工作空间内需要的目录，避免附件和备份服务各自处理目录初始化。 */
export declare function EnsureWorkspaceDirectories(workspacePath: string): void;
/** 工作空间的应用服务：状态、聚合视图、附件导入、备份、迁移与审计，持有业务数据库的唯一写句柄。 */
export declare class WorkspaceService {
    private db;
    private conversations;
    private resumes;
    private jobs;
    private applications;
    private workspacePath;
    private profilePath;
    private attachmentLifecycle;
    private workspaceOperations;
    private databasePath;
    private integrityCache;
    constructor({ db, conversationService, resumeService, jobService, applicationService, workspacePath, profilePath, attachmentLifecycle, workspaceOperations }: any);
    /** 执行完整 integrity_check 并缓存 30 秒；未过期直接返回缓存结果，避免高频状态查询触发全库扫描。 */
    RunIntegrityCheck(): string;
    /** 返回不含敏感配置的工作空间健康状态；只暴露目录名掩码，绝不包含绝对路径。 */
    GetStatus(): any;
    /** 从各领域 Application Service 聚合页面所需的业务 ViewModel；空库返回空集合而非种子。 */
    LoadViewModel(): any;
    /** 复制、校验并准备切换到空目标目录；源工作空间保持不变以便发生故障时回退；拒绝符号链接/Junction 目标。 */
    CopyWorkspaceTo(destinationPath: string): any;
    /** 复制用户主动选择的附件至工作空间内容寻址目录，并禁止向模型暴露源文件路径。 */
    ImportAttachment(sourcePath: string, mimeType?: string): any;
    /** 将虚拟附件 URI 解析为受控工作空间文件，拒绝任意物理路径输入。 */
    ResolveAttachmentUri(uri: string): any;
    /** 创建一致性的业务数据库和档案备份；附件以原始内容寻址文件继续由 manifest 引用；只返回掩码结果，不含备份目录路径。 */
    CreateBackup(): any;
    /** 只删除本服务生成且超出 7 份限制的日备份目录。 */
    PruneDailyBackups(): void;
    /** 关闭数据库句柄，供应用退出或后续工作空间迁移时安全调用。 */
    Close(): void;
}
