import { ResumeLockStore } from './resume-lock-store';
interface AgentHostOptions {
    userDataPath: string;
    workspacePath: string;
    Emit(event: unknown): void;
    business: any;
    observability: any;
    credentialPort: any;
    resolveProjectEnvironment?: (projectId: string) => Promise<unknown> | unknown;
    resumeLockStore?: ResumeLockStore;
}
/**
 * Agent 宿主组合根：替代 agent-runtime.cjs。
 * 持有配置凭据、会话/任务/项目环境内存态与快照持久化；Send 委托 agent-core RunAgentLoop，
 * 六槽默认实现由 defaults 包提供、经 module-host ResolveModules 校验装配。
 */
export declare class AgentHost {
    private statePath;
    private moduleConfigPath;
    private Emit;
    private business;
    private observabilityPort;
    private credentialPort;
    private resolveProjectEnvironment;
    private controllers;
    private histories;
    private tasks;
    private pendingQuestions;
    private pendingEdits;
    private projectEnvironments;
    private sessionSnapshots;
    private sessionReloadNotices;
    private sessionUsage;
    private lastContextUsage;
    private compressionCount;
    private fileReader;
    private resumePort;
    private resumeReadPort;
    private resumeWritePort;
    private moduleError;
    private moduleConfiguration;
    private moduleSnapshot;
    private modules;
    constructor(options: AgentHostOptions);
    SetWorkspacePath(workspacePath: string): void;
    Close(): Promise<void>;
    /** 构造官方默认六槽；端口全部由宿主持有。 */
    private CreateDefaults;
    /** 从受信任目录读取 offerget-modules.json，并把入口约束在该目录真实路径内。 */
    private LoadModuleOverrides;
    /** 装配默认或用户覆盖六槽；失败配置保持阻断状态，不静默回退执行 Agent。 */
    private BuildModules;
    private EnsureModulesReady;
    GetModuleConfiguration(): any;
    /** 用户在原生目录选择器中明确选择并信任目录后启用；无效配置被持久化为 blocked，供 UI 显式恢复默认。 */
    ConfigureUserModules(directoryPath: string): any;
    ResetUserModules(): any;
    /** 返回是否有未结束的 Agent 请求；工作空间迁移期间必须保持空闲。 */
    IsBusy(): boolean;
    /** 读取不含密钥的会话与任务状态；损坏文件只会回退为空状态。 */
    private LoadState;
    /** 原子写入不含 API Key 的受保护运行状态。 */
    private SaveState;
    /** 保存经校验的模型配置，API Key 经端口移交主进程 safeStorage 加密落盘。 */
    Configure(input: unknown): any;
    /** 使用表单临时配置测试连通性，不写入配置。 */
    TestConnection(config: unknown): any;
    /** 查询已加密保存的 DeepSeek Key 对应余额；不会向渲染层暴露凭据。 */
    GetBalance(): any;
    /** 查询当前凭据可访问的 DeepSeek 模型；不会向渲染层暴露凭据。 */
    GetModels(): any;
    /** 返回脱敏的配置状态。 */
    GetStatus(): any;
    /** 中止指定在途请求。 */
    Cancel(requestId: string): any;
    /** 应用或丢弃待确认的简历补丁：接受时经简历写端口落库并释放 Agent 锁。 */
    ConfirmResumeEdit(confirmationId: string, accepted: boolean): any;
    /** 用户开始编辑简历前获取互斥锁；Agent 占用时返回未获取及原因。 */
    AcquireResumeEditLock(resumeId: string): Promise<any>;
    /** 用户保存或取消编辑后释放简历锁。 */
    ReleaseResumeEditLock(resumeId: string): Promise<any>;
    /** 绑定单会话单项目目录；会话一旦绑定，后续请求不得切换到其它目录；项目只经 projectId 掩码解析真实路径。 */
    BindProjectEnvironment(sessionId: string, projectId: string): Promise<string | null>;
    /** 返回会话专属 usage 和脱敏项目标签；默认值绝不回退到其它会话。 */
    GetSessionAssistantState(sessionId: string): any;
    /** 将每次已完成模型请求的 usage 合并到单会话账本；缺失值仅记未上报，绝不估算。 */
    private RecordSessionUsage;
    /** 构建不可变的 Tool Array 快照：内置工具固定前缀、MCP 预留末尾；不保存 MCP 凭据。 */
    private BuildToolSnapshot;
    private BuildModuleSnapshot;
    /** 创建两份快照并原子写入会话表；供首次发送与原子重载使用。 */
    private CreateAndPersistSnapshots;
    /** 读取或惰性创建会话快照：内存缓存优先，其次会话表，最后新建并持久化。 */
    private LoadOrCreateSnapshots;
    /** 空闲时原子重载会话上下文与 Tool 快照；任一步失败保留旧快照。 */
    ReloadSession(sessionId: string): Promise<any>;
    /** 在显式状态机内执行一次受限的流式对话回合：编排完成后委托 Kernel 运行循环。 */
    Send(input: any): Promise<any>;
    /** 聚合运行时内存态与可观测性库数据，供开发者界面展示脱敏日志与 Trace。 */
    GetObservability(): Promise<any>;
    /** 按请求标识读取开发者主动展开的 Trace 事件。 */
    GetTraceEvents(requestId: string): any;
    /** 按会话删除对应的 Trace 索引及其事件，不影响日志或业务会话。 */
    DeleteTraces(sessionIds: string[]): any;
    /** 更新开发者可见的 Trace 留存量，不接收任何敏感配置。 */
    SetTraceRetention(value: number): any;
    /** 清空开发者模式可见的日志与 Trace，不影响会话、任务和 API 配置。 */
    ClearObservability(): any;
}
export {};
