import { useMemo, useState } from 'react';
import { useUiStore } from '../../../app/UiStore';
import { useApplications, useDeleteApplication, useMoveApplicationStatus, useUpsertApplication } from '../../../features/application/api/applicationQueries';
import { useJobs } from '../../../features/job/api/jobQueries';
import { useResumes } from '../../../features/resume/api/resumeQueries';
import { CreateEntityId } from '../../workspace/api/workspaceData';
import { Button, Drawer, FormField, Modal, PageHeader } from '../../../shared/components/UI';
import { Icon } from '../../../shared/components/Icon';
import { ApplicationStatusLabel, EmploymentTypeLabel } from '../../../shared/utils/format';
import type { Application, ApplicationStatus } from '../../../types/domain';

const Statuses: ApplicationStatus[] = ['saved', 'applied', 'written_test', 'interviewing', 'ended'];
const TimelineStatuses = Statuses.filter((status) => status !== 'ended');

function ApplicationsPage() {
  const { ShowNotice } = useUiStore();
  const applications = useApplications();
  const jobs = useJobs();
  const resumes = useResumes();
  const upsertApplication = useUpsertApplication({ onConflict: () => ShowNotice('投递已在其他窗口被修改，已刷新为最新版本'), onFailure: () => ShowNotice('投递保存失败，请稍后重试。') });
  const moveApplicationStatus = useMoveApplicationStatus({ onConflict: () => ShowNotice('投递已在其他窗口被修改，已刷新为最新版本'), onFailure: () => ShowNotice('投递阶段更新失败，请稍后重试。') });
  const deleteApplication = useDeleteApplication({ onFailure: () => ShowNotice('投递删除失败，请稍后重试。') });
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [editing, setEditing] = useState<Application | null>(null);
  const [form, setForm] = useState<Partial<Application>>({ status: 'saved', note: '' });
  const [deleteTarget, setDeleteTarget] = useState<Application | null>(null);
  const jobsById = useMemo(() => Object.fromEntries(jobs.map((job) => [job.id, job])), [jobs]);
  function OpenNew() { setEditing(null); setForm({ jobId: jobs[0]?.id, resumeId: resumes[0]?.id, status: 'saved', note: '' }); setDrawerOpen(true); }
  function OpenEdit(application: Application) { setEditing(application); setForm(application); setDrawerOpen(true); }
  function SaveApplication() {
    if (!form.jobId || !form.resumeId || !form.status) return;
    const jobId = form.jobId; const resumeId = form.resumeId; const status = form.status;
    if (editing) {
      upsertApplication.mutate({ application: { ...editing, ...form } as Application, expectedRevision: editing.revision });
    } else {
      upsertApplication.mutate({ application: { id: CreateEntityId('application'), jobId, resumeId, status, note: form.note ?? '', appliedAt: form.appliedAt, nextStepAt: form.nextStepAt } as Application });
    }
    setDrawerOpen(false); ShowNotice(editing ? '投递记录已更新' : '已从岗位库新增投递记录');
  }
  function MoveStatus(application: Application, status: ApplicationStatus) { moveApplicationStatus.mutate({ id: application.id, status, expectedRevision: application.revision }); ShowNotice(`已推进至${ApplicationStatusLabel[status]}`); }
  function ConfirmDeleteApplication() { if (!deleteTarget) return; deleteApplication.mutate({ id: deleteTarget.id }); setDeleteTarget(null); setDrawerOpen(false); ShowNotice('投递记录已删除'); }
  return <div className="standard-page"><PageHeader title="投递管理" description="用看板跟进每个机会的下一步，并在本地工作空间中保存。" actions={<Button variant="primary" onClick={OpenNew}><Icon name="plus" size={16} />新增投递</Button>} />
    <div className="application-timeline" aria-label="投递进度时间线">{TimelineStatuses.map((status, index) => {
      const cards = applications.filter((item) => item.status === status);
        return <section className="timeline-stage" key={status}><div className="timeline-stage-rail" aria-hidden="true"><span className="timeline-stage-dot">{index + 1}</span></div><div className="timeline-stage-content"><header className="timeline-stage-header"><h2>{ApplicationStatusLabel[status]}</h2><span>{cards.length}</span></header><div className="timeline-stage-cards">{cards.map((application) => {
          const job = jobsById[application.jobId];
          const currentIndex = TimelineStatuses.indexOf(status); const nextStatus = TimelineStatuses[currentIndex + 1];
        return <article className="application-card" key={application.id} onClick={() => OpenEdit(application)}><button className="application-delete-button" type="button" aria-label={`删除${job?.company ?? '投递'}的记录`} onClick={(event) => { event.stopPropagation(); setDeleteTarget(application); }}><Icon name="close" size={12} /></button><p>{job?.company ?? '已删除岗位'}</p><h3>{job?.title ?? '未知岗位'}</h3><small>{job ? <><Icon name="map-pin" size={12} />{job.city} · {EmploymentTypeLabel[job.employmentType]}</> : ''}</small>{application.nextStepAt && <div className="deadline"><b>下一步</b>{application.nextStepAt.slice(5)}</div>}<footer>{nextStatus && <button type="button" onClick={(event) => { event.stopPropagation(); MoveStatus(application, nextStatus); }}>推进至{ApplicationStatusLabel[nextStatus]}<Icon name="arrow-right" size={16} /></button>}</footer></article>;
      })}{cards.length === 0 && <div className="timeline-stage-empty">暂无记录</div>}</div></div></section>;
    })}</div>
    <Drawer open={drawerOpen} title={editing ? '编辑投递记录' : '新增投递记录'} onClose={() => setDrawerOpen(false)}><div className="drawer-form"><FormField label="选择岗位"><select value={form.jobId} onChange={(event) => setForm({ ...form, jobId: event.target.value })}>{jobs.map((job) => <option key={job.id} value={job.id}>{job.company} · {job.title}</option>)}</select></FormField><FormField label="使用简历"><select value={form.resumeId} onChange={(event) => setForm({ ...form, resumeId: event.target.value })}>{resumes.map((resume) => <option key={resume.id} value={resume.id}>{resume.name}</option>)}</select></FormField><FormField label="当前阶段"><select value={form.status} onChange={(event) => setForm({ ...form, status: event.target.value as ApplicationStatus })}>{Statuses.map((status) => <option key={status} value={status}>{ApplicationStatusLabel[status]}</option>)}</select></FormField><div className="form-two-col"><FormField label="投递日期"><input type="date" value={form.appliedAt ?? ''} onChange={(event) => setForm({ ...form, appliedAt: event.target.value })} /></FormField><FormField label="下一步日期"><input type="date" value={form.nextStepAt ?? ''} onChange={(event) => setForm({ ...form, nextStepAt: event.target.value })} /></FormField></div><FormField label="备注"><textarea rows={5} value={form.note ?? ''} onChange={(event) => setForm({ ...form, note: event.target.value })} /></FormField><div className="drawer-actions">{editing && <Button variant="danger" onClick={() => setDeleteTarget(editing)}>删除</Button>}<span /><Button onClick={() => setDrawerOpen(false)}>取消</Button><Button variant="primary" onClick={SaveApplication}>保存记录</Button></div></div></Drawer>
    <Modal open={Boolean(deleteTarget)} title="删除这条投递记录？" onClose={() => setDeleteTarget(null)}><p className="modal-copy">删除后投递记录及其进度事件将被移除，此操作不可撤销。</p><div className="modal-actions"><Button onClick={() => setDeleteTarget(null)}>取消</Button><Button variant="danger" onClick={ConfirmDeleteApplication}>确认删除</Button></div></Modal>
  </div>;
}

export { ApplicationsPage };
