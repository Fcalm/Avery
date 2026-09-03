import { useState } from 'react';
import { CreateResumeDocumentMarkup } from '@avery/contracts';
import { useUiStore } from '../../../app/UiStore';
import { useDeleteResume, useRenameResume, useResumes, LoadResumeRevisions, SetResumeRevisionPinned, ExportResumeFile } from '../../../features/resume/api/resumeQueries';
import { Button, Drawer, EmptyState, FormField, Modal } from '../../../shared/components/UI';
import { Icon } from '../../../shared/components/Icon';
import { FormatTime } from '../../../shared/utils/format';
import type { Resume } from '../../../types/domain';

interface ResumeRevisionRow {
  id: string;
  revision: number;
  source: string;
  isPinned: boolean;
  isProtected: boolean;
  createdAt: number;
}

function ResumesPage({ onGoAssistant }: { onGoAssistant: () => void }) {
  const { ShowNotice, currentResumeId, setCurrentResumeId } = useUiStore();
  const resumes = useResumes();
  const renameResume = useRenameResume({ onConflict: () => ShowNotice('简历已在其他窗口被修改，已刷新为最新版本'), onFailure: () => ShowNotice('简历重命名失败，请稍后重试。') });
  const deleteResume = useDeleteResume({ onFailure: () => ShowNotice('简历删除失败，请稍后重试。') });
  const [editing, setEditing] = useState<Resume | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Resume | null>(null);
  const [rename, setRename] = useState('');
  const [revisions, setRevisions] = useState<ResumeRevisionRow[]>([]);
  async function OpenResume(resume: Resume) {
    setEditing(resume); setRename(resume.name); setDrawerOpen(true);
    try { setRevisions((await LoadResumeRevisions(resume.id)) as ResumeRevisionRow[]); } catch { setRevisions([]); }
  }
  async function ToggleRevisionPinned(revisionId: string, isPinned: boolean) {
    try {
      const next = await SetResumeRevisionPinned(revisionId, !isPinned);
      setRevisions((current) => current.map((item) => item.id === next.id ? { ...item, isPinned: next.isPinned } : item));
      ShowNotice(next.isPinned ? '已标记为重要版本，将永久保留' : '已取消重要版本标记');
    } catch (error) { ShowNotice(error instanceof Error ? error.message : '更新版本标记失败'); }
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
  return <div className="standard-page resumes-page"><section className="paper-block resumes-content-card"><header className="content-card-heading"><div><p className="eyebrow">简历库</p><h1>简历版本</h1><p>保留每一份针对目标岗位定制的简历版本。</p></div><Button variant="primary" onClick={onGoAssistant}><Icon name="assistant" size={16} />让 Agent 起草</Button></header>
    {resumes.length === 0 ? <EmptyState icon={<Icon name="resumes" size={24} />} title="还没有保存的简历" description="从求职助手开始，整理一份可继续编辑的简历。" action={<Button variant="primary" onClick={onGoAssistant}><Icon name="assistant" size={16} />让 Agent 起草</Button>} /> : <section className="resume-grid">{resumes.map((resume) => <article className={`resume-card ${resume.id === currentResumeId ? 'current' : ''}`} key={resume.id} onClick={() => OpenResume(resume)}><div className="resume-card-paper"><div className="resume-card-top"><Icon name="resumes" size={20} />{resume.id === currentResumeId && <small>当前使用</small>}</div><h2>{resume.name}</h2><p>{resume.summary}</p><div>{resume.targetRoles.slice(0, 3).map((role) => <span key={role}>{role}</span>)}</div></div><footer><span>更新于 {FormatTime(resume.updatedAt)}</span>{resume.id === currentResumeId ? <span className="resume-current-note">正在用于助手</span> : <button type="button" onClick={(event) => { event.stopPropagation(); setCurrentResumeId(resume.id); ShowNotice('已设为当前简历'); }}>设为当前</button>}</footer></article>)}</section>}
  </section>
    <Drawer open={drawerOpen} title="简历详情" onClose={() => setDrawerOpen(false)}>{editing && <div className="drawer-form"><FormField label="简历名称"><input value={rename} onChange={(event) => setRename(event.target.value)} /></FormField><Button onClick={SaveRename}>保存名称</Button><div className="resume-detail-preview"><div className="resume-html-preview" dangerouslySetInnerHTML={{ __html: CreateResumeDocumentMarkup(editing) }} /></div><section className="resume-version-list"><header><b>版本历史</b><small>普通版本保留最近 100 个；重要版本永久保留</small></header>{revisions.length ? revisions.map((revision) => <div key={revision.id}><span>v{revision.revision} · {revision.source}</span><Button variant={revision.isPinned ? 'primary' : 'quiet'} onClick={() => void ToggleRevisionPinned(revision.id, revision.isPinned)}>{revision.isPinned ? '重要版本' : '标记重要'}</Button></div>) : <p>暂无可管理的历史版本。</p>}</section><div className="export-box"><span>导出文件</span><div><Button onClick={() => void ExportResume('html')}>HTML</Button><Button variant="primary" onClick={() => void ExportResume('pdf')}>PDF</Button></div></div><div className="drawer-actions"><Button variant="danger" onClick={() => setDeleteTarget(editing)}>删除简历</Button><span /><Button variant="primary" onClick={() => { setCurrentResumeId(editing.id); ShowNotice('已设为当前简历'); }}>设为当前</Button></div></div>}</Drawer>
    <Modal open={Boolean(deleteTarget)} title="删除这份简历？" onClose={() => setDeleteTarget(null)}><p className="modal-copy">删除后无法恢复，也不会保留导出文件。</p><div className="modal-actions"><Button onClick={() => setDeleteTarget(null)}>取消</Button><Button variant="danger" onClick={ConfirmDeleteResume}>确认删除</Button></div></Modal>
  </div>;
}

export { ResumesPage };
