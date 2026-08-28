import { useEffect, useMemo, useState } from 'react';
import type { AgentObservability, AgentTraceEvent } from '@offerget/contracts';
import { Icon } from '../../../shared/components/Icon';
import { Modal, Button, Select } from '../../../shared/components/UI';

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
  requestIndex: number;
  title: 'System' | 'User' | 'Tool' | 'Assistant';
  detail: string;
  tone: 'is-neutral' | 'is-accent' | 'is-success' | 'is-warning' | 'is-danger';
}

type EventFilter = 'all' | TimelineEvent['title'] | 'Success' | 'Failed';

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

function BuildTimeline(requestId: string, requestIndex: number, events: AgentTraceEvent[]) {
  const timeline: TimelineEvent[] = [];
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    const payload = EventPayload(event);
    const tokenCount = event.tokenCount || EstimateTokenCount(event.payload);
    if (event.eventType === 'system_prompt') {
      timeline.push({ ...event, id: `${requestId}-${event.ordinal}`, requestId, requestIndex, title: 'System', detail: 'System prompt', tone: 'is-neutral', tokenCount });
    } else if (event.eventType === 'user_message') {
      timeline.push({ ...event, id: `${requestId}-${event.ordinal}`, requestId, requestIndex, title: 'User', detail: 'User message', tone: 'is-neutral', tokenCount });
    } else if (event.eventType === 'tool_call') {
      const result = events[index + 1]?.eventType === 'tool_result' ? events[index + 1] : null;
      const resultPayload = result ? EventPayload(result) : null;
      const name = String(payload.name ?? resultPayload?.name ?? 'Tool');
      const succeeded = resultPayload?.ok === true;
      const detail = result ? `${name} · ${succeeded ? 'Success' : 'Failed'}` : `${name} · Running`;
      timeline.push({
        ordinal: event.ordinal,
        eventType: 'tool',
        payload: result ? { call: event.payload, result: result.payload } : { call: event.payload },
        tokenCount: tokenCount + (result?.tokenCount || (result ? EstimateTokenCount(result.payload) : 0)),
        createdAt: result?.createdAt ?? event.createdAt,
        id: `${requestId}-${event.ordinal}`,
        requestId,
        requestIndex,
        title: 'Tool',
        detail,
        tone: result ? (succeeded ? 'is-success' : 'is-danger') : 'is-warning',
      });
      if (result) index += 1;
    } else if (event.eventType === 'assistant_message') {
      timeline.push({ ...event, id: `${requestId}-${event.ordinal}`, requestId, requestIndex, title: 'Assistant', detail: 'Assistant message', tone: 'is-accent', tokenCount });
    } else if (event.eventType === 'error') {
      timeline.push({ ...event, id: `${requestId}-${event.ordinal}`, requestId, requestIndex, title: 'Assistant', detail: 'Request failed', tone: 'is-danger', tokenCount });
    }
  }
  return timeline;
}

function EventRow({ event, expanded, onToggle }: { event: TimelineEvent; expanded: boolean; onToggle: () => void }) {
  return <article className={`trace-event ${expanded ? 'open' : ''}`}>
    <button className="trace-event-summary" type="button" aria-expanded={expanded} onClick={onToggle}>
      <span className="trace-event-copy"><b className={`trace-event-role trace-event-role-${event.title.toLowerCase()}`}>{event.title}</b><small>{event.detail}</small></span>
      <span className="trace-event-tokens">{event.tokenCount.toLocaleString()} tokens</span>
      <time>{FormatTime(event.createdAt)}</time>
    </button>
    {expanded && <pre>{JSON.stringify(event.payload, null, 2)}</pre>}
  </article>;
}

/** 按会话聚合 Trace；每次模型请求在右侧时间线中以 Request-n 分隔。 */
function TraceViewer({ traces, conversations, onSelectTrace, onDeleteTraces, focusConversationId }: { traces: TraceSummary[]; conversations: ConversationOption[]; onSelectTrace: (requestId: string) => Promise<AgentTraceEvent[]>; onDeleteTraces?: (sessionIds: string[]) => Promise<void>; focusConversationId?: string | null }) {
  const isCurrentConversationMode = focusConversationId !== undefined;
  const [selectedConversationId, setSelectedConversationId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ConversationTrace | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [eventsByRequest, setEventsByRequest] = useState<Record<string, AgentTraceEvent[]>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState('');
  const [eventFilter, setEventFilter] = useState<EventFilter>('all');

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
  const visibleTimeline = useMemo(() => {
    const needle = query.toLowerCase();
    const MatchesFilter = (event: TimelineEvent) => eventFilter === 'all'
      || event.title === eventFilter
      || (eventFilter === 'Success' && event.tone === 'is-success')
      || (eventFilter === 'Failed' && event.tone === 'is-danger');
    return timeline.filter((event) => MatchesFilter(event) && (!needle || `${event.title} ${event.detail} ${PayloadText(event.payload)}`.toLowerCase().includes(needle)));
  }, [eventFilter, query, timeline]);

  function ToggleEvent(id: string) {
    setExpanded((current) => { const next = new Set(current); next.has(id) ? next.delete(id) : next.add(id); return next; });
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
      <main>
        {selectedConversation ? <>
          <div className="trace-detail-header">
            <div className="trace-detail-metadata">
              <span><b>{FormatDateTime(selectedConversation.traces[0].createdAt)}</b></span>
              <span><b>{selectedConversation.traces.at(-1)?.model}</b></span>
              <span><b>{selectedConversation.traces.length} requests</b></span>
              <span className="trace-scene"><b>求职助手</b></span>{onDeleteTraces && <button className="trace-detail-delete" type="button" aria-label={`删除${selectedConversation.title}的 Trace`} title="删除此对话的 Trace" onClick={() => { setDeleteError(null); setDeleteTarget(selectedConversation); }}><Icon name="delete" size={14} /></button>}
            </div>
            <div className="trace-detail-controls"><div className="trace-search"><Icon name="search" size={14} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索事件内容" aria-label="搜索事件内容" /></div><Select className="trace-event-filter" value={eventFilter} onChange={(value) => setEventFilter(value as EventFilter)} ariaLabel="筛选事件" options={[{ value: 'all', label: '全部事件' }, { value: 'System', label: 'System' }, { value: 'User', label: 'User' }, { value: 'Tool', label: 'Tool' }, { value: 'Assistant', label: 'Assistant' }, { value: 'Success', label: 'Success' }, { value: 'Failed', label: 'Failed' }]} /></div>
          </div>
          {visibleTimeline.length ? <div className="trace-event-list">{visibleTimeline.map((event, index) => <div key={event.id} className="trace-request-group">{(index === 0 || visibleTimeline[index - 1].requestId !== event.requestId) && <div className="trace-request-divider"><span>TURN-{event.requestIndex}</span><small>{FormatTime(selectedConversation.traces[event.requestIndex - 1].createdAt)}</small></div>}<EventRow event={event} expanded={expanded.has(event.id)} onToggle={() => ToggleEvent(event.id)} /></div>)}</div> : <p className="empty-copy">此对话暂时没有可显示的 System、User、Tool 或 Assistant 事件。</p>}
        </> : <p className="empty-copy">发送一条消息后，这里会按对话归纳 Trace 记录。</p>}
      </main>
    </div>
    {onDeleteTraces && <Modal open={Boolean(deleteTarget)} title="删除当前对话 Trace？" onClose={() => { setDeleteTarget(null); setDeleteError(null); }}><p className="modal-copy">将删除此对话的 {deleteTarget?.traces.length ?? 0} 条请求 Trace 与事件；对话消息和运行日志会保留。</p>{deleteError && <p className="modal-copy trace-delete-error">{deleteError}</p>}<div className="modal-actions"><Button onClick={() => { setDeleteTarget(null); setDeleteError(null); }}>取消</Button><Button variant="danger" onClick={() => void ConfirmDeleteTraces()}>确认删除</Button></div></Modal>}
  </div>;
}

export { TraceViewer };
