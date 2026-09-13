import type { AgentObservability, AgentTraceEvent } from '@avery/contracts';

/** 对话轨迹沿用原型的时间线形态：每条事件是一个消息，角色只有 system/user/assistant/tool。 */
export type TimelineRole = 'System' | 'User' | 'Tool' | 'Assistant';

export interface TimelineEvent extends AgentTraceEvent {
  id: string;
  requestId: string;
  runIndex: number;
  apiRequestIndex: number;
  requestKind: 'completion' | 'summary' | 'legacy';
  title: TimelineRole;
  detail: string;
  tone: 'is-neutral' | 'is-accent' | 'is-success' | 'is-warning' | 'is-danger';
}

export interface TraceTokenUsage {
  cachedInputTokens: number;
  uncachedInputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export type TraceSummary = AgentObservability['traces'][number];

function PayloadText(payload: unknown) {
  return JSON.stringify(payload ?? '');
}

function EstimateTokenCount(payload: unknown) {
  const content = PayloadText(payload);
  if (!content) return 0;
  let units = 0;
  for (const character of content) units += /[\u3400-\u9fff\uf900-\ufaff]/.test(character) ? 1 : .25;
  return Math.max(1, Math.ceil(units));
}

export function EventPayload(event: AgentTraceEvent) {
  return (event.payload && typeof event.payload === 'object' ? event.payload : {}) as Record<string, unknown>;
}

function MessageTitle(role: unknown): TimelineRole {
  if (role === 'system') return 'System';
  if (role === 'user') return 'User';
  if (role === 'tool') return 'Tool';
  return 'Assistant';
}

function MessageDetail(payload: Record<string, unknown>, message: Record<string, unknown>) {
  const direction = String(payload.direction ?? 'append');
  const source = String(payload.source ?? '');
  const calls = Array.isArray(message.tool_calls) ? message.tool_calls.length : 0;
  if (calls) return `Assistant message · ${calls} tool call${calls === 1 ? '' : 's'}`;
  if (message.role === 'tool') return `Tool result${message.tool_call_id ? ` · ${String(message.tool_call_id)}` : ''}`;
  if (direction === 'input') return `API input · message ${Number(payload.messageIndex ?? 0) + 1}`;
  if (direction === 'output') return 'API output';
  return source ? `Appended by ${source}` : 'Appended message';
}

function MessageFingerprint(message: Record<string, unknown>) {
  return JSON.stringify(message);
}

function NextMessageOccurrenceKey(message: Record<string, unknown>, counts: Map<string, number>) {
  const fingerprint = MessageFingerprint(message);
  const occurrence = (counts.get(fingerprint) ?? 0) + 1;
  counts.set(fingerprint, occurrence);
  return `${fingerprint}\u0000${occurrence}`;
}

/**
 * Provider 请求会重复携带完整历史，append 事件又会在下一请求中成为 input；直接平铺会把同一消息展示两次。
 * API input 是实际发送事实，优先作为权威来源。消息用“内容指纹 + 请求内出现序号”标识，避免动态提醒改变中间前缀后
 * 把其后的完整历史误判为新消息；相同正文确实在同一请求出现多次时仍能分别保留。
 */
function SelectCanonicalMessageOrdinals(events: AgentTraceEvent[]) {
  const visibleInputOrdinals = new Set<number>();
  const inputOrdinalsByOccurrence = new Map<string, number[]>();
  const occurrenceByOrdinal = new Map<number, string>();
  const requestMessages = new Map<number, Array<{ event: AgentTraceEvent; message: Record<string, unknown>; direction: string }>>();
  for (const event of events) {
    if (event.eventType !== 'message') continue;
    const payload = EventPayload(event);
    const message = payload.message && typeof payload.message === 'object' ? payload.message as Record<string, unknown> : {};
    const apiRequestIndex = Math.max(1, Number(payload.apiRequestIndex) || 1);
    const items = requestMessages.get(apiRequestIndex) ?? [];
    items.push({ event, message, direction: String(payload.direction ?? 'append') });
    requestMessages.set(apiRequestIndex, items);
  }

  const seenInputOccurrences = new Set<string>();
  for (const [, items] of [...requestMessages].sort(([left], [right]) => left - right)) {
    const counts = new Map<string, number>();
    for (const item of items.filter(({ direction }) => direction === 'input').sort((left, right) => left.event.ordinal - right.event.ordinal)) {
      const occurrence = NextMessageOccurrenceKey(item.message, counts);
      occurrenceByOrdinal.set(item.event.ordinal, occurrence);
      inputOrdinalsByOccurrence.set(occurrence, [...(inputOrdinalsByOccurrence.get(occurrence) ?? []), item.event.ordinal]);
      if (!seenInputOccurrences.has(occurrence)) {
        visibleInputOrdinals.add(item.event.ordinal);
        seenInputOccurrences.add(occurrence);
      }
    }
    // output/append 会成为下一次请求的 input；从本次 input 的相同消息计数继续编号，才能匹配其逻辑位置。
    for (const item of items.filter(({ direction }) => direction !== 'input').sort((left, right) => left.event.ordinal - right.event.ordinal)) {
      occurrenceByOrdinal.set(item.event.ordinal, NextMessageOccurrenceKey(item.message, counts));
    }
  }
  return { visibleInputOrdinals, inputOrdinalsByOccurrence, occurrenceByOrdinal };
}

/** 新 Trace 直接消费 append-only 消息；旧 Trace 才使用内容指纹兼容历史数据。 */
export function BuildTimeline(requestId: string, runIndex: number, events: AgentTraceEvent[]) {
  const timeline: TimelineEvent[] = [];
  const hasAppendOnlyMessages = events.some((event) => event.eventType === 'message_appended');
  const hasMessageEvents = events.some((event) => event.eventType === 'message');
  const { visibleInputOrdinals, inputOrdinalsByOccurrence, occurrenceByOrdinal } = hasAppendOnlyMessages
    ? { visibleInputOrdinals: new Set<number>(), inputOrdinalsByOccurrence: new Map<string, number[]>(), occurrenceByOrdinal: new Map<number, string>() }
    : SelectCanonicalMessageOrdinals(events);
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    const payload = EventPayload(event);
    const tokenCount = event.tokenCount || EstimateTokenCount(event.payload);
    if (event.eventType === 'message_appended') {
      const message = payload.message && typeof payload.message === 'object' ? payload.message as Record<string, unknown> : {};
      const title = MessageTitle(message.role);
      const apiRequestIndex = Math.max(1, Number(payload.apiRequestIndex) || 1);
      let tone: TimelineEvent['tone'] = title === 'Assistant' ? 'is-accent' : 'is-neutral';
      if (title === 'Tool') {
        try { tone = JSON.parse(String(message.content ?? '{}')).ok === true ? 'is-success' : 'is-danger'; } catch { tone = 'is-warning'; }
      }
      timeline.push({ ...event, id: `${requestId}-${event.ordinal}`, requestId, runIndex, apiRequestIndex, requestKind: 'completion', title, detail: MessageDetail(payload, message), tone, tokenCount, payload: message });
    } else if (!hasAppendOnlyMessages && event.eventType === 'message') {
      const message = payload.message && typeof payload.message === 'object' ? payload.message as Record<string, unknown> : {};
      if (payload.direction === 'input' && !visibleInputOrdinals.has(event.ordinal)) continue;
      if (payload.direction !== 'input') {
        const occurrence = occurrenceByOrdinal.get(event.ordinal) ?? '';
        const laterInputs = inputOrdinalsByOccurrence.get(occurrence) ?? [];
        if (laterInputs.some((ordinal) => ordinal > event.ordinal)) continue;
      }
      const title = MessageTitle(message.role);
      const apiRequestIndex = Math.max(1, Number(payload.apiRequestIndex) || 1);
      const requestKind = payload.kind === 'summary' ? 'summary' : 'completion';
      let tone: TimelineEvent['tone'] = title === 'Assistant' ? 'is-accent' : 'is-neutral';
      if (title === 'Tool') {
        try { tone = JSON.parse(String(message.content ?? '{}')).ok === true ? 'is-success' : 'is-danger'; } catch { tone = 'is-warning'; }
      }
      timeline.push({ ...event, id: `${requestId}-${event.ordinal}`, requestId, runIndex, apiRequestIndex, requestKind, title, detail: MessageDetail(payload, message), tone, tokenCount, payload: message });
    } else if (!hasAppendOnlyMessages && !hasMessageEvents && event.eventType === 'system_prompt') {
      timeline.push({ ...event, id: `${requestId}-${event.ordinal}`, requestId, runIndex, apiRequestIndex: 1, requestKind: 'legacy', title: 'System', detail: 'System prompt', tone: 'is-neutral', tokenCount });
    } else if (!hasAppendOnlyMessages && event.eventType === 'user_message') {
      if (!hasMessageEvents) timeline.push({ ...event, id: `${requestId}-${event.ordinal}`, requestId, runIndex, apiRequestIndex: 1, requestKind: 'legacy', title: 'User', detail: 'User message', tone: 'is-neutral', tokenCount });
    } else if (!hasAppendOnlyMessages && !hasMessageEvents && event.eventType === 'tool_call') {
      timeline.push({ ...event, id: `${requestId}-${event.ordinal}`, requestId, runIndex, apiRequestIndex: 1, requestKind: 'legacy', title: 'Tool', detail: `${String(payload.name ?? 'Tool')} · Call`, tone: 'is-warning', tokenCount });
    } else if (!hasAppendOnlyMessages && !hasMessageEvents && event.eventType === 'tool_result') {
      timeline.push({ ...event, id: `${requestId}-${event.ordinal}`, requestId, runIndex, apiRequestIndex: 1, requestKind: 'legacy', title: 'Tool', detail: `${String(payload.name ?? 'Tool')} · Result`, tone: payload.ok === true ? 'is-success' : 'is-danger', tokenCount });
    } else if (!hasAppendOnlyMessages && !hasMessageEvents && event.eventType === 'assistant_message') {
      timeline.push({ ...event, id: `${requestId}-${event.ordinal}`, requestId, runIndex, apiRequestIndex: 1, requestKind: 'legacy', title: 'Assistant', detail: 'Assistant message', tone: 'is-accent', tokenCount });
    } else if (!hasAppendOnlyMessages && !hasMessageEvents && event.eventType === 'error') {
      timeline.push({ ...event, id: `${requestId}-${event.ordinal}`, requestId, runIndex, apiRequestIndex: 1, requestKind: 'legacy', title: 'Assistant', detail: 'Request failed', tone: 'is-danger', tokenCount });
    }
  }
  return timeline;
}

/**
 * Trace 摘要当前只保证 prompt、completion 和 total 三项；缓存命中字段采用前向兼容读取，
 * 以便主进程补齐 cachedInputTokens 后，Renderer 无需改变展示协议即可直接绘制第三段。
 */
export function CreateTraceTokenUsage(traces: TraceSummary[]): TraceTokenUsage {
  let cachedInputTokens = 0;
  let promptTokens = 0;
  let outputTokens = 0;
  let reportedTotalTokens = 0;
  for (const trace of traces) {
    const usage = trace.usage;
    promptTokens += Math.max(0, usage.promptTokens);
    outputTokens += Math.max(0, usage.completionTokens);
    reportedTotalTokens += Math.max(0, usage.totalTokens);
    const cached = Number((usage as unknown as { cachedInputTokens?: unknown }).cachedInputTokens);
    if (Number.isFinite(cached)) cachedInputTokens += Math.max(0, Math.min(usage.promptTokens, cached));
  }
  const uncachedInputTokens = Math.max(0, promptTokens - cachedInputTokens);
  const totalTokens = Math.max(reportedTotalTokens, cachedInputTokens + uncachedInputTokens + outputTokens);
  return { cachedInputTokens, uncachedInputTokens, outputTokens, totalTokens };
}

/** 将结构化载荷转换为可阅读的键值内容，避免详情中出现 JSON 字符串引号。 */
export function FormatPayload(payload: unknown, depth = 0): string {
  const indent = '  '.repeat(depth);
  if (payload === null || payload === undefined) return 'null';
  if (typeof payload === 'string' || typeof payload === 'number' || typeof payload === 'boolean') return String(payload);
  if (Array.isArray(payload)) {
    if (!payload.length) return '[]';
    return payload.map((item) => {
      if (item && typeof item === 'object') return `${indent}-\n${FormatPayload(item, depth + 1)}`;
      return `${indent}- ${FormatPayload(item, depth + 1)}`;
    }).join('\n');
  }
  if (typeof payload === 'object') {
    const entries = Object.entries(payload as Record<string, unknown>);
    if (!entries.length) return '{}';
    return entries.map(([key, value]) => {
      if (value && typeof value === 'object') return `${indent}${key}:\n${FormatPayload(value, depth + 1)}`;
      return `${indent}${key}: ${FormatPayload(value, depth + 1)}`;
    }).join('\n');
  }
  return String(payload);
}

/** 将详情载荷拆为字段卡片，避免不同语义的数据混在同一个 JSON 文本区。 */
export function PayloadSections(payload: unknown) {
  const HasContent = (value: unknown): boolean => {
    if (value === null || value === undefined) return false;
    if (typeof value === 'string') return value.trim().length > 0;
    if (Array.isArray(value)) return value.length > 0;
    if (typeof value === 'object') return Object.keys(value as Record<string, unknown>).length > 0;
    return true;
  };
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return HasContent(payload) ? [{ key: 'content', value: payload }] : [];
  const entries = Object.entries(payload as Record<string, unknown>);
  return entries.filter(([, value]) => HasContent(value)).map(([key, value]) => ({ key, value }));
}
