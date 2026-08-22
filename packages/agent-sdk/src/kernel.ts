import type { AgentStreamEvent } from './events';
import type { AgentModules } from './modules';
import type { RegisteredAgentTool, ToolContext } from './tools';
import type { AgentMessage, CompiledInstructions, ConfirmationMode, ProviderUsageFact, RunDisposition, ScenarioSnapshot } from './types';

/** Kernel 单轮运行输入：全部业务态（历史、任务、交互）经参数与上下文注入，Kernel 自身不持持久化。 */
export interface KernelRunInput {
  requestId: string;
  sessionId: string;
  /** 本次请求使用的模型。 */
  model: string;
  /** 会话上下文快照序列化后的 system 消息正文（transcript[0]）；业务系统提示由 Run 快照中的 instructions 提供。 */
  systemContext: string;
  /** 已含动态快照消息的请求历史；Kernel 压缩后以此为基构建完整 transcript。 */
  requestHistory: AgentMessage[];
  userContent: string;
  /** 可选的多模态用户消息；缺省时 Kernel 仍按 userContent 构造纯文本消息。 */
  userMessage?: AgentMessage;
  /** 会话 Transcript 表：宿主持有的 Map 引用；压缩与落库由 Kernel 更新。 */
  histories: Map<string, AgentMessage[]>;
  /** 本次请求的工具数组（来自会话 Tool 快照顺序）。 */
  toolArray: RegisteredAgentTool[];
  modules: AgentModules;
  toolContext: ToolContext;
  emit: (event: AgentStreamEvent) => void;
  /** 每次模型请求完成时通知宿主；Provider 未返回完整 usage 时必须显式传 unavailable，宿主不得估算替代。 */
  onModelUsage?: (usage: ProviderUsageFact) => void;
  signal: AbortSignal;
  maxTurns: number;
  contextLimit: number;
  thresholdPercent: number;
  /** 生成摘要消息标识的注入函数：宿主提供 crypto.randomUUID，保持 Kernel 无 Node 依赖。 */
  createId: () => string;
  /** 当前 Run 场景快照；必须与同一原子 Run 快照中的工具和 Prompt 一起提供。 */
  scenario: ScenarioSnapshot;
  /** 运行前编译的 Prompt 指令；Provider 不再自行选择业务 Prompt。 */
  instructions: CompiledInstructions;
  /** 由 Kernel 追加的 user 角色运行状态栏；旧提醒保持 append-only。 */
  runtimeReminder: {
    confirmationMode: ConfirmationMode;
    /** 权限可由宿主在 Run 进行中切换；Kernel 只在轮次边界读取。 */
    getConfirmationMode?: () => ConfirmationMode;
    interval: number;
    timeZone: string;
    now?: () => number;
  };
}

/** Kernel 单轮运行结果：宿主据 outcome 决定事件与错误传播语义。 */
export interface KernelRunResult {
  outcome: 'completed' | 'cancelled' | 'circuit_open' | 'waiting_user_input' | 'waiting_confirmation' | 'paused';
  /** 统一运行去向；与 outcome 对齐，宿主可据此驱动 Run 状态机。 */
  disposition: RunDisposition;
  /** 不含 system 消息的最新 transcript 副本（供宿主持久化）。 */
  transcript: AgentMessage[];
  /** circuit_open 原因：iteration_limit 或压缩失败消息。 */
  reason?: string;
  /** 本次请求估算输入 token 数（供宿主更新 Usage）。 */
  inputTokens: number;
  /** 本次请求累计压缩次数。 */
  compressionCount: number;
}

/** 纯 Agent 内核函数类型：宿主在 agent-core 获得具体实现，SDK 仅声明契约。 */
export type KernelRunFunction = (input: KernelRunInput) => Promise<KernelRunResult>;
