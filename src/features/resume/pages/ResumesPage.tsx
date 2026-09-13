import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { CreateResumeDocumentMarkup, type ResumeRevisionDocumentDto } from '@avery/contracts';
import { useUiStore } from '../../../app/UiStore';
import { useDeleteResume, useResumes, useRestoreResumeRevision, LoadResumeRevisions, LoadResumeRevision, ExportResumeFile } from '../../../features/resume/api/resumeQueries';
import { AcquireResumeEditLock, ReleaseResumeEditLock } from '../../assistant/api/agentQueries';
import { Button, Modal } from '../../../shared/components/UI';
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

/** 版本来源的用户可读标签；后端目前只有保存与还原两种来源。 */
const RevisionSourceLabels: Record<string, string> = { user: '保存的版本', restore: '版本还原' };

/** 行描述与抽屉 meta 共用：有目标岗位写「针对 X 定制」，否则为通用版本。 */
function ResumeTargetText(resume: Resume): string {
  return resume.targetRoles.length ? `针对 ${resume.targetRoles.join('、')} 定制` : '通用版本，没有指定职位';
}

function ResumesPage({ onGoAssistant }: { onGoAssistant: () => void }) {
  const { ShowNotice, setActiveConversationId, setAssistantView, currentResumeId, setCurrentResumeId, setComposerSeed } = useUiStore();
  const resumes = useResumes();
  const restoreResumeRevision = useRestoreResumeRevision({ onConflict: () => ShowNotice('简历已被其他操作修改，已刷新为最新版本'), onFailure: () => ShowNotice('还原简历版本失败，请稍后重试。') });
  const deleteResume = useDeleteResume({ onFailure: () => ShowNotice('简历删除失败，请稍后重试。') });
  const [drawerResume, SetDrawerResume] = useState<Resume | null>(null);
  const [revisions, SetRevisions] = useState<ResumeRevisionRow[]>([]);
  const [viewingRevision, SetViewingRevision] = useState<ResumeRevisionDocumentDto | null>(null);
  const [restoreTarget, SetRestoreTarget] = useState<ResumeRevisionRow | null>(null);
  const [deleteTarget, SetDeleteTarget] = useState<Resume | null>(null);
  const drawerRef = useRef<HTMLElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);

  // 抽屉打开期间 Escape 关闭、初始焦点落在关闭按钮（原型 showDrawer 聚焦 dwClose）。
  useEffect(() => {
    if (!drawerResume) return undefined;
    const CloseOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); CloseDrawer(); }
    };
    document.addEventListener('keydown', CloseOnEscape);
    drawerRef.current?.focus();
    return () => document.removeEventListener('keydown', CloseOnEscape);
  }, [drawerResume]);

  // 原型简历视图：最近修改的版本排最前（v8 → v6）。
  const sortedResumes = useMemo(() => [...resumes].sort((left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0)), [resumes]);

  /** 「让Avery保存简历」：切到新建会话草稿态并预填输入框；首次发送时才由助手页创建实际会话，与侧栏「新建对话」一致。 */
  function SaveViaAvery() {
    setComposerSeed('帮我把这份简历保存到简历库');
    setActiveConversationId(null);
    setAssistantView('chat');
    onGoAssistant();
  }
  function OpenDrawer(resume: Resume) {
    SetDrawerResume(resume); SetViewingRevision(null); SetRevisions([]);
    void RefreshRevisions(resume.id);
  }
  function CloseDrawer() { SetDrawerResume(null); SetViewingRevision(null); SetRestoreTarget(null); SetDeleteTarget(null); }
  async function RefreshRevisions(resumeId: string) {
    // 版本列表读取失败不打断阅读，只是收起历史能力。
    try { SetRevisions((await LoadResumeRevisions(resumeId)) as ResumeRevisionRow[]); } catch { SetRevisions([]); }
  }
  async function PreviewRevision(revision: ResumeRevisionRow) {
    if (!drawerResume) return;
    try {
      SetViewingRevision(await LoadResumeRevision(drawerResume.id, revision.id));
      bodyRef.current?.scrollTo({ top: 0 });
    } catch (error) { ShowNotice(error instanceof Error ? error.message : '读取历史版本失败'); }
  }
  function ReturnToCurrent() { SetViewingRevision(null); bodyRef.current?.scrollTo({ top: 0 }); }
  async function ConfirmRestoreRevision() {
    if (!drawerResume || !restoreTarget) return;
    // 还原会覆盖当前正文，先取得编辑锁避免与 Avery 的进行中编辑互相踩踏。
    const lock = await AcquireResumeEditLock(drawerResume.id);
    if (!lock.acquired) { ShowNotice(lock.reason ?? '简历正被占用，暂时无法还原'); return; }
    try {
      const result = await restoreResumeRevision.mutateAsync({ resumeId: drawerResume.id, revisionId: restoreTarget.id, expectedRevision: drawerResume.revision });
      SetDrawerResume(result.resume); SetViewingRevision(null); SetRestoreTarget(null);
      await RefreshRevisions(result.id);
      ShowNotice(`已从 v${result.restoredFromRevision} 创建当前 v${result.revision}`);
    } catch {
      // 冲突与普通失败已由 mutation 统一提示；锁必须在 finally 中释放。
    } finally { await ReleaseResumeEditLock(drawerResume.id); }
  }
  function ConfirmDeleteResume() {
    if (!deleteTarget) return;
    deleteResume.mutate({ id: deleteTarget.id });
    // 后端已连同历史版本硬删除；当前使用指针指向被删简历时一并清空，避免助手引用失效简历。
    if (currentResumeId === deleteTarget.id) setCurrentResumeId(null);
    CloseDrawer(); ShowNotice('简历已删除');
  }
  function SetCurrentResume(resume: Resume) {
    setCurrentResumeId(resume.id);
    CloseDrawer();
    ShowNotice('已设为当前版本');
  }
  async function DownloadPdf() {
    if (!drawerResume) return;
    try {
      const result = await ExportResumeFile(drawerResume, 'pdf');
      ShowNotice(`已导出 ${result.fileName} 到工作空间 exports 文件夹`);
    } catch (error) { ShowNotice(error instanceof Error ? error.message : '简历导出失败'); }
  }

  return <div className="resumes-view">
    <div className="view-h">
      <div><h1>简历</h1><p>每一版各自针对一个职位。点开任意一版可以看到完整内容，以及这一版改了什么。</p></div>
      <div className="vh-act"><button className="ghost-btn" type="button" onClick={SaveViaAvery}><Icon name="assistant" size={14} />让Avery保存简历</button></div>
    </div>
    {sortedResumes.map((resume) => {
      const isCurrent = resume.id === currentResumeId;
      const edited = FormatTime(resume.updatedAt);
      return <button className="vrow clickable" type="button" key={resume.id} onClick={() => OpenDrawer(resume)}>
        <span className="vrow-main">
          <span className="vrow-t">{resume.name}</span>
          <span className="vrow-d">{ResumeTargetText(resume)}。{edited ? `${edited} 修改。` : ''}</span>
        </span>
        {/* 原型标签形态：目标岗位标签在当前版本上加主色，「当前」标签保持中性灰。 */}
        <span className={`tag${isCurrent ? ' accent' : ''}`}>{resume.targetRoles[0] ?? '通用'}</span>
        {isCurrent && <span className="tag">当前</span>}
        <Icon name="chevron-right" className="vrow-go" size={13} />
      </button>;
    })}
    {!sortedResumes.length && <div className="resumes-view-empty">还没有简历。点右上角「让Avery保存简历」，Avery 会在新对话里帮你把简历存进简历库。</div>}

    {/* 抽屉经 portal 挂到 body：脱离玻璃背景子树，遮罩与虚化才能盖住整个应用窗口（与档案、投递抽屉一致）。 */}
    {drawerResume && createPortal(<div className="dw-layer" role="presentation">
      <div className="dw-scrim" onClick={CloseDrawer} />
      <aside className="dw-drawer is-resume" role="dialog" aria-modal="true" aria-labelledby="resume-drawer-title" tabIndex={-1} ref={drawerRef}>
        <div className="dw-head">
          <div className="dw-head-main">
            <div className="dw-title" id="resume-drawer-title">{drawerResume.name}</div>
            <div className="dw-meta">
              <span>{drawerResume.targetRoles.length ? `针对 ${drawerResume.targetRoles.join('、')}` : '通用版本'}</span>
              {Boolean(drawerResume.updatedAt) && <span>{FormatTime(drawerResume.updatedAt)} 修改</span>}
              {viewingRevision && <span>正在查看 v{viewingRevision.revision}（只读）</span>}
            </div>
          </div>
          <button className="icon-btn" type="button" aria-label="关闭详情" title="关闭详情" autoFocus onClick={CloseDrawer}><Icon name="close" size={16} /></button>
        </div>
        <div className="dw-body" ref={bodyRef}>
          {viewingRevision && <div className="note plain">
            <Icon name="info" size={15} />
            <span>正在查看 v{viewingRevision.revision} 历史版本，内容不可编辑。</span>
            <button className="note-act" type="button" onClick={ReturnToCurrent}>返回当前版本</button>
          </div>}
          {/* 简历正文沿用现有渲染模板（CreateResumeDocumentMarkup）；查看历史版本时替换为只读快照。 */}
          <div className="resume-html-preview" dangerouslySetInnerHTML={{ __html: CreateResumeDocumentMarkup(viewingRevision?.document ?? drawerResume) }} />
          <section className="sec rev-sec">
            <div className="sec-h">版本历史</div>
            {revisions.length ? revisions.map((revision) => <div className="rev-row" key={revision.id}>
              <span className="rev-label">v{revision.revision}{revision.isCurrent ? ' · 当前版本' : ` · ${RevisionSourceLabels[revision.source] ?? revision.source}`}</span>
              <span className="rev-time">{FormatTime(revision.createdAt)}</span>
              {!revision.isCurrent && <span className="rev-acts">
                <button className="rev-act" type="button" onClick={() => void PreviewRevision(revision)}>查看</button>
                <button className="rev-act" type="button" onClick={() => SetRestoreTarget(revision)}>还原</button>
              </span>}
            </div>) : <p className="rev-none">暂无历史版本记录。</p>}
          </section>
        </div>
        <div className="dw-foot">
          <button className="ghost-btn is-danger" type="button" onClick={() => SetDeleteTarget(drawerResume)}><Icon name="delete" size={14} />删除</button>
          <button className="ghost-btn" type="button" onClick={() => void DownloadPdf()}><Icon name="download-simple" size={14} />下载 PDF</button>
          <button className="btn-accent" type="button" disabled={drawerResume.id === currentResumeId} onClick={() => SetCurrentResume(drawerResume)}>
            <Icon name="check-circle" size={14} />{drawerResume.id === currentResumeId ? '已是当前版本' : '设为当前版本'}
          </button>
        </div>
      </aside>
    </div>, document.body)}
    <Modal open={Boolean(deleteTarget)} title="删除这份简历？" onClose={() => SetDeleteTarget(null)}>
      <p className="modal-copy">删除后这份简历及其全部历史版本将从数据库中移除，无法恢复。</p>
      <div className="modal-actions"><Button onClick={() => SetDeleteTarget(null)}>取消</Button><Button variant="danger" onClick={ConfirmDeleteResume}>确认删除</Button></div>
    </Modal>
    <Modal open={Boolean(restoreTarget)} title="还原历史版本？" onClose={() => SetRestoreTarget(null)}>
      <p className="modal-copy">将从 v{restoreTarget?.revision} 创建新的当前版本；不会降低版本号。</p>
      <div className="modal-actions"><Button onClick={() => SetRestoreTarget(null)}>取消</Button><Button variant="primary" onClick={() => void ConfirmRestoreRevision()}>确认还原</Button></div>
    </Modal>
  </div>;
}

export { ResumesPage };
