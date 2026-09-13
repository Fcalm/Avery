import { useEffect, useMemo, useRef, useState, type DragEvent as ReactDragEvent, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent } from 'react';
import { createPortal } from 'react-dom';
import { useUiStore } from '../../../app/UiStore';
import { useApplications, useDeleteApplication, useMoveApplicationStatus, useUpsertApplication } from '../../../features/application/api/applicationQueries';
import { AppendApplicationTimeline, GetApplicationTimeline, type ApplicationTimelineEntry } from '../applicationTimeline';
import { useJobs } from '../../../features/job/api/jobQueries';
import { useResumes } from '../../../features/resume/api/resumeQueries';
import { CreateEntityId } from '../../workspace/api/workspaceData';
import { Button, FormField, Modal, Select } from '../../../shared/components/UI';
import { Icon } from '../../../shared/components/Icon';
import { ApplicationStatusLabel, ChannelLabel } from '../../../shared/utils/format';
import type { Application, ApplicationStatus, Job } from '../../../types/domain';

/** 三阶段模型：只保留已投递/笔试/面试（不做旧版本兼容，已收藏/已结束记录不再展示）。 */
const Statuses: ApplicationStatus[] = ['applied', 'written_test', 'interviewing'];
const BoardColumns: Array<{ id: string; status: ApplicationStatus; label: string }> = [
  { id: 'applied', status: 'applied', label: '已投递' },
  { id: 'written_test', status: 'written_test', label: '笔试' },
  { id: 'interviewing', status: 'interviewing', label: '面试' },
];

/** 与阶段对应的默认跟进文案；卡片有下一步日期时改显“下一步 M/D”。 */
const NextByStatus: Record<ApplicationStatus, string> = {
  saved: '待投递',
  applied: '已投递，暂无回音',
  written_test: '等待笔试安排',
  interviewing: '等待安排面试',
  ended: '流程已结束',
};

function FormatDay(value?: string): string {
  if (!value) return '';
  const [, month, day] = value.split('-');
  return month && day ? `${Number(month)}/${Number(day)}` : value;
}

/** 状态 → 看板阶段文案；三阶段之外的状态按共享映射兜底显示。 */
function StageLabel(status: ApplicationStatus): string {
  return BoardColumns.find((column) => column.status === status)?.label ?? ApplicationStatusLabel[status];
}

/** 本地日历日期 YYYY-MM-DD；不用 toISOString，避免 UTC 偏移把当天算错。 */
function LocalDateKey(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

/** 最近七天的 M/D 标签，旧 → 新，与折线图 X 轴一致。 */
function WeekLabels(): string[] {
  const labels: string[] = [];
  for (let offset = 6; offset >= 0; offset--) {
    const date = new Date();
    date.setDate(date.getDate() - offset);
    labels.push(`${date.getMonth() + 1}/${date.getDate()}`);
  }
  return labels;
}

/** 最近七天的投递量（按 appliedAt 日历日统计），旧 → 新。 */
function WeekCounts(applications: Application[]): number[] {
  const keys: string[] = [];
  for (let offset = 6; offset >= 0; offset--) {
    const date = new Date();
    date.setDate(date.getDate() - offset);
    keys.push(LocalDateKey(date));
  }
  const buckets = new Map(keys.map((key) => [key, 0]));
  applications.forEach((application) => {
    if (application.appliedAt && buckets.has(application.appliedAt)) buckets.set(application.appliedAt, (buckets.get(application.appliedAt) ?? 0) + 1);
  });
  return keys.map((key) => buckets.get(key) ?? 0);
}

/** 原型用数据里的 urgent 标记临近节点；投递没有该字段，按“下一步日期距今 2 天内（含逾期）且流程未结束”推导。 */
function IsUrgent(application: Application): boolean {
  if (!application.nextStepAt || application.status === 'ended' || application.status === 'saved') return false;
  const target = new Date(`${application.nextStepAt}T00:00:00`);
  if (Number.isNaN(target.getTime())) return false;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return target.getTime() - today.getTime() <= 2 * 24 * 60 * 60 * 1000;
}

const CHART_WIDTH = 560;
const CHART_HEIGHT = 186;
const CHART_PAD = { left: 30, right: 14, top: 18, bottom: 30 };

/** 最近七日折线图：结构与动画一比一对齐原型 lineChart/wireChart/animateLine。 */
function WeekChart({ week, labels }: { week: number[]; labels: string[] }) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const lineRef = useRef<SVGPathElement | null>(null);
  const tipRef = useRef<HTMLDivElement | null>(null);
  const tipLineRef = useRef<SVGLineElement | null>(null);
  const tipDotRef = useRef<SVGCircleElement | null>(null);
  const max = Math.max(4, Math.max(...week) + 1);
  const innerWidth = CHART_WIDTH - CHART_PAD.left - CHART_PAD.right;
  const innerHeight = CHART_HEIGHT - CHART_PAD.top - CHART_PAD.bottom;
  const step = innerWidth / (week.length - 1);
  const X = (index: number) => CHART_PAD.left + step * index;
  const Y = (value: number) => CHART_PAD.top + innerHeight - (innerHeight * value) / max;
  const points = week.map((value, index) => [X(index), Y(value)] as const);
  const linePath = points.map(([x, y], index) => `${index ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`).join(' ');
  const areaPath = `${linePath} L ${points[points.length - 1][0].toFixed(1)} ${(CHART_PAD.top + innerHeight).toFixed(1)} L ${CHART_PAD.left} ${(CHART_PAD.top + innerHeight).toFixed(1)} Z`;

  useEffect(() => {
    // 折线生长动画按路径总长回拉 dashoffset；reduce-motion 用户直接呈现静态折线。
    const line = lineRef.current;
    if (!line || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const length = line.getTotalLength();
    line.style.strokeDasharray = String(length);
    line.style.strokeDashoffset = String(length);
    line.style.transition = 'stroke-dashoffset .95s cubic-bezier(.16,1,.3,1)';
    const frame = requestAnimationFrame(() => requestAnimationFrame(() => { line.style.strokeDashoffset = '0'; }));
    return () => cancelAnimationFrame(frame);
  }, []);

  function HandlePointEnter(event: ReactMouseEvent<SVGRectElement>) {
    // 悬停反馈只改类名与属性（原型 wireChart 的做法）：dragover/悬停是高频事件，走 React 状态会整板重渲染。
    const rect = event.currentTarget;
    const wrap = wrapRef.current;
    if (!wrap) return;
    const x = Number(rect.dataset.x);
    const y = Number(rect.dataset.y);
    wrap.classList.add('hot');
    if (tipRef.current) {
      tipRef.current.textContent = `${rect.dataset.label} 投出 ${rect.dataset.v} 份`;
      tipRef.current.style.left = `${Math.min(Math.max((x / CHART_WIDTH) * 100, 9), 91)}%`;
      tipRef.current.style.top = `${(y / CHART_HEIGHT) * 100}%`;
    }
    tipLineRef.current?.setAttribute('x1', String(x));
    tipLineRef.current?.setAttribute('x2', String(x));
    tipDotRef.current?.setAttribute('cx', String(x));
    tipDotRef.current?.setAttribute('cy', String(y));
  }

  function HandleChartLeave() { wrapRef.current?.classList.remove('hot'); }

  return <div className="chart-wrap" ref={wrapRef} onMouseLeave={HandleChartLeave}>
    <svg className="chart" viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`} role="img" aria-label="最近七日投递数量折线图">
      <defs>
        <linearGradient id="appAreaFill" x1="0" y1="0" x2="0" y2="1">
          <stop className="g-stop-0" offset="0%"></stop>
          <stop className="g-stop-1" offset="100%"></stop>
        </linearGradient>
      </defs>
      {[0, Math.round(max / 2), max].map((tick) => <g key={tick}>
        <line className="grid" x1={CHART_PAD.left} y1={Y(tick).toFixed(1)} x2={CHART_WIDTH - CHART_PAD.right} y2={Y(tick).toFixed(1)}></line>
        <text className="axis" x={CHART_PAD.left - 8} y={(Y(tick) + 3.5).toFixed(1)} textAnchor="end">{tick}</text>
      </g>)}
      {labels.map((label, index) => <text className="axis" key={`${label}-${index}`} x={X(index).toFixed(1)} y={CHART_HEIGHT - 10} textAnchor="middle">{label}</text>)}
      <path className="area" d={areaPath}></path>
      <path className="line" ref={lineRef} d={linePath}></path>
      {points.map(([x, y], index) => <circle className="dot" key={index} cx={x.toFixed(1)} cy={y.toFixed(1)} r="3.4" style={{ animationDelay: `${360 + index * 70}ms` }}></circle>)}
      <line className="tip-line" ref={tipLineRef} y1={CHART_PAD.top} y2={CHART_PAD.top + innerHeight}></line>
      <circle className="tip-dot" ref={tipDotRef} r="4.6"></circle>
      {points.map(([x, y], index) => <rect className="hit" key={index} x={(x - step / 2).toFixed(1)} y={CHART_PAD.top} width={step.toFixed(1)} height={innerHeight} data-x={x.toFixed(1)} data-y={y.toFixed(1)} data-v={week[index]} data-label={labels[index]} onMouseEnter={HandlePointEnter}></rect>)}
    </svg>
    <div className="chart-tip" ref={tipRef}></div>
  </div>;
}

/** 进展圆环：分段颜色与分段间隙一比一对齐原型 donut/animateDonut。 */
function ProgressDonut({ segments, total }: { segments: Array<{ cls: string; count: number }>; total: number }) {
  const radius = 54;
  const circumference = 2 * Math.PI * radius;
  const gap = 3;
  const arcRefs = useRef<Array<SVGCircleElement | null>>([]);
  const signature = segments.map((segment) => segment.count).join(',');
  const safeTotal = total || 1;
  let accumulated = 0;
  let arcIndex = 0;
  const arcs = segments.flatMap((segment) => {
    if (!segment.count) return [];
    const fraction = segment.count / safeTotal;
    const length = Math.max(circumference * fraction - gap, 2);
    const staggerIndex = arcIndex++;
    const arc = <circle key={segment.cls} ref={(element) => { arcRefs.current[staggerIndex] = element; }} className={`seg-arc ${segment.cls}`} cx="70" cy="70" r={radius} strokeDasharray={`${length.toFixed(1)} ${(circumference - length).toFixed(1)}`} strokeDashoffset={(-circumference * accumulated).toFixed(1)}></circle>;
    accumulated += fraction;
    return [arc];
  });

  useEffect(() => {
    // 数据变化时组件以新 signature 重挂载，分段从 0 生长到目标弧长，相邻段错峰 90ms。
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    arcRefs.current.forEach((arc, index) => {
      if (!arc) return;
      const target = arc.getAttribute('stroke-dasharray');
      if (!target) return;
      arc.style.transition = '';
      arc.style.strokeDasharray = `0 ${circumference.toFixed(1)}`;
      requestAnimationFrame(() => requestAnimationFrame(() => {
        arc.style.transition = `stroke-dasharray .8s cubic-bezier(.16,1,.3,1) ${index * 90}ms`;
        arc.style.strokeDasharray = target;
      }));
    });
  }, [signature]);

  return <div className="donut-wrap">
    <svg className="donut" viewBox="0 0 140 140" role="img" aria-label="投递进展占比">
      <g transform="rotate(-90 70 70)">{arcs}</g>
    </svg>
    <div className="donut-c"><b>{total}</b><span>个投递</span></div>
  </div>;
}

/** 抽屉两形态：阅读态只渲染内容与阶段滑块；编辑态才出现输入框与选择菜单（对应原型 dw-foot 的按钮切换）。 */
type ApplicationDrawer = { mode: 'view'; application: Application } | { mode: 'edit'; application: Application | null };

/** 时间线首条记录由投递数据推导：通过某渠道提交申请。 */
function TimelineSeed(application: Application, job?: Job): ApplicationTimelineEntry[] {
  if (!application.appliedAt) return [];
  return [{ d: FormatDay(application.appliedAt), t: `通过 ${job ? ChannelLabel[job.channel] : '未知渠道'} 提交申请` }];
}

/** 阅读态正文：下一步提示条 + 投递信息键值对 + 流程记录时间线（结构一比一对齐原型 openApp）。 */
function ApplicationDetailView({ application, job }: { application: Application; job?: Job }) {
  const urgent = IsUrgent(application);
  const stageLabel = StageLabel(application.status);
  const timeline = GetApplicationTimeline(application.id, TimelineSeed(application, job));
  const fields: Array<[string, string]> = [
    ['投递时间', FormatDay(application.appliedAt) || '未投递'],
    ['投递渠道', job ? ChannelLabel[job.channel] : '未知'],
    ['工作地点', job?.city || '未设置'],
    ['薪资区间', job?.salary || '面议'],
    ['当前阶段', stageLabel],
  ];
  return <>
    <div className={`note${urgent ? '' : ' plain'}`}>
      <Icon name={urgent ? 'clock' : 'info'} size={15} />
      <span>{application.nextStepAt ? `下一步 ${FormatDay(application.nextStepAt)}` : NextByStatus[application.status]}</span>
    </div>
    <div className="sec">
      <div className="sec-h">投递信息</div>
      <div className="kv">{fields.map(([label, value]) => <div className="kv-r" key={label}><span>{label}</span><b>{value}</b></div>)}</div>
    </div>
    <div className="sec">
      <div className="sec-h">流程记录</div>
      <div className="tl">
        {timeline.length
          ? timeline.map((entry, index) => <div className="tl-r" key={`${entry.d}-${index}`}><span className="tl-d">{entry.d}</span><span className="tl-t">{entry.t}</span></div>)
          : <p className="tl-none">暂无流程记录，拖动卡片换阶段后会出现在这里。</p>}
      </div>
    </div>
  </>;
}

function ApplicationsPage() {
  const { ShowNotice } = useUiStore();
  const applications = useApplications();
  const jobs = useJobs();
  const resumes = useResumes();
  const upsertApplication = useUpsertApplication({ onConflict: () => ShowNotice('投递已在其他窗口被修改，已刷新为最新版本'), onFailure: () => ShowNotice('投递保存失败，请稍后重试。') });
  const moveApplicationStatus = useMoveApplicationStatus({ onConflict: () => ShowNotice('投递已在其他窗口被修改，已刷新为最新版本'), onFailure: () => ShowNotice('投递状态更新失败，请稍后重试。') });
  const deleteApplication = useDeleteApplication({ onFailure: () => ShowNotice('投递删除失败，请稍后重试。') });
  const [drawer, SetDrawer] = useState<ApplicationDrawer | null>(null);
  const [form, setForm] = useState<Partial<Application>>({ status: 'applied', note: '' });
  const [deleteTarget, setDeleteTarget] = useState<Application | null>(null);
  const drawerRef = useRef<HTMLElement>(null);
  const editingApplication = drawer?.mode === 'edit' ? drawer.application : null;

  // 抽屉打开期间 Escape 关闭、初始焦点落在关闭按钮（原型 showDrawer 聚焦 dwClose）。
  useEffect(() => {
    if (!drawer) return undefined;
    const CloseOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); SetDrawer(null); }
    };
    document.addEventListener('keydown', CloseOnEscape);
    drawerRef.current?.focus();
    return () => document.removeEventListener('keydown', CloseOnEscape);
  }, [drawer]);
  const jobsById = useMemo(() => Object.fromEntries(jobs.map((job) => [job.id, job])), [jobs]);
  const weekLabels = useMemo(WeekLabels, []);
  const week = useMemo(() => WeekCounts(applications), [applications]);
  const weekTotal = week.reduce((sum, value) => sum + value, 0);
  // 看板与圆环同源：只呈现三个投递阶段的记录，其余状态（已收藏/已结束）不做兼容展示。
  const boardApplications = useMemo(() => applications.filter((application) => Statuses.includes(application.status)), [applications]);
  const donutSegments = [
    { cls: 'seg-a', t: '面试', count: boardApplications.filter((application) => application.status === 'interviewing').length },
    { cls: 'seg-b', t: '笔试', count: boardApplications.filter((application) => application.status === 'written_test').length },
    { cls: 'seg-c', t: '已投递', count: boardApplications.filter((application) => application.status === 'applied').length },
  ];

  function OpenNew() { setForm({ jobId: jobs[0]?.id, resumeId: resumes[0]?.id, status: 'applied', note: '' }); SetDrawer({ mode: 'edit', application: null }); }
  function OpenDetail(application: Application) { SetDrawer({ mode: 'view', application }); }
  function StartEditing() {
    if (drawer?.mode !== 'view') return;
    setForm(drawer.application);
    SetDrawer({ mode: 'edit', application: drawer.application });
  }
  /** 取消编辑：从详情进入的回到阅读态（丢弃草稿），新建的直接关闭抽屉。 */
  function CancelEditing() {
    if (drawer?.mode !== 'edit') return;
    if (drawer.application) SetDrawer({ mode: 'view', application: drawer.application });
    else SetDrawer(null);
  }
  function SaveApplication() {
    if (!form.jobId || !form.resumeId || !form.status) return;
    const jobId = form.jobId; const resumeId = form.resumeId; const status = form.status;
    if (editingApplication) {
      upsertApplication.mutate({ application: { ...editingApplication, ...form } as Application, expectedRevision: editingApplication.revision });
      if (status !== editingApplication.status) {
        AppendApplicationTimeline(editingApplication.id, TimelineSeed(editingApplication, jobsById[editingApplication.jobId]), `移到「${StageLabel(status)}」`);
      }
    } else {
      upsertApplication.mutate({ application: { id: CreateEntityId('application'), jobId, resumeId, status, note: form.note ?? '', appliedAt: form.appliedAt, nextStepAt: form.nextStepAt } as Application });
    }
    SetDrawer(null); ShowNotice(editingApplication ? '投递记录已更新' : '已新增投递记录');
  }
  function ConfirmDeleteApplication() { if (!deleteTarget) return; deleteApplication.mutate({ id: deleteTarget.id }); setDeleteTarget(null); SetDrawer(null); ShowNotice('投递记录已删除'); }

  function HandleCardDragStart(event: ReactDragEvent<HTMLElement>, application: Application) {
    event.dataTransfer.setData('text/plain', application.id);
    event.dataTransfer.effectAllowed = 'move';
    event.currentTarget.classList.add('dragging');
  }
  function HandleCardDragEnd(event: ReactDragEvent<HTMLElement>) {
    event.currentTarget.classList.remove('dragging');
    document.querySelectorAll('.col-body.over').forEach((zone) => zone.classList.remove('over'));
  }
  function HandleZoneDragOver(event: ReactDragEvent<HTMLDivElement>) {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    event.currentTarget.classList.add('over');
  }
  function HandleZoneDragLeave(event: ReactDragEvent<HTMLDivElement>) {
    const related = event.relatedTarget as Node | null;
    if (related && event.currentTarget.contains(related)) return;
    event.currentTarget.classList.remove('over');
  }
  function HandleZoneDrop(event: ReactDragEvent<HTMLDivElement>, column: (typeof BoardColumns)[number]) {
    event.preventDefault();
    event.currentTarget.classList.remove('over');
    MoveApplication(event.dataTransfer.getData('text/plain'), column);
  }
  /** 拖拽/滑块换阶段：拖回原列忽略；时间线只记在前端会话内。 */
  function MoveApplication(id: string, column: (typeof BoardColumns)[number]) {
    const application = applications.find((item) => item.id === id);
    if (!application || application.status === column.status) return;
    moveApplicationStatus.mutate({ id: application.id, status: column.status, expectedRevision: application.revision });
    AppendApplicationTimeline(application.id, TimelineSeed(application, jobsById[application.jobId]), `移到「${column.label}」`);
    ShowNotice(`${jobsById[application.jobId]?.company ?? '投递'} 已移到「${column.label}」`);
  }
  function HandleCardKeyDown(event: ReactKeyboardEvent<HTMLElement>, application: Application) {
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); OpenDetail(application); }
  }

  const drawerApplication = drawer?.application ?? null;
  const drawerJob = drawerApplication ? jobsById[drawerApplication.jobId] : drawer?.mode === 'edit' && form.jobId ? jobsById[form.jobId] : undefined;
  const drawerStageLabel = drawerApplication ? StageLabel(drawerApplication.status) : '';
  const drawerTitle = drawer ? drawerJob?.company ?? (drawer.mode === 'edit' && !drawer.application ? '新建投递' : '投递详情') : '';

  return <div className="standard-page applications-page">
    <div className="app-view">
      <div className="view-h">
        <div><h1>投递记录</h1><p>上半部分是最近七天的投递节奏，下半部分是按阶段排列的投递卡片。卡片可以直接拖动换阶段，点开可以看详情。</p></div>
        <div className="vh-act"><button className="ghost-btn" type="button" onClick={OpenNew}><Icon name="plus" size={14} />添加投递</button></div>
      </div>
      <div className="dash">
        <section className="panel">
          <div className="panel-h">
            <div><div className="panel-t">最近七日投递</div><div className="panel-s">按提交日期统计</div></div>
            <div className="panel-num"><b>{weekTotal}</b><span>份</span></div>
          </div>
          <WeekChart key={week.join(',')} week={week} labels={weekLabels} />
        </section>
        <section className="panel">
          <div className="panel-h">
            <div><div className="panel-t">当前进展</div><div className="panel-s">共 {boardApplications.length} 个在流程中</div></div>
          </div>
          <ProgressDonut key={donutSegments.map((segment) => segment.count).join(',')} segments={donutSegments} total={boardApplications.length} />
          <div className="legend">
            {donutSegments.map((segment) => <div className="lg-r" key={segment.cls}>
              <span className={`lg-swatch ${segment.cls.replace('seg-', 'sw-')}`}></span>
              <span className="lg-t">{segment.t}</span>
              <span className="lg-n"><b>{segment.count}</b> 个 · {Math.round((segment.count / (boardApplications.length || 1)) * 100)}%</span>
            </div>)}
          </div>
        </section>
      </div>
      <div className="pipe">
        {BoardColumns.map((column) => {
          const items = boardApplications.filter((application) => application.status === column.status)
            .sort((left, right) => (right.nextStepAt ?? right.appliedAt ?? '').localeCompare(left.nextStepAt ?? left.appliedAt ?? ''));
          return <section className="col" key={column.id} aria-label={column.label}>
            <div className="col-h"><span className="col-t">{column.label}</span><span className="col-n">{items.length}</span></div>
            <div className="col-body" data-drop={column.id} onDragOver={HandleZoneDragOver} onDragLeave={HandleZoneDragLeave} onDrop={(event) => HandleZoneDrop(event, column)}>
              {items.length ? items.map((application) => {
                const job = jobsById[application.jobId];
                const urgent = IsUrgent(application);
                return <article className="acard" key={application.id} draggable data-application={application.id} tabIndex={0} role="button"
                  aria-label={`${job?.company ?? '未知企业'}，${job?.title ?? '已删除岗位'}，点击查看详情`}
                  onDragStart={(event) => HandleCardDragStart(event, application)} onDragEnd={HandleCardDragEnd}
                  onClick={() => OpenDetail(application)} onKeyDown={(event) => HandleCardKeyDown(event, application)}>
                  <div className="ac-top">
                    <span className="ac-co">{job?.company ?? '未知企业'}</span>
                    {urgent && <span className="ac-flag" role="img" aria-label="有临近的时间节点"><Icon name="clock" size={13} /></span>}
                  </div>
                  <div className="ac-role">{job?.title ?? '已删除岗位'}</div>
                  <div className="ac-meta">{application.appliedAt ? `${FormatDay(application.appliedAt)} 投递` : '未投递'} · {job ? ChannelLabel[job.channel] : '渠道未知'}</div>
                  <div className={`ac-next${urgent ? ' urgent' : ''}`}>{application.nextStepAt ? `下一步 ${FormatDay(application.nextStepAt)}` : NextByStatus[application.status]}</div>
                </article>;
              }) : <div className="col-empty">把卡片拖到这里</div>}
            </div>
          </section>;
        })}
      </div>
    </div>
    {/* 抽屉经 portal 挂到 body：玻璃背景等祖先带动画/滤镜时 fixed 会退化为相对祖先定位，
        只有脱离该子树才能像原型一样让遮罩与虚化盖住整个应用窗口。 */}
    {drawer && createPortal(<div className="dw-layer" role="presentation">
      <div className="dw-scrim" onClick={() => SetDrawer(null)} />
      <aside className="dw-drawer" role="dialog" aria-modal="true" aria-labelledby="application-drawer-title" tabIndex={-1} ref={drawerRef}>
        <div className="dw-head">
          <div className="dw-head-main">
            <div className="dw-title" id="application-drawer-title">{drawerTitle}</div>
            <div className="dw-meta">
              {drawer.mode === 'view'
                ? <><span>{drawerJob?.title ?? '已删除岗位'}</span><span>当前在「{drawerStageLabel}」</span></>
                : <span>{drawer.application ? '修改后尚未保存' : '尚未保存'}</span>}
            </div>
          </div>
          <button className="icon-btn" type="button" aria-label="关闭详情" title="关闭详情" autoFocus onClick={() => SetDrawer(null)}><Icon name="close" size={16} /></button>
        </div>
        <div className="dw-body">
          {drawer.mode === 'view'
            ? <ApplicationDetailView application={drawer.application} job={drawerJob ?? undefined} />
            : <div className="drawer-form">
              <FormField label="岗位"><Select value={form.jobId ?? ''} ariaLabel="选择岗位" onChange={(jobId) => setForm({ ...form, jobId })} options={jobs.map((job) => ({ value: job.id, label: `${job.company} · ${job.title}` }))} /></FormField>
              <FormField label="使用简历"><Select value={form.resumeId ?? ''} ariaLabel="使用简历" onChange={(resumeId) => setForm({ ...form, resumeId })} options={resumes.map((resume) => ({ value: resume.id, label: resume.name }))} /></FormField>
              <FormField label="当前阶段"><Select value={form.status ?? 'applied'} ariaLabel="当前阶段" onChange={(status) => setForm({ ...form, status: status as ApplicationStatus })} options={Statuses.map((status) => ({ value: status, label: ApplicationStatusLabel[status] }))} /></FormField>
              <FormField label="投递日期"><input type="date" value={form.appliedAt ?? ''} onChange={(event) => setForm({ ...form, appliedAt: event.target.value })} /></FormField>
              <FormField label="下一步日期"><input type="date" value={form.nextStepAt ?? ''} onChange={(event) => setForm({ ...form, nextStepAt: event.target.value })} /></FormField>
              <FormField label="备注"><textarea rows={4} value={form.note ?? ''} onChange={(event) => setForm({ ...form, note: event.target.value })} /></FormField>
            </div>}
        </div>
        <div className="dw-foot">
          {drawer.mode === 'view' ? <>
            <button className="ghost-btn is-danger" type="button" onClick={() => setDeleteTarget(drawer.application)}><Icon name="delete" size={14} />删除</button>
            <button className="ghost-btn" type="button" onClick={StartEditing}><Icon name="pencil-simple" size={14} />编辑</button>
            <span className="foot-label">移动到</span>
            <div className="stage-seg" role="group" aria-label="移动到其他阶段">
              {BoardColumns.map((column) => <button key={column.id} type="button" className={`seg-i${drawer.application.status === column.status ? ' sel' : ''}`} onClick={() => { const application = drawer.application; SetDrawer(null); MoveApplication(application.id, column); }}>{column.label}</button>)}
            </div>
          </> : <>
            {drawer.application && <button className="ghost-btn is-danger" type="button" onClick={() => setDeleteTarget(drawer.application)}><Icon name="delete" size={14} />删除</button>}
            <button className="ghost-btn" type="button" onClick={CancelEditing}>取消</button>
            <button className="btn-accent" type="button" onClick={SaveApplication}><Icon name="check-circle" size={14} />保存记录</button>
          </>}
        </div>
      </aside>
    </div>, document.body)}
    <Modal open={Boolean(deleteTarget)} title="删除这条投递记录？" onClose={() => setDeleteTarget(null)}><p className="modal-copy">删除后投递记录及其进度事件将被移除，此操作不可撤销。</p><div className="modal-actions"><Button onClick={() => setDeleteTarget(null)}>取消</Button><Button variant="danger" onClick={ConfirmDeleteApplication}>确认删除</Button></div></Modal>
  </div>;
}

export { ApplicationsPage };
