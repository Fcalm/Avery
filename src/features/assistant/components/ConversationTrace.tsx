import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { AgentTraceEvent } from '@avery/contracts';
import { Icon, type IconName } from '../../../shared/components/Icon';
import { BuildTimeline, CreateTraceTokenUsage, FormatPayload, PayloadSections, type TimelineEvent, type TraceSummary, type TraceTokenUsage } from './traceModel';
import { CalculateTokenSharePercent } from '../usagePresentation';

type TraceRole = 'system' | 'user' | 'assistant' | 'tool';
type RoleFilter = 'all' | TraceRole;

/** 角色筛选清单一比一取自原型；图标即事件行角色徽标使用的同一组字形。 */
const RoleFilters: Array<{ key: RoleFilter; label: string; icon: IconName }> = [
  { key: 'all', label: '全部角色', icon: 'list-bullets' },
  { key: 'system', label: 'system', icon: 'settings' },
  { key: 'user', label: 'user', icon: 'user' },
  { key: 'assistant', label: 'assistant', icon: 'sparkle' },
  { key: 'tool', label: 'tool', icon: 'wrench' },
];

function FormatTime(value: number) {
  return new Date(value).toLocaleTimeString('zh-CN', { hour12: false });
}

function FormatDateTime(value: number) {
  return new Date(value).toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

/** 千位分隔的英文计数，与原型轨迹中的 token 数字格式一致。 */
function FormatCount(value: number) {
  return Number(value || 0).toLocaleString('en-US');
}

function FormatTokenAbbreviation(total: number) {
  if (!total) return '0';
  const k = total / 1000;
  return `${Number.isInteger(k) ? k.toFixed(0) : k.toFixed(1)}k`;
}

/** 行文本取消息正文；无正文（如带工具调用的中间步骤）时退回事件描述。 */
function EventText(event: TimelineEvent): string {
  const message = event.payload && typeof event.payload === 'object' ? event.payload as Record<string, unknown> : {};
  const content = message.content;
  if (typeof content === 'string' && content.trim()) return content;
  if (Array.isArray(content)) {
    const text = content.map((part) => part && typeof part === 'object' && typeof (part as Record<string, unknown>).text === 'string' ? (part as Record<string, unknown>).text as string : '').join('\n').trim();
    if (text) return text;
  }
  return event.detail;
}

/** 实心饼图：一块扇区代表一类 token；总量为零时画空心圆底。 */
function TokenPie({ usage }: { usage: TraceTokenUsage }) {
  const segments = [
    { cls: 'seg-a', value: usage.cachedInputTokens },
    { cls: 'seg-b', value: usage.uncachedInputTokens },
    { cls: 'seg-c', value: usage.outputTokens },
  ];
  const total = usage.totalTokens;
  const CX = 70, CY = 70, R = 62;
  let startAngle = -Math.PI / 2;
  let wedges: ReactNode;
  if (!total) {
    wedges = <circle className="pie-empty" cx={CX} cy={CY} r={R} />;
  } else {
    wedges = segments.map((segment) => {
      if (!segment.value) return null;
      const fraction = segment.value / total;
      // 单一扇区占满时没有弧线可画，直接画整圆。
      if (fraction > 0.999) return <circle key={segment.cls} className={`pie-seg ${segment.cls}`} cx={CX} cy={CY} r={R} />;
      const endAngle = startAngle + fraction * Math.PI * 2;
      const x0 = (CX + R * Math.cos(startAngle)).toFixed(2);
      const y0 = (CY + R * Math.sin(startAngle)).toFixed(2);
      const x1 = (CX + R * Math.cos(endAngle)).toFixed(2);
      const y1 = (CY + R * Math.sin(endAngle)).toFixed(2);
      const wedge = <path key={segment.cls} className={`pie-seg ${segment.cls}`} d={`M${CX} ${CY} L${x0} ${y0} A${R} ${R} 0 ${fraction > .5 ? 1 : 0} 1 ${x1} ${y1} Z`} />;
      startAngle = endAngle;
      return wedge;
    });
  }
  return <svg className="pie" viewBox="0 0 140 140" role="img" aria-label="token 占比">{wedges}</svg>;
}

interface ConversationTraceProps {
  /** 仅限当前对话的请求摘要；排序与时间线组装在组件内完成。 */
  traces: TraceSummary[];
  /** 完整会话累计值；最近的 Trace 列表不能代替完整账本。 */
  sessionTokenUsage: TraceTokenUsage | null;
  title: string;
  onSelectTrace: (requestId: string) => Promise<AgentTraceEvent[]>;
}

/** 对话轨迹：按原型还原为“事件列表 + 仪表盘/详情”两栏，读的是真实 Provider usage。 */
function ConversationTrace({ traces, sessionTokenUsage, title, onSelectTrace }: ConversationTraceProps) {
  const [query, setQuery] = useState('');
  const [role, setRole] = useState<RoleFilter>('all');
  const [filterOpen, setFilterOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [eventsByRequest, setEventsByRequest] = useState<Record<string, AgentTraceEvent[]>>({});
  const filterRef = useRef<HTMLDivElement>(null);

  const sortedTraces = useMemo(() => [...traces].sort((left, right) => left.createdAt - right.createdAt), [traces]);
  // 轨迹请求清单用内容键比较：父组件每次渲染都会新建 traces 数组，避免无谓的重新拉取。
  const tracesKey = sortedTraces.map((trace) => `${trace.requestId}:${trace.eventCount}`).join(',');

  useEffect(() => {
    let cancelled = false;
    const requests = sortedTraces.map((trace) => trace.requestId);
    Promise.all(requests.map(async (requestId) => [requestId, await onSelectTrace(requestId)] as const))
      .then((entries) => { if (!cancelled) setEventsByRequest(Object.fromEntries(entries)); })
      .catch(() => undefined);
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tracesKey]);

  const events = useMemo(() => sortedTraces.flatMap((trace, index) => BuildTimeline(trace.requestId, index + 1, eventsByRequest[trace.requestId] ?? [])), [eventsByRequest, sortedTraces]);

  useEffect(() => {
    // 选中事件默认落在最近一条模型输出上；原选择在数据刷新后仍存在时保持不变。
    setSelectedId((current) => {
      if (current && events.some((event) => event.id === current)) return current;
      let lastAssistant = '';
      for (const event of events) { if (event.title === 'Assistant') lastAssistant = event.id; }
      return lastAssistant || events.at(-1)?.id || null;
    });
  }, [events]);

  useEffect(() => {
    if (!filterOpen) return undefined;
    function CloseFilter(event: PointerEvent) {
      if (!filterRef.current?.contains(event.target as Node)) setFilterOpen(false);
    }
    document.addEventListener('pointerdown', CloseFilter);
    return () => document.removeEventListener('pointerdown', CloseFilter);
  }, [filterOpen]);

  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return events
      .map((event, index) => ({ event, index }))
      .filter(({ event }) => role === 'all' || event.title.toLowerCase() === role)
      .filter(({ event }) => !needle || `${EventText(event)} ${event.title.toLowerCase()}`.toLowerCase().includes(needle));
  }, [events, query, role]);

  const usage = useMemo(() => sessionTokenUsage ?? CreateTraceTokenUsage(sortedTraces), [sessionTokenUsage, sortedTraces]);
  const selected = events.find((event) => event.id === selectedId) ?? null;
  // 正文字段排首位并默认展开（对齐原型“Content 卡承载主要内容”的意图），其余字段随后折叠；
  // role 字段不重复成卡——详情信息栏已展示角色。
  const detailSections = selected
    ? PayloadSections(selected.payload)
        .filter((section) => section.key !== 'role')
        .sort((left, right) => (left.key === 'content' ? -1 : right.key === 'content' ? 1 : 0))
    : [];
  const activeRole = RoleFilters.find((item) => item.key === role) ?? RoleFilters[0];

  return <div className="trace">
    <div className="tr-left">
      <div className="tr-search">
        <Icon name="search" size={14} />
        <input value={query} onChange={(event) => setQuery(event.target.value)} type="search" placeholder="搜索轨迹内容或 role" aria-label="搜索轨迹" />
        <div className="menu-wrap" ref={filterRef}>
          <button className={`tr-filter${role !== 'all' ? ' on' : ''}`} type="button" aria-expanded={filterOpen} aria-haspopup="menu" onClick={() => setFilterOpen((current) => !current)}>
            <span>{activeRole.label}</span>
            <Icon name="chevron-down" size={9} className="chev" />
          </button>
          {filterOpen && <div className="menu drop sm" role="menu" aria-label="按角色筛选">
            {RoleFilters.map((item) => <button key={item.key} className={`menu-item${role === item.key ? ' sel' : ''}`} type="button" role="menuitemradio" aria-checked={role === item.key} onClick={() => { setRole(item.key); setFilterOpen(false); }}>
              <Icon name={item.icon} size={16} />
              <span className="mt">{item.label}</span>
              <Icon name="check" size={14} className="tick" />
            </button>)}
          </div>}
        </div>
      </div>
      <div className="tr-list">
        {rows.length ? rows.map(({ event, index }) => <button key={event.id} className={`trow role-${event.title.toLowerCase()}${event.id === selectedId ? ' sel' : ''}`} type="button" aria-pressed={event.id === selectedId} title={EventText(event)} onClick={() => setSelectedId(event.id)}>
          <span className="trow-role"><Icon name={(RoleFilters.find((item) => item.key === event.title.toLowerCase()) ?? RoleFilters[0]).icon} size={12} />{event.title.toLowerCase()}</span>
          <span className="trow-txt">{EventText(event)}</span>
          <span className="trow-time">{FormatTime(event.createdAt)}</span>
        </button>) : <div className="tr-none">没有匹配的轨迹事件。</div>}
      </div>
    </div>
    <div className="tr-right">
      <section className="tr-dash">
        <div className="tr-dash-t">{title}</div>
        <div className="tr-meta tr-meta-1"><Icon name="clock" size={13} />创建于 {sortedTraces.length ? FormatDateTime(sortedTraces[0].createdAt) : '—'}</div>
        <div className="tr-meta tr-meta-2"><Icon name="cpu" size={13} />{sortedTraces.at(-1)?.model ?? '未记录模型'}</div>
        <div className="tr-tok-head"><span>{sessionTokenUsage ? '会话累计总 token' : '可见轨迹总 token'}</span><b>{FormatTokenAbbreviation(usage.totalTokens)}</b></div>
        {([[usage.cachedInputTokens, '命中输入', 'sw-a'], [usage.uncachedInputTokens, '未命中输入', 'sw-b'], [usage.outputTokens, '输出', 'sw-c']] as Array<[number, string, string]>).map(([value, label, swatch], index) => <div className={`lg-r tr-tok-${index + 1}`} key={label}>
          <span className={`lg-swatch ${swatch}`}></span>
          <span className="lg-t">{label}</span>
          <span className="lg-n"><b>{FormatCount(value)}</b> · {CalculateTokenSharePercent(value, usage.totalTokens) ?? 0}%</span>
        </div>)}
        <TokenPie usage={usage} />
      </section>
      <section className="tr-detail">
        {selected ? <>
          <div className="tr-bar">
            <span className="r">{selected.title.toLowerCase()}</span>
            <span className="t">{FormatTime(selected.createdAt)}</span>
            {/* 原型的逐事件命中/未命中拆分来自其演示数据；真实拆分只在请求级 Provider usage 中存在，
                事件级只展示按载荷估算的 token 数，避免编造每个消息的缓存账目。 */}
            <span className="k">{FormatCount(selected.tokenCount)} tokens</span>
          </div>
          <div className="tr-parts">
            {detailSections.length ? detailSections.map((section, index) => <details className="pcard" key={`${selected.id}-${section.key}`} open={index === 0}>
              <summary className="pcard-h">
                <span className="h">{section.key}</span>
                <Icon name="chevron-down" size={10} className="chev" />
              </summary>
              <div className="pcard-b"><pre className="pcode">{FormatPayload(section.value)}</pre></div>
            </details>) : <div className="tr-detail-none">这条事件没有更多内容。</div>}
          </div>
        </> : <>
          <div className="tr-bar"></div>
          <div className="tr-parts"><div className="tr-detail-none">左边选一条轨迹事件，这里会展开它的完整内容。</div></div>
        </>}
      </section>
    </div>
  </div>;
}

export { ConversationTrace };
