import { useEffect, useMemo, useState, type UIEvent } from 'react';
import { useUiStore } from '../../../app/UiStore';
import { useApplications } from '../../../features/application/api/applicationQueries';
import { useDeleteJob, useJobs, useSetJobFavorite, useUpsertJob } from '../../../features/job/api/jobQueries';
import { CreateEntityId } from '../../workspace/api/workspaceData';
import { Button, Drawer, EmptyState, FormField, Modal, Select } from '../../../shared/components/UI';
import { Icon } from '../../../shared/components/Icon';
import { ChannelLabel, GetScoreLabel, JobScoreLabel } from '../../../shared/utils/format';
import type { Channel, Job, JobScore } from '../../../types/domain';

const BlankJob: Omit<Job, 'id' | 'favorite'> = { company: '', title: '', city: '', salary: '', experience: '', employmentType: 'full_time', channel: 'boss_zhipin', jd: '' };
const ChannelOptions: Channel[] = ['boss_zhipin', 'company_website', 'other'];
const JobPageSize = 50;
type QuickFilter = 'all' | 'excellent' | 'applied' | 'favorite';
type SortMode = 'score' | 'company' | 'title';

function JobsPage() {
  const { ShowNotice } = useUiStore();
  const jobs = useJobs();
  const applications = useApplications();
  const upsertJob = useUpsertJob({ onConflict: () => ShowNotice('岗位已在其他窗口被修改，已刷新为最新版本'), onFailure: () => ShowNotice('岗位保存失败，请稍后重试。') });
  const setJobFavorite = useSetJobFavorite({ onConflict: () => ShowNotice('岗位收藏更新失败，请稍后重试。'), onFailure: () => ShowNotice('岗位收藏更新失败，请稍后重试。') });
  const deleteJob = useDeleteJob({ onFailure: () => ShowNotice('岗位删除失败，请稍后重试。') });
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [editingJob, setEditingJob] = useState<Job | null>(null);
  const [form, setForm] = useState<Omit<Job, 'id' | 'favorite'>>(BlankJob);
  const [deleteTarget, setDeleteTarget] = useState<Job | null>(null);
  const [visibleJobCount, setVisibleJobCount] = useState(JobPageSize);
  const [quickFilter, setQuickFilter] = useState<QuickFilter>('all');
  const [sortMode, setSortMode] = useState<SortMode>('score');
  const [query, setQuery] = useState('');
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const appliedJobIds = useMemo(() => new Set(applications.filter((item) => item.status !== 'saved').map((item) => item.jobId)), [applications]);
  const filtered = useMemo(() => {
    const keyword = query.trim().toLocaleLowerCase();
    const result = jobs.filter((job) => {
      const matchesQuickFilter = quickFilter === 'all'
        || (quickFilter === 'excellent' && GetScoreLabel(job.matchScore) === 'excellent')
        || (quickFilter === 'applied' && appliedJobIds.has(job.id))
        || (quickFilter === 'favorite' && job.favorite);
      return matchesQuickFilter && (!keyword || `${job.company} ${job.title} ${job.city}`.toLocaleLowerCase().includes(keyword));
    });
    return result.sort((left, right) => {
      if (sortMode === 'company') return left.company.localeCompare(right.company, 'zh-CN');
      if (sortMode === 'title') return left.title.localeCompare(right.title, 'zh-CN');
      return (right.matchScore ?? -1) - (left.matchScore ?? -1);
    });
  }, [appliedJobIds, jobs, query, quickFilter, sortMode]);
  const visibleJobs = useMemo(() => filtered.slice(0, visibleJobCount), [filtered, visibleJobCount]);
  const selectedJob = filtered.find((job) => job.id === selectedJobId) ?? filtered[0] ?? null;
  const appliedJobCount = appliedJobIds.size;
  const favoriteCount = jobs.filter((job) => job.favorite).length;
  const highMatchCount = jobs.filter((job) => GetScoreLabel(job.matchScore) === 'excellent').length;

  useEffect(() => { setVisibleJobCount(JobPageSize); }, [quickFilter, query, sortMode]);
  useEffect(() => { if (!selectedJobId || !filtered.some((job) => job.id === selectedJobId)) setSelectedJobId(filtered[0]?.id ?? null); }, [filtered, selectedJobId]);

  function OpenNew() { setEditingJob(null); setForm(BlankJob); setDrawerOpen(true); }
  function OpenEdit(job: Job) { setEditingJob(job); setForm(job); setDrawerOpen(true); }
  function SaveJob() {
    if (!form.company || !form.title || !form.city || !form.experience || !form.jd) { ShowNotice('请填写公司、岗位、城市、经验要求和完整 JD'); return; }
    if (editingJob) upsertJob.mutate({ job: { ...form, id: editingJob.id, favorite: editingJob.favorite, matchScore: editingJob.matchScore }, expectedRevision: editingJob.revision });
    else upsertJob.mutate({ job: { ...form, id: CreateEntityId('job'), favorite: false } });
    setDrawerOpen(false); ShowNotice(editingJob ? '岗位信息已更新' : '已新增岗位');
  }
  function ToggleFavorite(job: Job) { setJobFavorite.mutate({ id: job.id, favorite: !job.favorite, expectedRevision: job.revision }); }
  function HandleApplyJob(job: Job) { ShowNotice(appliedJobIds.has(job.id) ? '该岗位已有投递记录，请前往投递管理查看进度' : '请前往投递管理选择简历后创建投递记录'); }
  function ConfirmRemoveJob() { if (!deleteTarget) return; deleteJob.mutate({ id: deleteTarget.id }); setDeleteTarget(null); setDrawerOpen(false); ShowNotice('岗位已删除'); }
  function HandleJobListScroll(event: UIEvent<HTMLDivElement>) { const element = event.currentTarget; if (element.scrollTop + element.clientHeight >= element.scrollHeight - 120) setVisibleJobCount((current) => Math.min(filtered.length, current + JobPageSize)); }

  return <div className="standard-page jobs-page">
    <section className="jobs-reference-overview">
      <header className="jobs-reference-heading"><div><h1>岗位库</h1><p>集中整理关注的职位，并查看与当前简历的匹配信息。</p></div><div className="jobs-reference-stats" aria-label="岗位数据概览"><span><b>{jobs.length}</b><small>全部岗位</small></span><span><b>{favoriteCount}</b><small>已收藏</small></span><span><b>{appliedJobCount}</b><small>已投递</small></span><span><b>{highMatchCount}</b><small>高匹配</small></span></div></header>
      <div className="jobs-reference-toolbar"><div className="jobs-quick-filters" role="group" aria-label="快速筛选"><button type="button" className={quickFilter === 'all' ? 'selected' : ''} onClick={() => setQuickFilter('all')}>全部 <b>{jobs.length}</b></button><button type="button" className={quickFilter === 'excellent' ? 'selected' : ''} onClick={() => setQuickFilter('excellent')}>高匹配 <b>{highMatchCount}</b></button><button type="button" className={quickFilter === 'applied' ? 'selected' : ''} onClick={() => setQuickFilter('applied')}>已投递 <b>{appliedJobCount}</b></button><button type="button" className={quickFilter === 'favorite' ? 'selected' : ''} onClick={() => setQuickFilter('favorite')}>已收藏 <b>{favoriteCount}</b></button><Select value={sortMode} ariaLabel="岗位排序" onChange={(value) => setSortMode(value as SortMode)} options={[{ value: 'score', label: '按匹配度排序' }, { value: 'company', label: '按企业排序' }, { value: 'title', label: '按岗位名称排序' }]} /></div><div className="jobs-reference-actions"><label className="jobs-reference-search"><Icon name="search" size={16} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索企业、岗位或城市" aria-label="搜索岗位" /></label><Button variant="primary" onClick={OpenNew}><Icon name="plus" size={16} />新增岗位</Button></div></div>
    </section>
    <section className="jobs-reference-workspace" aria-label="岗位列表与详情">
      <div className="jobs-reference-list-card"><header><span>当前显示 {filtered.length} 个岗位</span><small>按匹配度排序</small></header>{jobs.length === 0 ? <EmptyState icon={<Icon name="jobs" size={24} />} title="还没有保存的岗位" description="集中整理关注的机会，从新增一个岗位开始。" action={<Button variant="primary" onClick={OpenNew}><Icon name="plus" size={16} />新增岗位</Button>} /> : filtered.length === 0 ? <EmptyState icon={<Icon name="jobs" size={24} />} title="没有符合筛选条件的岗位" description="调整搜索词或快速筛选后重试。" action={<Button onClick={() => { setQuickFilter('all'); setQuery(''); }}>重置筛选</Button>} /> : <div className="job-grid" onScroll={HandleJobListScroll}>{visibleJobs.map((job) => <button className={`job-reference-row ${selectedJob?.id === job.id ? 'selected' : ''}`} type="button" key={job.id} onClick={() => setSelectedJobId(job.id)}><span className="job-reference-mark">{job.company.slice(0, 1)}</span><span className="job-reference-copy"><b>{job.title}</b><small>{job.company} · {job.city} · {job.salary || '薪资面议'} · {job.experience}</small><i>{ChannelLabel[job.channel]}</i></span><span className="job-reference-score"><b>{job.matchScore ?? '—'}{typeof job.matchScore === 'number' && '%'}</b><small>匹配度</small><span className="job-reference-expand-indicator" aria-hidden="true">&gt;</span></span></button>)}{visibleJobs.length < filtered.length && <p className="job-list-more" role="status">继续向下滚动加载更多岗位</p>}</div>}</div>
      <article className="job-reference-detail">{selectedJob ? <><header className="job-reference-detail-heading"><span className="job-reference-mark is-large">{selectedJob.company.slice(0, 1)}</span><div><h2>{selectedJob.title}</h2><p>{selectedJob.company} · {selectedJob.city} · {selectedJob.salary || '薪资面议'} · {selectedJob.experience}</p><div className="job-reference-tags"><span>匹配 {selectedJob.matchScore ?? '待计算'}{typeof selectedJob.matchScore === 'number' && '%'}</span><span>{ChannelLabel[selectedJob.channel]}</span>{appliedJobIds.has(selectedJob.id) && <span>已投递</span>}</div></div><div className="job-reference-detail-score"><b>{selectedJob.matchScore ?? '—'}{typeof selectedJob.matchScore === 'number' && '%'}</b><small>综合匹配</small></div></header><section className="job-reference-section"><h3>Avery 匹配分析</h3><p>岗位匹配度为 {JobScoreLabel[GetScoreLabel(selectedJob.matchScore)]}。可根据岗位要求、经历与技能进一步调整投递材料。</p></section><section className="job-reference-section"><h3>岗位摘要</h3><p>{selectedJob.jd || '暂未保存岗位描述。'}</p></section><footer className="job-reference-footer"><Button variant="primary" onClick={() => HandleApplyJob(selectedJob)}><Icon name="applications" size={16} />加入投递计划</Button><Button onClick={() => OpenEdit(selectedJob)}><Icon name="edit" size={16} />编辑岗位</Button><button className={`favorite-button ${selectedJob.favorite ? 'on' : ''}`} type="button" onClick={() => ToggleFavorite(selectedJob)} aria-label={selectedJob.favorite ? '取消收藏' : '收藏岗位'} title={selectedJob.favorite ? '取消收藏' : '收藏岗位'}><Icon name="heart" size={18} /></button></footer></> : <EmptyState icon={<Icon name="jobs" size={24} />} title="选择一个岗位" description="在左侧浏览岗位，并在这里查看完整信息。" />}</article>
    </section>
    <Drawer open={drawerOpen} title={editingJob ? '编辑岗位信息' : '新增岗位'} onClose={() => setDrawerOpen(false)}><div className="drawer-form"><div className="form-two-col"><FormField label="公司 *"><input value={form.company} onChange={(event) => setForm({ ...form, company: event.target.value })} /></FormField><FormField label="岗位名称 *"><input value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })} /></FormField><FormField label="城市 *"><input value={form.city} onChange={(event) => setForm({ ...form, city: event.target.value })} /></FormField><FormField label="薪资"><input value={form.salary ?? ''} onChange={(event) => setForm({ ...form, salary: event.target.value })} /></FormField><FormField label="经验要求 *"><input value={form.experience} onChange={(event) => setForm({ ...form, experience: event.target.value })} /></FormField><FormField label="渠道"><Select value={form.channel} ariaLabel="渠道" onChange={(channel) => setForm({ ...form, channel: channel as Channel })} options={ChannelOptions.map((item) => ({ value: item, label: ChannelLabel[item] }))} /></FormField></div><FormField label="用工类型"><div className="segmented"><button className={form.employmentType === 'intern' ? 'selected' : ''} onClick={() => setForm({ ...form, employmentType: 'intern' })}>实习</button><button className={form.employmentType === 'full_time' ? 'selected' : ''} onClick={() => setForm({ ...form, employmentType: 'full_time' })}>正式工</button></div></FormField><FormField label="岗位链接"><input value={form.url ?? ''} onChange={(event) => setForm({ ...form, url: event.target.value })} placeholder="https://" /></FormField><FormField label="完整 JD *"><textarea value={form.jd} onChange={(event) => setForm({ ...form, jd: event.target.value })} rows={8} /></FormField>{editingJob && <Button variant="quiet" onClick={() => ToggleFavorite(editingJob)}>{editingJob.favorite ? '取消收藏' : '加入收藏'}</Button>}<div className="drawer-actions">{editingJob && <Button variant="danger" onClick={() => setDeleteTarget(editingJob)}>删除</Button>}<span /><Button onClick={() => setDrawerOpen(false)}>取消</Button><Button variant="primary" onClick={SaveJob}>保存岗位</Button></div></div></Drawer>
    <Modal open={Boolean(deleteTarget)} title="删除这份岗位？" onClose={() => setDeleteTarget(null)}><p className="modal-copy">删除后岗位将从岗位库移除，此操作不可撤销。</p><div className="modal-actions"><Button onClick={() => setDeleteTarget(null)}>取消</Button><Button variant="danger" onClick={ConfirmRemoveJob}>确认删除</Button></div></Modal>
  </div>;
}

export { JobsPage };
