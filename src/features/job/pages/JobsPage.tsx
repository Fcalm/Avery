import { useEffect, useMemo, useState, type CSSProperties, type UIEvent } from 'react';
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
const ChannelFilters: Array<Channel | 'all'> = ['all', ...ChannelOptions];
const ScoreFilters: Array<JobScore | 'all'> = ['all', 'poor', 'good', 'excellent'];
type ApplicationFilter = 'all' | 'not_applied' | 'applied';
type FavoriteFilter = 'all' | 'favorite' | 'not_favorite';
const JobPageSize = 50;

function ToDateKey(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function JobsPage() {
  const { ShowNotice } = useUiStore();
  const jobs = useJobs();
  const applications = useApplications();
  const upsertJob = useUpsertJob({ onConflict: () => ShowNotice('岗位已在其他窗口被修改，已刷新为最新版本'), onFailure: () => ShowNotice('岗位保存失败，请稍后重试。') });
  const setJobFavorite = useSetJobFavorite({ onConflict: () => ShowNotice('岗位已在其他窗口被修改，已刷新为最新版本'), onFailure: () => ShowNotice('岗位收藏更新失败，请稍后重试。') });
  const deleteJob = useDeleteJob({ onFailure: () => ShowNotice('岗位删除失败，请稍后重试。') });
  const [favorite, setFavorite] = useState<FavoriteFilter>('all');
  const [channel, setChannel] = useState<Channel | 'all'>('all');
  const [application, setApplication] = useState<ApplicationFilter>('all');
  const [score, setScore] = useState<JobScore | 'all'>('all');
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [editingJob, setEditingJob] = useState<Job | null>(null);
  const [form, setForm] = useState<Omit<Job, 'id' | 'favorite'>>(BlankJob);
  const [deleteTarget, setDeleteTarget] = useState<Job | null>(null);
  const [visibleJobCount, setVisibleJobCount] = useState(JobPageSize);

  const appliedJobIds = useMemo(() => new Set(applications.filter((item) => item.status !== 'saved').map((item) => item.jobId)), [applications]);
  const filtered = useMemo(() => jobs.filter((job) => (favorite === 'all' || (favorite === 'favorite' ? job.favorite : !job.favorite)) && (channel === 'all' || job.channel === channel) && (application === 'all' || (application === 'applied' ? appliedJobIds.has(job.id) : !appliedJobIds.has(job.id))) && (score === 'all' || GetScoreLabel(job.matchScore) === score)), [jobs, favorite, channel, application, appliedJobIds, score]);
  const appliedJobCount = appliedJobIds.size;
  const visibleJobs = useMemo(() => filtered.slice(0, visibleJobCount), [filtered, visibleJobCount]);
  const recentApplicationCounts = useMemo(() => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const counts = new Map<string, number>();
    for (const application of applications) {
      if (application.status === 'saved' || !application.appliedAt) continue;
      counts.set(application.appliedAt, (counts.get(application.appliedAt) ?? 0) + 1);
    }
    return Array.from({ length: 14 }, (_, index) => {
      const date = new Date(today);
      date.setDate(today.getDate() - 13 + index);
      const key = ToDateKey(date);
      return { key, label: `${date.getMonth() + 1}/${date.getDate()}`, count: counts.get(key) ?? 0 };
    });
  }, [applications]);
  const maximumDailyApplications = Math.max(1, ...recentApplicationCounts.map((item) => item.count));
  useEffect(() => { setVisibleJobCount(JobPageSize); }, [application, channel, favorite, score]);
  function OpenNew() { setEditingJob(null); setForm(BlankJob); setDrawerOpen(true); }
  function OpenEdit(job: Job) { setEditingJob(job); setForm(job); setDrawerOpen(true); }
  function SaveJob() {
    if (!form.company || !form.title || !form.city || !form.experience || !form.jd) { ShowNotice('请填写公司、岗位、城市、经验要求和完整 JD'); return; }
    if (editingJob) {
      upsertJob.mutate({ job: { ...form, id: editingJob.id, favorite: editingJob.favorite, matchScore: editingJob.matchScore }, expectedRevision: editingJob.revision });
    } else {
      upsertJob.mutate({ job: { ...form, id: CreateEntityId('job'), favorite: false } });
    }
    setDrawerOpen(false); ShowNotice(editingJob ? '岗位信息已更新' : '已新增岗位');
  }
  function ToggleFavorite(job: Job) { setJobFavorite.mutate({ id: job.id, favorite: !job.favorite, expectedRevision: job.revision }); }
  function HandleApplyJob(job: Job) { ShowNotice(appliedJobIds.has(job.id) ? '该岗位已有投递记录，请前往投递管理查看进度' : '请前往投递管理选择简历后创建投递记录'); }
  function ConfirmRemoveJob() { if (!deleteTarget) return; deleteJob.mutate({ id: deleteTarget.id }); setDeleteTarget(null); setDrawerOpen(false); ShowNotice('岗位已删除'); }
  function ResetFilters() { setFavorite('all'); setChannel('all'); setApplication('all'); setScore('all'); }
  function HandleJobListScroll(event: UIEvent<HTMLDivElement>) {
    const element = event.currentTarget;
    if (element.scrollTop + element.clientHeight < element.scrollHeight - 120) return;
    setVisibleJobCount((current) => Math.min(filtered.length, current + JobPageSize));
  }

  return <div className="standard-page jobs-page">
    <section className="paper-block jobs-summary-card" aria-label="近 14 天投递数量">
      <div className="jobs-chart-content"><p className="jobs-chart-title">近两周投递情况</p><div className="jobs-application-chart" role="list" aria-label="近十四天每日投递数量">{recentApplicationCounts.map((item) => <div key={item.key} className="jobs-chart-column" role="listitem"><div className="jobs-chart-bar-area" style={{ '--bar-height': `${item.count === 0 ? 2 : Math.max(8, (item.count / maximumDailyApplications) * 100)}%` } as CSSProperties}><span className="jobs-chart-tooltip">{item.count} 个投递</span><span className="jobs-chart-bar" /></div><time dateTime={item.key}>{item.label}</time></div>)}</div></div>
      <div className="jobs-filter-bar" aria-label="岗位筛选"><div className="jobs-filter-controls"><label><span>渠道</span><Select value={channel} ariaLabel="渠道" onChange={(value) => setChannel(value as Channel | 'all')} options={ChannelFilters.map((item) => ({ value: item, label: item === 'all' ? '全部渠道' : ChannelLabel[item] }))} /></label><label><span>投递情况</span><Select value={application} ariaLabel="投递情况" onChange={(value) => setApplication(value as ApplicationFilter)} options={[{ value: 'all', label: '全部' }, { value: 'not_applied', label: '未投递' }, { value: 'applied', label: '已投递' }]} /></label><label><span>匹配度</span><Select value={score} ariaLabel="匹配度" onChange={(value) => setScore(value as JobScore | 'all')} options={ScoreFilters.map((item) => ({ value: item, label: item === 'all' ? '全部' : JobScoreLabel[item] }))} /></label><label><span>收藏情况</span><Select value={favorite} ariaLabel="收藏情况" onChange={(value) => setFavorite(value as FavoriteFilter)} options={[{ value: 'all', label: '全部' }, { value: 'favorite', label: '已收藏' }, { value: 'not_favorite', label: '未收藏' }]} /></label></div><Button className="jobs-filter-reset" onClick={ResetFilters}>重置筛选</Button></div>
    </section>
    <section className="paper-block jobs-list-card" aria-label="岗位列表"><header><div className="jobs-list-summary"><p>当前显示 {filtered.length} 个岗位</p><p className="jobs-application-progress" aria-label={`已投递 ${appliedJobCount} 个岗位，共 ${jobs.length} 个岗位`}><span>已投递数量</span><b>{appliedJobCount}</b><small>/{jobs.length}</small></p></div><Button variant="primary" className="jobs-add-button" aria-label="新增岗位" title="新增岗位" onClick={OpenNew}><Icon name="plus" size={18} /></Button></header>{jobs.length === 0 ? <EmptyState icon={<Icon name="jobs" size={24} />} title="还没有保存的岗位" description="集中整理关注的机会，从新增一个岗位开始。" action={<Button variant="primary" onClick={OpenNew}><Icon name="plus" size={16} />新增岗位</Button>} /> : filtered.length === 0 ? <EmptyState icon={<Icon name="jobs" size={24} />} title="没有符合筛选条件的岗位" description="调整收藏、渠道或匹配度筛选后重试。" action={<Button onClick={ResetFilters}>重置筛选</Button>} /> : <div className="job-grid" onScroll={HandleJobListScroll}>{visibleJobs.map((job) => <article className="job-card" key={job.id}><p className="job-company">{job.company}</p><h3 className="job-title">{job.title}</h3><div className="job-meta"><span><Icon name="map-pin" size={14} />{job.city}</span><span>{job.salary || '薪资面议'}</span></div><div className="tag-row"><span>{job.experience}</span></div><div className={`job-score score-${GetScoreLabel(job.matchScore)}`} aria-label={`匹配分 ${job.matchScore ?? '未计算'}`}><span>匹配分</span><b>{job.matchScore ?? '—'}</b></div><div className="job-card-actions" aria-label="岗位操作"><button className="job-action-button" type="button" onClick={() => OpenEdit(job)} aria-label="编辑岗位" title="编辑岗位"><Icon name="edit" size={16} /></button><button className="job-action-button" type="button" onClick={() => HandleApplyJob(job)} aria-label="投递岗位" title="投递岗位"><Icon name="applications" size={16} /></button><button className={`favorite-button ${job.favorite ? 'on' : ''}`} type="button" onClick={() => ToggleFavorite(job)} aria-label={job.favorite ? '取消收藏' : '收藏岗位'} title={job.favorite ? '取消收藏' : '收藏岗位'}><Icon name="heart" size={18} /></button></div></article>)}{visibleJobs.length < filtered.length && <p className="job-list-more" role="status">继续向下滚动加载更多岗位</p>}</div>}</section>
    <Drawer open={drawerOpen} title={editingJob ? '编辑岗位信息' : '新增岗位'} onClose={() => setDrawerOpen(false)}><div className="drawer-form"><div className="form-two-col"><FormField label="公司 *"><input value={form.company} onChange={(event) => setForm({ ...form, company: event.target.value })} /></FormField><FormField label="岗位名称 *"><input value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })} /></FormField><FormField label="城市 *"><input value={form.city} onChange={(event) => setForm({ ...form, city: event.target.value })} /></FormField><FormField label="薪资"><input value={form.salary ?? ''} onChange={(event) => setForm({ ...form, salary: event.target.value })} /></FormField><FormField label="经验要求 *"><input value={form.experience} onChange={(event) => setForm({ ...form, experience: event.target.value })} /></FormField><FormField label="渠道"><Select value={form.channel} ariaLabel="渠道" onChange={(channel) => setForm({ ...form, channel: channel as Channel })} options={ChannelOptions.map((item) => ({ value: item, label: ChannelLabel[item] }))} /></FormField></div><FormField label="用工类型"><div className="segmented"><button className={form.employmentType === 'intern' ? 'selected' : ''} onClick={() => setForm({ ...form, employmentType: 'intern' })}>实习</button><button className={form.employmentType === 'full_time' ? 'selected' : ''} onClick={() => setForm({ ...form, employmentType: 'full_time' })}>正式工</button></div></FormField><FormField label="岗位链接"><input value={form.url ?? ''} onChange={(event) => setForm({ ...form, url: event.target.value })} placeholder="https://" /></FormField><FormField label="完整 JD *"><textarea value={form.jd} onChange={(event) => setForm({ ...form, jd: event.target.value })} rows={8} /></FormField>{editingJob && <Button variant="quiet" onClick={() => ToggleFavorite(editingJob)}>{editingJob.favorite ? '取消收藏' : '加入收藏'}</Button>}<div className="drawer-actions">{editingJob && <Button variant="danger" onClick={() => setDeleteTarget(editingJob)}>删除</Button>}<span /><Button onClick={() => setDrawerOpen(false)}>取消</Button><Button variant="primary" onClick={SaveJob}>保存岗位</Button></div></div></Drawer>
    <Modal open={Boolean(deleteTarget)} title="删除这份岗位？" onClose={() => setDeleteTarget(null)}><p className="modal-copy">删除后岗位将从岗位库移除，此操作不可撤销。</p><div className="modal-actions"><Button onClick={() => setDeleteTarget(null)}>取消</Button><Button variant="danger" onClick={ConfirmRemoveJob}>确认删除</Button></div></Modal>
  </div>;
}

export { JobsPage };
