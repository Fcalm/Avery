import { IsRuntimeContextMessage } from '@avery/agent-sdk';
import { CompactContextHistory, ContextCompactionError } from './context-compaction';
import { ReconcileInterruptedTools } from './tool-protocol';
import type { AgentMessage, KernelRunInput, KernelRunResult, ModelUsage, ProviderRequestSnapshot, ProviderUsageFact, RunDisposition, ToolCallFragment, ToolDisposition, ToolExecutionResult } from '@avery/agent-sdk';
import { CreateRuntimeReminderMessage, ShouldInjectRuntimeReminder } from './runtime-reminder';
import { GetToolResources } from './conversation-resources';

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

/** 浏览器填写与上传参数可能包含简历、联系方式或附件标识；Trace 只记录结构，不保存敏感明文。 */
function ScrubToolArguments(toolName: string, value: string): string {
  if (toolName === 'BrowserRunScript') {
    // 脚本常直接含档案字段；Trace 保留长度，逐步动作另有脱敏事件，不落完整脚本。
    return JSON.stringify({ script: '[REDACTED_BROWSER_SCRIPT]', length: value.length });
  }
  if (!['BrowserFill', 'BrowserFillForm', 'BrowserUploadFile'].includes(toolName)) return ScrubTraceContent(value);
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    if ('text' in parsed) parsed.text = '[REDACTED_BROWSER_INPUT]';
    if (Array.isArray(parsed.fields)) {
      parsed.fields = parsed.fields.map((field) => field && typeof field === 'object' && !Array.isArray(field)
        ? { ...(field as Record<string, unknown>), text: '[REDACTED_BROWSER_INPUT]' }
        : '[REDACTED_BROWSER_FIELD]');
    }
    if (Array.isArray(parsed.decisions)) {
      parsed.decisions = parsed.decisions.map((decision) => decision && typeof decision === 'object' && !Array.isArray(decision)
        ? { ...(decision as Record<string, unknown>), value: '[REDACTED_BROWSER_INPUT]' }
        : '[REDACTED_BROWSER_DECISION]');
    }
    if ('fileId' in parsed) parsed.fileId = '[REDACTED_FILE_ID]';
    return ScrubTraceContent(JSON.stringify(parsed));
  } catch {
    return '[REDACTED_BROWSER_ARGUMENTS]';
  }
}

/** 构造可安全写入 Trace 的消息副本；图片正文和敏感工具参数不得进入可观测性库。 */
function CreateTraceMessage(message: Record<string, unknown>): Record<string, unknown> {
  const traceMessage = { ...message };
  const content = traceMessage.content;
  if (Array.isArray(content)) {
    traceMessage.content = content.map((part) => {
      if (!part || typeof part !== 'object') return part;
      const record = part as Record<string, unknown>;
      if (record.type !== 'image_url' || !record.image_url || typeof record.image_url !== 'object') return record;
      const image = record.image_url as Record<string, unknown>;
      return { ...record, image_url: { ...image, url: typeof image.url === 'string' && image.url.startsWith('data:') ? '[REDACTED_IMAGE_DATA]' : image.url } };
    });
  } else {
    traceMessage.content = ScrubTraceContent(content);
  }
  if (Array.isArray(traceMessage.tool_calls)) {
    traceMessage.tool_calls = traceMessage.tool_calls.map((value) => {
      if (!value || typeof value !== 'object') return value;
      const call = value as Record<string, unknown>;
      const fn = call.function && typeof call.function === 'object' ? call.function as Record<string, unknown> : null;
      if (!fn) return call;
      const name = String(fn.name ?? '');
      return { ...call, function: { ...fn, arguments: ScrubToolArguments(name, String(fn.arguments ?? '')) } };
    });
  }
  if (typeof traceMessage.reasoning_content === 'string') traceMessage.reasoning_content = ScrubTraceContent(traceMessage.reasoning_content);
  return traceMessage;
}

/** 每次 Provider 请求只追加一个不可变请求事实；完整输入留在详情中，不再伪装成新的消息事件。 */
function RecordProviderRequest(input: KernelRunInput, apiRequestIndex: number, snapshot: ProviderRequestSnapshot): void {
  const messages = snapshot.messages.map((message) => CreateTraceMessage(message));
  input.modules.observability.AppendTraceEvent(input.requestId, 'provider_request', {
    apiRequestIndex,
    kind: snapshot.kind,
    model: snapshot.model,
    messageCount: messages.length,
    toolCount: snapshot.toolCount,
    messages,
  }, EstimateTraceTokens(JSON.stringify(messages)));
}

/** 消息仅在真正加入 Transcript 时追加一次；messageId 是身份，不依赖正文猜测去重。 */
function RecordAppendedMessage(input: KernelRunInput, apiRequestIndex: number, source: 'system' | 'user' | 'provider' | 'tool' | 'runtime', message: AgentMessage): void {
  const traceMessage = CreateTraceMessage({
    role: message.role,
    content: message.content,
    ...(message.tool_calls ? { tool_calls: message.tool_calls } : {}),
    ...(message.tool_call_id ? { tool_call_id: message.tool_call_id } : {}),
    ...(message.reasoning_content ? { reasoning_content: message.reasoning_content } : {}),
  });
  input.modules.observability.AppendTraceEvent(input.requestId, 'message_appended', {
    messageId: input.createId(),
    apiRequestIndex,
    source,
    message: traceMessage,
  }, EstimateTraceTokens(JSON.stringify(traceMessage)));
}

/** 提取可持久化的 append-only transcript；运行时业务快照只对当前请求有效，避免旧资料污染后续会话。 */
function HistorySnapshot(transcript: AgentMessage[]): AgentMessage[] {
  return transcript
    .filter((message) => message.role !== 'system' && !IsRuntimeContextMessage(message))
    .map(({ providerContent: _providerContent, ...message }) => message);
}

/**
 * 将已提交的 transcript 同步到宿主并建立持久化屏障。
 * 历史只能由已经越过取消检查的消息组成；流式增量和取消后迟到的 Provider 结果绝不能进入这里。
 */
async function CommitHistory(input: KernelRunInput, transcript: AgentMessage[], archive?: { summaryId: string; messages: AgentMessage[]; original?: AgentMessage[] }): Promise<AgentMessage[]> {
  if (archive) {
    if (!input.archiveHistory) throw new ContextCompactionError('宿主未提供原文归档能力，不能安全切换压缩视图。');
    await input.archiveHistory(archive);
    input.signal.throwIfAborted();
  }
  const history = HistorySnapshot(transcript);
  const previous = input.histories.get(input.sessionId);
  input.histories.set(input.sessionId, history);
  try { await input.persistHistory(); } catch (error) {
    if (previous) input.histories.set(input.sessionId, previous);
    else input.histories.delete(input.sessionId);
    throw error;
  }
  return history;
}

/** 工具结果的合成 user 消息只能在所有 tool result 完整追加后进入 Transcript。 */
function CommitToolFollowups(input: KernelRunInput, results: ToolExecutionResult[]): AgentMessage[] {
  const messages: AgentMessage[] = [];
  for (const result of results) {
    for (const message of result.followupMessages ?? []) {
      const metadata = message.metadata;
      if (metadata?.kind === 'loaded_skill') {
        input.toolContext.loadedSkills?.set(metadata.skillId, metadata.skillVersion);
        input.toolContext.pendingSkillLoads?.delete(`skill:${metadata.skillId.toLowerCase()}`);
      } else if (metadata?.kind === 'loaded_skill_resource') {
        const key = `${metadata.skillId.toLowerCase()}:${metadata.resourcePath}`;
        input.toolContext.loadedSkillResources?.add(key);
        input.toolContext.pendingSkillLoads?.delete(`resource:${key}`);
      }
      messages.push(message);
    }
  }
  return messages;
}

/** 首次索引与显式 Skill 正文在首个模型请求前提交，并同步会话级 loaded 状态。 */
function CommitInitialSyntheticMessages(input: KernelRunInput, messages: AgentMessage[]): AgentMessage[] {
  for (const message of messages) {
    const metadata = message.metadata;
    if (metadata?.kind === 'loaded_skill') input.toolContext.loadedSkills?.set(metadata.skillId, metadata.skillVersion);
    if (metadata?.kind === 'loaded_skill_resource') {
      input.toolContext.loadedSkillResources?.add(`${metadata.skillId.toLowerCase()}:${metadata.resourcePath}`);
    }
  }
  return messages;
}

/** 取消是硬边界：Provider 或工具即使忽略 AbortSignal 迟到返回，也不得继续产生 Usage、历史或副作用。 */
function ThrowIfRunCancelled(signal: KernelRunInput['signal']): void {
  if (!signal.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new Error('Agent run was cancelled.');
}

/** 将 Provider 模块边界的可选 usage 转为唯一事实；无效或缺失时显式 unavailable，禁止估算。 */
function CreateProviderUsageFact(usage: ModelUsage | undefined): ProviderUsageFact {
  const cachedInputTokens = usage?.cachedInputTokens ?? 0;
  if (!usage
    || ![usage.promptTokens, usage.completionTokens, usage.totalTokens]
      .every((value) => Number.isSafeInteger(value) && value >= 0)
    || usage.totalTokens !== usage.promptTokens + usage.completionTokens
    || !Number.isSafeInteger(cachedInputTokens) || cachedInputTokens < 0 || cachedInputTokens > usage.promptTokens) {
    return { source: 'unavailable', promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedInputTokens: 0 };
  }
  return { source: 'provider', promptTokens: usage.promptTokens, completionTokens: usage.completionTokens, totalTokens: usage.totalTokens, cachedInputTokens };
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

/** Skill 正文必须先回到模型；同批其他动作不能抢在 Skill 指令注入前执行。 */
function CreateSkippedAfterSkillLoadResult(call: ToolCallFragment): ToolExecutionResult {
  return {
    role: 'tool',
    tool_call_id: call.id,
    content: JSON.stringify({ ok: false, code: 'SKIPPED_FOR_SKILL_LOAD', message: 'Skipped because LoadSkill must complete as the only tool in its batch. Re-plan after reading the injected Skill instructions.' }),
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

/** 最后一轮仍返回工具调用时构造协议完整的拒绝结果，但绝不进入工具模块。 */
function CreateTurnBudgetExhaustedResult(call: ToolCallFragment): ToolExecutionResult {
  return {
    role: 'tool',
    tool_call_id: call.id,
    content: JSON.stringify({ ok: false, code: 'TURN_BUDGET_EXHAUSTED', message: 'The final model turn cannot start new tool calls.' }),
    disposition: 'pause',
  };
}

/** 按 tool_call 顺序执行工具批次；只读并行、写/交互屏障，等待后跳过未执行节点。 */
async function RunToolBatch(input: KernelRunInput, calls: ToolCallFragment[], stepId: string, contextToolCallIds: ReadonlySet<string>, onSettled?: (message: AgentMessage) => void): Promise<{ results: AgentMessage[]; disposition: RunDisposition }> {
  ThrowIfRunCancelled(input.signal);
  const skillLoadIndex = calls.findIndex((call) => call.function.name === 'LoadSkill');
  if (skillLoadIndex >= 0 && calls.length > 1) {
    const selected = calls[skillLoadIndex];
    const single = await RunToolBatch(input, [selected], stepId, contextToolCallIds, onSettled);
    for (const call of calls.filter((_, index) => index !== skillLoadIndex)) input.emit({ type: 'conversation_activity', requestId: input.requestId, activity: {
      kind: 'tool', stepId, toolCallId: call.id, name: call.function.name, toolStatus: 'skipped', summary: '技能加载后需要重新规划，本次未执行',
    } });
    return {
      results: calls.map((call, index) => index === skillLoadIndex ? single.results[0] : CreateSkippedAfterSkillLoadResult(call)),
      disposition: single.disposition,
    };
  }
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
      const argumentsText = ScrubToolArguments(call.function.name, call.function.arguments);
      input.emit({ type: 'conversation_activity', requestId: input.requestId, activity: { kind: 'tool', stepId, toolCallId: call.id, name: call.function.name, toolStatus: 'running', summary: '正在执行' } });
      input.modules.observability.AppendTraceEvent(input.requestId, 'tool_call', { name: call.function.name, arguments: argumentsText }, EstimateTraceTokens(argumentsText));
      const registered = input.toolArray.some((tool) => tool.definition.function.name === call.function.name);
      const allowedByScenario = input.scenario?.toolNames.includes(call.function.name) ?? false;
      const needsObservation = input.toolContext.requiresBrowserSnapshot && /^Browser(?:Click|Fill|Select|SetChecked|Press|Upload|Drag|Hover)/.test(call.function.name);
      const result = needsObservation
        ? { role: 'tool' as const, tool_call_id: call.id, content: JSON.stringify({ ok: false, code: 'BROWSER_SNAPSHOT_CONTEXT_LOST', message: '上下文已压缩，请先调用 BrowserSnapshot 重新观察，再使用当前页面引用。' }) }
        : registered && allowedByScenario
        ? await input.modules.tools.ExecuteToolCall(call, { ...input.toolContext, signal: input.signal, allowedToolNames: new Set(input.toolArray.map((tool) => tool.definition.function.name)), hasToolResultInContext: (id) => contextToolCallIds.has(id) })
        : CreateToolNotAllowedResult(call);
      let resultState: { ok: boolean; code: string; message: string } = { ok: false, code: 'UNPARSEABLE', message: '' };
      try {
        const parsed = JSON.parse(result.content) as { ok?: unknown; code?: unknown; message?: unknown };
        resultState = { ok: parsed.ok === true, code: String(parsed.code ?? ''), message: ScrubTraceContent(String(parsed.message ?? '').slice(0, 200)) };
      } catch { /* 工具结果无法解析时保留默认失败标记。 */ }
      input.modules.observability.AppendTraceEvent(input.requestId, 'tool_result', { name: call.function.name, ...resultState }, EstimateTraceTokens(resultState.message));
      if (call.function.name === 'BrowserSnapshot' && resultState.ok) input.toolContext.requiresBrowserSnapshot = false;
      const disposition = ParseToolDisposition(result);
      input.emit({ type: 'conversation_activity', requestId: input.requestId, activity: {
        kind: 'tool', stepId, toolCallId: call.id, name: call.function.name,
        toolStatus: disposition === 'wait_confirmation' || disposition === 'wait_user_input' ? 'waiting' : disposition === 'pause' ? 'paused' : resultState.ok ? 'succeeded' : 'failed',
        summary: resultState.message || (resultState.ok ? '执行完成' : resultState.code || '执行失败'),
      } });
      let parsed: { [key: string]: unknown } = {};
      let args: { [key: string]: unknown } = {};
      try { parsed = JSON.parse(result.content); args = JSON.parse(call.function.arguments || '{}'); } catch { /* 非结构化回执不建立资源引用。 */ }
      if (call.function.name === 'BrowserRunScript' && parsed.ok === true && parsed.browserState && typeof parsed.browserState === 'object') {
        const requiresSnapshot = (parsed.browserState as { requiresSnapshot?: unknown }).requiresSnapshot;
        if (typeof requiresSnapshot === 'boolean') input.toolContext.requiresBrowserSnapshot = requiresSnapshot;
      }
      const resources = GetToolResources(call.function.name, parsed, args);
      for (const resource of resources) {
        input.emit({ type: 'conversation_activity', requestId: input.requestId, activity: { kind: 'resource', stepId, toolCallId: call.id, resource } });
      }
      // 将经过回执验证的引用交给下一轮模型，回答可使用内链；正文里自行编造的引用仍不可点击。
      const resultWithResources = resources.length ? { ...result, content: JSON.stringify({ ...parsed, conversationResources: resources.map((resource) => ({ ...resource, href: 'avery://' + resource.kind + '/' + encodeURIComponent(resource.id) + (resource.revision ? '?revision=' + resource.revision : '') })) }) } : result;
      // 阶段返回前取消仍会走异常路径；保留已结算事实，不能因批次未整体提交而丢掉失败回执。
      // 取消后的迟到成功、待确认提案及依赖 Skill 正文的结果不在这里单独提交。
      if ((!input.signal.aborted || resultState.code === 'CANCELLED' || resultState.code === 'STATUS_UNKNOWN')
        && !result.followupMessages?.length && !['wait_confirmation', 'wait_user_input'].includes(ParseToolDisposition(result))) {
        const { followupMessages: _followups, ...protocolResult } = resultWithResources;
        onSettled?.(protocolResult);
      }
      return { call, result: resultWithResources };
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
        input.emit({ type: 'conversation_activity', requestId: input.requestId, activity: { kind: 'tool', stepId, toolCallId: call.id, name: call.function.name, toolStatus: 'skipped', summary: '等待用户操作，后续工具未执行' } });
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
  const settledTools = new Map<string, AgentMessage>();
  const RecoverInterruptedTools = (messages: AgentMessage[]) => {
    const result = ReconcileInterruptedTools(messages, settledTools);
    if (result.recovered.length) {
      modules.observability.AppendTraceEvent(requestId, 'tool_protocol_recovered', { callIds: result.recovered.map((message) => message.tool_call_id) });
      result.recovered.forEach((message) => RecordAppendedMessage(input, Math.max(1, apiRequestCount), 'runtime', message));
    }
    return result.history;
  };
  let inputTokens = 0;
  const checkpoint = input.resume?.checkpoint;
  let assistantContent = checkpoint?.assistantContent ?? '';
  let reasoningContent = checkpoint?.reasoningContent ?? '';
  let turn = checkpoint?.turn ?? 0;
  let reminderRevision = checkpoint?.reminderRevision ?? 0;
  let lastReminderConfirmationMode = checkpoint?.lastReminderConfirmationMode ?? input.runtimeReminder.confirmationMode;
  let toolCallCount = checkpoint?.toolCallCount ?? 0;
  let apiRequestCount = checkpoint?.apiRequestCount ?? 0;
  const NextApiRequestIndex = () => { apiRequestCount += 1; return apiRequestCount; };
  const maxTurns = input.scenario?.budgets?.maxModelTurns ?? input.maxTurns;
  // 场景只有显式配置时才限制工具总数；投递场景依赖较多原子浏览器动作，不另设浏览器动作预算。
  const maxToolCalls = input.scenario?.budgets?.maxToolCalls ?? Number.POSITIVE_INFINITY;
  input.toolContext.consumeBrowserScriptStep = () => {
    if (toolCallCount >= maxToolCalls) return false;
    toolCallCount += 1;
    return true;
  };
  const hadHistoryAtRunStart = input.requestHistory.length > 0;

  try {
    // 压缩熔断错误进入 catch，统一 FinishTrace/emit error（旧实现压缩在 try 外，抛错会跳过 Trace 收尾导致 running 幽灵 Trace）。
    // 先补全原 tool call 的唯一最终结果，才能压缩或调用 Provider；绝不修改既有消息。
    if (input.resume) {
      const resumedMessages = [input.resume.result, ...input.resume.checkpoint.remainingResults, ...input.resume.checkpoint.followups];
      transcript = [{ role: 'system', content: input.systemContext }, ...input.requestHistory, ...resumedMessages];
      resumedMessages.forEach((message) => RecordAppendedMessage(input, apiRequestCount + 1, message.role === 'tool' ? 'tool' : 'runtime', message));
      input.onResumed?.();
      await CommitHistory(input, transcript);
    }
    requestHistory = input.resume ? HistorySnapshot(transcript) : RecoverInterruptedTools(input.requestHistory);
    let requiresBrowserSnapshot = requestHistory.some((message) => message.metadata?.kind === 'context_summary');
    const beforeUser = CommitInitialSyntheticMessages(input, input.messagesBeforeUser ?? []);
    const afterUser = CommitInitialSyntheticMessages(input, input.messagesAfterUser ?? []);
    transcript = [
      { role: 'system', content: input.systemContext },
      ...requestHistory,
      ...beforeUser,
      ...(input.resume ? [] : [input.userMessage ?? { role: 'user' as const, content: input.userContent }]),
      ...afterUser,
    ];
    const firstCompletionRequestIndex = apiRequestCount + 1;
    if (!hadHistoryAtRunStart) {
      RecordAppendedMessage(input, firstCompletionRequestIndex, 'system', { role: 'system', content: input.instructions.compiled });
      RecordAppendedMessage(input, firstCompletionRequestIndex, 'system', transcript[0]);
    }
    beforeUser.forEach((message) => RecordAppendedMessage(input, firstCompletionRequestIndex, 'runtime', message));
    if (!input.resume) RecordAppendedMessage(input, firstCompletionRequestIndex, 'user', input.userMessage ?? { role: 'user', content: input.userContent });
    afterUser.forEach((message) => RecordAppendedMessage(input, firstCompletionRequestIndex, 'runtime', message));
    // 用户输入一旦进入模型可见 transcript，即使本轮随后取消也必须能在下一轮恢复。
    await CommitHistory(input, transcript);
    if (!input.resume && input.prepareBrowserObservation) {
      const observation = await input.prepareBrowserObservation();
      signal.throwIfAborted();
      if (observation) {
        transcript = [...transcript, observation];
        RecordAppendedMessage(input, apiRequestCount + 1, 'runtime', observation);
      }
    }
    inputTokens = modules.modelProvider.EstimateTokens({ system: input.instructions.compiled, tools: input.toolArray, messages: transcript });
    while (true) {
      // 取消不经循环顶部轮询：模型流经 signal 中止抛错，由 catch 统一 FinishTrace 并 emit cancelled。
      if (turn >= maxTurns) {
        modules.observability.RecordLog('WARN', 'conversation.circuit_open', 'iteration_limit');
        modules.observability.FinishTrace(requestId, 'circuit_open', 'Circuit opened: iteration_limit. Transcript preserved for automatic recovery.');
        emit({ type: 'error', requestId, message: '本轮迭代达到上限，已暂停；会话上下文与历史已保留，可继续提问' });
        return { outcome: 'circuit_open', disposition: 'paused', reason: 'iteration_limit', transcript: HistorySnapshot(transcript), inputTokens, compressionCount };
      }
      const finalTurn = turn === maxTurns - 1;
      const currentConfirmationMode = input.runtimeReminder.getConfirmationMode?.() ?? input.runtimeReminder.confirmationMode;
      const confirmationChanged = currentConfirmationMode !== lastReminderConfirmationMode;
      if (ShouldInjectRuntimeReminder(turn, maxTurns, input.runtimeReminder.interval, confirmationChanged)) {
        reminderRevision += 1;
        const reminder = CreateRuntimeReminderMessage({
          now: input.runtimeReminder.now?.() ?? Date.now(),
          timeZone: input.runtimeReminder.timeZone,
          usedTurns: turn,
          maxTurns,
          confirmationMode: currentConfirmationMode,
          finalTurn,
          loadedSkillIds: input.runtimeReminder.getLoadedSkillIds?.() ?? [],
          boundResumeName: input.runtimeReminder.getBoundResumeName?.() ?? null,
        }, reminderRevision);
        transcript = [...transcript, reminder];
        RecordAppendedMessage(input, apiRequestCount + 1, 'runtime', reminder);
        await CommitHistory(input, transcript);
        modules.observability.AppendTraceEvent(requestId, 'runtime_reminder', {
          reminderRevision,
          injectedAtTurn: turn,
          maxTurns,
          remainingTurns: maxTurns - turn,
          confirmationMode: currentConfirmationMode,
          finalTurn,
        });
        lastReminderConfirmationMode = currentConfirmationMode;
      }
      turn += 1;
      const stepId = requestId + ':step:' + turn;
      emit({ type: 'conversation_activity', requestId, activity: { kind: 'step', stepId } });
      let currentPartKind = '';
      let partIndex = 0;
      const PartId = (kind: string) => { if (currentPartKind !== kind) { currentPartKind = kind; partIndex += 1; } return stepId + ':part:' + partIndex; };
      modules.observability.AppendTraceEvent(requestId, 'loop_turn', { turn });
      let apiRequestIndex = 0;
      // Provider 可能在 Promise settle 或取消后仍回调；仅当前流处于 active 时接收增量，避免终态后污染 UI。
      let acceptsProviderDelta = true;
      let streamedText = '', streamedReasoning = '';
      // 工具批次完整返回后、每次业务模型调用前统一检查；当前用户原文与动态状态完整计入预算。
      const dynamic = transcript.filter((message) => message.role === 'system' || IsRuntimeContextMessage(message));
      let compacted: Awaited<ReturnType<typeof CompactContextHistory>>;
      try {
        compacted = await CompactContextHistory({
          modules, provider: input.provider, model: input.model, reasoningEffort: input.reasoningEffort,
          modelConfiguration: input.modelConfiguration,
          history: HistorySnapshot(transcript), system: input.instructions.compiled, tools: input.toolArray,
          extraMessages: dynamic, signal, createId: input.createId, protectedState: input.getCompactionState?.(),
          onRequest: (snapshot) => { apiRequestIndex = NextApiRequestIndex(); RecordProviderRequest(input, apiRequestIndex, snapshot); },
          onUsage: (summary) => input.onModelUsage?.(CreateProviderUsageFact(summary.usage)),
        });
        if (compacted.archive) {
          await CommitHistory(input, compacted.history, compacted.archive);
          transcript = [...dynamic.filter((message) => message.role === 'system'), ...compacted.history, ...dynamic.filter((message) => message.role !== 'system')];
          compressionCount += 1;
          RecordAppendedMessage(input, apiRequestIndex + 1, 'runtime', compacted.history[0]);
          requiresBrowserSnapshot = true;
          modules.observability.AppendTraceEvent(requestId, 'context_compressed', { before: compacted.before, after: compacted.after, summaryId: compacted.archive.summaryId });
        }
      } catch (error) {
        signal.throwIfAborted();
        throw new ContextCompactionError(error instanceof Error ? error.message : '上下文压缩或原文归档失败，原历史已保留。');
      }
      if (compacted.archive || input.toolContext.requiresBrowserSnapshot === undefined) input.toolContext.requiresBrowserSnapshot = requiresBrowserSnapshot;
      requiresBrowserSnapshot = input.toolContext.requiresBrowserSnapshot;
      inputTokens = compacted.after;
      const completion = await modules.modelProvider.StreamCompletion({
        requestId,
        provider: input.provider,
        model: input.model,
        modelConfiguration: input.modelConfiguration,
        reasoningEffort: input.reasoningEffort,
        history: transcript,
        tools: input.toolArray,
        signal,
        instructions: input.instructions,
        onRequest: (snapshot) => {
          apiRequestIndex = NextApiRequestIndex();
          RecordProviderRequest(input, apiRequestIndex, snapshot);
        },
        onDelta: (delta) => {
          if (!acceptsProviderDelta || signal.aborted) return;
          if (delta.reasoning) { streamedReasoning += delta.reasoning; reasoningContent += delta.reasoning; emit({ type: 'thinking_delta', requestId, delta: delta.reasoning, activity: { kind: 'reasoning', stepId, partId: PartId('reasoning'), delta: delta.reasoning } }); }
          if (delta.content) { streamedText += delta.content; assistantContent += delta.content; emit({ type: 'content_delta', requestId, delta: delta.content, activity: { kind: 'text', stepId, partId: PartId('text'), delta: delta.content } }); }
        },
      }).finally(() => { acceptsProviderDelta = false; });
      ThrowIfRunCancelled(signal);
      // 部分 Provider 只返回完整正文，或最后一段未走流回调；只补齐已收到前缀的尾部，避免重复。
      const remainingReasoning = (completion.reasoningContent ?? '').startsWith(streamedReasoning) ? (completion.reasoningContent ?? '').slice(streamedReasoning.length) : '';
      const remainingText = completion.content.startsWith(streamedText) ? completion.content.slice(streamedText.length) : '';
      if (remainingReasoning) { reasoningContent += remainingReasoning; emit({ type: 'thinking_delta', requestId, delta: remainingReasoning, activity: { kind: 'reasoning', stepId, partId: PartId('reasoning'), delta: remainingReasoning } }); }
      if (remainingText) { assistantContent += remainingText; emit({ type: 'content_delta', requestId, delta: remainingText, activity: { kind: 'text', stepId, partId: PartId('text'), delta: remainingText } }); }
      input.onModelUsage?.(CreateProviderUsageFact(completion.usage));
      const assistantMessage: AgentMessage = {
        role: 'assistant',
        content: completion.content,
        ...(completion.reasoningContent ? { reasoning_content: completion.reasoningContent } : {}),
        ...(completion.toolCalls.length ? { tool_calls: completion.toolCalls } : {}),
      };
      transcript = [...transcript, assistantMessage];
      if (apiRequestIndex) RecordAppendedMessage(input, apiRequestIndex, 'provider', assistantMessage);
      await CommitHistory(input, transcript);
      if (!completion.toolCalls.length) break;
      if (finalTurn) {
        const exhaustedResults = completion.toolCalls.map(CreateTurnBudgetExhaustedResult);
        transcript = [...transcript, ...exhaustedResults];
        if (apiRequestIndex) exhaustedResults.forEach((message) => RecordAppendedMessage(input, apiRequestIndex, 'runtime', message));
        await CommitHistory(input, transcript);
        modules.observability.RecordLog('WARN', 'conversation.circuit_open', 'iteration_limit');
        modules.observability.FinishTrace(requestId, 'circuit_open', 'Final model turn attempted new tool calls.');
        emit({ type: 'error', requestId, message: '本轮模型轮数已用尽，最后一轮的新工具调用未执行；上下文已保存，可继续提问' });
        return { outcome: 'circuit_open', disposition: 'paused', reason: 'iteration_limit', transcript: HistorySnapshot(transcript), inputTokens, compressionCount };
      }
      toolCallCount += completion.toolCalls.length;
      if (toolCallCount > maxToolCalls) {
        const exhausted = completion.toolCalls.map((call) => ({ role: 'tool' as const, tool_call_id: call.id, content: JSON.stringify({ ok: false, code: 'TOOL_CALL_BUDGET_EXHAUSTED', executed: false, message: '工具调用预算已用尽，本批次未执行。' }) }));
        transcript = [...transcript, ...exhausted];
        if (apiRequestIndex) exhausted.forEach((message) => RecordAppendedMessage(input, apiRequestIndex, 'runtime', message));
        await CommitHistory(input, transcript);
        modules.observability.RecordLog('WARN', 'conversation.circuit_open', 'tool_call_limit');
        modules.observability.FinishTrace(requestId, 'circuit_open', 'Circuit opened: tool_call_limit.');
        emit({ type: 'error', requestId, message: '本轮工具调用达到上限，已暂停；可继续提问或缩小目标' });
        return { outcome: 'circuit_open', disposition: 'paused', reason: 'tool_call_limit', transcript: HistorySnapshot(transcript), inputTokens, compressionCount };
      }
      const contextToolCallIds = new Set(transcript.flatMap((message) => message.role === 'tool' && message.tool_call_id ? [message.tool_call_id] : []));
      settledTools.clear();
      const { results, disposition } = await RunToolBatch(input, completion.toolCalls, stepId, contextToolCallIds, (message) => { if (message.tool_call_id) settledTools.set(message.tool_call_id, message); });
      const toolResults = results as ToolExecutionResult[];
      const toolFollowups = CommitToolFollowups(input, toolResults);
      const protocolResults = toolResults.map(({ followupMessages: _followupMessages, ...result }) => result);
      const waitingIndex = input.onCheckpoint && (disposition === 'waiting_confirmation' || disposition === 'waiting_user_input')
        ? toolResults.findIndex((result) => ParseToolDisposition(result) === 'wait_confirmation'
          || (ParseToolDisposition(result) === 'wait_user_input' && input.toolContext.pendingQuestions.has(input.sessionId))) : -1;
      const committedResults = waitingIndex >= 0 ? protocolResults.slice(0, waitingIndex) : protocolResults;
      transcript = [...transcript, ...committedResults, ...(waitingIndex >= 0 ? [] : toolFollowups)];
      if (apiRequestIndex) {
        committedResults.forEach((message) => RecordAppendedMessage(input, apiRequestIndex, 'tool', message));
        if (waitingIndex < 0) toolFollowups.forEach((message) => RecordAppendedMessage(input, apiRequestIndex, 'runtime', message));
      }
      if (waitingIndex >= 0) input.onCheckpoint!({
        turn, toolCallCount, apiRequestCount, reminderRevision, lastReminderConfirmationMode, assistantContent, reasoningContent,
        pendingCall: completion.toolCalls[waitingIndex], pendingResult: toolResults[waitingIndex],
        remainingResults: protocolResults.slice(waitingIndex + 1), followups: toolFollowups,
      });
      await CommitHistory(input, transcript);
      if (disposition !== 'continue') {
        const waitOutcome = disposition === 'waiting_user_input' ? 'waiting_user_input' : disposition === 'waiting_confirmation' ? 'waiting_confirmation' : 'paused';
        modules.observability.RecordLog('INFO', `conversation.${waitOutcome}`, `turns=${turn}`);
        modules.observability.FinishTrace(requestId, waitOutcome, `Waiting or paused after ${turn} loop turn(s).`);
        emit({ type: waitOutcome, requestId, message: waitOutcome === 'waiting_user_input' ? '等待用户回答问题' : waitOutcome === 'waiting_confirmation' ? '等待用户确认提案' : '运行已暂停' });
        return { outcome: waitOutcome, disposition: waitOutcome, transcript: HistorySnapshot(transcript), inputTokens, compressionCount };
      }
    }
    modules.observability.RecordLog('INFO', 'conversation.completed', `turns=${turn}`);
    modules.observability.FinishTrace(requestId, 'completed', `Completed in ${turn} loop turn(s).`);
    emit({ type: 'completed', requestId, content: assistantContent, thinkingContent: reasoningContent });
    return { outcome: 'completed', disposition: 'completed', transcript: HistorySnapshot(transcript), inputTokens, compressionCount };
  } catch (error) {
    if (signal.aborted) {
      // 取消前已构建的用户输入、已完成的模型回复和工具结果仍属于会话事实；取消前尚未建好 transcript 时保留旧历史。
      if (transcript.length) { transcript = RecoverInterruptedTools(transcript); await CommitHistory(input, transcript); }
      modules.observability.FinishTrace(requestId, 'cancelled', 'Cancelled by user.');
      emit({ type: 'cancelled', requestId });
      return { outcome: 'cancelled', disposition: 'cancelled', transcript: HistorySnapshot(transcript), inputTokens, compressionCount };
    }
    const message = error instanceof Error ? error.message : 'Agent request failed.';
    if (transcript.some((item) => item.tool_calls?.length)) {
      const recovered = RecoverInterruptedTools(transcript);
      if (recovered !== transcript) { transcript = recovered; await CommitHistory(input, transcript); }
    }
    const compressionExhausted = error instanceof ContextCompactionError;
    modules.observability.RecordLog('ERROR', 'conversation.failed', message);
    const errorText = ScrubTraceContent(message);
    modules.observability.AppendTraceEvent(requestId, 'error', { message: errorText }, EstimateTraceTokens(errorText));
    if (compressionExhausted) {
      // 压缩只在完整工具批次之间运行。此处暂停不创建待确认检查点，Host 保留浏览器任务供用户续轮。
      modules.observability.FinishTrace(requestId, 'paused', 'context_compaction');
      emit({ type: 'paused', requestId, message: `上下文压缩未完成，本轮已暂停；原历史和浏览器任务已保留。${message}`.slice(0, 500) });
      return { outcome: 'paused', disposition: 'paused', reason: 'context_compaction', transcript: HistorySnapshot(transcript), inputTokens, compressionCount };
    }
    modules.observability.FinishTrace(requestId, 'failed', message);
    emit({ type: 'error', requestId, message: message.slice(0, 500) });
    throw new Error(message);
  }
}
