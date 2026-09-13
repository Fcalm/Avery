import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { CreateResumeDocumentMarkup } from '@avery/contracts';
import { useUiStore } from '../../../app/UiStore';
import { useResumes, ExportResumeFile } from '../../../features/resume/api/resumeQueries';
import { Icon } from '../../../shared/components/Icon';
import { FormatTime } from '../../../shared/utils/format';
import type { Resume } from '../../../types/domain';

/** 行描述与抽屉 meta 共用：有目标岗位写「针对 X 定制」，否则为通用版本。 */
function ResumeTargetText(resume: Resume): string {
  return resume.targetRoles.length ? `针对 ${resume.targetRoles.join('、')} 定制` : '通用版本，没有指定职位';
}

function ResumesPage({ onGoAssistant }: { onGoAssistant: () => void }) {
  const { ShowNotice, setActiveConversationId, setAssistantView, currentResumeId, setCurrentResumeId, setComposerSeed } = useUiStore();
  const resumes = useResumes();
  const [drawerResume, SetDrawerResume] = useState<Resume | null>(null);
  const drawerRef = useRef<HTMLElement>(null);

  // 抽屉打开期间 Escape 关闭、初始焦点落在关闭按钮（原型 showDrawer 聚焦 dwClose）。
  useEffect(() => {
    if (!drawerResume) return undefined;
    const CloseOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); SetDrawerResume(null); }
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
  function SetCurrentResume(resume: Resume) {
    setCurrentResumeId(resume.id);
    SetDrawerResume(null);
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
      return <button className="vrow clickable" type="button" key={resume.id} onClick={() => SetDrawerResume(resume)}>
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
      <div className="dw-scrim" onClick={() => SetDrawerResume(null)} />
      <aside className="dw-drawer" role="dialog" aria-modal="true" aria-labelledby="resume-drawer-title" tabIndex={-1} ref={drawerRef}>
        <div className="dw-head">
          <div className="dw-head-main">
            <div className="dw-title" id="resume-drawer-title">{drawerResume.name}</div>
            <div className="dw-meta">
              <span>{drawerResume.targetRoles.length ? `针对 ${drawerResume.targetRoles.join('、')}` : '通用版本'}</span>
              {Boolean(drawerResume.updatedAt) && <span>{FormatTime(drawerResume.updatedAt)} 修改</span>}
            </div>
          </div>
          <button className="icon-btn" type="button" aria-label="关闭详情" title="关闭详情" autoFocus onClick={() => SetDrawerResume(null)}><Icon name="close" size={16} /></button>
        </div>
        <div className="dw-body">
          {/* 简历正文沿用现有渲染模板（CreateResumeDocumentMarkup），抽屉只提供原型同款的阅读容器。 */}
          <div className="resume-html-preview" dangerouslySetInnerHTML={{ __html: CreateResumeDocumentMarkup(drawerResume) }} />
        </div>
        <div className="dw-foot">
          <button className="ghost-btn" type="button" onClick={() => void DownloadPdf()}><Icon name="download-simple" size={14} />下载 PDF</button>
          <button className="btn-accent" type="button" disabled={drawerResume.id === currentResumeId} onClick={() => SetCurrentResume(drawerResume)}>
            <Icon name="check-circle" size={14} />{drawerResume.id === currentResumeId ? '已是当前版本' : '设为当前版本'}
          </button>
        </div>
      </aside>
    </div>, document.body)}
  </div>;
}

export { ResumesPage };
