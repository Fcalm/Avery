import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { useUiStore } from '../../../app/UiStore';
import { DialogButton, FormField, Modal, Select } from '../../../shared/components/UI';
import { Icon } from '../../../shared/components/Icon';
import { platformClient, Unwrap } from '../../../shared/platform/platformClient';
import { ChannelLabel, FormatDateTime, FormatRelativeTime, FromDateTimeLocalValue, JobSeekingTypeLabel, ToDateTimeLocalValue } from '../../../shared/utils/format';
import { CreateEntityId } from '../../workspace/api/workspaceData';
import { useDeleteJob, useDeleteJobs, useJobLibraryQuery, useSetJobFavorite, useUpsertJob } from '../api/jobQueries';
import { BuildJobLibraryQuery, DefaultJobConditions, GetJobConditionValues, JobConditionGroups, LoadJobConditions, SaveJobConditions, ToggleJobCondition, type JobConditions } from '../api/jobConditions';
import { ScoreRing } from '../components/ScoreRing';
import { JobCollectionPanel } from '../components/JobCollectionPanel';
import { useJobCollection } from '../api/jobCollection';
import { GetJobFormErrors } from '../jobForm';
import { useInvalidFormFeedback } from '../../../shared/forms/useInvalidFormFeedback';
import type { Channel, Job, JobSeekingType } from '../../../types/domain';
import type { JobLibraryView, JobQuery } from '@avery/contracts';

const ChannelOptions: Channel[] = ['boss_zhipin', 'company_website', 'other'];
const JobSeekingTypeOptions: JobSeekingType[] = ['intern', 'campus_recruitment', 'social_recruitment'];
type SortMode = JobQuery['sort'];

/** 表单只承载用户可编辑字段；createdAt 由后端 created_at 投影，不参与写回。 */
type JobForm = Pick<Job, 'company' | 'title' | 'city' | 'salary' | 'experience' | 'education' | 'companySize' | 'jobSeekingType' | 'channel' | 'url' | 'jd' | 'deadline'>;

const BlankJob: JobForm = {
  company: '', title: '', city: '', salary: '', experience: '',
  education: '', companySize: '',
  jobSeekingType: 'social_recruitment', channel: 'boss_zhipin', url: '', jd: '', deadline: undefined,
};

function ToForm(job: Job): JobForm {
  const { company, title, city, salary, experience, education, companySize, jobSeekingType, channel, url, jd, deadline } = job;
  return { company, title, city, salary, experience, education, companySize, jobSeekingType, channel, url, jd, deadline };
}

/** 排序只作用于已入库岗位；目前没有可靠的源站发布时间，明确显示入库时间。 */
const SortOptions: Array<{ value: SortMode; label: string }> = [
  { value: 'score', label: '分数' },
  { value: 'salary', label: '薪资' },
  { value: 'created', label: '入库时间' },
];
const JobViews: Array<{ value: JobLibraryView; label: string }> = [
  { value: 'all', label: '全部' }, { value: 'favorites', label: '收藏' },
  { value: 'pending', label: '未投递' }, { value: 'applied', label: '已投递' },
];
const EmptyJobs: Job[] = [];

/** 原生复选框保留键盘操作，视觉使用空心/实心圆；半选状态单独提示。 */
function JobSelection({ checked, mixed = false, disabled, label, showLabel = false, onChange }: {
  checked: boolean; mixed?: boolean; disabled?: boolean; label: string; showLabel?: boolean; onChange: () => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { if (ref.current) ref.current.indeterminate = mixed; }, [mixed]);
  return <label className="job-selection" title={label}>
    <input ref={ref} className="job-selection-circle" type="checkbox" checked={checked} disabled={disabled} aria-label={label} onChange={onChange} />
    {showLabel && <span>{label}</span>}
  </label>;
}

/** 应用不允许在窗口内跳转外部站点，因此岗位链接只提供只读文本与复制入口。 */
function JobUrlLink({ url, onCopy }: { url: string; onCopy: (url: string) => void }) {
  return <span className="kv-link">
    <span title={url}>{url}</span>
    <button type="button" aria-label="复制岗位链接" title="复制岗位链接" onClick={() => onCopy(url)}><Icon name="copy" size={13} /></button>
  </span>;
}

/** 岗位详情分为基础信息和 JD，分别约束尺寸，长正文不再撑高页面。 */
function JobReadView({ job, onCopyUrl }: { job: Job; onCopyUrl: (url: string) => void }) {
  const createdAt = FormatDateTime(job.createdAt);
  const deadline = FormatDateTime(job.deadline);
  const facts = [
    { label: '求职类型', value: job.jobSeekingType ? JobSeekingTypeLabel[job.jobSeekingType] : '类型未记录' },
    { label: '渠道', value: ChannelLabel[job.channel] },
    { label: '城市', value: job.city || '城市不限' },
    { label: '工作经验', value: job.experience || '经验不限' },
    { label: '学历要求', value: job.education || '学历未记录' },
    { label: '公司规模', value: job.companySize || '规模未记录' },
    { label: '入库时间', value: createdAt ? `${FormatRelativeTime(job.createdAt)}入库` : '入库时间未记录', detail: createdAt },
    { label: '截止时间', value: deadline ? `${deadline.slice(0, 10)}截止` : '长期有效', detail: deadline },
  ];
  return <>
    <section className="sec job-facts">
      <ul className="job-fact-tags" aria-label="岗位基本信息">{facts.map((fact) => <li className="job-fact-tag" key={fact.label} title={`${fact.label}：${fact.detail || fact.value}`}>#{fact.value}</li>)}</ul>
      <div className="job-fact-link"><span>岗位链接</span>{job.url ? <JobUrlLink url={job.url} onCopy={onCopyUrl} /> : <span>未填写</span>}</div>
    </section>
    <section className="sec job-description">
      <div className="sec-h">职位 JD</div>
      <div className="jd-body" role="region" aria-label="职位 JD 内容" tabIndex={0}>{job.jd ? <div className="jd-text">{job.jd}</div> : <div className="jd-none">暂未保存岗位描述。</div>}</div>
    </section>
  </>;
}

function JobsPage(_props: { onGoAssistant: () => void }) {
  const [collectionOpen, setCollectionOpen] = useState(false);
  const collection = useJobCollection(collectionOpen);
  const { ShowNotice } = useUiStore();
  const upsertJob = useUpsertJob({ onConflict: () => ShowNotice('岗位已在其他窗口被修改，已刷新为最新版本', "error"), onFailure: () => ShowNotice('岗位保存失败，请稍后重试。', "error") });
  const setJobFavorite = useSetJobFavorite({ onConflict: () => ShowNotice('岗位收藏更新失败，请稍后重试。', "error"), onFailure: () => ShowNotice('岗位收藏更新失败，请稍后重试。', "error") });
  const deleteJob = useDeleteJob({ onFailure: () => ShowNotice('岗位删除失败，请稍后重试。', "error") });
  const deleteJobs = useDeleteJobs({ onFailure: (message) => ShowNotice(`批量删除失败：${message}`, "error") });

  const [conditions, setConditions] = useState<JobConditions>(() => LoadJobConditions());
  const [sortMode, setSortMode] = useState<SortMode>('score');
  const [sortDirection, setSortDirection] = useState<JobQuery['sortDirection']>('desc');
  const [view, setView] = useState<JobLibraryView>('all');
  const [draftConditions, setDraftConditions] = useState<JobConditions>(conditions);
  const [draftView, setDraftView] = useState<JobLibraryView>('all');
  const [page, setPage] = useState(1);
  const [filterOpen, setFilterOpen] = useState(false);
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [editingJob, setEditingJob] = useState<Job | null>(null);
  const [form, setForm] = useState<JobForm>(BlankJob);
  const [deleteTarget, setDeleteTarget] = useState<Job | null>(null);
  const [selecting, setSelecting] = useState(false);
  const [checkedIds, setCheckedIds] = useState<Set<string>>(() => new Set());
  const [bulkDeleteTarget, setBulkDeleteTarget] = useState<string[] | null>(null);
  const filterButtonRef = useRef<HTMLButtonElement>(null);
  const filterPanelId = useId();
  const drawerRef = useRef<HTMLElement>(null);
  const [validationAttempt, setValidationAttempt] = useState(0);
  const formErrors = GetJobFormErrors(form, Boolean(editingJob));
  const visibleErrors = validationAttempt ? formErrors : {};
  useInvalidFormFeedback(validationAttempt, drawerRef);

  /** 筛选偏好只写入应用内缓存，不修改岗位事实。 */
  useEffect(() => { SaveJobConditions(conditions); }, [conditions]);

  // 抽屉打开期间 Escape 关闭；初始焦点落在关闭按钮，与简历/档案抽屉一致。
  useEffect(() => {
    if (!drawerOpen) return undefined;
    function OnKeyDown(event: KeyboardEvent) { if (event.key === 'Escape' && !upsertJob.isPending) setDrawerOpen(false); }
    document.addEventListener('keydown', OnKeyDown);
    return () => document.removeEventListener('keydown', OnKeyDown);
  }, [drawerOpen, upsertJob.isPending]);

  const input = useMemo(() => BuildJobLibraryQuery(conditions, view, sortMode, page, sortDirection), [conditions, view, sortMode, page, sortDirection]);
  const jobQuery = useJobLibraryQuery(input);
  const filtered = jobQuery.data?.items ?? EmptyJobs;
  const total = jobQuery.data?.total ?? 0;
  const pageCount = jobQuery.data?.pageCount ?? 0;
  const checkedOnPage = filtered.filter((job) => checkedIds.has(job.id)).length;
  const allPageChecked = filtered.length > 0 && checkedOnPage === filtered.length;
  // 删除末页最后一项后使用服务器实际页码，不让页面停留在失效页。
  useEffect(() => { if (jobQuery.data && jobQuery.data.page !== page) setPage(jobQuery.data.page); }, [jobQuery.data, page]);

  const selectedJob = filtered.find((job) => job.id === selectedJobId) ?? filtered[0] ?? null;

  useEffect(() => { if (!selectedJobId || !filtered.some((job) => job.id === selectedJobId)) setSelectedJobId(filtered[0]?.id ?? null); }, [filtered, selectedJobId]);

  // 翻页、排序保留选择；筛选范围变化后清空，避免误删隐藏在旧条件下的岗位。
  function UpdateConditions(next: JobConditions) { setConditions(next); setPage(1); setCheckedIds(new Set()); }
  const activeFilterCount = JobConditionGroups.filter((group) => GetJobConditionValues(conditions[group.key]).length > 0).length + (view === 'all' ? 0 : 1);
  const draftFilterCount = JobConditionGroups.filter((group) => GetJobConditionValues(draftConditions[group.key]).length > 0).length + (draftView === 'all' ? 0 : 1);
  function CloseFilters() { setFilterOpen(false); filterButtonRef.current?.focus({ preventScroll: true }); }
  function CloseFiltersOnEscape(event: ReactKeyboardEvent<HTMLElement>) {
    if (event.key !== 'Escape' || !filterOpen) return;
    event.preventDefault(); event.stopPropagation(); CloseFilters();
  }
  function ToggleFilters() {
    if (filterOpen) { CloseFilters(); return; }
    setDraftConditions({ ...conditions, companySize: [...conditions.companySize] });
    setDraftView(view); setFilterOpen(true);
  }
  function ClearFilters() { setDraftConditions({ ...DefaultJobConditions, keyword: conditions.keyword }); setDraftView('all'); }
  function ConfirmFilters() {
    // 标签选择与缓存、查询分离；确认时使用当前搜索词，避免面板打开期间的搜索被旧草稿覆盖。
    UpdateConditions({ ...draftConditions, keyword: conditions.keyword });
    setView(draftView); CloseFilters();
  }
  function UpdateSort(next: SortMode) {
    setSortDirection(next === sortMode && sortDirection === 'desc' ? 'asc' : 'desc');
    setSortMode(next); setPage(1);
  }
  function ToggleJob(id: string) {
    setCheckedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }
  function TogglePage() {
    setCheckedIds((current) => {
      const next = new Set(current);
      for (const job of filtered) { if (allPageChecked) next.delete(job.id); else next.add(job.id); }
      return next;
    });
  }

  function OpenNew() { setValidationAttempt(0); setEditingJob(null); setForm(BlankJob); setDrawerOpen(true); }
  function OpenEdit(job: Job) { setValidationAttempt(0); setEditingJob(job); setForm(ToForm(job)); setDrawerOpen(true); }
  async function SaveJob() {
    if (upsertJob.isPending) return;
    if (Object.keys(formErrors).length) {
      setValidationAttempt((current) => current + 1);
      ShowNotice(Object.values(formErrors)[0]!, 'error');
      return;
    }
    try {
      if (editingJob) await upsertJob.mutateAsync({ job: { ...editingJob, ...form }, expectedRevision: editingJob.revision });
      else await upsertJob.mutateAsync({ job: { ...form, id: CreateEntityId('job'), favorite: false } });
      setDrawerOpen(false); ShowNotice(editingJob ? '岗位信息已更新' : '已新增岗位', 'success');
    } catch { /* mutation 已提示失败或冲突，保留当前表单供修正、重试。 */ }
  }
  async function ConfirmRemoveJob() {
    if (!deleteTarget || deleteJob.isPending) return;
    const id = deleteTarget.id;
    try {
      await deleteJob.mutateAsync({ id });
      setCheckedIds((current) => new Set([...current].filter((item) => item !== id)));
      setDeleteTarget(null); setDrawerOpen(false); ShowNotice('岗位已删除', "success");
    } catch { /* 失败提示由 mutation 统一处理，保留确认窗口以便重试。 */ }
  }
  async function ConfirmRemoveJobs() {
    if (!bulkDeleteTarget || deleteJobs.isPending) return;
    const ids = bulkDeleteTarget;
    try {
      const result = await deleteJobs.mutateAsync({ ids });
      const removed = new Set(ids);
      setCheckedIds((current) => new Set([...current].filter((id) => !removed.has(id))));
      setBulkDeleteTarget(null);
      ShowNotice(result.ids.length ? `已删除 ${result.ids.length} 个岗位` : '所选岗位已不在岗位库中', result.ids.length ? 'success' : 'info');
    } catch { /* 删除失败不清除选择，也不显示成功提示。 */ }
  }
  function ToggleFavorite(job: Job) { setJobFavorite.mutate({ id: job.id, favorite: !job.favorite, expectedRevision: job.revision }); }
  function CopyJobUrl(url: string) {
    void Unwrap(platformClient.desktop.WriteClipboardText(url))
      .then(() => ShowNotice('岗位链接已复制', "success"))
      .catch((error: unknown) => ShowNotice(error instanceof Error ? `岗位链接复制失败：${error.message}` : '岗位链接复制失败，请重试', "error"));
  }

  return <div className="standard-page job-view">
    <div className="view-h">
      <h1>岗位库</h1>
      <div className="vh-act"><button className="btn-accent" type="button" onClick={() => setCollectionOpen(true)}><Icon name="plus" size={14} />{collection.task.data?.status === 'running' ? '查看采集进度' : '采集岗位'}</button><button className="ghost-btn" type="button" onClick={OpenNew}><Icon name="plus" size={14} />手动添加</button></div>
    </div>

    <section className="job-filters" aria-label="岗位筛选与排序" onKeyDown={CloseFiltersOnEscape}>
      <div className="job-filter-toolbar">
        <div className="job-toolbar-start">
          <label className="job-keyword">
            <Icon name="search" size={15} />
            <input type="search" value={conditions.keyword} maxLength={500} placeholder="搜索岗位、企业或 JD" aria-label="岗位关键词" onChange={(event) => UpdateConditions({ ...conditions, keyword: event.target.value })} />
          </label>
          <span className="job-result-count" aria-live="polite">{jobQuery.isPending ? '正在查询…' : <>共 <strong>{total}</strong> 个岗位</>}{jobQuery.isFetching && !jobQuery.isPending ? ' · 更新中' : ''}</span>
          <div className="job-bulk-actions">
            {selecting && <>
              <JobSelection checked={allPageChecked} mixed={checkedOnPage > 0 && !allPageChecked} disabled={!filtered.length || jobQuery.isFetching || deleteJobs.isPending} label={allPageChecked ? '取消全选' : '全选本页'} showLabel onChange={TogglePage} />
              <button className="filter-btn is-danger" type="button" aria-label={`删除已选的 ${checkedIds.size} 个岗位`} title={`删除已选的 ${checkedIds.size} 个岗位`} disabled={!checkedIds.size || deleteJobs.isPending} onClick={() => setBulkDeleteTarget([...checkedIds])}><Icon name="delete" size={14} /></button>
            </>}
            <button className={`filter-btn${selecting ? ' on' : ''}`} type="button" aria-pressed={selecting} disabled={deleteJobs.isPending} onClick={() => { setSelecting(!selecting); setCheckedIds(new Set()); }}>
              {!selecting && <Icon name="delete" size={14} />}{selecting ? '取消' : '批量删除'}
            </button>
          </div>
        </div>
        <div className="job-toolbar-end">
          <div className="job-sort-options" role="group" aria-label="岗位排序">
            {SortOptions.map((option) => {
              const active = sortMode === option.value;
              const descending = !active || sortDirection === 'desc';
              const direction = option.value === 'created' ? descending ? '新到旧' : '旧到新' : descending ? '高到低' : '低到高';
              const nextDirection = option.value === 'created' ? descending ? '旧到新' : '新到旧' : descending ? '低到高' : '高到低';
              const label = `${option.label}：${active ? `当前${direction}，点击切换为${nextDirection}` : `点击按${direction}排序`}${option.value === 'salary' ? '；按月薪下限比较，面议及非月薪置后' : ''}`;
              return <button key={option.value} className={`job-sort-btn${active ? ' is-active' : ''}`} type="button" aria-pressed={active} aria-label={label} title={label} onClick={() => UpdateSort(option.value)}>
                {option.label}<Icon name="arrow-up" size={13} className={descending ? 'is-descending' : ''} />
              </button>;
            })}
          </div>
          <button ref={filterButtonRef} className={`job-more-filter${filterOpen || activeFilterCount ? ' is-active' : ''}`} type="button" aria-expanded={filterOpen} aria-controls={filterPanelId} onClick={ToggleFilters}>
            <Icon name="sliders" size={15} />更多筛选{activeFilterCount > 0 && <span className="job-filter-count">{activeFilterCount}</span>}<Icon name="chevron-down" size={11} className="chev" />
          </button>
        </div>
      </div>
    </section>

    <div className="jlib">
      {filterOpen && <div className="job-filter-panel" id={filterPanelId} role="region" aria-label="更多岗位筛选" onKeyDown={CloseFiltersOnEscape}>
        <div className="job-filter-panel-head"><span>筛选条件</span><button type="button" className="job-filter-reset" disabled={!draftFilterCount} onClick={ClearFilters}>清空筛选</button></div>
        <div className="job-filter-groups">
          {JobConditionGroups.map((group) => {
            const selected = GetJobConditionValues(draftConditions[group.key]);
            return <div className="job-filter-row" key={group.key} role="group" aria-label={`${group.label}${group.multiple ? '（可多选）' : ''}`}>
              <span className="job-filter-label">{group.label}{group.multiple && <small>可多选</small>}</span>
              <div className="job-filter-tags">{group.options.map((option) => {
                const active = option.value === 'any' ? !selected.length : selected.includes(option.value);
                return <button key={option.value} type="button" className={`job-filter-tag${active ? ' is-active' : ''}`} aria-pressed={active} onClick={() => setDraftConditions((current) => ToggleJobCondition(current, group.key, option.value))}>{option.label}</button>;
              })}</div>
            </div>;
          })}
          <div className="job-filter-row" role="group" aria-label="岗位视图">
            <span className="job-filter-label">岗位视图</span>
            <div className="job-filter-tags">{JobViews.map((option) => <button key={option.value} type="button" className={`job-filter-tag${draftView === option.value ? ' is-active' : ''}`} aria-pressed={draftView === option.value} onClick={() => setDraftView((current) => current === option.value ? 'all' : option.value)}>{option.label}</button>)}</div>
          </div>
        </div>
        <div className="job-filter-panel-foot"><button className="ghost-btn" type="button" onClick={CloseFilters}>取消</button><button className="btn-accent" type="button" onClick={ConfirmFilters}>确认筛选</button></div>
      </div>}
      <section className="panel job-list" aria-label="岗位列表" inert={filterOpen}>
        <div className="jrows">
          {jobQuery.isError ? <div className="jrow-empty" role="alert">岗位查询失败：{jobQuery.error.message}<button className="ghost-btn" type="button" onClick={() => void jobQuery.refetch()}>重试</button></div> : filtered.length
            ? filtered.map((job) => <div key={job.id} className={`jrow${selectedJob?.id === job.id ? ' active' : ''}`}>
              {selecting && <JobSelection checked={checkedIds.has(job.id)} disabled={deleteJobs.isPending} label={`选择岗位：${job.company} · ${job.title}`} onChange={() => ToggleJob(job.id)} />}
              <button className="jrow-open" type="button" aria-pressed={selectedJob?.id === job.id} onClick={() => setSelectedJobId(job.id)}>
                <span className="jr-main">
                  <span className="jr-heading"><span className="jr-role" title={job.title}>{job.title}</span><span className="jr-salary" title={job.salary || '薪资面议'}>{job.salary || '薪资面议'}</span></span>
                  <span className="jr-co" title={job.company}>{job.company}</span>
                  <span className="jr-tags">
                    <span className="jtag">{job.city || '城市不限'}</span>
                    <span className="jtag">{ChannelLabel[job.channel]}</span>
                  </span>
                </span>
                <ScoreRing score={job.matchScore} />
              </button>
            </div>)
            : <div className="jrow-empty">{jobQuery.isPending ? '正在加载岗位…' : '没有匹配的岗位。可清空筛选，或手动添加、采集岗位。'}</div>}
        </div>
        <div className="job-pagination" aria-label="岗位分页">
          <button className="ghost-btn" type="button" disabled={page <= 1 || jobQuery.isFetching} onClick={() => setPage((current) => current - 1)}>上一页</button>
          <span>第 {jobQuery.data?.page ?? page} / {Math.max(1, pageCount)} 页 · 每页 20 条</span>
          <button className="ghost-btn" type="button" disabled={page >= pageCount || jobQuery.isFetching} onClick={() => setPage((current) => current + 1)}>下一页</button>
        </div>
      </section>

      <section className="panel job-detail" aria-label="岗位详情" inert={filterOpen}>
        {selectedJob ? <>
          <div className="jd-head">
            <div className="jd-title">
              <div className="jd-role">{selectedJob.title}</div>
              <div className="jd-salary">{selectedJob.salary || '薪资面议'}</div>
              <div className="jd-co">{selectedJob.company}</div>
            </div>
            <ScoreRing score={selectedJob.matchScore} size="detail" />
            <div className="jd-actions">
              <button className={`ghost-btn${selectedJob.favorite ? ' on' : ''}`} type="button" aria-pressed={selectedJob.favorite} onClick={() => ToggleFavorite(selectedJob)}>
                <Icon name="heart" size={14} />{selectedJob.favorite ? '已收藏' : '收藏'}
              </button>
              <button className="ghost-btn" type="button" onClick={() => OpenEdit(selectedJob)}><Icon name="pencil-simple" size={14} />编辑</button>
            </div>
          </div>
          <JobReadView key={selectedJob.id} job={selectedJob} onCopyUrl={CopyJobUrl} />
        </> : <div className="jd-empty">从左边选一个岗位，这里会显示它的完整信息。</div>}
      </section>
    </div>

    {/* 抽屉经 portal 挂到 body：玻璃背景等祖先带动画/滤镜时 fixed 会退化为相对祖先定位，
        脱离该子树后，由共用容器将抽屉及外部点击关闭区域限制在顶部栏下方。 */}
    {drawerOpen && createPortal(<div className="dw-layer" role="presentation">
      <div className="dw-scrim" onClick={() => { if (!upsertJob.isPending) setDrawerOpen(false); }} />
      <aside className="dw-drawer is-job" role="dialog" aria-modal="true" aria-labelledby="job-drawer-title" tabIndex={-1} ref={drawerRef}>
        <div className="dw-head">
          <div className="dw-head-main">
            <div className="dw-title" id="job-drawer-title">{editingJob ? '编辑岗位信息' : '手动添加岗位'}</div>
            <div className="dw-meta">
              {editingJob ? <><span>{editingJob.company}</span><span>{ChannelLabel[editingJob.channel]}</span><span>修改后尚未保存</span></> : <span>尚未保存</span>}
            </div>
          </div>
          <button className="icon-btn" type="button" disabled={upsertJob.isPending} aria-label="关闭编辑" title="关闭编辑" autoFocus onClick={() => setDrawerOpen(false)}><Icon name="close" size={16} /></button>
        </div>
        <div className="dw-body">
          <div className="drawer-form" inert={upsertJob.isPending}>
            <div className="form-two-col">
              <FormField label="公司" required error={visibleErrors.company}><input value={form.company} onChange={(event) => setForm({ ...form, company: event.target.value })} /></FormField>
              <FormField label="岗位名称" required error={visibleErrors.title}><input value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })} /></FormField>
              <FormField label="城市" required={!editingJob} error={visibleErrors.city}><input value={form.city} onChange={(event) => setForm({ ...form, city: event.target.value })} /></FormField>
              <FormField label="薪资"><input value={form.salary ?? ''} onChange={(event) => setForm({ ...form, salary: event.target.value })} /></FormField>
              <FormField label="经验要求" required={!editingJob} error={visibleErrors.experience}><input value={form.experience} onChange={(event) => setForm({ ...form, experience: event.target.value })} /></FormField>
              <FormField label="学历要求"><input value={form.education ?? ''} maxLength={100} placeholder="例如：本科及以上" onChange={(event) => setForm({ ...form, education: event.target.value })} /></FormField>
              <FormField label="公司规模"><input value={form.companySize ?? ''} maxLength={100} placeholder="例如：100-499人" onChange={(event) => setForm({ ...form, companySize: event.target.value })} /></FormField>
              <FormField label="渠道"><Select value={form.channel} ariaLabel="渠道" onChange={(channel) => setForm({ ...form, channel: channel as Channel })} options={ChannelOptions.map((item) => ({ value: item, label: ChannelLabel[item] }))} /></FormField>
            </div>
            <FormField label="求职类型">
              <div className="segmented">{JobSeekingTypeOptions.map((item) => <button key={item} type="button" className={form.jobSeekingType === item ? 'selected' : ''} onClick={() => setForm({ ...form, jobSeekingType: item })}>{JobSeekingTypeLabel[item]}</button>)}</div>
            </FormField>
            <FormField label="岗位链接"><input value={form.url ?? ''} onChange={(event) => setForm({ ...form, url: event.target.value })} placeholder="https://" /></FormField>
            <FormField label="截止时间" hint="到期后岗位会自动从岗位库删除；留空表示长期有效。">
              <input type="datetime-local" value={ToDateTimeLocalValue(form.deadline)} onChange={(event) => setForm({ ...form, deadline: FromDateTimeLocalValue(event.target.value) })} />
            </FormField>
            <FormField label="完整 JD" required={!editingJob} error={visibleErrors.jd}><textarea value={form.jd} onChange={(event) => setForm({ ...form, jd: event.target.value })} rows={8} /></FormField>
          </div>
        </div>
        <div className="dw-foot">
          {editingJob && <button className="ghost-btn is-danger" type="button" disabled={upsertJob.isPending} onClick={() => setDeleteTarget(editingJob)}><Icon name="delete" size={14} />删除</button>}
          <button className="ghost-btn" type="button" disabled={upsertJob.isPending} onClick={() => setDrawerOpen(false)}>取消</button>
          <button className="btn-accent" type="button" disabled={upsertJob.isPending} onClick={() => void SaveJob()}><Icon name="check-circle" size={14} />{upsertJob.isPending ? '保存中…' : '保存岗位'}</button>
        </div>
      </aside>
    </div>, document.body)}

    <JobCollectionPanel open={collectionOpen} onClose={() => setCollectionOpen(false)} conditions={conditions} collection={collection} />
    <Modal
      open={Boolean(deleteTarget)}
      title="删除这份岗位？"
      onClose={() => { if (!deleteJob.isPending) setDeleteTarget(null); }}
      footer={<>
        <DialogButton disabled={deleteJob.isPending} onClick={() => setDeleteTarget(null)}>取消</DialogButton>
        <DialogButton disabled={deleteJob.isPending} tone="danger" onClick={() => void ConfirmRemoveJob()}>{deleteJob.isPending ? '删除中…' : '确认删除'}</DialogButton>
      </>}
    >
      删除后岗位将从岗位库移除，此操作不可撤销。
    </Modal>
    <Modal
      open={bulkDeleteTarget !== null}
      title={`删除选中的 ${bulkDeleteTarget?.length ?? 0} 个岗位？`}
      onClose={() => { if (!deleteJobs.isPending) setBulkDeleteTarget(null); }}
      footer={<>
        <DialogButton disabled={deleteJobs.isPending} onClick={() => setBulkDeleteTarget(null)}>取消</DialogButton>
        <DialogButton disabled={deleteJobs.isPending} tone="danger" onClick={() => void ConfirmRemoveJobs()}>{deleteJobs.isPending ? '删除中…' : '确认删除'}</DialogButton>
      </>}
    >
      所选岗位将从岗位库移除，已有投递记录会保留。此操作不可撤销。
    </Modal>
  </div>;
}

export { JobsPage };
