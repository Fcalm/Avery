/** Agent 模块契约的基础类型：消息、模型增量、工具结果与业务只读快照形状。 */
/** Transcript 消息角色；与既有 Chat Completions 协议保持一致。 */
export type AgentRole = 'system' | 'user' | 'assistant' | 'tool';
/** 模型返回的工具调用增量；同一调用按 index 累加拼接。 */
export interface ToolCallFragment {
    id: string;
    type: 'function';
    function: {
        name: string;
        arguments: string;
    };
}
/** 一条 Transcript 消息；工具结果与思考正文按协议字段透传。 */
export interface AgentMessage {
    role: AgentRole;
    content: string;
    tool_calls?: ToolCallFragment[];
    tool_call_id?: string;
    reasoning_content?: string;
}
/** 流式模型增量：思考正文与回复正文可能各自到达。 */
export interface ModelDelta {
    reasoning: string;
    content: string;
}
/** Provider 在一次模型请求完成后返回的真实 token 使用量；缺失时绝不以本地估算替代。 */
export interface ModelUsage {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
}
/** 一次完整模型补全：正文、可选思考正文与工具调用列表。 */
export interface ModelCompletion {
    content: string;
    reasoningContent?: string;
    toolCalls: ToolCallFragment[];
    usage?: ModelUsage;
}
/** 压缩摘要同样是一次真实模型请求，需携带其 usage。 */
export interface ModelSummary {
    content: string;
    usage?: ModelUsage;
}
/** 统一工具执行结果：与既有 Chat Completions tool 消息同构。 */
export interface ToolExecutionResult {
    role: 'tool';
    tool_call_id: string;
    content: string;
}
/** 本地运行日志条目：不含用户正文、附件路径或密钥。 */
export interface LogEntry {
    time: string;
    level: 'INFO' | 'WARN' | 'ERROR';
    event: string;
    detail: string;
}
/** Trace 摘要条目：开发者页面只读。 */
export interface TraceEntry {
    requestId: string;
    sessionId: string;
    model: string;
    state: string;
    summary: string;
    createdAt: number;
    completedAt: number | null;
    eventCount: number;
}
/** Trace 事件条目：开发者页面只读。 */
export interface TraceEventEntry {
    ordinal: number;
    eventType: string;
    payload: unknown;
    tokenCount: number;
    createdAt: number;
}
/** 会话内任务：Agent 工具维护的结构化待办。 */
export interface TaskItem {
    id: string;
    title: string;
    description: string;
    status: string;
}
/** 简历只读快照：后端按 resumeId 读取，仅含展示与编辑所需字段；revision 供乐观锁校验，targetRoles/summary 供整份保存不丢字段。 */
export interface ResumeSnapshot {
    id: string;
    name: string;
    content: string;
    updatedAt: string;
    revision?: number;
    targetRoles?: string[];
    summary?: string;
}
/** 个人档案只读快照项。 */
export interface ProfileSnapshotItem {
    id: string;
    category: string;
    title: string;
    content: string;
    updatedAt: string;
}
/** 附件描述：只暴露虚拟路径与展示名，绝对路径由宿主持有。 */
export interface AttachmentDescriptor {
    name: string;
    path: string;
}
/** 归一化后的受限运行时上下文：仅承载确认模式与业务只读快照。 */
export interface RuntimeContext {
    confirmationMode: '需要确认' | '无需确认';
    resumeEditing: boolean;
    resume: ResumeSnapshot | null;
    profiles: ProfileSnapshotItem[];
    attachments: AttachmentDescriptor[];
    projectId?: string;
}
