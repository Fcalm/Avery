"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ScrubTraceContent = ScrubTraceContent;
exports.RunAgentLoop = RunAgentLoop;
/** 从 Trace 正文中移除常见密钥、Bearer 凭据与超长内容；纯函数，供内核事件脱敏。 */
function ScrubTraceContent(value) {
    return String(value ?? '').replace(/Bearer\s+[^\s]+/gi, 'Bearer [REDACTED]').replace(/\bsk-[A-Za-z0-9_-]+\b/g, '[REDACTED_API_KEY]').slice(0, 20000);
}
/** Trace 没有逐事件的 Provider usage 时，以中英文字符密度给出稳定的本地估算值。 */
function EstimateTraceTokens(value) {
    const text = String(value ?? '');
    if (!text)
        return 0;
    let units = 0;
    for (const character of text)
        units += /[\u3400-\u9fff\uf900-\ufaff]/.test(character) ? 1 : 0.25;
    return Math.max(1, Math.ceil(units));
}
/** 提取不含 system 消息的 transcript 副本，供宿主持久化会话历史。 */
function HistorySnapshot(transcript) {
    return transcript.filter((message) => message.role !== 'system').slice(-40);
}
/** 按真实用户轮次压缩早期历史；重试循环内置 3 次熔断，全部失败抛出压缩错误（宿主据此传播）。 */
async function CompressIfNeeded(input, history, onCompressed) {
    const { modules, toolArray } = input;
    const { contextLimit, threshold } = modules.modelProvider.GetRuntimeLimits();
    const estimate = modules.modelProvider.EstimateTokens({
        system: modules.modelProvider.SystemPrompt(),
        tools: toolArray,
        messages: [...history, { role: 'user', content: input.userContent }],
    });
    if (!modules.compaction.ShouldCompact(estimate, contextLimit, threshold))
        return history;
    let candidate = history;
    // 标记是否已因摘要失败降级截断过：若截断后仍无更早轮可切分，说明压缩无法推进，进入熔断而非静默丢弃历史。
    let dropped = false;
    for (let retry = 0; retry <= 3; retry += 1) {
        try {
            const { earlier, recent } = modules.compaction.SplitRecentTurns(candidate);
            if (!earlier.length) {
                if (dropped)
                    throw new Error('Context compression cannot make progress: history has no earlier turns to compact.');
                return candidate;
            }
            const summary = await modules.modelProvider.CreateSummary(input.model, earlier);
            input.onModelUsage?.(summary.usage);
            const compacted = [{ role: 'user', content: `<summary summary_id="summary-${input.createId()}">${summary.content}</summary>` }, ...recent];
            input.histories.set(input.sessionId, compacted);
            onCompressed();
            modules.observability.AppendTraceEvent(input.requestId, 'context_compressed', { retry, removed: earlier.length });
            modules.observability.RecordLog('INFO', 'context.compressed', `retry=${retry}; removed=${earlier.length}`);
            return compacted;
        }
        catch (error) {
            // 熔断错误（无更早轮）直接上抛，不再尝试降级截断。
            if (error instanceof Error && /cannot make progress/i.test(error.message))
                throw error;
            candidate = modules.compaction.DropOldestTurns(candidate, 5);
            dropped = true;
            modules.observability.AppendTraceEvent(input.requestId, 'context_compress_retry', { retry: retry + 1 });
            modules.observability.RecordLog('WARN', 'context.compress_retry', `retry=${retry + 1}`);
        }
    }
    throw new Error('Context compression failed after three retries. Start a new conversation or shorten the request.');
}
/** 按 tool_call 顺序执行工具；并发屏障由 isConcurrencySafe 标记区分，当前默认串行以严格保持工具结果与宿主副作用顺序。 */
async function RunToolCalls(input, calls) {
    const results = [];
    for (const call of calls) {
        const argumentsText = ScrubTraceContent(call.function.arguments);
        input.modules.observability.AppendTraceEvent(input.requestId, 'tool_call', { name: call.function.name, arguments: argumentsText }, EstimateTraceTokens(argumentsText));
        const result = await input.modules.tools.ExecuteToolCall(call, input.toolContext);
        results.push(result);
        let resultState = { ok: false, code: 'UNPARSEABLE', message: '' };
        try {
            const parsed = JSON.parse(result.content);
            resultState = { ok: parsed.ok === true, code: parsed.code, message: ScrubTraceContent(String(parsed.message ?? '').slice(0, 200)) };
        }
        catch { /* 工具结果无法解析时保留默认失败标记。 */ }
        input.modules.observability.AppendTraceEvent(input.requestId, 'tool_result', { name: call.function.name, ...resultState }, EstimateTraceTokens(resultState.message));
    }
    return results;
}
/** 纯 Agent 内核：Send 的 while 状态机。宿主负责配置、快照、持久化与事件出口；Kernel 不持有 config/凭据/业务态。 */
async function RunAgentLoop(input) {
    const { modules, emit, signal, requestId } = input;
    let compressionCount = 0;
    let requestHistory;
    let transcript = [];
    let inputTokens = 0;
    let assistantContent = '';
    let reasoningContent = '';
    let turn = 0;
    try {
        // 压缩熔断错误进入 catch，统一 FinishTrace/emit error（旧实现压缩在 try 外，抛错会跳过 Trace 收尾导致 running 幽灵 Trace）。
        requestHistory = await CompressIfNeeded(input, input.requestHistory, () => { compressionCount += 1; });
        transcript = [{ role: 'system', content: input.systemContext }, ...requestHistory, { role: 'user', content: input.userContent }];
        inputTokens = modules.modelProvider.EstimateTokens({ system: modules.modelProvider.SystemPrompt(), tools: input.toolArray, messages: transcript });
        while (true) {
            // 取消不经循环顶部轮询：模型流经 signal 中止抛错，由 catch 统一 FinishTrace 并 emit cancelled。
            if (turn >= input.maxTurns) {
                // 熔断时仍落库当前 transcript（与原运行时一致），宿主据此持久化恢复。
                input.histories.set(input.sessionId, HistorySnapshot(transcript));
                modules.observability.RecordLog('WARN', 'conversation.circuit_open', 'iteration_limit');
                modules.observability.FinishTrace(requestId, 'circuit_open', 'Circuit opened: iteration_limit. Transcript preserved for automatic recovery.');
                emit({ type: 'error', requestId, message: '本轮迭代达到上限，已暂停；会话上下文与历史已保留，可继续提问' });
                return { outcome: 'circuit_open', reason: 'iteration_limit', transcript: HistorySnapshot(transcript), inputTokens, compressionCount };
            }
            turn += 1;
            modules.observability.AppendTraceEvent(requestId, 'loop_turn', { turn });
            const completion = await modules.modelProvider.StreamCompletion({
                requestId,
                model: input.model,
                history: transcript,
                tools: input.toolArray,
                signal,
                onDelta: (delta) => {
                    if (delta.reasoning) {
                        reasoningContent += delta.reasoning;
                        emit({ type: 'thinking_delta', requestId, delta: delta.reasoning });
                    }
                    if (delta.content) {
                        assistantContent += delta.content;
                        emit({ type: 'content_delta', requestId, delta: delta.content });
                    }
                },
            });
            input.onModelUsage?.(completion.usage);
            const assistantMessage = {
                role: 'assistant',
                content: completion.content,
                ...(completion.reasoningContent ? { reasoning_content: completion.reasoningContent } : {}),
                ...(completion.toolCalls.length ? { tool_calls: completion.toolCalls } : {}),
            };
            transcript = [...transcript, assistantMessage];
            if (!completion.toolCalls.length)
                break;
            const results = await RunToolCalls(input, completion.toolCalls);
            transcript = [...transcript, ...results];
            const awaitingUser = results.some((result) => {
                try {
                    return JSON.parse(result.content).awaitingUser === true;
                }
                catch {
                    return false;
                }
            });
            if (awaitingUser)
                break;
        }
        input.histories.set(input.sessionId, HistorySnapshot(transcript));
        modules.observability.RecordLog('INFO', 'conversation.completed', `turns=${turn}`);
        const responseText = ScrubTraceContent(assistantContent);
        const reasoningText = ScrubTraceContent(reasoningContent);
        modules.observability.AppendTraceEvent(requestId, 'assistant_message', { content: responseText, reasoning: reasoningText }, EstimateTraceTokens(`${responseText}\n${reasoningText}`));
        modules.observability.FinishTrace(requestId, 'completed', `Completed in ${turn} loop turn(s).`);
        emit({ type: 'completed', requestId, content: assistantContent, thinkingContent: reasoningContent });
        return { outcome: 'completed', transcript: HistorySnapshot(transcript), inputTokens, compressionCount };
    }
    catch (error) {
        if (signal.aborted) {
            modules.observability.FinishTrace(requestId, 'cancelled', 'Cancelled by user.');
            emit({ type: 'cancelled', requestId });
            return { outcome: 'cancelled', transcript: HistorySnapshot(transcript), inputTokens, compressionCount };
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
