import { useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type Ref } from 'react';
import { CreateResumeDocumentMarkup, type ConversationResource } from '@avery/contracts';
import { ASSISTANT_MAIN_MIN_WIDTH } from '../../../shared/layoutConstants';
import { useProfiles } from '../../profile/api/profileQueries';
import { ProfileEntryView } from '../../profile/components/ProfileEntryView';
import { CompareProfileCategory, GetProfileSummary } from '../../profile/profileView';
import { FormatTime, ProfileCategoryLabel } from '../../../shared/utils/format';
import { Icon, type IconName } from '../../../shared/components/Icon';
import { MarkdownText } from '../../../shared/components/MarkdownText';
import { DownloadMarkdown, useConversationResource, type ConversationResourceSelection } from '../useConversationResource';
import { useSidePanelResume } from '../useSidePanelResume';
import type { ProfileCategory, ProfileItem, Resume } from '../../../types/domain';

type SideKind = 'resume' | 'profile';

interface DocumentSelection {
  kind: ConversationResource['kind'];
  id: string | null;
  revision?: number;
  external?: ConversationResourceSelection;
}

/** 消息链接只转换为普通条目选择；岗位和文件仍保留会话授权来源。 */
function SelectionFromResource(source: ConversationResourceSelection): DocumentSelection {
  const { kind, id, revision } = source.resource;
  return { kind, id, revision, ...(kind !== 'resume' && kind !== 'profile' ? { external: source } : {}) };
}

/** 原型 RS_KINDS：边栏打开先选资料类型，再从右下角菜单挑具体条目。 */
const KindMeta: Record<SideKind, { label: string; icon: 'resumes' | 'profiles'; picker: string; menuLabel: string; emptyTitle: string; emptyHint: string }> = {
  resume: { label: '简历', icon: 'resumes', picker: '选择简历', menuLabel: '我的简历', emptyTitle: '还没有选择简历', emptyHint: '从右下角选一份简历，它的完整内容会显示在这里。' },
  profile: { label: '档案', icon: 'profiles', picker: '选择档案', menuLabel: '档案条目', emptyTitle: '还没有选择档案', emptyHint: '从右下角选一条档案，它的完整内容会显示在这里。' },
};

interface DocSidePanelProps {
  open: boolean;
  resourceSelection?: ConversationResourceSelection | null;
  onClearResourceSelection?: () => void;
  onClose?: () => void;
  resumes: Resume[];
  currentResumeId: string | null;
  editing: boolean;
  resumeText: string;
  canUndo: boolean;
  panelWidth: number;
  /** 边栏根元素引用：拖拽时用它实时读边栏与布局宽度（原型 startW 读 getBoundingClientRect）。 */
  contentRef: Ref<HTMLElement>;
  onSelectResume: (resumeId: string) => void;
  onEditChange: (value: string) => void;
  onStartEditing: () => void;
  onCancelEditing: () => void;
  onSaveResume: () => void;
  onUndo: () => void;
  onPanelWidthChange: (width: number) => void;
}

/**
 * 原型一比一的右侧资料边栏（.rside）：拖拽 grip、类型选择屏、文档阅读区与右下角
 * 的条目选择菜单。常规打开先选类型；对话中的资源引用直接定位对应条目或历史版本。
 * 简历渲染沿用当前导出模板（CreateResumeDocumentMarkup），编辑/撤销/保存沿用页面的
 * 锁与保存流程，只把按钮换成原型样式；档案条目在边栏内只读，编辑走档案页抽屉。
 */
function DocSidePanelContent({ resourceSelection = null, onClearResourceSelection, onClose, resumes, currentResumeId, editing, resumeText, canUndo, panelWidth, contentRef, onSelectResume, onEditChange, onStartEditing, onCancelEditing, onSaveResume, onUndo, onPanelWidthChange }: Omit<DocSidePanelProps, 'open'>) {
  const profiles = useProfiles();
  const [selection, SetSelection] = useState<DocumentSelection | null>(() => resourceSelection ? SelectionFromResource(resourceSelection) : null);
  const [openMenu, SetOpenMenu] = useState<'documents' | 'versions' | null>(null);
  const menuWrapRef = useRef<HTMLDivElement>(null);
  const versionMenuWrapRef = useRef<HTMLDivElement>(null);
  const selectedKind = selection?.kind ?? null;
  const profileId = selectedKind === 'profile' ? selection?.id : null;
  const resume = selectedKind === 'resume' ? resumes.find((item) => item.id === selection?.id) ?? null : null;
  const profile = profiles.find((item) => item.id === profileId) ?? null;
  const resource = useConversationResource(selection?.external ?? null);
  const resumeDocument = useSidePanelResume(resume, selection?.revision);
  const displayedResume = resumeDocument.document;
  const isCurrentResume = !!displayedResume && displayedResume.id === currentResumeId && displayedResume.revision === resume?.revision;
  const displayedResumeText = isCurrentResume ? resumeText : displayedResume?.content ?? '';
  const versions = resumeDocument.versions;
  const currentRevision = versions.find((version) => version.isCurrent)?.revision ?? resume?.revision;
  const downloadLabel = resource.view?.format === 'file'
    ? resource.view.mimeType === 'application/pdf' ? '下载 PDF' : '下载 PNG'
    : '下载 Markdown';

  useEffect(() => {
    if (!resourceSelection) {
      // 会话切换清除外部资源授权；普通资料选择继续沿用侧栏自身状态。
      SetSelection((current) => current?.external ? null : current);
      return;
    }
    SetSelection(SelectionFromResource(resourceSelection));
    SetOpenMenu(null);
  }, [resourceSelection]);

  // 宽度上下限与页面 HandleResize 原逻辑一致：窗口放不下时设计下限让位（原型 rsClamp）。
  const WidthRange = () => {
    const layoutWidth = contentRef && 'current' in contentRef ? contentRef.current?.closest<HTMLElement>('.assistant-layout')?.clientWidth ?? 0 : 0;
    const maximum = Math.min(720, Math.max(360, layoutWidth - ASSISTANT_MAIN_MIN_WIDTH));
    return { minimum: Math.min(360, maximum), maximum };
  };

  /**
   * 原型 initRsGrip 的拖拽：按住左缘左右拖动改写宽度，起点宽度取元素实时矩形。
   * 指针捕获在部分合成输入下不生效，因此移动监听挂 document（原型行为等价：拖拽期间
   * 无论指针在哪都持续更新宽度，pointerup / pointercancel 结束）。
   */
  function HandleGripPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    event.preventDefault();
    const grip = event.currentTarget;
    const startX = event.clientX;
    const startWidth = contentRef && 'current' in contentRef ? contentRef.current?.getBoundingClientRect().width ?? panelWidth : panelWidth;
    const { minimum, maximum } = WidthRange();
    try { grip.setPointerCapture(event.pointerId); } catch { /* 捕获失败时由 document 监听兜底 */ }
    grip.classList.add('on');
    document.body.classList.add('is-resizing-resume');
    const HandleMove = (moveEvent: PointerEvent) => {
      onPanelWidthChange(Math.round(Math.min(maximum, Math.max(minimum, startWidth + (startX - moveEvent.clientX)))));
    };
    const HandleUp = (upEvent: PointerEvent) => {
      grip.classList.remove('on');
      document.body.classList.remove('is-resizing-resume');
      document.removeEventListener('pointermove', HandleMove);
      document.removeEventListener('pointerup', HandleUp);
      document.removeEventListener('pointercancel', HandleUp);
      try { grip.releasePointerCapture(upEvent.pointerId); } catch { /* 指针已释放 */ }
    };
    document.addEventListener('pointermove', HandleMove);
    document.addEventListener('pointerup', HandleUp);
    document.addEventListener('pointercancel', HandleUp);
  }

  /** 键盘用户与拖拽同区间：方向键微调（Shift 加速），Home/End 跳到下限/上限。 */
  function HandleGripKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    const step = event.shiftKey ? 40 : 12;
    const { minimum, maximum } = WidthRange();
    let next: number | null = null;
    if (event.key === 'ArrowLeft') next = panelWidth + step;
    else if (event.key === 'ArrowRight') next = panelWidth - step;
    else if (event.key === 'Home') next = minimum;
    else if (event.key === 'End') next = maximum;
    if (next === null) return;
    event.preventDefault();
    onPanelWidthChange(Math.round(Math.min(maximum, Math.max(minimum, next))));
  }

  // 菜单展开期间点击外部关闭，与原型 rsMenu 的浮层行为一致。
  useEffect(() => {
    if (!openMenu) return undefined;
    const CloseOnOutsidePointer = (event: PointerEvent) => {
      const wrapper = openMenu === 'versions' ? versionMenuWrapRef.current : menuWrapRef.current;
      if (!wrapper?.contains(event.target as Node)) SetOpenMenu(null);
    };
    document.addEventListener('pointerdown', CloseOnOutsidePointer);
    return () => document.removeEventListener('pointerdown', CloseOnOutsidePointer);
  }, [openMenu]);

  useEffect(() => {
    if (openMenu === 'versions') versionMenuWrapRef.current?.querySelector<HTMLButtonElement>('[role="menuitemradio"][aria-checked="true"]')?.focus();
  }, [openMenu]);

  /** 替换原生 select 后保留方向键选择和 Esc 返回入口的键盘能力。 */
  function HandleVersionMenuKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (openMenu !== 'versions') return;
    const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')];
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === 'ArrowDown' ? (index + 1) % items.length
      : event.key === 'ArrowUp' ? (index + items.length - 1) % items.length
      : event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : null;
    if (next === null || !items.length) return;
    event.preventDefault();
    items[next].focus();
  }

  function SelectVersion(revision: number | undefined) {
    SetOpenMenu(null);
    versionMenuWrapRef.current?.querySelector<HTMLButtonElement>('.menu-trigger')?.focus();
    SetSelection((current) => current?.kind === 'resume' ? { ...current, revision } : current);
  }

  function SelectDocument(nextKind: SideKind, id: string | null) {
    SetSelection({ kind: nextKind, id });
    onClearResourceSelection?.();
    SetOpenMenu(null);
    if (nextKind === 'resume' && id) onSelectResume(id);
  }

  function DownloadDocument() {
    if (selectedKind === 'resume' && displayedResume) DownloadMarkdown(displayedResume.content, displayedResume.name);
    else if (selectedKind === 'profile' && profile) DownloadMarkdown(profile.content, profile.title);
    else resource.Download();
  }

  // 档案菜单按固定分类顺序分组展示，组头即分类名。
  const groupedProfiles = useMemo(() => {
    const groups: Array<{ category: ProfileCategory; items: ProfileItem[] }> = [];
    for (const item of [...profiles].sort((left, right) => CompareProfileCategory(left.category, right.category) || left.title.localeCompare(right.title, 'zh-Hans-CN'))) {
      const group = groups.at(-1);
      if (group && group.category === item.category) group.items.push(item);
      else groups.push({ category: item.category, items: [item] });
    }
    return groups;
  }, [profiles]);

  function PickKind(nextKind: SideKind) {
    SelectDocument(nextKind, nextKind === 'resume' ? currentResumeId ?? resumes[0]?.id ?? null : null);
  }

  const linkedMeta: Record<string, { label: string; icon: IconName }> = {
    job: { label: '岗位', icon: 'jobs' }, application: { label: '投递记录', icon: 'applications' }, file: { label: '文件', icon: 'resume' },
  };
  const meta = selectedKind === 'resume' || selectedKind === 'profile' ? KindMeta[selectedKind] : selectedKind ? linkedMeta[selectedKind] : null;
  const pickerMeta = selectedKind === 'resume' || selectedKind === 'profile' ? KindMeta[selectedKind] : null;
  const doc: { title: string; meta: string[] } | null = selectedKind === 'resume'
    ? displayedResume && { title: displayedResume.name, meta: [displayedResume.revision ? `v${displayedResume.revision}${isCurrentResume ? ' · 当前' : ' · 历史版本，只读'}` : '', `${displayedResume.content.length} 字`, displayedResume.updatedAt ? `更新于 ${FormatTime(displayedResume.updatedAt)}` : '尚未保存'] }
    : selectedKind === 'profile' && profile ? { title: profile.title, meta: [ProfileCategoryLabel[profile.category], profile.updatedAt ? `更新于 ${FormatTime(profile.updatedAt)}` : ''] } : null;

  return <section ref={contentRef} className="rside" style={{ '--panel-width': `${panelWidth}px` } as CSSProperties} onKeyDown={(event) => {
    if (event.key !== 'Escape') return;
    if (openMenu) {
      event.stopPropagation();
      const wrapper = openMenu === 'versions' ? versionMenuWrapRef.current : menuWrapRef.current;
      SetOpenMenu(null);
      wrapper?.querySelector<HTMLButtonElement>('.menu-trigger')?.focus();
    } else if (onClose && !editing) { event.stopPropagation(); onClose(); }
  }}>
    <div className="rs-grip" role="separator" aria-orientation="vertical" aria-label="调整边栏宽度" aria-valuenow={panelWidth} tabIndex={0} onPointerDown={HandleGripPointerDown} onKeyDown={HandleGripKeyDown} />
    {!meta ? <div className="rs-body"><div className="rs-pick">
      {(Object.keys(KindMeta) as SideKind[]).map((key) => <button className="rs-pick-btn" type="button" key={key} onClick={() => PickKind(key)}>
        <Icon name={KindMeta[key].icon} size={21} />
        <span>{KindMeta[key].label}</span>
        <Icon name="chevron-right" className="rs-pick-go" size={14} />
      </button>)}
    </div></div> : <>
      <header className="rs-head">
        <button className="icon-btn sm" type="button" disabled={editing} aria-label="重新选择类型" title="重新选择类型" onClick={() => { onClearResourceSelection?.(); SetSelection(null); SetOpenMenu(null); }}>
          <Icon name="arrow-left" size={14} />
        </button>
        <Icon name={meta.icon} className="rs-kind" size={16} />
        <span className="rs-kind-t">{meta.label}</span>
        {onClose && <button className="icon-btn sm rs-resource-close" type="button" aria-label="关闭资料侧栏" disabled={editing} onClick={onClose}><Icon name="close" size={14} /></button>}
      </header>
      <div className="rs-body">
        {resumeDocument.error && displayedResume && <p className="conversation-run-error" role="alert">版本记录读取失败：{resumeDocument.error}</p>}
        {selectedKind === 'resume' && selection?.id && !resume ? <div className="rs-empty"><p role="alert">简历已删除或不可用，请重新选择。</p></div>
        : (resumeDocument.error && !displayedResume) || resource.error ? <div className="rs-empty"><p role="alert">{resumeDocument.error || resource.error}</p>{selectedKind === 'resume' && (selection?.revision !== undefined ? <button className="ghost-btn" type="button" onClick={() => SelectVersion(undefined)}>查看当前版本</button> : <button className="ghost-btn" type="button" onClick={() => void resumeDocument.Reload()}>重新读取</button>)}</div>
        : (selection?.external && !resource.view) || (resumeDocument.loading && !displayedResume) ? <p role="status">正在读取资料…</p>
        : doc ? <div className="rs-doc">
          <div className="rs-doc-h">
            <div className="rs-doc-t">{doc.title}</div>
            <div className="rs-doc-m">{doc.meta.filter(Boolean).map((entry) => <span key={entry}>{entry}</span>)}</div>
          </div>
          {selectedKind === 'resume'
            ? (editing && isCurrentResume
              ? <textarea className="rs-resume-editor" value={resumeText} onChange={(event) => onEditChange(event.target.value)} aria-label="编辑简历内容" />
              : <div className="rs-doc-resume resume-html-preview" dangerouslySetInnerHTML={{ __html: CreateResumeDocumentMarkup({ name: displayedResume?.name ?? '未命名简历', summary: '', content: displayedResumeText }) }} />)
            : profile && <ProfileEntryView item={profile} />}
        </div> : resource.view?.format === 'markdown' ? <div className="rs-doc"><MarkdownText content={resource.view.content} /></div>
        : resource.view?.format === 'file' ? resource.view.mimeType === 'image/png'
          ? <img className="rs-resource-image" src={resource.fileUrl} alt={resource.view.resource.title} />
          : <iframe className="rs-resource-file" src={resource.fileUrl} title={resource.view.resource.title} />
        : <div className="rs-empty">
          <Icon name={meta.icon} size={30} />
          <div className="t">{pickerMeta?.emptyTitle ?? '资料不可用'}</div>
          <div className="d">{pickerMeta?.emptyHint}</div>
        </div>}
      </div>
      <footer className="rs-foot">
        {selectedKind === 'resume' && <div className="rs-actions">
          <button className="ghost-btn" type="button" disabled={!isCurrentResume} aria-label={editing ? '取消编辑' : '编辑简历'} title={!isCurrentResume ? '历史版本只读，请选择当前版本后编辑' : editing ? '取消编辑' : '编辑简历'} onClick={editing ? onCancelEditing : () => { if (!resume) return; SelectDocument('resume', resume.id); onStartEditing(); }}>
            <Icon name={editing ? 'close' : 'pencil-simple'} size={14} /><span className="btn-txt">{editing ? '取消' : '编辑'}</span>
          </button>
          <button className="ghost-btn" type="button" disabled={!editing || !canUndo} aria-label="撤销修改" title="撤销修改" onClick={onUndo}>
            <Icon name="recovery" size={14} /><span className="btn-txt">撤销</span>
          </button>
          <button className="btn-accent" type="button" disabled={!editing} aria-label="保存简历" title="保存简历" onClick={onSaveResume}>
            <Icon name="check-circle" size={14} /><span className="btn-txt">保存</span>
          </button>
        </div>}
        {selectedKind === 'resume' && resume && <div className="menu-wrap rs-resource-version-wrap" ref={versionMenuWrapRef} onKeyDown={HandleVersionMenuKeyDown} onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) SetOpenMenu((current) => current === 'versions' ? null : current); }}>
          <button className="tb-txt-btn menu-trigger rs-resource-version" type="button" aria-label="选择简历版本" title="选择简历版本" disabled={editing || resumeDocument.loading} aria-expanded={openMenu === 'versions'} aria-haspopup="menu" aria-controls="rs-version-menu" onClick={() => SetOpenMenu((current) => current === 'versions' ? null : 'versions')}>
            <span>{selection?.revision === undefined ? '当前' : `v${selection.revision}`}</span><Icon name="chevron-down" className="chev" size={10} />
          </button>
          {openMenu === 'versions' && <div className="menu pop open rs-version-menu" id="rs-version-menu" role="menu" aria-label="简历版本">
            <div className="menu-label">简历版本</div>
            <button className={`menu-item plain ${selection?.revision === undefined || selection.revision === currentRevision ? 'sel' : ''}`} type="button" role="menuitemradio" aria-checked={selection?.revision === undefined || selection.revision === currentRevision} onClick={() => SelectVersion(undefined)}>
              <Icon name="resumes" size={16} /><span className="mt">当前版本{currentRevision !== undefined ? ` · v${currentRevision}` : ''}</span><Icon name="check" className="tick" size={14} />
            </button>
            {versions.filter((version) => !version.isCurrent).map((version) => <button className={`menu-item plain ${selection?.revision === version.revision ? 'sel' : ''}`} type="button" key={version.id} role="menuitemradio" aria-checked={selection?.revision === version.revision} onClick={() => SelectVersion(version.revision)}>
              <Icon name="clock" size={16} /><span><span className="mt">v{version.revision}</span><span className="md">{FormatTime(version.createdAt)}</span></span><Icon name="check" className="tick" size={14} />
            </button>)}
          </div>}
        </div>}
        {(displayedResume || profile || resource.view) && <button className="ghost-btn rs-resource-download" type="button" aria-label={downloadLabel} title={downloadLabel} onClick={DownloadDocument}><Icon name="download-simple" size={14} /></button>}
        {pickerMeta && <div className="menu-wrap" ref={menuWrapRef}>
          <button className="tb-txt-btn menu-trigger" type="button" disabled={editing} aria-label={pickerMeta.picker} title={pickerMeta.picker} aria-expanded={openMenu === 'documents'} aria-haspopup="true" aria-controls="rs-menu" onClick={() => SetOpenMenu((current) => current === 'documents' ? null : 'documents')}>
            <Icon name="list-bullets" size={14} /><span className="btn-txt">{pickerMeta.picker}</span><Icon name="chevron-down" className="chev" size={10} />
          </button>
          {openMenu === 'documents' && <div className="menu pop lg open" id="rs-menu" role="menu" aria-label={pickerMeta.menuLabel}>
            {selectedKind === 'resume' && resumes.map((item) => <button className={`menu-item ${item.id === selection?.id ? 'sel' : ''}`} type="button" key={item.id} role="menuitemradio" aria-checked={item.id === selection?.id} title={item.name} onClick={() => SelectDocument('resume', item.id)}>
              <Icon name="resumes" size={16} />
              <span><span className="mt">{item.name}</span><span className="md">{item.updatedAt ? `更新于 ${FormatTime(item.updatedAt)}` : '尚未保存'}</span></span>
              <Icon name="check" className="tick" size={14} />
            </button>)}
            {selectedKind === 'resume' && !resumes.length && <div className="menu-label">还没有简历</div>}
            {selectedKind === 'profile' && groupedProfiles.map((group) => <div key={group.category}>
              <div className="menu-label">{ProfileCategoryLabel[group.category]}</div>
              {group.items.map((item) => <button className={`menu-item ${item.id === profileId ? 'sel' : ''}`} type="button" key={item.id} role="menuitemradio" aria-checked={item.id === profileId} title={item.title} onClick={() => SelectDocument('profile', item.id)}>
                <Icon name="profiles" size={16} />
                <span><span className="mt">{item.title}</span><span className="md">{GetProfileSummary(item.content)}</span></span>
                <Icon name="check" className="tick" size={14} />
              </button>)}
            </div>)}
            {selectedKind === 'profile' && !profiles.length && <div className="menu-label">还没有档案条目</div>}
          </div>}
        </div>}
      </footer>
    </>}
  </section>;
}

const SidePanelTransitionMs = 280;

/** 关闭动画结束后才卸载资料内容；快速重新打开时撤销卸载，保留进行中的选择和滚动位置。 */
function DocSidePanel({ open, ...props }: DocSidePanelProps) {
  const [retained, setRetained] = useState(open);
  useEffect(() => {
    if (open) { setRetained(true); return; }
    const duration = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : SidePanelTransitionMs;
    const timer = window.setTimeout(() => setRetained(false), duration);
    return () => window.clearTimeout(timer);
  }, [open]);

  if (!open && !retained) return null;
  return <div className={`rs-presence${open ? ' is-open' : ''}`} inert={!open} aria-hidden={!open}
    style={{ '--panel-width': `${props.panelWidth}px`, '--rs-transition-duration': `${SidePanelTransitionMs}ms` } as CSSProperties}>
    <DocSidePanelContent {...props} />
  </div>;
}

export { DocSidePanel };
