import { useMemo, useState } from 'react';
import { useUiStore } from '../../../app/UiStore';
import { useDeleteJob, useJobs, useSetJobFavorite, useUpsertJob } from '../../../features/job/api/jobQueries';
import { CreateEntityId } from '../../workspace/api/workspaceData';
import { Button, Drawer, EmptyState, FormField, Modal, PageHeader } from '../../../shared/components/UI';
import { Icon } from '../../../shared/components/Icon';
import { ChannelLabel, EmploymentTypeLabel, GetScoreLabel, JobScoreLabel } from '../../../shared/utils/format';
import type { Channel, Job, JobScore } from '../../../types/domain';

const BlankJob: Omit<Job, 'id' | 'favorite'> = { company: '', title: '', city: '', salary: '', experience: '', employmentType: 'full_time', channel: 'boss_zhipin', jd: '' };
const ChannelOptions: Channel[] = ['boss_zhipin', 'company_website', 'other'];
const ChannelFilters: Array<Channel | 'all'> = ['all', ...ChannelOptions];
const ScoreFilters: Array<JobScore | 'all'> = ['all', 'poor', 'good', 'excellent'];

function JobsPage() {
  const { ShowNotice } = useUiStore();
  const jobs = useJobs();
  const upsertJob = useUpsertJob({ onConflict: () => ShowNotice('岗位已在其他窗口被修改，已刷新为最新版本'), onFailure: () => ShowNotice('岗位保存失败，请稍后重试。') });
  const setJobFavorite = useSetJobFavorite({ onConflict: () => ShowNotice('岗位已在其他窗口被修改，已刷新为最新版本'), onFailure: () => ShowNotice('岗位收藏更新失败，请稍后重试。') });
  const deleteJob = useDeleteJob({ onFailure: () => ShowNotice('岗位删除失败，请稍后重试。') });
  const [favoriteOnly, setFavoriteOnly] = useState(false);
  const [channel, setChannel] = useState<Channel | 'all'>('all');
  const [score, setScore] = useState<JobScore | 'all'>('all');
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [editingJob, setEditingJob] = useState<Job | null>(null);
  const [form, setForm] = useState<Omit<Job, 'id' | 'favorite'>>(BlankJob);
  const [deleteTarget, setDeleteTarget] = useState<Job | null>(null);

  const filtered = useMemo(() => jobs.filter((job) => (!favoriteOnly || job.favorite) && (channel === 'all' || job.channel === channel) && (score === 'all' || GetScoreLabel(job.matchScore) === score)), [jobs, favoriteOnly, channel, score]);
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
  function ConfirmRemoveJob() { if (!deleteTarget) return; deleteJob.mutate({ id: deleteTarget.id }); setDeleteTarget(null); setDrawerOpen(false); ShowNotice('岗位已删除'); }
  function ResetFilters() { setFavoriteOnly(false); setChannel('all'); setScore('all'); }

  return <div className="standard-page"><PageHeader title="岗位库" description="集中整理关注的机会，并在本地工作空间中保存。" actions={<Button variant="primary" onClick={OpenNew}><Icon name="plus" size={16} />新增岗位</Button>} />
    <section className="paper-block job-filter" aria-label="岗位筛选"><div className="filter-group"><span>范围</span><button className={favoriteOnly ? 'selected' : ''} onClick={() => setFavoriteOnly((value) => !value)}><Icon name="heart" size={15} />收藏</button>{ChannelFilters.map((item) => <button key={item} className={channel === item ? 'selected' : ''} onClick={() => setChannel(item)}>{item === 'all' ? '全部渠道' : ChannelLabel[item]}</button>)}</div><div className="filter-group"><span>匹配度</span>{ScoreFilters.map((item) => <button key={item} className={score === item ? 'selected' : ''} onClick={() => setScore(item)}>{item === 'all' ? '全部' : JobScoreLabel[item]}</button>)}</div></section>
    <div className="result-note">共找到 {filtered.length} 个岗位 <span>· 匹配分由后续 Agent 能力计算</span></div>
    {jobs.length === 0 ? <EmptyState icon={<Icon name="jobs" size={24} />} title="还没有保存的岗位" description="集中整理关注的机会，从新增一个岗位开始。" action={<Button variant="primary" onClick={OpenNew}><Icon name="plus" size={16} />新增岗位</Button>} /> : filtered.length === 0 ? <EmptyState icon={<Icon name="jobs" size={24} />} title="没有符合筛选条件的岗位" description="调整收藏、渠道或匹配度筛选后重试。" action={<Button onClick={ResetFilters}>重置筛选</Button>} /> : <section className="job-grid">{filtered.map((job) => <article className="job-card" key={job.id} onClick={() => OpenEdit(job)}><button className={`favorite-button ${job.favorite ? 'on' : ''}`} type="button" onClick={(event) => { event.stopPropagation(); ToggleFavorite(job); }} aria-label={job.favorite ? '取消收藏' : '收藏岗位'} title={job.favorite ? '取消收藏' : '收藏岗位'}><Icon name="heart" size={18} /></button><div className={`job-score score-${GetScoreLabel(job.matchScore)}`}><b>{job.matchScore ?? '—'}</b><span>{JobScoreLabel[GetScoreLabel(job.matchScore)]}</span></div><p className="card-kicker">{job.company}</p><h2>{job.title}</h2><div className="job-meta"><span><Icon name="map-pin" size={14} />{job.city}</span><span>{job.salary || '薪资面议'}</span></div><div className="tag-row"><span>{job.experience}</span><span>{EmploymentTypeLabel[job.employmentType]}</span></div><p className="job-jd">{job.jd}</p></article>)}</section>}
    <Drawer open={drawerOpen} title={editingJob ? '编辑岗位信息' : '新增岗位'} onClose={() => setDrawerOpen(false)}><div className="drawer-form"><div className="form-two-col"><FormField label="公司 *"><input value={form.company} onChange={(event) => setForm({ ...form, company: event.target.value })} /></FormField><FormField label="岗位名称 *"><input value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })} /></FormField><FormField label="城市 *"><input value={form.city} onChange={(event) => setForm({ ...form, city: event.target.value })} /></FormField><FormField label="薪资"><input value={form.salary ?? ''} onChange={(event) => setForm({ ...form, salary: event.target.value })} /></FormField><FormField label="经验要求 *"><input value={form.experience} onChange={(event) => setForm({ ...form, experience: event.target.value })} /></FormField><FormField label="渠道"><select value={form.channel} onChange={(event) => setForm({ ...form, channel: event.target.value as Channel })}>{ChannelOptions.map((item) => <option key={item} value={item}>{ChannelLabel[item]}</option>)}</select></FormField></div><FormField label="用工类型"><div className="segmented"><button className={form.employmentType === 'intern' ? 'selected' : ''} onClick={() => setForm({ ...form, employmentType: 'intern' })}>实习</button><button className={form.employmentType === 'full_time' ? 'selected' : ''} onClick={() => setForm({ ...form, employmentType: 'full_time' })}>正式工</button></div></FormField><FormField label="岗位链接"><input value={form.url ?? ''} onChange={(event) => setForm({ ...form, url: event.target.value })} placeholder="https://" /></FormField><FormField label="完整 JD *"><textarea value={form.jd} onChange={(event) => setForm({ ...form, jd: event.target.value })} rows={8} /></FormField>{editingJob && <Button variant="quiet" onClick={() => ToggleFavorite(editingJob)}>{editingJob.favorite ? '取消收藏' : '加入收藏'}</Button>}<div className="drawer-actions">{editingJob && <Button variant="danger" onClick={() => setDeleteTarget(editingJob)}>删除</Button>}<span /><Button onClick={() => setDrawerOpen(false)}>取消</Button><Button variant="primary" onClick={SaveJob}>保存岗位</Button></div></div></Drawer>
    <Modal open={Boolean(deleteTarget)} title="删除这份岗位？" onClose={() => setDeleteTarget(null)}><p className="modal-copy">删除后岗位将从岗位库移除，此操作不可撤销。</p><div className="modal-actions"><Button onClick={() => setDeleteTarget(null)}>取消</Button><Button variant="danger" onClick={ConfirmRemoveJob}>确认删除</Button></div></Modal>
  </div>;
}

export { JobsPage };
