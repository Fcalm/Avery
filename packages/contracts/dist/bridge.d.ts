import type { ApplicationDto, AttachmentDto, ChatMessageInput, ConversationDto, JobDto, ProfileItemDto, ResumeDto, ResumeRevisionDto, SettingsDto, WorkspaceStatusDto, WorkspaceViewModel } from './dto';
import type { WriteCommandOptions } from './envelope';
/** Agent 请求的显式窄字段：确认模式、附件、项目 ID 与简历 ID；业务只读快照（简历/档案）由后端按 ID 读取，不再整包透传前端组合态。 */
export interface AgentSendRequest {
    requestId: string;
    sessionId: string;
    content: string;
    model?: string;
    /** 请求级确认模式；缺省由后端场景默认。 */
    confirmationMode?: '需要确认' | '无需确认';
    attachments?: Array<{
        name: string;
        path: string;
    }>;
    projectId?: string;
    resumeId?: string;
}
/** Agent 流式事件：preload 单通道 `agent:stream` 的全部事件类型。 */
export interface AgentStreamEvent {
    type: 'thinking_delta' | 'content_delta' | 'completed' | 'cancelled' | 'error' | 'resume_updated' | 'resume_created' | 'resume_confirmation' | 'task_created' | 'task_updated' | 'question_requested' | 'waiting_user_input' | 'waiting_confirmation' | 'paused';
    requestId?: string;
    delta?: string;
    content?: string;
    thinkingContent?: string;
    message?: string;
    resumeId?: string;
    resumeName?: string;
    reason?: string;
    task?: {
        id: string;
        title: string;
        description: string;
        status: string;
    };
    confirmationId?: string;
    questions?: Array<{
        id: string;
        question: string;
        options: string[];
    }>;
}
/** Agent 模型配置：API Key 仅经 IPC 进入主进程 safeStorage。 */
export interface AgentConfiguration {
    provider: 'DeepSeek' | '自定义';
    apiKey: string;
    baseUrl: string;
    model: string;
    contextLength: string;
    compressionThreshold: number;
    thinkingEnabled: boolean;
}
/** Agent 运行指标：供开发者界面展示脱敏后的 Usage 与日志。 */
export interface AgentObservability {
    configured: boolean;
    model: string;
    historySessions: number;
    taskCount: number;
    contextUsage: {
        inputTokens: number;
        contextLimit: number;
        compressionCount: number;
        compressionThreshold: number;
    };
    logs: Array<{
        time: string;
        level: 'INFO' | 'WARN' | 'ERROR';
        event: string;
        detail: string;
    }>;
    traces: Array<{
        requestId: string;
        sessionId: string;
        model: string;
        state: string;
        summary: string;
        createdAt: number;
        completedAt: number | null;
        eventCount: number;
    }>;
}
/** 单会话的助手运行状态；用于恢复输入栏 usage 与项目环境，不含真实路径或凭据。 */
export interface AgentSessionAssistantState {
    usage: {
        inputTokens: number;
        contextLimit: number;
        compressionCount: number;
        compressionThreshold: number;
        source: 'actual' | 'unavailable' | 'legacy_estimate';
        promptTokens: number;
        completionTokens: number;
        totalTokens: number;
        reportedRequestCount: number;
        unreportedRequestCount: number;
    };
    project: {
        projectId: string | null;
        name: string;
    } | null;
}
/** 高级用户模块配置只返回目录掩码和校验状态，绝不向 Renderer 暴露绝对路径。 */
export interface AgentModuleConfiguration {
    enabled: boolean;
    trusted: boolean;
    status: 'default' | 'active' | 'blocked';
    directoryName: string | null;
    error?: string;
    modules: Array<{
        slot: string;
        name: string;
        version: string;
        sdkVersion: string;
        capabilities: string[];
    }>;
}
/** Agent Trace 事件：开发者模式只读。 */
export interface AgentTraceEvent {
    ordinal: number;
    eventType: string;
    payload: unknown;
    tokenCount: number;
    createdAt: number;
}
/** preload `offergetAgent` 命名空间的类型化 Bridge 接口。 */
export interface DesktopAgentBridge {
    Configure: (config: AgentConfiguration) => Promise<{
        configured: boolean;
    }>;
    TestConnection: (config: AgentConfiguration) => Promise<{
        connected: boolean;
    }>;
    GetBalance: () => Promise<{
        available: boolean;
        balances: Array<{
            currency: string;
            totalBalance: string;
        }>;
    }>;
    /** 读取当前凭据可访问的 DeepSeek 模型列表，凭据不会离开主进程。 */
    GetModels: () => Promise<{
        models: string[];
    }>;
    Send: (request: AgentSendRequest) => Promise<{
        accepted: boolean;
    }>;
    Cancel: (requestId: string) => Promise<{
        cancelled: boolean;
    }>;
    ConfirmResumeEdit: (confirmationId: string, accepted: boolean) => Promise<{
        applied: boolean;
    }>;
    /** 用户开始编辑简历前获取互斥锁；Agent 占用时返回未获取及原因。 */
    AcquireResumeEditLock: (resumeId: string) => Promise<{
        acquired: boolean;
        reason?: string;
    }>;
    /** 用户保存或取消编辑后释放简历锁。 */
    ReleaseResumeEditLock: (resumeId: string) => Promise<{
        released: boolean;
    }>;
    GetStatus: () => Promise<{
        configured: boolean;
        provider: string;
        model: string;
    }>;
    GetObservability: () => Promise<AgentObservability>;
    GetTraceEvents: (requestId: string) => Promise<AgentTraceEvent[]>;
    /** 按会话删除其全部 Trace 索引和事件，不影响日志与会话业务数据。 */
    DeleteTraces: (sessionIds: string[]) => Promise<{
        deleted: number;
    }>;
    SetTraceRetention: (value: number) => Promise<{
        traceRetention: number;
    }>;
    ClearObservability: () => Promise<{
        cleared: boolean;
    }>;
    ReloadSession: (sessionId: string) => Promise<{
        reloaded: boolean;
        sessionRevision?: number;
        reason?: string;
    }>;
    SelectProjectDirectory: () => Promise<{
        projectId: string;
        name: string;
    } | null>;
    /** 按会话读取 usage 与项目环境；绝不暴露项目绝对路径。 */
    GetSessionAssistantState: (sessionId: string) => Promise<AgentSessionAssistantState>;
    /** 将已由原生选择器授权的项目环境立即绑定到会话。 */
    BindProjectEnvironment: (sessionId: string, projectId: string) => Promise<AgentSessionAssistantState['project']>;
    GetModuleConfiguration: () => Promise<AgentModuleConfiguration>;
    SelectModuleDirectory: () => Promise<AgentModuleConfiguration>;
    ResetModules: () => Promise<AgentModuleConfiguration>;
    OnStream: (listener: (event: AgentStreamEvent) => void) => () => void;
}
/** preload `offergetWorkspace` 命名空间的类型化 Bridge 接口；形状与当前实现保持一致。 */
export interface WorkspaceBridge {
    GetStatus: () => Promise<WorkspaceStatusDto>;
    GetViewModel: () => Promise<WorkspaceViewModel>;
    GetSettings: () => Promise<Partial<SettingsDto>>;
    SaveSettings: (settings: Partial<SettingsDto>, options?: WriteCommandOptions) => Promise<{
        saved: boolean;
    }>;
    CreateConversation: (conversation: {
        id: string;
        title: string;
    }, options?: WriteCommandOptions) => Promise<ConversationDto>;
    RenameConversation: (id: string, title: string, expectedRevision?: number, options?: WriteCommandOptions) => Promise<{
        id: string;
        title: string;
        revision: number;
    }>;
    DeleteConversation: (id: string, options?: WriteCommandOptions) => Promise<{
        id: string;
    }>;
    AppendConversationMessages: (conversationId: string, messages: ChatMessageInput[], options?: WriteCommandOptions) => Promise<{
        conversationId: string;
        count: number;
    }>;
    CompleteConversationMessage: (conversationId: string, messageId: string, content: string, thinkingContent?: string, options?: WriteCommandOptions) => Promise<{
        conversationId: string;
        messageId: string;
    }>;
    RemoveConversationMessage: (conversationId: string, messageId: string, options?: WriteCommandOptions) => Promise<{
        conversationId: string;
        messageId: string;
    }>;
    UpsertResume: (resume: ResumeDto, expectedRevision?: number, options?: WriteCommandOptions) => Promise<{
        id: string;
        revision: number;
    }>;
    RenameResume: (id: string, name: string, expectedRevision?: number, options?: WriteCommandOptions) => Promise<{
        id: string;
        name: string;
        revision: number;
    }>;
    DeleteResume: (id: string, options?: WriteCommandOptions) => Promise<{
        id: string;
    }>;
    UpsertJob: (job: JobDto, expectedRevision?: number, options?: WriteCommandOptions) => Promise<{
        id: string;
        revision: number;
    }>;
    SetJobFavorite: (id: string, favorite: boolean, expectedRevision?: number, options?: WriteCommandOptions) => Promise<{
        id: string;
        isFavorite: boolean;
        revision: number;
    }>;
    DeleteJob: (id: string, options?: WriteCommandOptions) => Promise<{
        id: string;
    }>;
    UpsertApplication: (application: ApplicationDto, expectedRevision?: number, options?: WriteCommandOptions) => Promise<{
        id: string;
        revision: number;
    }>;
    MoveApplicationStatus: (id: string, status: string, expectedRevision?: number, options?: WriteCommandOptions) => Promise<{
        id: string;
        status: string;
        revision: number;
    }>;
    DeleteApplication: (id: string, options?: WriteCommandOptions) => Promise<{
        id: string;
    }>;
    GetProfiles: () => Promise<{
        items: ProfileItemDto[];
        hash: string | null;
        modified: boolean;
    }>;
    SaveProfiles: (items: ProfileItemDto[], force?: boolean, options?: WriteCommandOptions) => Promise<{
        count: number;
        hash: string;
    }>;
    ReloadProfiles: () => Promise<{
        items: ProfileItemDto[];
        hash: string | null;
    }>;
    ImportAttachment: (file: File, mimeType: string, options?: WriteCommandOptions) => Promise<AttachmentDto>;
    CleanupAttachments: (options?: WriteCommandOptions) => Promise<{
        scanned: number;
        logicallyDeleted: number;
        filesDeleted: number;
        cacheFilesDeleted: number;
        failed: number;
        pending: number;
    }>;
    GetRecoveryStatus: () => Promise<{
        recovering: boolean;
        blocked: boolean;
        recovered: number;
        failed: number;
        blockedCount?: number;
    }>;
    RecoverOperations: (options?: WriteCommandOptions) => Promise<{
        recovered: number;
        failed: number;
        blocked: number;
        writable: boolean;
    }>;
    GetDatabaseRecoveryStatus: () => Promise<{
        mode: 'healthy' | 'recovery';
        readOnly: boolean;
        reason: string | null;
        backups: Array<{
            id: string;
            valid: boolean;
            schemaVersion: number | null;
            createdAt: number;
        }>;
        canRestore: boolean;
    }>;
    RestoreLatestBackup: (options?: WriteCommandOptions) => Promise<{
        restored: boolean;
        backupId: string;
        sceneId: string;
    }>;
    RestoreBackup: (backupId: string, options?: WriteCommandOptions) => Promise<{
        restored: boolean;
        backupId: string;
        sceneId: string;
    }>;
    ExportRecoveryDiagnostic: (options?: WriteCommandOptions) => Promise<{
        exported: boolean;
        fileName: string;
    }>;
    CreateBackup: (options?: WriteCommandOptions) => Promise<{
        created: boolean;
        timestamp: number;
        retainedCount: number;
    }>;
    GetResumeRevisions: (resumeId: string) => Promise<ResumeRevisionDto[]>;
    SetResumeRevisionPinned: (revisionId: string, pinned: boolean, options?: WriteCommandOptions) => Promise<{
        id: string;
        isPinned: boolean;
    }>;
    ExportResume: (resume: {
        name: string;
        summary: string;
        content: string;
    }, format: 'pdf' | 'docx' | 'png') => Promise<{
        fileName: string;
        exported: boolean;
    }>;
    Migrate: () => Promise<WorkspaceStatusDto & {
        migration: unknown;
    }>;
}
/** Bridge 方法清单：preload 暴露的方法名唯一来源，供一致性冒烟校验与契约生成使用。 */
export declare const BridgeNamespaces: {
    readonly agent: readonly ['Configure', 'TestConnection', 'GetBalance', 'GetModels', 'Send', 'Cancel', 'ConfirmResumeEdit', 'AcquireResumeEditLock', 'ReleaseResumeEditLock', 'GetStatus', 'GetObservability', 'GetTraceEvents', 'DeleteTraces', 'SetTraceRetention', 'ClearObservability', 'ReloadSession', 'SelectProjectDirectory', 'GetSessionAssistantState', 'BindProjectEnvironment', 'GetModuleConfiguration', 'SelectModuleDirectory', 'ResetModules', 'OnStream'];
    readonly workspace: readonly ['GetStatus', 'GetViewModel', 'GetSettings', 'SaveSettings', 'CreateConversation', 'RenameConversation', 'DeleteConversation', 'AppendConversationMessages', 'CompleteConversationMessage', 'RemoveConversationMessage', 'UpsertResume', 'RenameResume', 'DeleteResume', 'UpsertJob', 'SetJobFavorite', 'DeleteJob', 'UpsertApplication', 'MoveApplicationStatus', 'DeleteApplication', 'GetProfiles', 'SaveProfiles', 'ReloadProfiles', 'ImportAttachment', 'CleanupAttachments', 'GetRecoveryStatus', 'RecoverOperations', 'GetDatabaseRecoveryStatus', 'RestoreLatestBackup', 'RestoreBackup', 'ExportRecoveryDiagnostic', 'CreateBackup', 'GetResumeRevisions', 'SetResumeRevisionPinned', 'ExportResume', 'Migrate'];
};
/** Bridge 命名空间名：agent → offergetAgent，workspace → offergetWorkspace。 */
export type BridgeNamespaceName = keyof typeof BridgeNamespaces;
