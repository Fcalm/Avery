import { useEffect, useMemo, useRef, useState } from 'react';
import { useUiStore } from '../../../app/UiStore';
import { Button, Drawer, FormField, Modal, Select } from '../../../shared/components/UI';
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
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [editingJob, setEditingJob] = useState<Job | null>(null);
  const [form, setForm] = useState<JobForm>(BlankJob);
  const [deleteTarget, setDeleteTarget] = useState<Job | null>(null);
  const filterRef = useRef<HTMLDivElement>(null);

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

  function OpenNew() { setEditingJob(null); setForm(BlankJob); setDrawerOpen(true); }
  function OpenEdit(job: Job) { setEditingJob(job); setForm(ToForm(job)); setDrawerOpen(true); }
  function SaveJob() {
    if (!form.company || !form.title || !form.city || !form.experience || !form.jd) { ShowNotice('请填写公司、岗位、城市、经验要求和完整 JD'); return; }
    if (editingJob) upsertJob.mutate({ job: { ...form, id: editingJob.id, favorite: editingJob.favorite, matchScore: editingJob.matchScore }, expectedRevision: editingJob.revision });
    else upsertJob.mutate({ job: { ...form, id: CreateEntityId('job'), favorite: false } });
    setDrawerOpen(false); ShowNotice(editingJob ? '岗位信息已更新' : '已新增岗位');
  }
  function ConfirmRemoveJob() { if (!deleteTarget) return; deleteJob.mutate({ id: deleteTarget.id }); setDeleteTarget(null); setDrawerOpen(false); ShowNotice('岗位已删除'); }
  function ToggleFavorite(job: Job) { setJobFavorite.mutate({ id: job.id, favorite: !job.favorite, expectedRevision: job.revision }); }
  function CopyJobUrl(job: Job) {
    if (!job.url) return;
    void navigator.clipboard?.writeText(job.url).then(() => ShowNotice('岗位链接已复制')).catch(() => ShowNotice('岗位链接复制失败，请手动选择复制'));
  }
  /** 采集入口与原型一致：把条件整理成指令预填到助手输入框，由用户确认后发送。 */
  function CollectViaAvery() {
    setComposerSeed(BuildCollectPrompt(conditions));
    setActiveConversationId(null);
    setAssistantView('chat');
    onGoAssistant();
  }

  const activeSort = SortOptions.find((option) => option.value === sortMode) ?? SortOptions[0];

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
              <button className="ghost-btn" type="button" onClick={() => OpenEdit(selectedJob)}><Icon name="edit" size={14} />编辑</button>
            </div>
          </div>
          <div className="sec">
            <div className="sec-h">基本信息</div>
            <div className="kv">
              <div className="kv-r"><span>薪资</span><b>{selectedJob.salary || '面议'}</b></div>
              <div className="kv-r"><span>城市</span><b>{selectedJob.city || '不限'}</b></div>
              <div className="kv-r"><span>渠道</span><b>{ChannelLabel[selectedJob.channel]}</b></div>
              <div className="kv-r"><span>求职类型</span><b>{JobSeekingTypeLabel[selectedJob.jobSeekingType]}</b></div>
              <div className="kv-r"><span>工作经验</span><b>{selectedJob.experience || '不限'}</b></div>
              <div className="kv-r"><span>采集时间</span><b title={FormatDateTime(selectedJob.createdAt)}>{FormatRelativeTime(selectedJob.createdAt) || '—'}</b></div>
              <div className="kv-r"><span>岗位链接</span><b>{selectedJob.url
                ? <span className="kv-link"><span title={selectedJob.url}>{selectedJob.url}</span><button type="button" aria-label="复制岗位链接" title="复制岗位链接" onClick={() => CopyJobUrl(selectedJob)}><Icon name="copy" size={13} /></button></span>
                : '未填写'}</b></div>
              <div className="kv-r"><span>截止时间</span><b>{selectedJob.deadline ? FormatDateTime(selectedJob.deadline) : '长期有效'}</b></div>
            </div>
          </div>
          <div className="sec">
            <div className="sec-h">职位 JD</div>
            <div className="jd-body">{selectedJob.jd ? <div className="jd-text">{selectedJob.jd}</div> : <div className="jd-none">暂未保存岗位描述。</div>}</div>
          </div>
        </> : <div className="jd-empty">从左边选一个岗位，这里会显示它的完整信息。</div>}
      </section>
    </div>

    <Drawer open={drawerOpen} title={editingJob ? '编辑岗位信息' : '手动添加岗位'} onClose={() => setDrawerOpen(false)}>
      <div className="drawer-form">
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
        <div className="drawer-actions">
          {editingJob && <Button variant="danger" onClick={() => setDeleteTarget(editingJob)}>删除</Button>}
          <span />
          <Button onClick={() => setDrawerOpen(false)}>取消</Button>
          <Button variant="primary" onClick={SaveJob}>保存岗位</Button>
        </div>
      </div>
    </Drawer>

    <Modal open={Boolean(deleteTarget)} title="删除这份岗位？" onClose={() => setDeleteTarget(null)}>
      <p className="modal-copy">删除后岗位将从岗位库移除，此操作不可撤销。</p>
      <div className="modal-actions"><Button onClick={() => setDeleteTarget(null)}>取消</Button><Button variant="danger" onClick={ConfirmRemoveJob}>确认删除</Button></div>
    </Modal>
  </div>;
}

export { JobsPage };
