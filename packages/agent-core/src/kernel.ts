import type { AgentMessage, KernelRunInput, KernelRunResult, RunDisposition, ToolCallFragment, ToolDisposition, ToolExecutionResult } from '@offerget/agent-sdk';
import { KeepRecentTurnGroups } from '@offerget/agent-sdk';

/** 从 Trace 正文中移除常见密钥、Authorization 凭据和绝对路径；纯函数，供内核事件脱敏。 */
export function ScrubTraceContent(value: unknown): string {
  return String(value ?? '')
    .replace(/Bearer\s+[^\s]+/gi, 'Bearer [REDACTED]')
    .replace(/\b(?:api[_-]?key|x-api-key|authorization|token)\s*[:=]\s*[^\s,;"'}]+/gi, (match) => `${match.split(/[:=]/, 1)[0]}=[REDACTED]`)
    .replace(/\bsk-[A-Za-z0-9_-]+\b/g, '[REDACTED_API_KEY]')
    .replace(/\b[A-Za-z]:\\[^\s"'<>]*/g, '[REDACTED_PATH]')
    .replace(/(?<![:\w])\/(?:[^\s"'<>]+)/g, '[REDACTED_PATH]')
    .slice(0, 20000);
}

/** Trace 没有逐事件的 Provider usage 时，以中英文字符密度给出稳定的本地估算值。 */
function EstimateTraceTokens(value: unknown): number {
  const text = String(value ?? '');
  if (!text) return 0;
  let units = 0;
  for (const character of text) units += /[\u3400-\u9fff\uf900-\ufaff]/.test(character) ? 1 : 0.25;
  return Math.max(1, Math.ceil(units));
}

/** 提取不含 system 消息的 transcript，并按完整 TurnGroup 保留最近 5 轮，避免拆开工具链。 */
function HistorySnapshot(transcript: AgentMessage[]): AgentMessage[] {
  return KeepRecentTurnGroups(transcript.filter((message) => message.role !== 'system'), 5);
}

/** 取消是硬边界：Provider 或工具即使忽略 AbortSignal 迟到返回，也不得继续产生 Usage、历史或副作用。 */
function ThrowIfRunCancelled(signal: KernelRunInput['signal']): void {
  if (!signal.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new Error('Agent run was cancelled.');
}

/** 从工具结果解析统一 disposition；优先读取结构化字段，其次兼容旧 payload 标记。 */
function ParseToolDisposition(result: ToolExecutionResult): ToolDisposition {
  if (result.disposition && result.disposition !== 'continue') return result.disposition;
  try {
    const payload = JSON.parse(result.content) as { awaitingUser?: unknown; code?: unknown };
    if (payload.awaitingUser === true) return 'wait_user_input';
    if (payload.code === 'CONFIRMATION_REQUIRED') return 'wait_confirmation';
    if (payload.code === 'STATUS_UNKNOWN' || payload.code === 'PAUSED') return 'pause';
  } catch { /* 非 JSON 工具结果按 continue 处理。 */ }
  return 'continue';
}

/** 构造屏障后未执行工具的结果；不得产生副作用。 */
function CreateSkippedResult(call: ToolCallFragment): ToolExecutionResult {
  return {
    role: 'tool',
    tool_call_id: call.id,
    content: JSON.stringify({ ok: false, code: 'SKIPPED_AFTER_WAIT', message: 'Skipped because an earlier tool in this batch is waiting for user input or confirmation.' }),
  };
}

/** 构造冻结场景白名单拒绝结果；未知或未授权工具不得进入工具模块。 */
function CreateToolNotAllowedResult(call: ToolCallFragment): ToolExecutionResult {
  return {
    role: 'tool',
    tool_call_id: call.id,
    content: JSON.stringify({ ok: false, code: 'TOOL_NOT_ALLOWED', message: 'This tool is not available in the frozen Run whitelist.' }),
  };
}

/** 按真实用户轮次压缩早期历史；重试循环内置 3 次熔断，全部失败抛出压缩错误（宿主据此传播）。 */
async function CompressIfNeeded(input: KernelRunInput, history: AgentMessage[], onCompressed: () => void): Promise<AgentMessage[]> {
  const { modules, toolArray } = input;
  const { contextLimit, threshold } = modules.modelProvider.GetRuntimeLimits();
  const estimate = modules.modelProvider.EstimateTokens({
    system: input.instructions.compiled,
    tools: toolArray,
    messages: [...history, { role: 'user', content: input.userContent }],
  });
  if (!modules.compaction.ShouldCompact(estimate, contextLimit, threshold)) return history;
  let candidate = history;
  // 标记是否已因摘要失败降级截断过：若截断后仍无更早轮可切分，说明压缩无法推进，进入熔断而非静默丢弃历史。
  let dropped = false;
  for (let retry = 0; retry <= 3; retry += 1) {
    try {
      const { earlier, recent } = modules.compaction.SplitRecentTurns(candidate);
      if (!earlier.length) {
        if (dropped) throw new Error('Context compression cannot make progress: history has no earlier turns to compact.');
        return candidate;
      }
      const summary = await modules.modelProvider.CreateSummary(input.model, earlier);
      ThrowIfRunCancelled(input.signal);
      input.onModelUsage?.(summary.usage);
      const compacted: AgentMessage[] = [{ role: 'user', content: `<summary summary_id="summary-${input.createId()}">${summary.content}</summary>` }, ...recent];
      input.histories.set(input.sessionId, compacted);
      onCompressed();
      modules.observability.AppendTraceEvent(input.requestId, 'context_compressed', { retry, removed: earlier.length });
      modules.observability.RecordLog('INFO', 'context.compressed', `retry=${retry}; removed=${earlier.length}`);
      return compacted;
    } catch (error) {
      // 熔断错误（无更早轮）直接上抛，不再尝试降级截断。
      if (error instanceof Error && /cannot make progress/i.test(error.message)) throw error;
      candidate = modules.compaction.DropOldestTurns(candidate, 5);
      dropped = true;
      modules.observability.AppendTraceEvent(input.requestId, 'context_compress_retry', { retry: retry + 1 });
      modules.observability.RecordLog('WARN', 'context.compress_retry', `retry=${retry + 1}`);
    }
  }
  throw new Error('Context compression failed after three retries. Start a new conversation or shorten the request.');
}

/** 按 tool_call 顺序执行工具批次；只读并行、写/交互屏障，等待后跳过未执行节点。 */
async function RunToolBatch(input: KernelRunInput, calls: ToolCallFragment[]): Promise<{ results: AgentMessage[]; disposition: RunDisposition }> {
  ThrowIfRunCancelled(input.signal);
  const results: AgentMessage[] = new Array(calls.length);
  const phases: ToolCallFragment[][] = [];
  let currentPhase: ToolCallFragment[] = [];
  const activeResourceKeys = new Set<string>();

  for (const call of calls) {
    const meta = input.toolArray.find((tool) => tool.definition.function.name === call.function.name);
    let args: Record<string, unknown> = {};
    try { args = JSON.parse(call.function.arguments || '{}'); } catch { /* 参数由工具模块负责校验。 */ }
    const keys = meta?.resourceKeys?.(args) ?? [];
    const canParallel = meta
      ? meta.sideEffect === 'none' && meta.isConcurrencySafe !== false
      : false;
    const conflicts = keys.some((key) => activeResourceKeys.has(key));
    if (!canParallel) {
      // 写操作、交互和未知工具都是屏障：独立成阶段，不能与后续调用并行。
      if (currentPhase.length) phases.push(currentPhase);
      phases.push([call]);
      currentPhase = [];
      activeResourceKeys.clear();
    } else if (conflicts) {
      if (currentPhase.length) phases.push(currentPhase);
      currentPhase = [call];
      activeResourceKeys.clear();
      keys.forEach((key) => activeResourceKeys.add(key));
    } else {
      currentPhase.push(call);
      keys.forEach((key) => activeResourceKeys.add(key));
    }
  }
  if (currentPhase.length) phases.push(currentPhase);

  let disposition: RunDisposition = 'continue';
  let executedCount = 0;
  for (const phase of phases) {
    if (disposition !== 'continue') break;
    ThrowIfRunCancelled(input.signal);
    const phaseResults = await Promise.all(phase.map(async (call) => {
      ThrowIfRunCancelled(input.signal);
      const argumentsText = ScrubTraceContent(call.function.arguments);
      input.modules.observability.AppendTraceEvent(input.requestId, 'tool_call', { name: call.function.name, arguments: argumentsText }, EstimateTraceTokens(argumentsText));
      const registered = input.toolArray.some((tool) => tool.definition.function.name === call.function.name);
      const allowedByScenario = input.scenario?.toolNames.includes(call.function.name) ?? false;
      const result = registered && allowedByScenario
        ? await input.modules.tools.ExecuteToolCall(call, { ...input.toolContext, signal: input.signal })
        : CreateToolNotAllowedResult(call);
      let resultState: { ok: boolean; code: string; message: string } = { ok: false, code: 'UNPARSEABLE', message: '' };
      try {
        const parsed = JSON.parse(result.content) as { ok?: unknown; code?: unknown; message?: unknown };
        resultState = { ok: parsed.ok === true, code: String(parsed.code ?? ''), message: ScrubTraceContent(String(parsed.message ?? '').slice(0, 200)) };
      } catch { /* 工具结果无法解析时保留默认失败标记。 */ }
      input.modules.observability.AppendTraceEvent(input.requestId, 'tool_result', { name: call.function.name, ...resultState }, EstimateTraceTokens(resultState.message));
      return { call, result };
    }));
    ThrowIfRunCancelled(input.signal);
    for (const { call, result } of phaseResults) {
      const index = calls.findIndex((item) => item.id === call.id);
      if (index >= 0) results[index] = result;
      const callDisposition = ParseToolDisposition(result);
      if (disposition === 'continue') {
        if (callDisposition === 'wait_user_input') disposition = 'waiting_user_input';
        else if (callDisposition === 'wait_confirmation') disposition = 'waiting_confirmation';
        else if (callDisposition === 'pause') disposition = 'paused';
      }
    }
    executedCount += phase.length;
    if (disposition !== 'continue') {
      for (const call of calls.slice(executedCount)) {
        const index = calls.findIndex((item) => item.id === call.id);
        if (index >= 0) results[index] = CreateSkippedResult(call);
      }
    }
  }

  for (let index = 0; index < calls.length; index += 1) {
    if (!results[index]) results[index] = CreateSkippedResult(calls[index]);
  }
  return { results, disposition };
}

/** 纯 Agent 内核：Send 的 while 状态机。宿主负责配置、快照、持久化与事件出口；Kernel 不持有 config/凭据/业务态。 */
export async function RunAgentLoop(input: KernelRunInput): Promise<KernelRunResult> {
  const { modules, emit, signal, requestId } = input;
  let compressionCount = 0;
  let requestHistory: AgentMessage[];
  let transcript: AgentMessage[] = [];
  let inputTokens = 0;
  let assistantContent = '';
  let reasoningContent = '';
  let turn = 0;
  let toolCallCount = 0;
  const maxTurns = input.scenario?.budgets?.maxModelTurns ?? input.maxTurns;
  const maxToolCalls = input.scenario?.budgets?.maxToolCalls ?? 12;

  try {
    // 压缩熔断错误进入 catch，统一 FinishTrace/emit error（旧实现压缩在 try 外，抛错会跳过 Trace 收尾导致 running 幽灵 Trace）。
    requestHistory = await CompressIfNeeded(input, input.requestHistory, () => { compressionCount += 1; });
    transcript = [{ role: 'system', content: input.systemContext }, ...requestHistory, { role: 'user', content: input.userContent }];
    inputTokens = modules.modelProvider.EstimateTokens({ system: input.instructions.compiled, tools: input.toolArray, messages: transcript });
    while (true) {
      // 取消不经循环顶部轮询：模型流经 signal 中止抛错，由 catch 统一 FinishTrace 并 emit cancelled。
      if (turn >= maxTurns) {
        input.histories.set(input.sessionId, HistorySnapshot(transcript));
        modules.observability.RecordLog('WARN', 'conversation.circuit_open', 'iteration_limit');
        modules.observability.FinishTrace(requestId, 'circuit_open', 'Circuit opened: iteration_limit. Transcript preserved for automatic recovery.');
        emit({ type: 'error', requestId, message: '本轮迭代达到上限，已暂停；会话上下文与历史已保留，可继续提问' });
        return { outcome: 'circuit_open', disposition: 'paused', reason: 'iteration_limit', transcript: HistorySnapshot(transcript), inputTokens, compressionCount };
      }
      turn += 1;
      modules.observability.AppendTraceEvent(requestId, 'loop_turn', { turn });
      // Provider 可能在 Promise settle 或取消后仍回调；仅当前流处于 active 时接收增量，避免终态后污染 UI。
      let acceptsProviderDelta = true;
      const completion = await modules.modelProvider.StreamCompletion({
        requestId,
        model: input.model,
        history: transcript,
        tools: input.toolArray,
        signal,
        instructions: input.instructions,
        onDelta: (delta) => {
          if (!acceptsProviderDelta || signal.aborted) return;
          if (delta.reasoning) { reasoningContent += delta.reasoning; emit({ type: 'thinking_delta', requestId, delta: delta.reasoning }); }
          if (delta.content) { assistantContent += delta.content; emit({ type: 'content_delta', requestId, delta: delta.content }); }
        },
      }).finally(() => { acceptsProviderDelta = false; });
      ThrowIfRunCancelled(signal);
      input.onModelUsage?.(completion.usage);
      const assistantMessage: AgentMessage = {
        role: 'assistant',
        content: completion.content,
        ...(completion.reasoningContent ? { reasoning_content: completion.reasoningContent } : {}),
        ...(completion.toolCalls.length ? { tool_calls: completion.toolCalls } : {}),
      };
      transcript = [...transcript, assistantMessage];
      if (!completion.toolCalls.length) break;
      toolCallCount += completion.toolCalls.length;
      if (toolCallCount > maxToolCalls) {
        input.histories.set(input.sessionId, HistorySnapshot(transcript));
        modules.observability.RecordLog('WARN', 'conversation.circuit_open', 'tool_call_limit');
        modules.observability.FinishTrace(requestId, 'circuit_open', 'Circuit opened: tool_call_limit.');
        emit({ type: 'error', requestId, message: '本轮工具调用达到上限，已暂停；可继续提问或缩小目标' });
        return { outcome: 'circuit_open', disposition: 'paused', reason: 'tool_call_limit', transcript: HistorySnapshot(transcript), inputTokens, compressionCount };
      }
      const { results, disposition } = await RunToolBatch(input, completion.toolCalls);
      transcript = [...transcript, ...results];
      if (disposition !== 'continue') {
        const waitOutcome = disposition === 'waiting_user_input' ? 'waiting_user_input' : disposition === 'waiting_confirmation' ? 'waiting_confirmation' : 'paused';
        input.histories.set(input.sessionId, HistorySnapshot(transcript));
        modules.observability.RecordLog('INFO', `conversation.${waitOutcome}`, `turns=${turn}`);
        modules.observability.FinishTrace(requestId, waitOutcome, `Waiting or paused after ${turn} loop turn(s).`);
        emit({ type: waitOutcome, requestId, message: waitOutcome === 'waiting_user_input' ? '等待用户回答问题' : waitOutcome === 'waiting_confirmation' ? '等待用户确认提案' : '运行已暂停' });
        return { outcome: waitOutcome, disposition: waitOutcome, transcript: HistorySnapshot(transcript), inputTokens, compressionCount };
      }
    }
    input.histories.set(input.sessionId, HistorySnapshot(transcript));
    modules.observability.RecordLog('INFO', 'conversation.completed', `turns=${turn}`);
    const responseText = ScrubTraceContent(assistantContent);
    const reasoningText = ScrubTraceContent(reasoningContent);
    modules.observability.AppendTraceEvent(requestId, 'assistant_message', { content: responseText, reasoning: reasoningText }, EstimateTraceTokens(`${responseText}\n${reasoningText}`));
    modules.observability.FinishTrace(requestId, 'completed', `Completed in ${turn} loop turn(s).`);
    emit({ type: 'completed', requestId, content: assistantContent, thinkingContent: reasoningContent });
    return { outcome: 'completed', disposition: 'completed', transcript: HistorySnapshot(transcript), inputTokens, compressionCount };
  } catch (error) {
    if (signal.aborted) {
      modules.observability.FinishTrace(requestId, 'cancelled', 'Cancelled by user.');
      emit({ type: 'cancelled', requestId });
      return { outcome: 'cancelled', disposition: 'cancelled', transcript: HistorySnapshot(transcript), inputTokens, compressionCount };
    }
    const message = error instanceof Error ? error.message : 'Agent request failed.';
    const compressionExhausted = /compression/i.test(message);
    modules.observability.RecordLog('ERROR', 'conversation.failed', message);
    const errorText = ScrubTraceContent(message);
    modules.observability.AppendTraceEvent(requestId, 'error', { message: errorText }, EstimateTraceTokens(errorText));
    modules.observability.FinishTrace(requestId, compressionExhausted ? 'circuit_open' : 'failed', compressionExhausted ? 'compression_retry_exhausted' : message);
    emit({ type: 'error', requestId, message: (compressionExhausted ? '上下文压缩连续失败，已暂停本轮；可新建会话或缩短请求' : message).slice(0, 500) });
    throw new Error(message);
  }
}
