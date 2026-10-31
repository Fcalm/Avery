import type { AgentMessage, AgentModules, ReasoningEffort, RegisteredAgentTool, ModelSummary, KernelRunInput } from '@avery/agent-sdk';

/** 区分可解释的压缩停机和普通模型故障，不依赖错误语言判断 Trace 状态。 */
export class ContextCompactionError extends Error { readonly code = 'CONTEXT_COMPACTION_FAILED'; }

export interface ContextCompactionInput {
  modelConfiguration?: import('@avery/agent-sdk').ResolvedModelConfiguration;
  modules: AgentModules;
  provider: string;
  model: string;
  reasoningEffort: ReasoningEffort;
  history: AgentMessage[];
  system: string;
  tools: RegisteredAgentTool[];
  /** 本轮动态上下文等不参与摘要的消息仍计入完整预算。 */
  extraMessages?: AgentMessage[];
  signal: KernelRunInput['signal'];
  createId: () => string;
  force?: boolean;
  compressionInstructions?: string;
  protectedState?: string;
  resolveSource?: (messages: AgentMessage[]) => AgentMessage[] | Promise<AgentMessage[]>;
  onUsage?: (summary: ModelSummary) => void;
  onRequest?: Parameters<AgentModules['modelProvider']['CreateSummary']>[3];
}

/** 压缩只准备候选，不写入宿主。调用方必须在原文归档与持久化成功后再切换视图。 */
export async function CompactContextHistory(input: ContextCompactionInput): Promise<{
  history: AgentMessage[]; before: number; after: number;
  summary?: string;
  archive?: { summaryId: string; messages: AgentMessage[]; original?: AgentMessage[] };
}> {
  const { modules, history, signal } = input;
  signal.throwIfAborted();
  const provider = modules.modelProvider;
  const limits = provider.GetRuntimeLimits(input.provider, input.model);
  const contextLimit = input.modelConfiguration?.values.contextWindow ?? limits.contextLimit;
  const threshold = limits.threshold;
  // 每次请求保留输出与协议余量，阈值始终应用于相同的完整输入口径。
  const budget = Math.floor(contextLimit - Math.min(8192, contextLimit * 0.1));
  const trigger = budget * threshold / 100;
  const estimate = (messages: AgentMessage[]) => provider.EstimateTokens({ system: input.system, tools: input.tools, messages: [...messages, ...(input.extraMessages ?? [])] });
  const before = estimate(history);
  if (!input.force && before < trigger) return { history, before, after: before };
  const fixed = estimate([]);
  if (fixed >= trigger) throw new ContextCompactionError('固定规则、工具或当前输入已占满上下文，请缩小材料范围。');
  const target = Math.min(budget * 0.5, trigger * 0.7);
  const split = modules.compaction.SplitRecentTurns(history, {
    maxRecentTokens: Math.max(0, Math.min(target - fixed - Math.min(2048, contextLimit * 0.05), input.force ? provider.EstimateTokens(history) * 0.25 : Infinity)),
    estimate: (messages) => provider.EstimateTokens(messages),
  });
  if (!split.earlier.length) {
    if (before >= trigger) throw new ContextCompactionError('当前用户输入或最近工具步骤过大，无法安全压缩，请缩小处理范围。');
    return { history, before, after: before };
  }
  if (estimate(split.recent) >= trigger) throw new ContextCompactionError('当前用户原文或必须保留的规则已占满上下文，请缩小处理范围。');
  const source = await input.resolveSource?.(split.earlier) ?? split.earlier;
  const recentContext = split.recent.filter((message) => (message.role === 'user' && message.metadata?.source !== 'runtime') || (message.role === 'assistant' && !message.tool_calls?.length));
  const summaryBudget = Math.floor((budget - provider.EstimateTokens({ recentContext, state: input.protectedState, instructions: input.compressionInstructions })) * 0.65);
  if (summaryBudget <= 0) throw new ContextCompactionError('需要保留的事实与当前输入过大，无法安全生成摘要。');
  const chunks: AgentMessage[][] = [];
  let current: AgentMessage[] = [];
  for (const message of source) {
    let pieces = [message];
    if (provider.EstimateTokens([message]) > summaryBudget) {
      // 旧超大消息可分片供摘要阅读，原文仍完整归档；分片不会作为业务工具回执重放。
      const text = JSON.stringify({ role: message.role, content: message.content, toolCalls: message.tool_calls, toolCallId: message.tool_call_id });
      const size = Math.max(1, Math.floor(summaryBudget / 2));
      pieces = [];
      for (let offset = 0; offset < text.length; offset += size) pieces.push({ role: 'user', content: JSON.stringify({ sourcePart: offset, data: text.slice(offset, offset + size) }) });
    }
    for (const piece of pieces) {
      if (current.length && provider.EstimateTokens([...current, piece]) > summaryBudget) { chunks.push(current); current = []; }
      current.push(piece);
    }
  }
  if (current.length) chunks.push(current);
  if (chunks.length > 7) throw new ContextCompactionError('历史过大，需要超过本次摘要调用上限；原文已保留，请缩小范围。');
  let calls = 0;
  const summarize = async (messages: AgentMessage[]): Promise<ModelSummary> => {
    signal.throwIfAborted();
    if (++calls > 8) throw new ContextCompactionError('摘要调用达到上限，原文已保留。');
    const summary = await provider.CreateSummary(input.provider, input.model, messages, input.onRequest, {
      modelConfiguration: input.modelConfiguration,
      signal, reasoningEffort: input.reasoningEffort,
      compressionInstructions: input.compressionInstructions, protectedState: input.protectedState,
      recentContext,
    });
    signal.throwIfAborted(); input.onUsage?.(summary);
    if (!summary.content.trim() || summary.content.length > 16000) throw new Error('压缩摘要为空或超过长度限制。');
    return summary;
  };
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    signal.throwIfAborted();
    try {
      const parts: AgentMessage[] = [];
      for (const chunk of chunks) parts.push({ role: 'user', content: (await summarize(chunk)).content });
      const summary = parts.length === 1 ? { content: parts[0].content } : await summarize(parts);
      const summaryId = `summary-${input.createId()}`;
      const message: AgentMessage = { role: 'user', content: `<summary summary_id="${summaryId}">${summary.content}</summary>${input.protectedState ? `\n<protected-state>${JSON.stringify(input.protectedState)}</protected-state>` : ''}`, metadata: { source: 'runtime', visibility: 'hidden', kind: 'context_summary', summaryId } };
      const candidate = [message, ...split.recent];
      const after = estimate(candidate);
      if (after >= before || after >= trigger) throw new Error('压缩后仍未腾出足够空间，原上下文已保留。');
      return { history: candidate, before, after, summary: summary.content, archive: { summaryId, messages: split.earlier, original: history } };
    } catch (error) {
      signal.throwIfAborted();
      lastError = error;
      // 参数/认证错误不会因重发而变好；受控重试始终使用相同原文。
      if (error instanceof Error && /\(40[0134]\)/.test(error.message)) break;
    }
  }
  throw new ContextCompactionError(`上下文压缩失败，原历史已保留：${lastError instanceof Error ? lastError.message : '摘要生成失败'}`);
}
