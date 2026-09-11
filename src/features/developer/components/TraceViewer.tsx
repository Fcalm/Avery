import { useEffect, useMemo, useRef, useState, type MouseEventHandler } from 'react';
import type { AgentObservability, AgentTraceEvent } from '@avery/contracts';
import { Icon } from '../../../shared/components/Icon';
import { Modal, Button } from '../../../shared/components/UI';

type TraceSummary = AgentObservability['traces'][number];

interface ConversationOption { id: string; title: string; }
interface ConversationTrace {
  id: string;
  title: string;
  traces: TraceSummary[];
  latestAt: number;
}

interface TimelineEvent extends AgentTraceEvent {
  id: string;
  requestId: string;
  runIndex: number;
  apiRequestIndex: number;
  requestKind: 'completion' | 'summary' | 'legacy';
  title: 'System' | 'User' | 'Tool' | 'Assistant';
  detail: string;
  tone: 'is-neutral' | 'is-accent' | 'is-success' | 'is-warning' | 'is-danger';
}

interface ApiRequestEvent extends AgentTraceEvent {
  id: string;
  requestId: string;
  runIndex: number;
  apiRequestIndex: number;
  requestKind: 'completion' | 'summary';
  model: string;
  messageCount: number;
  toolCount: number;
}

type EventFilter = 'all' | TimelineEvent['title'] | 'Success' | 'Failed';
type TraceView = 'messages' | 'requests';

const StateLabels: Record<string, string> = { completed: '已完成', running: '进行中', failed: '失败', cancelled: '已取消', circuit_open: '已暂停', interrupted: '已中断' };

function FormatTime(value: number | string) {
  return new Date(value).toLocaleTimeString('zh-CN', { hour12: false });
}

function FormatDateTime(value: number | string) {
  return new Date(value).toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function StateTone(state: string) {
  const normalized = state.toLowerCase();
  if (normalized.includes('fail') || normalized.includes('error')) return 'is-danger';
  if (normalized.includes('run') || normalized.includes('pending')) return 'is-warning';
  return 'is-success';
}

function PayloadText(payload: unknown) {
  return JSON.stringify(payload ?? '');
}

/** 将结构化载荷转换为可阅读的键值内容，避免详情中出现 JSON 字符串引号。 */
function FormatPayload(payload: unknown, depth = 0): string {
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
function PayloadSections(payload: unknown) {
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

function EstimateTokenCount(payload: unknown) {
  const content = PayloadText(payload);
  if (!content) return 0;
  let units = 0;
  for (const character of content) units += /[\u3400-\u9fff\uf900-\ufaff]/.test(character) ? 1 : .25;
  return Math.max(1, Math.ceil(units));
}

function EventPayload(event: AgentTraceEvent) {
  return (event.payload && typeof event.payload === 'object' ? event.payload : {}) as Record<string, unknown>;
}

function MessageTitle(role: unknown): TimelineEvent['title'] {
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

/** API 请求保留 Provider 最终序列化后的完整输入，但不会展开成消息时间线事件。 */
export function BuildApiRequests(requestId: string, runIndex: number, events: AgentTraceEvent[]): ApiRequestEvent[] {
  return events.filter((event) => event.eventType === 'provider_request').map((event) => {
    const payload = EventPayload(event);
    return {
      ...event,
      id: `${requestId}-request-${event.ordinal}`,
      requestId,
      runIndex,
      apiRequestIndex: Math.max(1, Number(payload.apiRequestIndex) || 1),
      requestKind: payload.kind === 'summary' ? 'summary' : 'completion',
      model: String(payload.model ?? '—'),
      messageCount: Math.max(0, Number(payload.messageCount) || 0),
      toolCount: Math.max(0, Number(payload.toolCount) || 0),
    };
  });
}

function EventRow({ event, expanded, onToggle }: { event: TimelineEvent; expanded: boolean; onToggle: () => void }) {
  return <article className={`trace-event ${expanded ? 'open' : ''}`}>
    <button className="trace-event-summary" type="button" aria-expanded={expanded} onClick={onToggle}>
      <span className="trace-event-copy"><b className={`trace-event-role trace-event-role-${event.title.toLowerCase()}`}>{event.title}</b><small>{event.detail}</small></span>
      <span className="trace-event-tokens">{event.tokenCount.toLocaleString()} tokens</span>
      <time>{FormatTime(event.createdAt)}</time>
    </button>
    {expanded && <pre>{FormatPayload(event.payload)}</pre>}
  </article>;
}

function EventThumbnail({ event, selected, onSelect }: { event: TimelineEvent; selected: boolean; onSelect: () => void }) {
  const outcome = event.tone === 'is-success' ? 'Success' : event.tone === 'is-danger' ? 'Failed' : '—';
  return <button className={`trace-event-thumbnail ${selected ? 'selected' : ''}`} type="button" aria-current={selected ? 'true' : undefined} onClick={onSelect}>
    <b className={`trace-event-role trace-event-role-${event.title.toLowerCase()}`}>{event.title}</b>
    <small className={`trace-event-outcome ${event.tone}`}>{outcome}</small>
    <time>{FormatTime(event.createdAt)}</time>
  </button>;
}

function DetailSections({ payload }: { payload: unknown }) {
  const [collapsedSections, setCollapsedSections] = useState<Set<string>>(new Set());
  const sections = useMemo(() => PayloadSections(payload), [payload]);

  useEffect(() => {
    // 选择另一条事件时恢复默认展开，避免旧事件的阅读状态泄漏。
    setCollapsedSections(new Set());
  }, [payload]);

  function ToggleSection(key: string) {
    setCollapsedSections((current) => { const next = new Set(current); next.has(key) ? next.delete(key) : next.add(key); return next; });
  }

  return <div className="trace-event-detail-sections">{sections.map(({ key, value }) => {
    const expanded = !collapsedSections.has(key);
    return <section className="trace-event-detail-section" key={key}>
      <button className="trace-event-detail-section-summary" type="button" aria-expanded={expanded} onClick={() => ToggleSection(key)}><b>{key}</b><Icon name={expanded ? 'chevron-up' : 'chevron-down'} size={14} /></button>
      {expanded && <pre>{FormatPayload(value)}</pre>}
    </section>;
  })}</div>;
}

function EventDetail({ event }: { event: TimelineEvent }) {
  return <article className="trace-event-detail-card">
    <header>
      <span className="trace-event-copy"><b className={`trace-event-role trace-event-role-${event.title.toLowerCase()}`}>{event.title}</b><small>{event.detail}</small></span>
      <span className="trace-event-tokens">{event.tokenCount.toLocaleString()} tokens</span>
      <time>{FormatTime(event.createdAt)}</time>
    </header>
    <DetailSections payload={event.payload} />
  </article>;
}

function ApiRequestRow({ request, expanded, onToggle }: { request: ApiRequestEvent; expanded: boolean; onToggle: () => void }) {
  return <article className={`trace-event ${expanded ? 'open' : ''}`}>
    <button className="trace-event-summary" type="button" aria-expanded={expanded} onClick={onToggle}>
      <span className="trace-event-copy"><b>API REQUEST-{request.apiRequestIndex}</b><small>{request.requestKind} · {request.model}</small></span>
      <span className="trace-event-tokens">{request.messageCount} messages · {request.toolCount} tools</span>
      <time>{FormatTime(request.createdAt)}</time>
    </button>
    {expanded && <pre>{FormatPayload(request.payload)}</pre>}
  </article>;
}

function ApiRequestThumbnail({ request, selected, onSelect }: { request: ApiRequestEvent; selected: boolean; onSelect: () => void }) {
  return <button className={`trace-event-thumbnail ${selected ? 'selected' : ''}`} type="button" aria-current={selected ? 'true' : undefined} onClick={onSelect}>
    <b>API REQUEST-{request.apiRequestIndex}</b>
    <small>{request.requestKind} · {request.messageCount} messages</small>
    <time>{FormatTime(request.createdAt)}</time>
  </button>;
}

function ApiRequestDetail({ request }: { request: ApiRequestEvent }) {
  return <article className="trace-event-detail-card">
    <header>
      <span className="trace-event-copy"><b>API REQUEST-{request.apiRequestIndex}</b><small>{request.requestKind} · {request.model}</small></span>
      <span className="trace-event-tokens">{request.messageCount} messages · {request.toolCount} tools</span>
      <time>{FormatTime(request.createdAt)}</time>
    </header>
    <DetailSections payload={request.payload} />
  </article>;
}

interface TraceTurn<Item extends { runIndex: number; createdAt: number | string }> {
  runIndex: number;
  createdAt: number | string;
  items: Item[];
}

function GroupByTurn<Item extends { runIndex: number; createdAt: number | string }>(items: Item[]): TraceTurn<Item>[] {
  const groups = new Map<number, TraceTurn<Item>>();
  for (const item of items) {
    const group = groups.get(item.runIndex);
    if (group) group.items.push(item);
    else groups.set(item.runIndex, { runIndex: item.runIndex, createdAt: item.createdAt, items: [item] });
  }
  return [...groups.values()];
}

function TurnIndex({ runIndex, count, createdAt, expanded, onToggle }: { runIndex: number; count: number; createdAt: number | string; expanded: boolean; onToggle: () => void }) {
  return <button className="trace-turn-index" type="button" aria-expanded={expanded} onClick={onToggle}>
    <b>TURN-{runIndex}</b><small>{count} 条事件</small><time>{FormatTime(createdAt)}</time><Icon name={expanded ? 'chevron-up' : 'chevron-down'} size={14} />
  </button>;
}

interface TraceTokenUsage {
  cachedInputTokens: number;
  uncachedInputTokens: number;
  outputTokens: number;
  totalTokens: number;
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

function TokenUsageRing({ usage }: { usage: TraceTokenUsage }) {
  const segments = [
    { key: 'cached', label: '命中输入', tokens: usage.cachedInputTokens, color: 'var(--trace-token-cached)', desc: '由 Provider 缓存命中、无需重新计费的输入 token 数量' },
    { key: 'input', label: '输入（未命中）', tokens: usage.uncachedInputTokens, color: 'var(--trace-token-input)', desc: '未经缓存、完整发送给 Provider 的输入 token 数量' },
    { key: 'output', label: '输出', tokens: usage.outputTokens, color: 'var(--trace-token-output)', desc: '模型生成的输出 token 数量' },
  ];
  const [hovered, setHovered] = useState<string | null>(null);
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const tooltipRef = useRef<HTMLDivElement>(null);

  // 悬停详情面板跟随指针，靠近视口边缘时翻转到指针另一侧，避免被裁切。
  const TrackTooltip: MouseEventHandler = (event) => {
    const pad = 14;
    const width = tooltipRef.current?.offsetWidth ?? 220;
    const height = tooltipRef.current?.offsetHeight ?? 88;
    let x = event.clientX + pad;
    let y = event.clientY + pad;
    if (x + width > window.innerWidth - 8) x = event.clientX - width - pad;
    if (y + height > window.innerHeight - 8) y = event.clientY - height - pad;
    setPosition({ x, y });
  };

  function Enter(key: string): MouseEventHandler {
    return (event) => { setHovered(key); TrackTooltip(event); };
  }

  const active = hovered === 'total'
    ? { label: '总 token', tokens: usage.totalTokens, color: null, desc: '缓存命中输入、未命中输入与输出 token 之和' }
    : hovered ? segments.find((segment) => segment.key === hovered) ?? null : null;
  let offset = 0;
  return <div className="trace-token-usage">
    <dl className="trace-token-legend">
      <div onMouseEnter={Enter('total')} onMouseMove={TrackTooltip} onMouseLeave={() => setHovered(null)}>
        <dt>总 token</dt><dd>{usage.totalTokens.toLocaleString()}</dd>
      </div>
      {segments.filter((segment) => segment.key !== 'input').map((segment) => <div key={segment.key} onMouseEnter={Enter(segment.key)} onMouseMove={TrackTooltip} onMouseLeave={() => setHovered(null)}>
        <dt><i aria-hidden="true" style={{ background: segment.color }} />{segment.label}</dt>
        <dd>{segment.tokens.toLocaleString()}</dd>
      </div>)}
    </dl>
    <div className="trace-token-ring" role="img" aria-label={`Token 总计 ${usage.totalTokens.toLocaleString()}`}>
      <svg viewBox="0 0 40 40" aria-hidden="true" focusable="false">
        <circle className="trace-token-ring-track" cx="20" cy="20" r="15.5" pathLength="100" />
        {segments.map((segment) => {
          const percentage = usage.totalTokens ? segment.tokens / usage.totalTokens * 100 : 0;
          const segmentLength = percentage ? Math.max(percentage - 1.2, 0) : 0;
          const dashOffset = -(offset + (percentage ? .6 : 0));
          offset += percentage;
          const state = hovered === segment.key ? ' is-active' : hovered && hovered !== 'total' ? ' is-dim' : '';
          return <circle key={segment.key} className={`trace-token-ring-segment is-${segment.key}${state}`} cx="20" cy="20" r="15.5" pathLength="100" strokeDasharray={`${segmentLength} ${100 - segmentLength}`} strokeDashoffset={dashOffset} onMouseEnter={Enter(segment.key)} onMouseMove={TrackTooltip} onMouseLeave={() => setHovered(null)} />;
        })}
      </svg>
    </div>
    {active && <div ref={tooltipRef} className="trace-token-tooltip" style={{ left: position.x, top: position.y }}>
      <div className="trace-token-tooltip-name">{active.color && <i aria-hidden="true" style={{ background: active.color }} />}{active.label}</div>
      <div className="trace-token-tooltip-value">{active.tokens.toLocaleString()} · 占比 {(usage.totalTokens ? active.tokens / usage.totalTokens * 100 : 0).toFixed(1)}%</div>
      <div className="trace-token-tooltip-desc">{active.desc}</div>
    </div>}
  </div>;
}

/** 按会话聚合 Trace；每次模型请求在右侧时间线中以 Request-n 分隔。 */
function TraceViewer({ traces, conversations, onSelectTrace, onDeleteTraces, focusConversationId }: { traces: TraceSummary[]; conversations: ConversationOption[]; onSelectTrace: (requestId: string) => Promise<AgentTraceEvent[]>; onDeleteTraces?: (sessionIds: string[]) => Promise<void>; focusConversationId?: string | null }) {
  const isCurrentConversationMode = focusConversationId !== undefined;
  const [selectedConversationId, setSelectedConversationId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ConversationTrace | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [eventsByRequest, setEventsByRequest] = useState<Record<string, AgentTraceEvent[]>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [collapsedTurns, setCollapsedTurns] = useState<Set<string>>(new Set());
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null);
  const [selectedApiRequestId, setSelectedApiRequestId] = useState<string | null>(null);
  const [traceView, setTraceView] = useState<TraceView>('messages');
  const [query, setQuery] = useState('');
  const [eventFilter, setEventFilter] = useState<EventFilter>('all');
  const [showTraceFilter, setShowTraceFilter] = useState(false);
  const traceFilterRef = useRef<HTMLDivElement>(null);

  const conversationTraces = useMemo<ConversationTrace[]>(() => {
    const titles = new Map(conversations.map((conversation) => [conversation.id, conversation.title]));
    const grouped = new Map<string, TraceSummary[]>();
    for (const trace of traces) grouped.set(trace.sessionId, [...(grouped.get(trace.sessionId) ?? []), trace]);
    return [...grouped.entries()].map(([id, items]) => ({
      id,
      title: titles.get(id) || '未命名对话',
      traces: [...items].sort((left, right) => left.createdAt - right.createdAt),
      latestAt: Math.max(...items.map((item) => item.createdAt)),
    })).filter((conversation) => !isCurrentConversationMode || conversation.id === focusConversationId).sort((left, right) => right.latestAt - left.latestAt);
  }, [conversations, focusConversationId, isCurrentConversationMode, traces]);

  const selectedConversation = conversationTraces.find((conversation) => conversation.id === selectedConversationId) ?? null;

  useEffect(() => {
    if (!conversationTraces.length) {
      setSelectedConversationId(null);
      setEventsByRequest({});
      return;
    }
    if (!selectedConversationId || !conversationTraces.some((conversation) => conversation.id === selectedConversationId)) setSelectedConversationId(conversationTraces[0].id);
  }, [conversationTraces, selectedConversationId]);

  async function LoadConversation(conversation: ConversationTrace) {
    const entries = await Promise.all(conversation.traces.map(async (trace) => [trace.requestId, await onSelectTrace(trace.requestId)] as const));
    setEventsByRequest(Object.fromEntries(entries));
  }

  useEffect(() => {
    if (selectedConversation) void LoadConversation(selectedConversation);
  }, [selectedConversation?.id]);

  const timeline = useMemo(() => selectedConversation?.traces.flatMap((trace, index) => BuildTimeline(trace.requestId, index + 1, eventsByRequest[trace.requestId] ?? [])) ?? [], [eventsByRequest, selectedConversation]);
  const apiRequests = useMemo(() => selectedConversation?.traces.flatMap((trace, index) => BuildApiRequests(trace.requestId, index + 1, eventsByRequest[trace.requestId] ?? [])) ?? [], [eventsByRequest, selectedConversation]);
  const visibleTimeline = useMemo(() => {
    const needle = query.toLowerCase();
    const MatchesFilter = (event: TimelineEvent) => eventFilter === 'all'
      || event.title === eventFilter
      || (eventFilter === 'Success' && event.tone === 'is-success')
      || (eventFilter === 'Failed' && event.tone === 'is-danger');
    return timeline.filter((event) => MatchesFilter(event) && (!needle || `${event.title} ${event.detail} ${PayloadText(event.payload)}`.toLowerCase().includes(needle)));
  }, [eventFilter, query, timeline]);
  const visibleTimelineTurns = useMemo(() => GroupByTurn(visibleTimeline), [visibleTimeline]);

  const selectedEvent = isCurrentConversationMode ? visibleTimeline.find((event) => event.id === selectedEventId) ?? null : null;
  const visibleApiRequests = useMemo(() => {
    const needle = query.toLowerCase();
    return apiRequests.filter((request) => !needle || `API REQUEST-${request.apiRequestIndex} ${request.model} ${PayloadText(request.payload)}`.toLowerCase().includes(needle));
  }, [apiRequests, query]);
  const visibleApiRequestTurns = useMemo(() => GroupByTurn(visibleApiRequests), [visibleApiRequests]);
  const selectedApiRequest = isCurrentConversationMode ? visibleApiRequests.find((request) => request.id === selectedApiRequestId) ?? null : null;

  useEffect(() => {
    if (!isCurrentConversationMode) return;
    setSelectedEventId((current) => visibleTimeline.some((event) => event.id === current) ? current : visibleTimeline[0]?.id ?? null);
  }, [isCurrentConversationMode, visibleTimeline]);

  useEffect(() => {
    if (!isCurrentConversationMode) return;
    setSelectedApiRequestId((current) => visibleApiRequests.some((request) => request.id === current) ? current : visibleApiRequests[0]?.id ?? null);
  }, [isCurrentConversationMode, visibleApiRequests]);

  useEffect(() => {
    // 切换会话后默认展开全部 Turn，避免把上一个会话的折叠状态带入当前会话。
    setCollapsedTurns(new Set());
  }, [selectedConversationId]);

  useEffect(() => {
    if (!showTraceFilter) return;
    function CloseTraceFilter(event: PointerEvent) {
      if (!traceFilterRef.current?.contains(event.target as Node)) setShowTraceFilter(false);
    }
    document.addEventListener('pointerdown', CloseTraceFilter);
    return () => document.removeEventListener('pointerdown', CloseTraceFilter);
  }, [showTraceFilter]);

  function ToggleEvent(id: string) {
    setExpanded((current) => { const next = new Set(current); next.has(id) ? next.delete(id) : next.add(id); return next; });
  }

  function ToggleTurn(view: TraceView, runIndex: number) {
    const key = `${view}-${runIndex}`;
    setCollapsedTurns((current) => { const next = new Set(current); next.has(key) ? next.delete(key) : next.add(key); return next; });
  }

  async function ConfirmDeleteTraces() {
    if (!deleteTarget || !onDeleteTraces) return;
    try {
      await onDeleteTraces([deleteTarget.id]);
      setDeleteTarget(null);
      setDeleteError(null);
    } catch (error) {
      setDeleteError(error instanceof Error ? error.message : '删除 Trace 失败，请稍后重试。');
    }
  }

  const selectedTrace = traceView === 'messages' && selectedEvent
    ? selectedConversation?.traces[selectedEvent.runIndex - 1]
    : traceView === 'requests' && selectedApiRequest
      ? selectedConversation?.traces[selectedApiRequest.runIndex - 1]
      : selectedConversation?.traces.at(-1);
  const traceUsage = CreateTraceTokenUsage(selectedConversation?.traces ?? []);

  return <div className={`trace-window ${isCurrentConversationMode ? 'trace-window-current-conversation' : ''}`}>
    <div className="trace-workbench">
      {!isCurrentConversationMode && <aside aria-label="对话记录">
        <div className="trace-list-heading"><b>对话记录</b><small>{conversationTraces.length} 条</small></div>
        <div className="trace-request-list">{conversationTraces.map((conversation) => {
          const latest = conversation.traces.at(-1)!;
          const isCurrent = selectedConversationId === conversation.id;
          return <div className={`trace-record ${isCurrent ? 'is-current' : ''}`} key={conversation.id}><button className={`trace-record-main ${isCurrent ? 'selected' : ''}`} type="button" onClick={() => { setSelectedConversationId(conversation.id); setExpanded(new Set()); }}>
            <span><b>{conversation.title}</b><small>{conversation.traces.length} requests · {latest.model}</small></span>
            <time>{FormatTime(conversation.latestAt)}</time>
          </button></div>;
        })}</div>
      </aside>}
      {isCurrentConversationMode && <aside className="trace-event-list-aside" aria-label="当前对话轨迹事件">
        <div className="trace-list-toolbar">
          <div className="trace-search"><Icon name="search" size={14} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={traceView === 'messages' ? '搜索消息内容' : '搜索请求内容'} aria-label={traceView === 'messages' ? '搜索消息内容' : '搜索请求内容'} /></div>
          <div className="trace-filter-wrap" ref={traceFilterRef}><button className="trace-filter-trigger" type="button" aria-label="筛选轨迹" title="筛选轨迹" aria-expanded={showTraceFilter} onClick={() => setShowTraceFilter((current) => !current)}><Icon name="more" size={16} /></button>{showTraceFilter && <div className="trace-filter-menu" role="menu" aria-label="轨迹筛选"><section><small>视图</small>{([{ value: 'messages', label: '消息轨迹' }, { value: 'requests', label: 'API 请求' }] as Array<{ value: TraceView; label: string }>).map((item) => <button key={item.value} type="button" role="menuitemradio" aria-checked={traceView === item.value} className={traceView === item.value ? 'selected' : ''} onClick={() => { setTraceView(item.value); setShowTraceFilter(false); }}>{item.label}</button>)}</section>{traceView === 'messages' && <section><small>事件</small>{(['all', 'System', 'User', 'Tool', 'Assistant', 'Success', 'Failed'] as EventFilter[]).map((item) => <button key={item} type="button" role="menuitemradio" aria-checked={eventFilter === item} className={eventFilter === item ? 'selected' : ''} onClick={() => { setEventFilter(item); setShowTraceFilter(false); }}>{item === 'all' ? '全部事件' : item}</button>)}</section>}</div>}</div>
        </div>
        <div className="trace-list-heading"><b>{traceView === 'messages' ? '消息轨迹' : 'API 请求'}</b><small>{traceView === 'messages' ? visibleTimeline.length : visibleApiRequests.length} 条</small></div>
        {traceView === 'messages'
          ? visibleTimelineTurns.length ? <div className="trace-turn-list">{visibleTimelineTurns.map((turn) => { const key = `messages-${turn.runIndex}`; const isExpanded = !collapsedTurns.has(key); return <section className="trace-turn" key={key}><TurnIndex runIndex={turn.runIndex} count={turn.items.length} createdAt={turn.createdAt} expanded={isExpanded} onToggle={() => ToggleTurn('messages', turn.runIndex)} />{isExpanded && <div className="trace-turn-events">{turn.items.map((event) => <EventThumbnail key={event.id} event={event} selected={selectedEvent?.id === event.id} onSelect={() => setSelectedEventId(event.id)} />)}</div>}</section>; })}</div> : <p className="empty-copy">没有符合筛选条件的消息事件。</p>
          : visibleApiRequestTurns.length ? <div className="trace-turn-list">{visibleApiRequestTurns.map((turn) => { const key = `requests-${turn.runIndex}`; const isExpanded = !collapsedTurns.has(key); return <section className="trace-turn" key={key}><TurnIndex runIndex={turn.runIndex} count={turn.items.length} createdAt={turn.createdAt} expanded={isExpanded} onToggle={() => ToggleTurn('requests', turn.runIndex)} />{isExpanded && <div className="trace-turn-events">{turn.items.map((request) => <ApiRequestThumbnail key={request.id} request={request} selected={selectedApiRequest?.id === request.id} onSelect={() => setSelectedApiRequestId(request.id)} />)}</div>}</section>; })}</div> : <p className="empty-copy">没有符合筛选条件的 API 请求。</p>}
      </aside>}
      <main>
        {selectedConversation ? <>
          <div className="trace-detail-header trace-dashboard">
            <div className="trace-dashboard-copy"><h2>{selectedConversation.title}</h2><div><span>{FormatDateTime(selectedTrace?.createdAt ?? selectedConversation.traces[0].createdAt)}</span><span>{selectedTrace?.model ?? selectedConversation.traces.at(-1)?.model ?? '未记录模型'}</span></div></div>
            <div className="trace-dashboard-actions">{onDeleteTraces && <button className="trace-detail-delete" type="button" aria-label={`删除${selectedConversation.title}的 Trace`} title="删除此对话的 Trace" onClick={() => { setDeleteError(null); setDeleteTarget(selectedConversation); }}><Icon name="delete" size={14} /></button>}<TokenUsageRing usage={traceUsage} /></div>
          </div>
          {traceView === 'messages'
            ? isCurrentConversationMode ? selectedEvent ? <EventDetail event={selectedEvent} /> : <p className="empty-copy">此对话暂时没有可显示的 System、User、Tool 或 Assistant 事件。</p> : visibleTimeline.length ? <div className="trace-event-list">{visibleTimeline.map((event, index) => { const previous = visibleTimeline[index - 1]; const startsRequest = index === 0 || previous.requestId !== event.requestId || previous.apiRequestIndex !== event.apiRequestIndex; return <div key={event.id} className="trace-request-group">{startsRequest && <div className="trace-request-divider"><span>API REQUEST-{event.apiRequestIndex}</span><code>{event.requestKind}</code><small>{FormatTime(event.createdAt)}</small></div>}<EventRow event={event} expanded={expanded.has(event.id)} onToggle={() => ToggleEvent(event.id)} /></div>; })}</div> : <p className="empty-copy">此对话暂时没有可显示的 System、User、Tool 或 Assistant 事件。</p>
            : isCurrentConversationMode ? selectedApiRequest ? <ApiRequestDetail request={selectedApiRequest} /> : <p className="empty-copy">此对话暂时没有 API 请求。</p> : visibleApiRequests.length ? <div className="trace-event-list">{visibleApiRequests.map((request) => <ApiRequestRow key={request.id} request={request} expanded={expanded.has(request.id)} onToggle={() => ToggleEvent(request.id)} />)}</div> : <p className="empty-copy">此对话暂时没有 API 请求。</p>}
        </> : <p className="empty-copy">发送一条消息后，这里会按对话归纳 Trace 记录。</p>}
      </main>
    </div>
    {onDeleteTraces && <Modal open={Boolean(deleteTarget)} title="删除当前对话 Trace？" onClose={() => { setDeleteTarget(null); setDeleteError(null); }}><p className="modal-copy">将删除此对话的 {deleteTarget?.traces.length ?? 0} 条请求 Trace 与事件；对话消息和运行日志会保留。</p>{deleteError && <p className="modal-copy trace-delete-error">{deleteError}</p>}<div className="modal-actions"><Button onClick={() => { setDeleteTarget(null); setDeleteError(null); }}>取消</Button><Button variant="danger" onClick={() => void ConfirmDeleteTraces()}>确认删除</Button></div></Modal>}
  </div>;
}

export { TraceViewer };
