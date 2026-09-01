import { useMemo, useState } from 'react';
import { useUiStore } from '../../../app/UiStore';
import { useApplications, useDeleteApplication, useUpsertApplication } from '../../../features/application/api/applicationQueries';
import { useJobs } from '../../../features/job/api/jobQueries';
import { useResumes } from '../../../features/resume/api/resumeQueries';
import { CreateEntityId } from '../../workspace/api/workspaceData';
import { Button, Drawer, FormField, Modal, Select } from '../../../shared/components/UI';
import { Icon } from '../../../shared/components/Icon';
import { ApplicationStatusLabel } from '../../../shared/utils/format';
import type { Application, ApplicationStatus } from '../../../types/domain';

const Statuses: ApplicationStatus[] = ['saved', 'applied', 'written_test', 'interviewing', 'ended'];
const FilterOptions: Array<{ value: 'all' | ApplicationStatus; label: string }> = [{ value: 'all', label: '全部' }, ...Statuses.map((status) => ({ value: status, label: ApplicationStatusLabel[status] }))];
const BoardColumns: Array<{ id: string; label: string; statuses: ApplicationStatus[] }> = [
  { id: 'saved', label: '待投递', statuses: ['saved'] },
  { id: 'applied', label: '已投递', statuses: ['applied'] },
  { id: 'in-progress', label: '测评与面试', statuses: ['written_test', 'interviewing'] },
  { id: 'ended', label: '已结束', statuses: ['ended'] },
];

function FormatDate(value?: string): string {
  if (!value) return '未设置';
  const [, month, day] = value.split('-');
  return month && day ? `${month}-${day}` : value;
}

function ApplicationsPage() {
  const { ShowNotice } = useUiStore();
  const applications = useApplications();
  const jobs = useJobs();
  const resumes = useResumes();
  const upsertApplication = useUpsertApplication({ onConflict: () => ShowNotice('投递已在其他窗口被修改，已刷新为最新版本'), onFailure: () => ShowNotice('投递保存失败，请稍后重试。') });
  const deleteApplication = useDeleteApplication({ onFailure: () => ShowNotice('投递删除失败，请稍后重试。') });
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [editing, setEditing] = useState<Application | null>(null);
  const [form, setForm] = useState<Partial<Application>>({ status: 'saved', note: '' });
  const [deleteTarget, setDeleteTarget] = useState<Application | null>(null);
  const [filter, setFilter] = useState<'all' | ApplicationStatus>('all');
  const [query, setQuery] = useState('');
  const jobsById = useMemo(() => Object.fromEntries(jobs.map((job) => [job.id, job])), [jobs]);
  const filteredApplications = useMemo(() => {
    const keyword = query.trim().toLocaleLowerCase();
    return applications.filter((application) => {
      const job = jobsById[application.jobId];
      const matchesFilter = filter === 'all' || application.status === filter;
      const searchable = `${job?.company ?? ''} ${job?.title ?? ''} ${job?.city ?? ''}`.toLocaleLowerCase();
      return matchesFilter && (!keyword || searchable.includes(keyword));
    }).sort((left, right) => (right.nextStepAt ?? right.appliedAt ?? '').localeCompare(left.nextStepAt ?? left.appliedAt ?? ''));
  }, [applications, filter, jobsById, query]);
  const activeCount = applications.filter((application) => application.status !== 'ended' && application.status !== 'saved').length;
  const followUpCount = applications.filter((application) => Boolean(application.nextStepAt) && application.status !== 'ended').length;
  const interviewCount = applications.filter((application) => application.status === 'interviewing').length;

  function OpenNew() { setEditing(null); setForm({ jobId: jobs[0]?.id, resumeId: resumes[0]?.id, status: 'saved', note: '' }); setDrawerOpen(true); }
  function OpenEdit(application: Application) { setEditing(application); setForm(application); setDrawerOpen(true); }
  function SaveApplication() {
    if (!form.jobId || !form.resumeId || !form.status) return;
    const jobId = form.jobId; const resumeId = form.resumeId; const status = form.status;
    if (editing) upsertApplication.mutate({ application: { ...editing, ...form } as Application, expectedRevision: editing.revision });
    else upsertApplication.mutate({ application: { id: CreateEntityId('application'), jobId, resumeId, status, note: form.note ?? '', appliedAt: form.appliedAt, nextStepAt: form.nextStepAt } as Application });
    setDrawerOpen(false); ShowNotice(editing ? '投递记录已更新' : '已新增投递记录');
  }
  function ConfirmDeleteApplication() { if (!deleteTarget) return; deleteApplication.mutate({ id: deleteTarget.id }); setDeleteTarget(null); setDrawerOpen(false); ShowNotice('投递记录已删除'); }

  return <div className="standard-page applications-page">
    <section className="applications-reference-overview">
      <header className="applications-reference-heading"><div><h1>投递管理</h1><p>集中追踪每个机会的状态变化与下一步安排。</p></div><div className="applications-stats" aria-label="投递数据概览"><span><b>{applications.length}</b><small>全部投递</small></span><span><b>{activeCount}</b><small>进行中</small></span><span><b>{followUpCount}</b><small>待跟进</small></span><span><b>{interviewCount}</b><small>面试中</small></span></div></header>
      <div className="applications-reference-toolbar"><div className="application-filter-tags" role="group" aria-label="投递状态筛选">{FilterOptions.map((option) => <button key={option.value} type="button" className={filter === option.value ? 'selected' : ''} onClick={() => setFilter(option.value)}>{option.label} <b>{option.value === 'all' ? applications.length : applications.filter((application) => application.status === option.value).length}</b></button>)}</div><div className="applications-toolbar-actions"><label className="applications-search"><Icon name="search" size={16} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索企业、岗位或城市" aria-label="搜索投递记录" /></label><Button variant="primary" onClick={OpenNew}><Icon name="plus" size={16} />添加投递</Button></div></div>
    </section>
    <section className="applications-board" aria-label="按阶段管理投递">{BoardColumns.map((column) => {
      const columnApplications = filteredApplications.filter((application) => column.statuses.includes(application.status));
      return <section className="applications-board-column" key={column.id} aria-label={column.label}><header><h2>{column.label}</h2><b>{columnApplications.length}</b><button type="button" aria-label={`新增${column.label}投递`} title="新增投递" onClick={OpenNew}><Icon name="plus" size={14} /></button></header><div className="applications-board-list">{columnApplications.length ? columnApplications.map((application) => {
        const job = jobsById[application.jobId];
        return <button key={application.id} type="button" className="application-board-card" onClick={() => OpenEdit(application)}><span className="application-company-mark">{job?.company.slice(0, 1) ?? '职'}</span><span className="application-board-copy"><b>{job?.title ?? '已删除岗位'}</b><small>{job ? `${job.company} · ${job.city}` : '对应岗位已删除'}</small><span className="application-board-tags">{typeof job?.matchScore === 'number' && <i>匹配 {job.matchScore}%</i>}{job?.salary && <i>{job.salary}</i>}</span>{application.nextStepAt && <em>{application.status === 'interviewing' ? '下一轮' : '下一步'} {FormatDate(application.nextStepAt)}</em>}<span className="application-board-footer"><small>{application.appliedAt ? `投递于 ${FormatDate(application.appliedAt)}` : '尚未投递'}</small><b>{ApplicationStatusLabel[application.status]}</b></span></span></button>;
      }) : <p className="applications-board-empty">暂无记录</p>}</div></section>;
    })}</section>
    <Drawer open={drawerOpen} title={editing ? '编辑投递记录' : '新增投递记录'} onClose={() => setDrawerOpen(false)}><div className="drawer-form"><FormField label="选择岗位"><Select value={form.jobId ?? ''} ariaLabel="选择岗位" onChange={(jobId) => setForm({ ...form, jobId })} options={jobs.map((job) => ({ value: job.id, label: `${job.company} · ${job.title}` }))} /></FormField><FormField label="使用简历"><Select value={form.resumeId ?? ''} ariaLabel="使用简历" onChange={(resumeId) => setForm({ ...form, resumeId })} options={resumes.map((resume) => ({ value: resume.id, label: resume.name }))} /></FormField><FormField label="当前阶段"><Select value={form.status ?? 'saved'} ariaLabel="当前阶段" onChange={(status) => setForm({ ...form, status: status as ApplicationStatus })} options={Statuses.map((status) => ({ value: status, label: ApplicationStatusLabel[status] }))} /></FormField><div className="form-two-col"><FormField label="投递日期"><input type="date" value={form.appliedAt ?? ''} onChange={(event) => setForm({ ...form, appliedAt: event.target.value })} /></FormField><FormField label="下一步日期"><input type="date" value={form.nextStepAt ?? ''} onChange={(event) => setForm({ ...form, nextStepAt: event.target.value })} /></FormField></div><FormField label="备注"><textarea rows={5} value={form.note ?? ''} onChange={(event) => setForm({ ...form, note: event.target.value })} /></FormField><div className="drawer-actions">{editing && <Button variant="danger" onClick={() => setDeleteTarget(editing)}>删除</Button>}<span /><Button onClick={() => setDrawerOpen(false)}>取消</Button><Button variant="primary" onClick={SaveApplication}>保存记录</Button></div></div></Drawer>
    <Modal open={Boolean(deleteTarget)} title="删除这条投递记录？" onClose={() => setDeleteTarget(null)}><p className="modal-copy">删除后投递记录及其进度事件将被移除，此操作不可撤销。</p><div className="modal-actions"><Button onClick={() => setDeleteTarget(null)}>取消</Button><Button variant="danger" onClick={ConfirmDeleteApplication}>确认删除</Button></div></Modal>
  </div>;
}

export { ApplicationsPage };
