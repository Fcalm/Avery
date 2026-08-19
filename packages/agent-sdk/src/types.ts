/** Agent 模块契约的基础类型：消息、模型增量、工具结果与业务只读快照形状。 */

/** Transcript 消息角色；与既有 Chat Completions 协议保持一致。 */
export type AgentRole = 'system' | 'user' | 'assistant' | 'tool';

/** Run 状态机状态；终态之间互斥，等待/暂停可恢复。 */
export type RunState =
  | 'created'
  | 'preparing'
  | 'model_streaming'
  | 'tool_validating'
  | 'tools_running'
  | 'waiting_user_input'
  | 'waiting_confirmation'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'cancelled';

/** 工具批次执行后的统一运行去向：普通继续、等待用户、等待确认或暂停。 */
export type RunDisposition =
  | 'continue'
  | 'waiting_user_input'
  | 'waiting_confirmation'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'cancelled';

/** 工具结果携带的统一等待/暂停语义；默认 continue。 */
export type ToolDisposition = 'continue' | 'wait_user_input' | 'wait_confirmation' | 'pause';

/** 一次 Run 的不可变场景快照；工具白名单、确认策略与预算均来自这里。 */
export interface ScenarioSnapshot {
  id: string;
  name: string;
  enabled: boolean;
  status: 'active' | 'planned';
  /** 模型可见工具白名单；不在名单中的工具即使模型请求也不执行。 */
  toolNames: string[];
  /** 场景可进一步收窄的预算；缺省由 Harness 提供默认值。 */
  budgets?: {
    maxModelTurns?: number;
    maxToolCalls?: number;
    maxWallTimeMs?: number;
  };
  /** 场景确认策略：低风险写入是否可自动执行。 */
  confirmationPolicy?: 'low_risk_auto' | 'confirm_all_writes' | 'always_confirm';
}

/** 待确认/待提问的统一挂起交互；等待期间不持有资源锁。 */
export interface PendingQuestionInteraction {
  type: 'question';
  interactionId: string;
  runId: string;
  questions: Array<{
    id: string;
    prompt: string;
    required: boolean;
    options?: Array<{ id: string; label: string }>;
  }>;
  answerSchema: unknown;
  createdAt: string;
  expiresAt?: string;
}

/** 已冻结的确认提案；接受时必须校验 proposalHash 与 revision。 */
export interface PendingConfirmation {
  type: 'confirmation';
  interactionId: string;
  proposalId: string;
  proposalHash: string;
  toolName: string;
  canonicalArguments: unknown;
  resourceId: string;
  expectedRevision?: number;
  risk: 'low' | 'medium' | 'high';
  diff: unknown;
  expiresAt: string;
}

export type PendingInteraction = PendingQuestionInteraction | PendingConfirmation;

/** 结构化运行错误：稳定 code、可追踪 request/run 标识，不向 UI 泄露堆栈。 */
export interface StructuredRunError {
  code: string;
  message: string;
  requestId?: string;
  runId?: string;
  retryable: boolean;
  details?: unknown;
}

/** 工具回执：只有携带有效回执才表示对应动作已发生。 */
export interface ToolReceipt {
  receiptId: string;
  toolDefinitionId: string;
  resourceIds: string[];
  revisions?: Record<string, number>;
  idempotencyKey?: string;
}

/** Tool Ledger 条目：写工具在执行前落 started，完成后落 succeeded/failed/status_unknown。 */
export interface ToolLedgerEntry {
  ledgerId: string;
  runId?: string;
  toolCallId: string;
  toolName: string;
  idempotencyKey?: string;
  argumentsHash: string;
  actor: string;
  resourceIds: string[];
  status: 'started' | 'succeeded' | 'failed' | 'status_unknown';
  receipt?: ToolReceipt;
  errorCode?: string;
  startedAt: number;
  finishedAt?: number;
}

/** Prompt 片段；Trace 只保存 id/version/hash，不默认保存正文。 */
export interface PromptFragment {
  id: string;
  version: string;
  trustLevel: 'runtime' | 'product' | 'scenario' | 'user-preference';
  content: string;
  contentHash: string;
}

/** 每次 Run 冻结的 Prompt Manifest；重放历史必须使用原 Manifest。 */
export interface PromptManifest {
  manifestVersion: 1;
  compilerVersion: string;
  fragments: PromptFragment[];
  scenarioId: string;
  toolPolicyHash: string;
  outputContractVersion: string;
  compiledHash: string;
}

/** 编译后的指令：内部有序片段 + 完整文本；Provider 只做角色映射。 */
export interface CompiledInstructions {
  manifest: PromptManifest;
  compiled: string;
  /** 支持分层指令的 Provider 可使用的次级指令层。 */
  layers?: Array<{ trustLevel: PromptFragment['trustLevel']; content: string }>;
}

/** Provider 规范化错误；Loop/Harness 只消费稳定字段。 */
export interface ProviderError {
  code: string;
  category: 'auth' | 'rate_limit' | 'timeout' | 'network' | 'invalid_request' | 'content_policy' | 'protocol' | 'server' | 'cancelled';
  retryability: 'none' | 'safe_before_output' | 'user_action';
  httpStatus?: number;
  providerRequestId?: string;
  safeMessage: string;
}

/** Provider 能力快照；按模型记录，不按供应商名称硬编码。 */
export interface ModelCapabilities {
  contextLimit?: number;
  maxOutputTokens?: number;
  toolCalling: 'none' | 'single' | 'parallel';
  strictToolSchema: boolean;
  streaming: boolean;
  usageInStream: boolean;
  systemInstructions: 'none' | 'single' | 'layered';
  reasoning: 'none' | 'opaque' | 'summary' | 'provider_specific';
  vision: boolean;
  tokenCounting: boolean;
}

/** Provider 归一化 Usage；缺失字段保持 undefined，不填 0。 */
export interface NormalizedUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cachedInputTokens?: number;
  reasoningTokens?: number;
  source: 'provider';
  complete: boolean;
}

/** 规范化 Provider 流事件；Loop 不解析供应商原始 SSE。 */
export type ModelStreamEvent =
  | { type: 'response_started'; providerRequestId?: string }
  | { type: 'output_text_delta'; text: string }
  | { type: 'reasoning_summary_delta'; text: string }
  | { type: 'tool_call_started'; index: number; id: string; name: string }
  | { type: 'tool_arguments_delta'; index: number; text: string }
  | { type: 'tool_call_completed'; index: number }
  | { type: 'usage'; usage: NormalizedUsage; raw: unknown }
  | { type: 'response_completed'; finishReason: string }
  | { type: 'error'; error: ProviderError };

/** Transcript 原子组：一个完整用户轮次及其工具链不可拆分。 */
export interface TurnGroup {
  userMessage: AgentMessage;
  messages: AgentMessage[];
}

/** 模型返回的工具调用增量；同一调用按 index 累加拼接。 */
export interface ToolCallFragment {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
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

/** 统一工具执行结果：与既有 Chat Completions tool 消息同构；disposition 供 Kernel 判断是否等待。 */
export interface ToolExecutionResult {
  role: 'tool';
  tool_call_id: string;
  content: string;
  /** 工具执行后的统一运行去向；缺省视为 continue。 */
  disposition?: ToolDisposition;
  /** 写工具成功时携带回执，供最终回复与 Harness 校验。 */
  receipt?: ToolReceipt;
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
