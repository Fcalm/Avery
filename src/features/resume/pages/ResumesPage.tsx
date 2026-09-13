import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { CreateResumeDocumentMarkup, type ResumeRevisionDocumentDto } from '@avery/contracts';
import { useUiStore } from '../../../app/UiStore';
import { useDeleteResume, useResumes, useRestoreResumeRevision, useUpsertResume, LoadResumeRevisions, LoadResumeRevision, ExportResumeFile } from '../../../features/resume/api/resumeQueries';
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
  const upsertResume = useUpsertResume({ onConflict: () => ShowNotice('简历已在其他窗口被修改，已刷新为最新版本'), onFailure: () => ShowNotice('简历保存失败，请稍后重试。') });
  const [drawerResume, SetDrawerResume] = useState<Resume | null>(null);
  const [revisions, SetRevisions] = useState<ResumeRevisionRow[]>([]);
  const [viewingRevision, SetViewingRevision] = useState<ResumeRevisionDocumentDto | null>(null);
  const [restoreTarget, SetRestoreTarget] = useState<ResumeRevisionRow | null>(null);
  const [deleteTarget, SetDeleteTarget] = useState<Resume | null>(null);
  // 编辑态与侧边栏简历编辑共用同一套语义：editText 为编辑中内容，savedText 为最后一次已保存内容，editHistory 为撤销栈。
  const [editing, SetEditing] = useState(false);
  const [editText, SetEditText] = useState('');
  const [savedText, SetSavedText] = useState('');
  const [editHistory, SetEditHistory] = useState<string[]>([]);
  const drawerRef = useRef<HTMLElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  // 用户编辑锁：记录持有锁的简历，保存/取消/卸载时释放（与侧边栏 editLockRef 是同一把后端锁）。
  const editLockRef = useRef<string | null>(null);

  // 抽屉打开时初始焦点落在关闭按钮（原型 showDrawer 聚焦 dwClose）。
  useEffect(() => { if (drawerResume) drawerRef.current?.focus(); }, [drawerResume]);

  // 编辑期间 Escape 只取消编辑不关抽屉，避免一次误按同时丢弃修改并退出抽屉。
  useEffect(() => {
    if (!drawerResume) return undefined;
    const CloseOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      if (editing) CancelEdit(); else CloseDrawer();
    };
    document.addEventListener('keydown', CloseOnEscape);
    return () => document.removeEventListener('keydown', CloseOnEscape);
  }, [drawerResume, editing]);

  // 卸载兜底释放编辑锁：离开页面时不把用户锁留在后端。
  useEffect(() => () => { if (editLockRef.current) void ReleaseResumeEditLock(editLockRef.current); }, []);

  // 抽屉打开期间跟随工作空间缓存刷新（如 Avery 在后台更新了这份简历）；编辑中不覆盖用户输入。
  useEffect(() => {
    if (!drawerResume || editing) return;
    const fresh = resumes.find((item) => item.id === drawerResume.id);
    if (fresh && fresh !== drawerResume) SetDrawerResume(fresh);
  }, [resumes, drawerResume, editing]);

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
  /** 关闭入口统一收口：编辑中先取消编辑（恢复正文并释放锁），再次操作才真正收起抽屉。 */
  function RequestClose() { if (editing) { CancelEdit(); return; } CloseDrawer(); }
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
  /** 进入编辑前取得后端互斥锁：Avery 占用时拒绝进入；只允许编辑当前版本，历史快照入口已禁用。 */
  async function StartEdit() {
    if (!drawerResume || viewingRevision) return;
    const lock = await AcquireResumeEditLock(drawerResume.id);
    if (!lock.acquired) { ShowNotice(lock.reason ?? '简历正被占用，暂时无法编辑'); return; }
    editLockRef.current = drawerResume.id;
    SetEditText(drawerResume.content); SetSavedText(drawerResume.content); SetEditHistory([]);
    SetEditing(true);
  }
  function HandleEditChange(value: string) { SetEditHistory((current) => [...current, editText]); SetEditText(value); }
  /** 撤销最近一次编辑：弹回上一份快照；保存或取消后撤销栈清空。 */
  function UndoEdit() {
    const last = editHistory.at(-1);
    if (last === undefined) return;
    SetEditText(last);
    SetEditHistory((current) => current.slice(0, -1));
  }
  async function SaveEdit() {
    if (!drawerResume) return;
    try {
      const result = await upsertResume.mutateAsync({ resume: { ...drawerResume, content: editText, updatedAt: Date.now() }, expectedRevision: drawerResume.revision });
      // 保存成功才释放锁并退出编辑态；失败时保留编辑态与锁供重试（提示由 mutation 统一给出）。
      if (editLockRef.current) { void ReleaseResumeEditLock(editLockRef.current); editLockRef.current = null; }
      SetSavedText(editText); SetEditHistory([]); SetEditing(false);
      SetDrawerResume((current) => (current ? { ...current, content: editText, updatedAt: Date.now(), revision: result.revision } : current));
      void RefreshRevisions(drawerResume.id);
      ShowNotice('简历已保存');
    } catch { /* 冲突与普通失败已由 mutation 统一提示 */ }
  }
  /** 取消编辑恢复最后一次已保存内容，并立即释放锁供 Avery 继续更新（与侧边栏一致）。 */
  function CancelEdit() {
    SetEditText(savedText); SetEditHistory([]); SetEditing(false);
    if (editLockRef.current) { void ReleaseResumeEditLock(editLockRef.current); editLockRef.current = null; }
    ShowNotice('已取消编辑，未保存修改已放弃');
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
      <div className="dw-scrim" onClick={RequestClose} />
      <aside className="dw-drawer is-resume" role="dialog" aria-modal="true" aria-labelledby="resume-drawer-title" tabIndex={-1} ref={drawerRef}>
        <div className="dw-head">
          <div className="dw-head-main">
            <div className="dw-title" id="resume-drawer-title">{drawerResume.name}</div>
            <div className="dw-meta">
              <span>{drawerResume.targetRoles.length ? `针对 ${drawerResume.targetRoles.join('、')}` : '通用版本'}</span>
              {Boolean(drawerResume.updatedAt) && <span>{FormatTime(drawerResume.updatedAt)} 修改</span>}
              {viewingRevision && <span>正在查看 v{viewingRevision.revision}（只读）</span>}
              {editing && <span>正在编辑 Markdown 源文</span>}
            </div>
          </div>
          <button className="icon-btn" type="button" aria-label="关闭详情" title="关闭详情" autoFocus onClick={RequestClose}><Icon name="close" size={16} /></button>
        </div>
        <div className="dw-body" ref={bodyRef}>
          {/* 编辑态把正文整体换成 Markdown 源文编辑框；阅读态维持渲染模板与版本历史。 */}
          {editing ? <textarea className="dw-resume-editor" value={editText} onChange={(event) => HandleEditChange(event.target.value)} aria-label="编辑简历内容" /> : <>
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
          </>}
        </div>
        <div className="dw-foot">
          {/* 编辑态换用侧边栏同款按钮组：取消 / 撤销 / 保存；阅读态保留删除、编辑、导出与设为当前。 */}
          {editing ? <>
            <button className="ghost-btn" type="button" onClick={CancelEdit}><Icon name="close" size={14} />取消</button>
            <button className="ghost-btn" type="button" disabled={!editHistory.length} onClick={UndoEdit}><Icon name="recovery" size={14} />撤销</button>
            <button className="btn-accent" type="button" onClick={() => void SaveEdit()}><Icon name="check-circle" size={14} />保存</button>
          </> : <>
            <button className="ghost-btn is-danger" type="button" onClick={() => SetDeleteTarget(drawerResume)}><Icon name="delete" size={14} />删除</button>
            <button className="ghost-btn" type="button" disabled={Boolean(viewingRevision)} title={viewingRevision ? '历史版本只读，返回当前版本后可编辑' : undefined} onClick={() => void StartEdit()}>
              <Icon name="pencil-simple" size={14} />编辑
            </button>
            <button className="ghost-btn" type="button" onClick={() => void DownloadPdf()}><Icon name="download-simple" size={14} />下载 PDF</button>
            <button className="btn-accent" type="button" disabled={drawerResume.id === currentResumeId} onClick={() => SetCurrentResume(drawerResume)}>
              <Icon name="check-circle" size={14} />{drawerResume.id === currentResumeId ? '已是当前版本' : '设为当前版本'}
            </button>
          </>}
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
