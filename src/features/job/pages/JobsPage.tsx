import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useUiStore } from '../../../app/UiStore';
import { Button, FormField, Modal, Select } from '../../../shared/components/UI';
import { Icon } from '../../../shared/components/Icon';
import { ChannelLabel, FormatDateTime, FormatRelativeTime, FromDateTimeLocalValue, JobSeekingTypeLabel, ToDateTimeLocalValue } from '../../../shared/utils/format';
import { CreateEntityId } from '../../workspace/api/workspaceData';
import { useDeleteJob, useJobs, useSetJobFavorite, useUpsertJob } from '../api/jobQueries';
import { BuildCollectPrompt, JobConditionGroups, LoadJobConditions, SaveJobConditions, type JobConditions } from '../api/jobConditions';
import { ScoreRing } from '../components/ScoreRing';
import type { Channel, Job, JobSeekingType } from '../../../types/domain';

const ChannelOptions: Channel[] = ['boss_zhipin', 'company_website', 'other'];
const JobSeekingTypeOptions: JobSeekingType[] = ['intern', 'campus_recruitment', 'social_recruitment'];
type SortMode = 'posted' | 'score';

/** 表单只承载用户可编辑字段；createdAt 由后端 created_at 投影，不参与写回。 */
type JobForm = Pick<Job, 'company' | 'title' | 'city' | 'salary' | 'experience' | 'jobSeekingType' | 'channel' | 'url' | 'jd' | 'deadline'>;
/** 抽屉两种形态：阅读态只渲染字段，编辑态才出现输入框；新建岗位没有阅读态。 */
type JobDrawer = { mode: 'view'; job: Job } | { mode: 'edit'; job: Job | null };

const BlankJob: JobForm = {
  company: '', title: '', city: '', salary: '', experience: '',
  jobSeekingType: 'social_recruitment', channel: 'boss_zhipin', url: '', jd: '', deadline: undefined,
};

function ToForm(job: Job): JobForm {
  const { company, title, city, salary, experience, jobSeekingType, channel, url, jd, deadline } = job;
  return { company, title, city, salary, experience, jobSeekingType, channel, url, jd, deadline };
}

/** 排序与筛选：与原型一致，只作用于已入库岗位，不改变采集条件。 */
const SortOptions: Array<{ value: SortMode; label: string }> = [
  { value: 'posted', label: '按发布时间' },
  { value: 'score', label: '按岗位分数' },
];

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
        <div className="kv-r"><span>求职类型</span><b>{JobSeekingTypeLabel[job.jobSeekingType]}</b></div>
        <div className="kv-r"><span>工作经验</span><b>{job.experience || '不限'}</b></div>
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

function JobsPage({ onGoAssistant }: { onGoAssistant: () => void }) {
  const { ShowNotice, setComposerSeed, setActiveConversationId, setAssistantView } = useUiStore();
  const jobs = useJobs();
  const upsertJob = useUpsertJob({ onConflict: () => ShowNotice('岗位已在其他窗口被修改，已刷新为最新版本'), onFailure: () => ShowNotice('岗位保存失败，请稍后重试。') });
  const setJobFavorite = useSetJobFavorite({ onConflict: () => ShowNotice('岗位收藏更新失败，请稍后重试。'), onFailure: () => ShowNotice('岗位收藏更新失败，请稍后重试。') });
  const deleteJob = useDeleteJob({ onFailure: () => ShowNotice('岗位删除失败，请稍后重试。') });

  const [conditions, setConditions] = useState<JobConditions>(() => LoadJobConditions());
  const [query, setQuery] = useState('');
  const [sortMode, setSortMode] = useState<SortMode>('score');
  const [favoriteOnly, setFavoriteOnly] = useState(false);
  const [filterOpen, setFilterOpen] = useState(false);
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const [drawer, setDrawer] = useState<JobDrawer | null>(null);
  const [form, setForm] = useState<JobForm>(BlankJob);
  const [deleteTarget, setDeleteTarget] = useState<Job | null>(null);
  const filterRef = useRef<HTMLDivElement>(null);
  const drawerRef = useRef<HTMLElement>(null);

  /** 条件选择只写入应用内缓存：它决定采集口径，不是岗位事实，因此不进入业务数据库。 */
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
    if (!drawer) return undefined;
    function OnKeyDown(event: KeyboardEvent) { if (event.key === 'Escape') setDrawer(null); }
    document.addEventListener('keydown', OnKeyDown);
    return () => document.removeEventListener('keydown', OnKeyDown);
  }, [drawer]);

  const filtered = useMemo(() => {
    const keyword = query.trim().toLocaleLowerCase();
    const result = jobs.filter((job) => {
      if (favoriteOnly && !job.favorite) return false;
      if (!keyword) return true;
      return `${job.company} ${job.title} ${job.city} ${ChannelLabel[job.channel]}`.toLocaleLowerCase().includes(keyword);
    });
    return result.sort((left, right) => (sortMode === 'score'
      ? (right.matchScore ?? -1) - (left.matchScore ?? -1)
      : (right.createdAt ?? 0) - (left.createdAt ?? 0)));
  }, [favoriteOnly, jobs, query, sortMode]);

  const selectedJob = filtered.find((job) => job.id === selectedJobId) ?? filtered[0] ?? null;

  useEffect(() => { if (!selectedJobId || !filtered.some((job) => job.id === selectedJobId)) setSelectedJobId(filtered[0]?.id ?? null); }, [filtered, selectedJobId]);

  const activeSort = SortOptions.find((option) => option.value === sortMode) ?? SortOptions[0];
  const editingJob = drawer?.mode === 'edit' ? drawer.job : null;

  function OpenNew() { setForm(BlankJob); setDrawer({ mode: 'edit', job: null }); }
  function OpenDetail(job: Job) { setDrawer({ mode: 'view', job }); }
  function StartEditing() {
    const job = drawer?.mode === 'view' ? drawer.job : null;
    setForm(job ? ToForm(job) : BlankJob);
    setDrawer({ mode: 'edit', job });
  }
  function SaveJob() {
    if (!form.company || !form.title || !form.city || !form.experience || !form.jd) { ShowNotice('请填写公司、岗位、城市、经验要求和完整 JD'); return; }
    if (editingJob) upsertJob.mutate({ job: { ...form, id: editingJob.id, favorite: editingJob.favorite, matchScore: editingJob.matchScore }, expectedRevision: editingJob.revision });
    else upsertJob.mutate({ job: { ...form, id: CreateEntityId('job'), favorite: false } });
    setDrawer(null); ShowNotice(editingJob ? '岗位信息已更新' : '已新增岗位');
  }
  function ConfirmRemoveJob() {
    if (!deleteTarget) return;
    deleteJob.mutate({ id: deleteTarget.id });
    setDeleteTarget(null); setDrawer(null); ShowNotice('岗位已删除');
  }
  function ToggleFavorite(job: Job) { setJobFavorite.mutate({ id: job.id, favorite: !job.favorite, expectedRevision: job.revision }); }
  function CopyJobUrl(url: string) {
    void navigator.clipboard?.writeText(url).then(() => ShowNotice('岗位链接已复制')).catch(() => ShowNotice('岗位链接复制失败，请手动选择复制'));
  }
  /** 采集入口与原型一致：把条件整理成指令预填到助手输入框，由用户确认后发送。 */
  function CollectViaAvery() {
    setComposerSeed(BuildCollectPrompt(conditions));
    setActiveConversationId(null);
    setAssistantView('chat');
    onGoAssistant();
  }

  return <div className="standard-page job-view">
    <div className="view-h">
      <div>
        <h1>岗位库</h1>
        <p>这里存放采集到的岗位。左边是岗位列表，右边是详情，上面的条件决定 Avery 去采集什么。</p>
      </div>
      <div className="vh-act"><button className="ghost-btn" type="button" onClick={OpenNew}><Icon name="plus" size={14} />手动添加</button></div>
    </div>

    <section className="panel cond" aria-label="采集条件">
      <div className="field">
        <span>岗位关键词</span>
        <input type="search" value={conditions.keyword} placeholder="例如：产品设计师" aria-label="岗位关键词" onChange={(event) => setConditions({ ...conditions, keyword: event.target.value })} />
      </div>
      {JobConditionGroups.map((group) => <div className="field" key={group.key}>
        <span>{group.label}</span>
        <Select value={conditions[group.key]} ariaLabel={group.label} options={group.options.map((option) => ({ value: option.value, label: option.label }))} onChange={(value) => setConditions({ ...conditions, [group.key]: value })} />
      </div>)}
      <button className="btn-accent cond-go" type="button" onClick={CollectViaAvery}><Icon name="sparkle" size={14} />让 Avery 采集岗位</button>
    </section>

    <div className="jlib">
      <section className="panel" aria-label="岗位列表">
        <div className="jsearch">
          <Icon name="search" size={15} />
          <input type="search" value={query} placeholder="搜索公司、岗位或城市" aria-label="搜索岗位" onChange={(event) => setQuery(event.target.value)} />
          <span className="sep-v" aria-hidden="true"></span>
          <div className="menu-wrap" ref={filterRef}>
            <button className={`filter-btn${favoriteOnly ? ' on' : ''}`} type="button" aria-expanded={filterOpen} aria-haspopup="menu" onClick={() => setFilterOpen((current) => !current)}>
              <Icon name="sliders" size={14} />筛选<Icon name="chevron-down" size={9} className="chev" />
            </button>
            {filterOpen && <div className="menu drop sm" role="menu" aria-label="筛选与排序">
              <div className="menu-label">排序</div>
              {SortOptions.map((option) => <button key={option.value} className={`menu-item plain${sortMode === option.value ? ' sel' : ''}`} type="button" role="menuitemradio" aria-checked={sortMode === option.value} onClick={() => { setSortMode(option.value); setFilterOpen(false); }}>
                <span className="mt">{option.label}</span><Icon name="check" size={14} className="tick" />
              </button>)}
              <div className="menu-label">筛选</div>
              <button className={`menu-item plain${favoriteOnly ? ' sel' : ''}`} type="button" role="menuitemcheckbox" aria-checked={favoriteOnly} onClick={() => { setFavoriteOnly((current) => !current); setFilterOpen(false); }}>
                <span className="mt">只看已收藏</span><Icon name="check" size={14} className="tick" />
              </button>
            </div>}
          </div>
        </div>
        <div className="jrows">
          {filtered.length
            ? filtered.map((job) => <button key={job.id} className={`jrow${selectedJob?.id === job.id ? ' active' : ''}`} type="button" aria-pressed={selectedJob?.id === job.id} onClick={() => setSelectedJobId(job.id)}>
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
            </button>)
            : <div className="jrow-empty">{jobs.length ? '没有匹配的岗位，换个关键词，或者清掉筛选再看看。' : '还没有保存的岗位，点右上角“手动添加”，或者用上面的条件让 Avery 去采集。'}</div>}
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
              <button className="ghost-btn" type="button" onClick={() => OpenDetail(selectedJob)}><Icon name="info" size={14} />详情</button>
            </div>
          </div>
          <JobReadView job={selectedJob} onCopyUrl={CopyJobUrl} />
        </> : <div className="jd-empty">从左边选一个岗位，这里会显示它的完整信息。</div>}
      </section>
    </div>

    {/* 抽屉经 portal 挂到 body：玻璃背景等祖先带动画/滤镜时 fixed 会退化为相对祖先定位，
        只有脱离该子树才能像简历/档案抽屉一样让遮罩与虚化盖住整个应用窗口。 */}
    {drawer && createPortal(<div className="dw-layer" role="presentation">
      <div className="dw-scrim" onClick={() => setDrawer(null)} />
      <aside className="dw-drawer is-job" role="dialog" aria-modal="true" aria-labelledby="job-drawer-title" tabIndex={-1} ref={drawerRef}>
        <div className="dw-head">
          <div className="dw-head-main">
            <div className="dw-title" id="job-drawer-title">{drawer.mode === 'view' ? drawer.job.title : editingJob ? '编辑岗位信息' : '手动添加岗位'}</div>
            <div className="dw-meta">
              {drawer.mode === 'view' ? <>
                <span>{drawer.job.company}</span>
                <span>{ChannelLabel[drawer.job.channel]}</span>
                {Boolean(drawer.job.createdAt) && <span>{FormatRelativeTime(drawer.job.createdAt)}采集</span>}
              </> : <span>{editingJob ? '修改后尚未保存' : '尚未保存'}</span>}
            </div>
          </div>
          <button className="icon-btn" type="button" aria-label="关闭详情" title="关闭详情" autoFocus onClick={() => setDrawer(null)}><Icon name="close" size={16} /></button>
        </div>
        <div className="dw-body">
          {drawer.mode === 'view' ? <JobReadView job={drawer.job} onCopyUrl={CopyJobUrl} /> : <div className="drawer-form">
            <div className="form-two-col">
              <FormField label="公司 *"><input value={form.company} onChange={(event) => setForm({ ...form, company: event.target.value })} /></FormField>
              <FormField label="岗位名称 *"><input value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })} /></FormField>
              <FormField label="城市 *"><input value={form.city} onChange={(event) => setForm({ ...form, city: event.target.value })} /></FormField>
              <FormField label="薪资"><input value={form.salary ?? ''} onChange={(event) => setForm({ ...form, salary: event.target.value })} /></FormField>
              <FormField label="经验要求 *"><input value={form.experience} onChange={(event) => setForm({ ...form, experience: event.target.value })} /></FormField>
              <FormField label="渠道"><Select value={form.channel} ariaLabel="渠道" onChange={(channel) => setForm({ ...form, channel: channel as Channel })} options={ChannelOptions.map((item) => ({ value: item, label: ChannelLabel[item] }))} /></FormField>
            </div>
            <FormField label="求职类型">
              <div className="segmented">{JobSeekingTypeOptions.map((item) => <button key={item} type="button" className={form.jobSeekingType === item ? 'selected' : ''} onClick={() => setForm({ ...form, jobSeekingType: item })}>{JobSeekingTypeLabel[item]}</button>)}</div>
            </FormField>
            <FormField label="岗位链接"><input value={form.url ?? ''} onChange={(event) => setForm({ ...form, url: event.target.value })} placeholder="https://" /></FormField>
            <FormField label="截止时间" hint="到期后岗位会自动从岗位库删除；留空表示长期有效。">
              <input type="datetime-local" value={ToDateTimeLocalValue(form.deadline)} onChange={(event) => setForm({ ...form, deadline: FromDateTimeLocalValue(event.target.value) })} />
            </FormField>
            <FormField label="完整 JD *"><textarea value={form.jd} onChange={(event) => setForm({ ...form, jd: event.target.value })} rows={8} /></FormField>
          </div>}
        </div>
        <div className="dw-foot">
          {drawer.mode === 'view' ? <>
            <button className="ghost-btn" type="button" disabled={!drawer.job.url} onClick={() => drawer.job.url && CopyJobUrl(drawer.job.url)}><Icon name="copy" size={14} />复制链接</button>
            <button className="ghost-btn is-danger" type="button" onClick={() => setDeleteTarget(drawer.job)}><Icon name="delete" size={14} />删除</button>
            <button className="btn-accent" type="button" onClick={StartEditing}><Icon name="pencil-simple" size={14} />编辑</button>
          </> : <>
            {editingJob && <button className="ghost-btn is-danger" type="button" onClick={() => setDeleteTarget(editingJob)}><Icon name="delete" size={14} />删除</button>}
            <button className="ghost-btn" type="button" onClick={() => setDrawer(null)}>取消</button>
            <button className="btn-accent" type="button" onClick={SaveJob}><Icon name="check-circle" size={14} />保存岗位</button>
          </>}
        </div>
      </aside>
    </div>, document.body)}

    <Modal open={Boolean(deleteTarget)} title="删除这份岗位？" onClose={() => setDeleteTarget(null)}>
      <p className="modal-copy">删除后岗位将从岗位库移除，此操作不可撤销。</p>
      <div className="modal-actions"><Button onClick={() => setDeleteTarget(null)}>取消</Button><Button variant="danger" onClick={ConfirmRemoveJob}>确认删除</Button></div>
    </Modal>
  </div>;
}

export { JobsPage };
