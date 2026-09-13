import { useState } from 'react';
import { CreateResumeDocumentMarkup } from '@avery/contracts';
import { useUiStore } from '../../../app/UiStore';
import { useDeleteResume, useDeleteResumeRevision, useRenameResume, useResumes, useRestoreResumeRevision, LoadResumeRevision, LoadResumeRevisions, ExportResumeFile } from '../../../features/resume/api/resumeQueries';
import { AcquireResumeEditLock, ReleaseResumeEditLock } from '../../assistant/api/agentQueries';
import { Button, Drawer, EmptyState, FormField, Modal } from '../../../shared/components/UI';
import { Icon } from '../../../shared/components/Icon';
import { FormatTime } from '../../../shared/utils/format';
import type { Resume } from '../../../types/domain';

interface ResumeRevisionRow {
  id: string;
  revision: number;
  source: string;
  createdAt: number;
  isCurrent: boolean;
}

interface ResumeRevisionPreview extends ResumeRevisionRow {
  document: Resume;
}

function ResumesPage({ onGoAssistant }: { onGoAssistant: () => void }) {
  const { ShowNotice, currentResumeId, setCurrentResumeId } = useUiStore();
  const resumes = useResumes();
  const renameResume = useRenameResume({ onConflict: () => ShowNotice('简历已在其他窗口被修改，已刷新为最新版本'), onFailure: () => ShowNotice('简历重命名失败，请稍后重试。') });
  const deleteResume = useDeleteResume({ onFailure: () => ShowNotice('简历删除失败，请稍后重试。') });
  const restoreResumeRevision = useRestoreResumeRevision({ onConflict: () => ShowNotice('简历已被其他操作修改，已刷新为最新版本'), onFailure: () => ShowNotice('还原简历版本失败，请稍后重试。') });
  const deleteResumeRevision = useDeleteResumeRevision({ onFailure: () => ShowNotice('删除历史版本失败，请稍后重试。') });
  const [editing, setEditing] = useState<Resume | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Resume | null>(null);
  const [rename, setRename] = useState('');
  const [revisions, setRevisions] = useState<ResumeRevisionRow[]>([]);
  const [revisionPreview, setRevisionPreview] = useState<ResumeRevisionPreview | null>(null);
  const [restoreTarget, setRestoreTarget] = useState<ResumeRevisionRow | null>(null);
  const [deleteRevisionTarget, setDeleteRevisionTarget] = useState<ResumeRevisionRow | null>(null);
  async function RefreshRevisions(resumeId: string) {
    try { setRevisions((await LoadResumeRevisions(resumeId)) as ResumeRevisionRow[]); } catch { setRevisions([]); }
  }
  async function OpenResume(resume: Resume) {
    setEditing(resume); setRename(resume.name); setRevisionPreview(null); setDrawerOpen(true);
    await RefreshRevisions(resume.id);
  }
  async function PreviewRevision(revision: ResumeRevisionRow) {
    if (!editing) return;
    try { setRevisionPreview(await LoadResumeRevision(editing.id, revision.id) as ResumeRevisionPreview); }
    catch (error) { ShowNotice(error instanceof Error ? error.message : '读取历史版本失败'); }
  }
  async function ConfirmRestoreRevision() {
    if (!editing || !restoreTarget) return;
    const lock = await AcquireResumeEditLock(editing.id);
    if (!lock.acquired) { ShowNotice(lock.reason ?? '简历正被占用，暂时无法还原'); return; }
    try {
      const result = await restoreResumeRevision.mutateAsync({ resumeId: editing.id, revisionId: restoreTarget.id, expectedRevision: editing.revision });
      setEditing(result.resume); setRename(result.resume.name); setRevisionPreview(null); setRestoreTarget(null);
      await RefreshRevisions(result.id);
      ShowNotice(`已从 v${result.restoredFromRevision} 创建当前 v${result.revision}`);
    } catch {
      // Mutation 已按冲突和普通失败给出提示；锁仍必须在 finally 中释放。
    } finally { await ReleaseResumeEditLock(editing.id); }
  }
  async function ConfirmDeleteRevision() {
    if (!editing || !deleteRevisionTarget) return;
    try {
      await deleteResumeRevision.mutateAsync({ resumeId: editing.id, revisionId: deleteRevisionTarget.id });
      if (revisionPreview?.id === deleteRevisionTarget.id) setRevisionPreview(null);
      setDeleteRevisionTarget(null);
      await RefreshRevisions(editing.id);
      ShowNotice('历史版本已删除');
    } catch {
      // Mutation 已给出失败提示。
    }
  }
  function SaveRename() {
    if (!editing || !rename.trim()) return;
    const expectedRevision = resumes.find((item) => item.id === editing.id)?.revision;
    renameResume.mutate({ id: editing.id, name: rename.trim(), expectedRevision });
    setEditing((current) => current ? { ...current, name: rename.trim() } : null);
    ShowNotice('简历名称已保存');
  }
  async function ExportResume(format: 'html' | 'pdf' | 'docx' | 'png') {
    if (!editing) return;
    try {
      const result = await ExportResumeFile(editing, format);
      ShowNotice(`已导出 ${result.fileName} 到工作空间 exports 文件夹`);
    } catch (error) { ShowNotice(error instanceof Error ? error.message : '简历导出失败'); }
  }
  function ConfirmDeleteResume() { if (!deleteTarget) return; deleteResume.mutate({ id: deleteTarget.id }); setDeleteTarget(null); setDrawerOpen(false); ShowNotice('简历已删除'); }
  const currentResume = resumes.find((resume) => resume.id === currentResumeId);
  return <div className="standard-page resumes-page"><section className="resumes-reference-overview"><header className="resumes-reference-heading"><div><h1>简历库</h1><p>保留每一份针对目标岗位定制的简历版本。</p></div><div className="resumes-reference-stats" aria-label="简历数据概览"><span><b>{resumes.length}</b><small>全部简历</small></span><span><b>{currentResume ? 1 : 0}</b><small>当前使用</small></span></div><Button variant="primary" onClick={onGoAssistant}><Icon name="assistant" size={16} />让 Agent 起草</Button></header></section><section className="paper-block resumes-content-card"><header className="content-card-heading"><div><h2>简历版本</h2><p>{currentResume ? `当前使用：${currentResume.name}` : '选择一份简历作为当前版本。'}</p></div></header>
    {resumes.length === 0 ? <EmptyState icon={<Icon name="resumes" size={24} />} title="还没有保存的简历" description="从求职助手开始，整理一份可继续编辑的简历。" action={<Button variant="primary" onClick={onGoAssistant}><Icon name="assistant" size={16} />让 Agent 起草</Button>} /> : <section className="resume-grid">{resumes.map((resume) => <article className={`resume-card ${resume.id === currentResumeId ? 'current' : ''}`} key={resume.id} onClick={() => OpenResume(resume)}><div className="resume-card-paper"><div className="resume-card-top"><Icon name="resumes" size={20} />{resume.id === currentResumeId && <small>当前使用</small>}</div><h2>{resume.name}</h2><p>{resume.summary}</p><div>{resume.targetRoles.slice(0, 3).map((role) => <span key={role}>{role}</span>)}</div></div><footer><span>更新于 {FormatTime(resume.updatedAt)}</span>{resume.id === currentResumeId ? <span className="resume-current-note">正在用于助手</span> : <button type="button" onClick={(event) => { event.stopPropagation(); setCurrentResumeId(resume.id); ShowNotice('已设为当前简历'); }}>设为当前</button>}</footer></article>)}</section>}
  </section>
    <Drawer open={drawerOpen} title="简历详情" onClose={() => { setDrawerOpen(false); setRevisionPreview(null); }}>{editing && <div className="drawer-form"><FormField label="简历名称"><input disabled={Boolean(revisionPreview)} value={rename} onChange={(event) => setRename(event.target.value)} /></FormField><Button disabled={Boolean(revisionPreview)} onClick={SaveRename}>保存名称</Button>{revisionPreview && <p className="resume-current-note">正在查看 v{revisionPreview.revision}（只读历史版本）</p>}<div className="resume-detail-preview"><div className="resume-html-preview" dangerouslySetInnerHTML={{ __html: CreateResumeDocumentMarkup(revisionPreview?.document ?? editing) }} /></div><section className="resume-version-list"><header><b>版本历史</b><small>保留当前版本和最近两份历史版本；历史版本仅可查看、还原或删除。</small></header>{revisions.length ? revisions.map((revision) => <div key={revision.id}><span>v{revision.revision} · {revision.isCurrent ? '当前版本' : revision.source} · {FormatTime(revision.createdAt)}</span><div><Button variant="quiet" onClick={() => void PreviewRevision(revision)}>查看</Button>{!revision.isCurrent && <><Button variant="quiet" onClick={() => setRestoreTarget(revision)}>还原</Button><Button variant="danger" onClick={() => setDeleteRevisionTarget(revision)}>删除</Button></>}</div></div>) : <p>暂无可管理的历史版本。</p>}</section><div className="export-box"><span>导出文件</span><div><Button onClick={() => void ExportResume('html')}>HTML</Button><Button variant="primary" onClick={() => void ExportResume('pdf')}>PDF</Button></div></div><div className="drawer-actions"><Button variant="danger" onClick={() => setDeleteTarget(editing)}>删除简历</Button><span /><Button variant="primary" onClick={() => { setCurrentResumeId(editing.id); ShowNotice('已设为当前简历'); }}>设为当前</Button></div></div>}</Drawer>
    <Modal open={Boolean(deleteTarget)} title="删除这份简历？" onClose={() => setDeleteTarget(null)}><p className="modal-copy">删除后无法恢复，也不会保留导出文件。</p><div className="modal-actions"><Button onClick={() => setDeleteTarget(null)}>取消</Button><Button variant="danger" onClick={ConfirmDeleteResume}>确认删除</Button></div></Modal>
    <Modal open={Boolean(restoreTarget)} title="还原历史版本？" onClose={() => setRestoreTarget(null)}><p className="modal-copy">将从 v{restoreTarget?.revision} 创建新的当前版本；不会降低版本号。</p><div className="modal-actions"><Button onClick={() => setRestoreTarget(null)}>取消</Button><Button variant="primary" onClick={() => void ConfirmRestoreRevision()}>确认还原</Button></div></Modal>
    <Modal open={Boolean(deleteRevisionTarget)} title="删除历史版本？" onClose={() => setDeleteRevisionTarget(null)}><p className="modal-copy">将永久删除 v{deleteRevisionTarget?.revision}，无法恢复。</p><div className="modal-actions"><Button onClick={() => setDeleteRevisionTarget(null)}>取消</Button><Button variant="danger" onClick={() => void ConfirmDeleteRevision()}>确认删除</Button></div></Modal>
  </div>;
}

export { ResumesPage };
