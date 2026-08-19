import type { ModuleManifest } from './manifest';
import type { RegisteredAgentTool, ToolContext } from './tools';
import type { AgentMessage, CompiledInstructions, LogEntry, ModelCompletion, ModelDelta, ModelSummary, RuntimeContext, ToolCallFragment, ToolExecutionResult, TraceEntry, TraceEventEntry } from './types';
/** 会话上下文快照来源：如用户自定义上下文。 */
export interface SessionContextSource {
    type: string;
    name: string;
    content: string;
    contentHash: string;
}
/** 不可变的会话上下文快照。 */
export interface SessionContextSnapshot {
    snapshotId: string;
    sessionId: string;
    sessionRevision: number;
    sources: SessionContextSource[];
}
/** 模型 Provider 槽：配置、连通性、请求级模型解析、流式补全、摘要与规模估算。 */
export interface ModelProviderModule extends ModuleManifest {
    slot: 'model-provider';
    Configure(input: unknown): Promise<{
        configured: boolean;
        provider: string;
        model: string;
    }>;
    TestConnection(input: unknown): Promise<{
        connected: boolean;
        provider: string;
        baseUrl: string;
    }>;
    GetBalance(): Promise<{
        available: boolean;
        balances: Array<{
            currency: string;
            totalBalance: string;
        }>;
    }>;
    GetModels(): Promise<{
        models: string[];
    }>;
    GetStatus(): Promise<{
        configured: boolean;
        provider: string;
        model: string;
    }>;
    ResolveRequestModel(requestedModel: string | undefined): string;
    StreamCompletion(request: {
        requestId: string;
        model: string;
        history: AgentMessage[];
        tools: RegisteredAgentTool[];
        signal: AbortSignal;
        onDelta: (delta: ModelDelta) => void;
        /** 运行前由 Prompt Compiler 编译的指令；Provider 不再持有业务 System Prompt 所有权。 */
        instructions?: CompiledInstructions;
    }): Promise<ModelCompletion>;
    CreateSummary(model: string, messages: AgentMessage[]): Promise<ModelSummary>;
    EstimateTokens(value: unknown): number;
    /** 返回上下文长度上限与压缩阈值百分比；供 Kernel 与宿主读取。 */
    GetRuntimeLimits(): {
        contextLimit: number;
        threshold: number;
    };
    /** 返回当前 BaseUrl，供连通性等只读展示（不含密钥）。 */
    BaseUrl(): string;
    /** 返回模块拥有的场景系统提示；Kernel 估算与请求共用，保证估算口径与实际请求一致。 */
    SystemPrompt(): string;
}
/** 上下文构建槽：读取业务只读快照并序列化为会话上下文。 */
export interface ContextBuilderModule extends ModuleManifest {
    slot: 'context-builder';
    BuildSessionContextSnapshot(sessionId: string, sessionRevision: number): Promise<SessionContextSnapshot>;
    SerializeSessionContext(snapshot: SessionContextSnapshot): string;
    /** 业务快照变化时返回动态快照消息；否则返回 unchanged。 */
    CreateDynamicSnapshot(sessionId: string, context: RuntimeContext | null): {
        changed: boolean;
        message: AgentMessage | null;
    };
}
/** 压缩槽：判定、切分与降级原语；摘要生成由 model-provider 承担，重试循环在 Kernel。 */
export interface CompactionModule extends ModuleManifest {
    slot: 'compaction';
    ShouldCompact(estimate: number, contextLimit: number, threshold: number): boolean;
    SplitRecentTurns(history: AgentMessage[]): {
        earlier: AgentMessage[];
        recent: AgentMessage[];
    };
    DropOldestTurns(history: AgentMessage[], count: number): AgentMessage[];
    /** 按完整 TurnGroup 保留最近 count 组；供 Kernel 保存历史快照。 */
    KeepRecentTurnGroups?(history: AgentMessage[], count: number): AgentMessage[];
}
/** 工具槽：统一执行管道（Schema 校验/一次修复/幂等/超时/结构化错误码）；权限由宿主注入窄端口约束。 */
export interface ToolsModule extends ModuleManifest {
    slot: 'tools';
    capabilities: string[];
    GetToolDefinitions(): RegisteredAgentTool[];
    ExecuteToolCall(call: ToolCallFragment, context: ToolContext): Promise<ToolExecutionResult>;
}
/** 交互槽：澄清提问与简历确认的宿主侧状态与事件；AskUserQuestion 作为内置工具由 tools 槽直接实现。 */
export interface InteractionModule extends ModuleManifest {
    slot: 'interaction';
    /** 应用或丢弃待确认简历补丁：接受时经 resumeWrite 端口落库并释放锁；确认标识只能使用一次。 */
    ConfirmResumeEdit(confirmationId: string, accepted: boolean, context: ToolContext): Promise<{
        applied: boolean;
    }>;
    GetPendingQuestions(sessionId: string, pendingQuestions: Map<string, unknown>): unknown;
    ClearPendingQuestion(sessionId: string, pendingQuestions: Map<string, unknown>): void;
}
/** 可观测性槽：本地日志缓冲 + 后端 Trace 存储端口；读失败返回 undefined 由调用方兜底。 */
export interface ObservabilityModule extends ModuleManifest {
    slot: 'observability';
    RecordLog(level: 'INFO' | 'WARN' | 'ERROR', event: string, detail: string): void;
    StartTrace(requestId: string, sessionId: string, model: string): void;
    AppendTraceEvent(requestId: string, eventType: string, payload: unknown, tokenCount?: number): void;
    FinishTrace(requestId: string, state: string, summary: string): void;
    GetLogs(): Promise<LogEntry[]>;
    GetTraces(): Promise<TraceEntry[]>;
    GetTraceEvents(requestId: string): Promise<TraceEventEntry[]>;
    DeleteTraces(sessionIds: string[]): Promise<{
        deleted: number;
    }>;
    SetTraceRetention(value: number): Promise<{
        traceRetention: number;
    }>;
    ClearObservability(): Promise<{
        cleared: boolean;
    }>;
    /** 返回本地日志缓冲（供宿主聚合开发者页面数据）。 */
    SnapshotLocalLogs(): LogEntry[];
}
/** 六槽聚合：Kernel 的唯一模块入口。 */
export interface AgentModules {
    modelProvider: ModelProviderModule;
    contextBuilder: ContextBuilderModule;
    compaction: CompactionModule;
    tools: ToolsModule;
    interaction: InteractionModule;
    observability: ObservabilityModule;
}
/** 槽位名 → AgentModules 聚合键名映射：SlotOrder 为连字符命名，聚合键为驼峰命名。 */
export declare const SlotToModuleKey: {
    readonly 'model-provider': 'modelProvider';
    readonly 'context-builder': 'contextBuilder';
    readonly compaction: 'compaction';
    readonly tools: 'tools';
    readonly interaction: 'interaction';
    readonly observability: 'observability';
};
