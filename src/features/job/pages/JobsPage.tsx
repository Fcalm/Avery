import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useUiStore } from '../../../app/UiStore';
import { DialogButton, FormField, Modal, Select } from '../../../shared/components/UI';
import { Icon } from '../../../shared/components/Icon';
import { platformClient, Unwrap } from '../../../shared/platform/platformClient';
import { ChannelLabel, FormatDateTime, FormatRelativeTime, FromDateTimeLocalValue, JobSeekingTypeLabel, ToDateTimeLocalValue } from '../../../shared/utils/format';
import { CreateEntityId } from '../../workspace/api/workspaceData';
import { useDeleteJob, useDeleteJobs, useJobLibraryQuery, useSetJobFavorite, useUpsertJob } from '../api/jobQueries';
import { BuildJobLibraryQuery, DefaultJobConditions, JobConditionGroups, LoadJobConditions, SaveJobConditions, type JobConditions } from '../api/jobConditions';
import { ScoreRing } from '../components/ScoreRing';
import { JobCollectionPanel } from '../components/JobCollectionPanel';
import { useJobCollection } from '../api/jobCollection';
import type { Channel, Job, JobSeekingType } from '../../../types/domain';
import type { JobLibraryView } from '@avery/contracts';

const ChannelOptions: Channel[] = ['boss_zhipin', 'company_website', 'other'];
const JobSeekingTypeOptions: JobSeekingType[] = ['intern', 'campus_recruitment', 'social_recruitment'];
type SortMode = 'created' | 'score';

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
  { value: 'created', label: '按入库时间' },
  { value: 'score', label: '按岗位分数' },
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

/** 岗位阅读态：详情面板与抽屉阅读态共用同一份字段顺序与排版，避免两处漂移。 */
function JobReadView({ job, onCopyUrl }: { job: Job; onCopyUrl: (url: string) => void }) {
  return <>
    <section className="sec">
      <div className="sec-h">基本信息</div>
      <div className="kv">
        <div className="kv-r"><span>薪资</span><b>{job.salary || '面议'}</b></div>
        <div className="kv-r"><span>城市</span><b>{job.city || '不限'}</b></div>
        <div className="kv-r"><span>渠道</span><b>{ChannelLabel[job.channel]}</b></div>
        <div className="kv-r"><span>求职类型</span><b>{job.jobSeekingType ? JobSeekingTypeLabel[job.jobSeekingType] : '未记录'}</b></div>
        <div className="kv-r"><span>工作经验</span><b>{job.experience || '不限'}</b></div>
        <div className="kv-r"><span>学历要求</span><b>{job.education || '未记录'}</b></div>
        <div className="kv-r"><span>公司规模</span><b>{job.companySize || '未记录'}</b></div>
        <div className="kv-r"><span>采集时间</span><b title={FormatDateTime(job.createdAt)}>{FormatRelativeTime(job.createdAt) || '—'}</b></div>
        <div className="kv-r"><span>岗位链接</span><b>{job.url ? <JobUrlLink url={job.url} onCopy={onCopyUrl} /> : '未填写'}</b></div>
        <div className="kv-r"><span>截止时间</span><b>{job.deadline ? FormatDateTime(job.deadline) : '长期有效'}</b></div>
      </div>
    </section>
    <section className="sec">
      <div className="sec-h">职位 JD</div>
      <div className="jd-body">{job.jd ? <div className="jd-text">{job.jd}</div> : <div className="jd-none">暂未保存岗位描述。</div>}</div>
    </section>
  </>;
}

function JobsPage(_props: { onGoAssistant: () => void }) {
  const [collectionOpen, setCollectionOpen] = useState(false);
  const collection = useJobCollection(collectionOpen);
  const { ShowNotice } = useUiStore();
  const upsertJob = useUpsertJob({ onConflict: () => ShowNotice('岗位已在其他窗口被修改，已刷新为最新版本'), onFailure: () => ShowNotice('岗位保存失败，请稍后重试。') });
  const setJobFavorite = useSetJobFavorite({ onConflict: () => ShowNotice('岗位收藏更新失败，请稍后重试。'), onFailure: () => ShowNotice('岗位收藏更新失败，请稍后重试。') });
  const deleteJob = useDeleteJob({ onFailure: () => ShowNotice('岗位删除失败，请稍后重试。') });
  const deleteJobs = useDeleteJobs({ onFailure: (message) => ShowNotice(`批量删除失败：${message}`) });

  const [conditions, setConditions] = useState<JobConditions>(() => LoadJobConditions());
  const [sortMode, setSortMode] = useState<SortMode>('score');
  const [view, setView] = useState<JobLibraryView>('all');
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
  const filterRef = useRef<HTMLDivElement>(null);
  const drawerRef = useRef<HTMLElement>(null);

  /** 筛选偏好只写入应用内缓存，不修改岗位事实。 */
  useEffect(() => { SaveJobConditions(conditions); }, [conditions]);

  useEffect(() => {
    if (!filterOpen) return undefined;
    function CloseOnOutsidePointer(event: PointerEvent) {
      if (!filterRef.current?.contains(event.target as Node)) setFilterOpen(false);
    }
    document.addEventListener('pointerdown', CloseOnOutsidePointer);
    return () => document.removeEventListener('pointerdown', CloseOnOutsidePointer);
  }, [filterOpen]);

  // 抽屉打开期间 Escape 关闭；初始焦点落在关闭按钮，与简历/档案抽屉一致。
  useEffect(() => {
    if (!drawerOpen) return undefined;
    function OnKeyDown(event: KeyboardEvent) { if (event.key === 'Escape') setDrawerOpen(false); }
    document.addEventListener('keydown', OnKeyDown);
    return () => document.removeEventListener('keydown', OnKeyDown);
  }, [drawerOpen]);

  const input = useMemo(() => BuildJobLibraryQuery(conditions, view, sortMode, page), [conditions, view, sortMode, page]);
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
  function UpdateView(next: JobLibraryView) { setView(next); setPage(1); setCheckedIds(new Set()); }
  function ClearFilters() { UpdateConditions({ ...DefaultJobConditions }); setView('all'); }
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

  function OpenNew() { setEditingJob(null); setForm(BlankJob); setDrawerOpen(true); }
  function OpenEdit(job: Job) { setEditingJob(job); setForm(ToForm(job)); setDrawerOpen(true); }
  function SaveJob() {
    // 编辑来源缺失字段的岗位不强迫用户补造事实；手动新增仍沿用完整输入要求。
    if (!form.company || !form.title || (!editingJob && (!form.city || !form.experience || !form.jd))) { ShowNotice(editingJob ? '请填写公司和岗位名称' : '请填写公司、岗位、城市、经验要求和完整 JD'); return; }
    if (editingJob) upsertJob.mutate({ job: { ...editingJob, ...form }, expectedRevision: editingJob.revision });
    else upsertJob.mutate({ job: { ...form, id: CreateEntityId('job'), favorite: false } });
    setDrawerOpen(false); ShowNotice(editingJob ? '岗位信息已更新' : '已新增岗位');
  }
  async function ConfirmRemoveJob() {
    if (!deleteTarget || deleteJob.isPending) return;
    const id = deleteTarget.id;
    try {
      await deleteJob.mutateAsync({ id });
      setCheckedIds((current) => new Set([...current].filter((item) => item !== id)));
      setDeleteTarget(null); setDrawerOpen(false); ShowNotice('岗位已删除');
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
      ShowNotice(result.ids.length ? `已删除 ${result.ids.length} 个岗位` : '所选岗位已不在岗位库中');
    } catch { /* 删除失败不清除选择，也不显示成功提示。 */ }
  }
  function ToggleFavorite(job: Job) { setJobFavorite.mutate({ id: job.id, favorite: !job.favorite, expectedRevision: job.revision }); }
  function CopyJobUrl(url: string) {
    void Unwrap(platformClient.desktop.WriteClipboardText(url))
      .then(() => ShowNotice('岗位链接已复制'))
      .catch((error: unknown) => ShowNotice(error instanceof Error ? `岗位链接复制失败：${error.message}` : '岗位链接复制失败，请重试'));
  }

  return <div className="standard-page job-view">
    <div className="view-h">
      <div>
        <h1>岗位库</h1>
        <p>按渠道、关键词和其他条件筛选已保存的岗位，在右侧查看完整信息。筛选不会修改岗位数据。</p>
      </div>
      <div className="vh-act"><button className="btn-accent" type="button" onClick={() => setCollectionOpen(true)}><Icon name="plus" size={14} />{collection.task.data?.status === 'running' ? '查看采集进度' : '采集岗位'}</button><button className="ghost-btn" type="button" onClick={OpenNew}><Icon name="plus" size={14} />手动添加</button></div>
    </div>

    <section className="panel cond" aria-label="岗位筛选条件">
      <div className="field">
        <span>岗位关键词</span>
        <input type="search" value={conditions.keyword} maxLength={500} placeholder="搜索岗位、企业或 JD" aria-label="岗位关键词" onChange={(event) => UpdateConditions({ ...conditions, keyword: event.target.value })} />
      </div>
      {JobConditionGroups.map((group) => <div className="field" key={group.key}>
        <span>{group.label}</span>
        <Select value={conditions[group.key]} ariaLabel={group.label} options={group.options.map((option) => ({ value: option.value, label: option.label }))} onChange={(value) => UpdateConditions({ ...conditions, [group.key]: value })} />
      </div>)}
      <div className="field">
        <span>岗位视图</span>
        <Select value={view} ariaLabel="岗位视图" options={JobViews} onChange={(value) => UpdateView(value as JobLibraryView)} />
      </div>
      <div className="cond-actions">
        <button className="ghost-btn" type="button" onClick={ClearFilters}>清空筛选</button>
      </div>
    </section>

    <div className="jlib">
      <section className="panel" aria-label="岗位列表">
        <div className="jsearch">
          <span className="job-result-count" aria-live="polite">{jobQuery.isPending ? '正在查询…' : `共 ${total} 个岗位`}{jobQuery.isFetching && !jobQuery.isPending ? ' · 更新中' : ''}</span>
          <span className="sep-v" aria-hidden="true"></span>
          <div className="job-bulk-actions">
            {selecting && <>
              <JobSelection checked={allPageChecked} mixed={checkedOnPage > 0 && !allPageChecked} disabled={!filtered.length || jobQuery.isFetching || deleteJobs.isPending} label={allPageChecked ? '取消全选' : '全选本页'} showLabel onChange={TogglePage} />
              <button className="filter-btn is-danger" type="button" aria-label={`删除已选的 ${checkedIds.size} 个岗位`} title={`删除已选的 ${checkedIds.size} 个岗位`} disabled={!checkedIds.size || deleteJobs.isPending} onClick={() => setBulkDeleteTarget([...checkedIds])}><Icon name="delete" size={14} /></button>
            </>}
            <button className={`filter-btn${selecting ? ' on' : ''}`} type="button" aria-pressed={selecting} disabled={deleteJobs.isPending} onClick={() => { setSelecting(!selecting); setCheckedIds(new Set()); }}>
              {!selecting && <Icon name="delete" size={14} />}{selecting ? '取消' : '批量删除'}
            </button>
          </div>
          <div className="menu-wrap" ref={filterRef}>
            <button className="filter-btn" type="button" aria-expanded={filterOpen} aria-haspopup="menu" onClick={() => setFilterOpen((current) => !current)}>
              <Icon name="sliders" size={14} />排序<Icon name="chevron-down" size={9} className="chev" />
            </button>
            {filterOpen && <div className="menu drop sm" role="menu" aria-label="筛选与排序">
              <div className="menu-label">排序</div>
              {SortOptions.map((option) => <button key={option.value} className={`menu-item plain${sortMode === option.value ? ' sel' : ''}`} type="button" role="menuitemradio" aria-checked={sortMode === option.value} onClick={() => { setSortMode(option.value); setPage(1); setFilterOpen(false); }}>
                <span className="mt">{option.label}</span><Icon name="check" size={14} className="tick" />
              </button>)}
            </div>}
          </div>
        </div>
        <div className="jrows">
          {jobQuery.isError ? <div className="jrow-empty" role="alert">岗位查询失败：{jobQuery.error.message}<button className="ghost-btn" type="button" onClick={() => void jobQuery.refetch()}>重试</button></div> : filtered.length
            ? filtered.map((job) => <div key={job.id} className={`jrow${selectedJob?.id === job.id ? ' active' : ''}`}>
              {selecting && <JobSelection checked={checkedIds.has(job.id)} disabled={deleteJobs.isPending} label={`选择岗位：${job.company} · ${job.title}`} onChange={() => ToggleJob(job.id)} />}
              <button className="jrow-open" type="button" aria-pressed={selectedJob?.id === job.id} onClick={() => setSelectedJobId(job.id)}>
                <span className="jr-main">
                  <span className="jr-co">{job.company}</span>
                  <span className="jr-role">{job.title}</span>
                  <span className="jr-tags">
                    <span className="jtag">{job.salary || '薪资面议'}</span>
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

      <section className="panel job-detail" aria-label="岗位详情">
        {selectedJob ? <>
          <div className="jd-head">
            <div className="jd-title">
              <div className="jd-co">{selectedJob.company}</div>
              <div className="jd-role">{selectedJob.title}</div>
            </div>
            <ScoreRing score={selectedJob.matchScore} size="detail" />
            <div className="jd-actions">
              <button className={`ghost-btn${selectedJob.favorite ? ' on' : ''}`} type="button" aria-pressed={selectedJob.favorite} onClick={() => ToggleFavorite(selectedJob)}>
                <Icon name="heart" size={14} />{selectedJob.favorite ? '已收藏' : '收藏'}
              </button>
              <button className="ghost-btn" type="button" onClick={() => OpenEdit(selectedJob)}><Icon name="pencil-simple" size={14} />编辑</button>
            </div>
          </div>
          <JobReadView job={selectedJob} onCopyUrl={CopyJobUrl} />
        </> : <div className="jd-empty">从左边选一个岗位，这里会显示它的完整信息。</div>}
      </section>
    </div>

    {/* 抽屉经 portal 挂到 body：玻璃背景等祖先带动画/滤镜时 fixed 会退化为相对祖先定位，
        只有脱离该子树才能像简历/档案抽屉一样让遮罩与虚化盖住整个应用窗口。 */}
    {drawerOpen && createPortal(<div className="dw-layer" role="presentation">
      <div className="dw-scrim" onClick={() => setDrawerOpen(false)} />
      <aside className="dw-drawer is-job" role="dialog" aria-modal="true" aria-labelledby="job-drawer-title" tabIndex={-1} ref={drawerRef}>
        <div className="dw-head">
          <div className="dw-head-main">
            <div className="dw-title" id="job-drawer-title">{editingJob ? '编辑岗位信息' : '手动添加岗位'}</div>
            <div className="dw-meta">
              {editingJob ? <><span>{editingJob.company}</span><span>{ChannelLabel[editingJob.channel]}</span><span>修改后尚未保存</span></> : <span>尚未保存</span>}
            </div>
          </div>
          <button className="icon-btn" type="button" aria-label="关闭编辑" title="关闭编辑" autoFocus onClick={() => setDrawerOpen(false)}><Icon name="close" size={16} /></button>
        </div>
        <div className="dw-body">
          <div className="drawer-form">
            <div className="form-two-col">
              <FormField label="公司 *"><input value={form.company} onChange={(event) => setForm({ ...form, company: event.target.value })} /></FormField>
              <FormField label="岗位名称 *"><input value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })} /></FormField>
              <FormField label={editingJob ? '城市' : '城市 *'}><input value={form.city} onChange={(event) => setForm({ ...form, city: event.target.value })} /></FormField>
              <FormField label="薪资"><input value={form.salary ?? ''} onChange={(event) => setForm({ ...form, salary: event.target.value })} /></FormField>
              <FormField label={editingJob ? '经验要求' : '经验要求 *'}><input value={form.experience} onChange={(event) => setForm({ ...form, experience: event.target.value })} /></FormField>
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
            <FormField label={editingJob ? '完整 JD' : '完整 JD *'}><textarea value={form.jd} onChange={(event) => setForm({ ...form, jd: event.target.value })} rows={8} /></FormField>
          </div>
        </div>
        <div className="dw-foot">
          {editingJob && <button className="ghost-btn is-danger" type="button" onClick={() => setDeleteTarget(editingJob)}><Icon name="delete" size={14} />删除</button>}
          <button className="ghost-btn" type="button" onClick={() => setDrawerOpen(false)}>取消</button>
          <button className="btn-accent" type="button" onClick={SaveJob}><Icon name="check-circle" size={14} />保存岗位</button>
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
