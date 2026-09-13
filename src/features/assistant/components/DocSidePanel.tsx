import { useEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent } from 'react';
import { CreateResumeDocumentMarkup } from '@avery/contracts';
import { useProfiles } from '../../profile/api/profileQueries';
import { ProfileEntryView } from '../../profile/components/ProfileEntryView';
import { CompareProfileCategory, GetProfileSummary } from '../../profile/profileView';
import { FormatTime, ProfileCategoryLabel } from '../../../shared/utils/format';
import { Icon } from '../../../shared/components/Icon';
import type { ProfileCategory, ProfileItem, Resume } from '../../../types/domain';

type SideKind = 'resume' | 'profile';

/** 原型 RS_KINDS：边栏打开先选资料类型，再从右下角菜单挑具体条目。 */
const KindMeta: Record<SideKind, { label: string; icon: 'resumes' | 'profiles'; picker: string; menuLabel: string; emptyTitle: string; emptyHint: string }> = {
  resume: { label: '简历', icon: 'resumes', picker: '选择简历', menuLabel: '我的简历', emptyTitle: '还没有选择简历', emptyHint: '从右下角选一份简历，它的完整内容会显示在这里。' },
  profile: { label: '档案', icon: 'profiles', picker: '选择档案', menuLabel: '档案条目', emptyTitle: '还没有选择档案', emptyHint: '从右下角选一条档案，它的完整内容会显示在这里。' },
};

interface DocSidePanelProps {
  resumes: Resume[];
  currentResumeId: string | null;
  editing: boolean;
  resumeText: string;
  canUndo: boolean;
  panelWidth: number;
  onSelectResume: (resumeId: string) => void;
  onEditChange: (value: string) => void;
  onStartEditing: () => void;
  onCancelEditing: () => void;
  onSaveResume: () => void;
  onUndo: () => void;
  onResizeStart: (event: ReactMouseEvent<HTMLDivElement>) => void;
}

/**
 * 原型一比一的右侧资料边栏（.rside）：拖拽 grip、类型选择屏、文档阅读区与右下角
 * 的条目选择菜单。组件仅在边栏展开时挂载，每次打开都回到类型选择屏，与原型
 * closeRside 重置 rstate.kind 的行为一致。
 * 简历渲染沿用当前导出模板（CreateResumeDocumentMarkup），编辑/撤销/保存沿用页面的
 * 锁与保存流程，只把按钮换成原型样式；档案条目在边栏内只读，编辑走档案页抽屉。
 */
function DocSidePanel({ resumes, currentResumeId, editing, resumeText, canUndo, panelWidth, onSelectResume, onEditChange, onStartEditing, onCancelEditing, onSaveResume, onUndo, onResizeStart }: DocSidePanelProps) {
  const profiles = useProfiles();
  const [kind, SetKind] = useState<SideKind | null>(null);
  const [profileId, SetProfileId] = useState<string | null>(null);
  const [menuOpen, SetMenuOpen] = useState(false);
  const menuWrapRef = useRef<HTMLDivElement>(null);
  const resume = resumes.find((item) => item.id === currentResumeId) ?? null;
  const profile = profiles.find((item) => item.id === profileId) ?? null;

  // 菜单展开期间点击外部关闭，与原型 rsMenu 的浮层行为一致。
  useEffect(() => {
    if (!menuOpen) return undefined;
    const CloseOnOutsidePointer = (event: PointerEvent) => {
      if (!menuWrapRef.current?.contains(event.target as Node)) SetMenuOpen(false);
    };
    document.addEventListener('pointerdown', CloseOnOutsidePointer);
    return () => document.removeEventListener('pointerdown', CloseOnOutsidePointer);
  }, [menuOpen]);

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
    SetKind(nextKind);
    // 简历类型沿用当前会话的简历；没有当前简历时选第一份，避免落进空态。
    if (nextKind === 'resume' && !currentResumeId && resumes.length) onSelectResume(resumes[0].id);
  }

  const meta = kind ? KindMeta[kind] : null;
  const doc: { title: string; meta: string[] } | null = kind === 'resume'
    ? resume && { title: resume.name, meta: [`${resume.content.length} 字`, resume.updatedAt ? `更新于 ${FormatTime(resume.updatedAt)}` : '尚未保存'] }
    : profile && { title: profile.title, meta: [ProfileCategoryLabel[profile.category], profile.updatedAt ? `更新于 ${FormatTime(profile.updatedAt)}` : ''] };

  return <section className="rside" style={{ '--panel-width': `${panelWidth}px` } as CSSProperties}>
    <div className="rs-grip" role="separator" aria-orientation="vertical" aria-label="调整边栏宽度" onMouseDown={onResizeStart} />
    {!meta ? <div className="rs-body"><div className="rs-pick">
      {(Object.keys(KindMeta) as SideKind[]).map((key) => <button className="rs-pick-btn" type="button" key={key} onClick={() => PickKind(key)}>
        <Icon name={KindMeta[key].icon} size={21} />
        <span>{KindMeta[key].label}</span>
        <Icon name="chevron-right" className="rs-pick-go" size={14} />
      </button>)}
    </div></div> : <>
      <header className="rs-head">
        <button className="icon-btn sm" type="button" aria-label="重新选择类型" title="重新选择类型" onClick={() => { SetKind(null); SetMenuOpen(false); }}>
          <Icon name="arrow-left" size={14} />
        </button>
        <Icon name={meta.icon} className="rs-kind" size={16} />
        <span className="rs-kind-t">{meta.label}</span>
      </header>
      <div className="rs-body">
        {doc ? <div className="rs-doc">
          <div className="rs-doc-h">
            <div className="rs-doc-t">{doc.title}</div>
            <div className="rs-doc-m">{doc.meta.filter(Boolean).map((entry) => <span key={entry}>{entry}</span>)}</div>
          </div>
          {kind === 'resume'
            ? (editing
              ? <textarea className="rs-resume-editor" value={resumeText} onChange={(event) => onEditChange(event.target.value)} aria-label="编辑简历内容" />
              : <div className="rs-doc-resume resume-html-preview" dangerouslySetInnerHTML={{ __html: CreateResumeDocumentMarkup({ name: resume?.name ?? '未命名简历', summary: '', content: resumeText }) }} />)
            : profile && <ProfileEntryView item={profile} />}
        </div> : <div className="rs-empty">
          <Icon name={meta.icon} size={30} />
          <div className="t">{meta.emptyTitle}</div>
          <div className="d">{meta.emptyHint}</div>
        </div>}
      </div>
      <footer className="rs-foot">
        {kind === 'resume' && <div className="rs-actions">
          <button className="ghost-btn" type="button" disabled={editing && !resume} onClick={editing ? onCancelEditing : onStartEditing}>
            <Icon name={editing ? 'close' : 'pencil-simple'} size={14} />{editing ? '取消' : '编辑'}
          </button>
          <button className="ghost-btn" type="button" disabled={!editing || !canUndo} onClick={onUndo}>
            <Icon name="recovery" size={14} />撤销
          </button>
          <button className="btn-accent" type="button" disabled={!editing} onClick={onSaveResume}>
            <Icon name="check-circle" size={14} />保存
          </button>
        </div>}
        <div className="menu-wrap" ref={menuWrapRef}>
          <button className="tb-txt-btn menu-trigger" type="button" aria-expanded={menuOpen} aria-haspopup="true" aria-controls="rs-menu" onClick={() => SetMenuOpen((value) => !value)}>
            <Icon name="list-bullets" size={14} /><span>{meta.picker}</span><Icon name="chevron-down" className="chev" size={10} />
          </button>
          {menuOpen && <div className="menu pop lg open" id="rs-menu" role="menu" aria-label={meta.menuLabel}>
            {kind === 'resume' && resumes.map((item) => <button className={`menu-item ${item.id === currentResumeId ? 'sel' : ''}`} type="button" key={item.id} role="menuitemradio" aria-checked={item.id === currentResumeId} title={item.name} onClick={() => { onSelectResume(item.id); SetMenuOpen(false); }}>
              <Icon name="resumes" size={16} />
              <span><span className="mt">{item.name}</span><span className="md">{item.updatedAt ? `更新于 ${FormatTime(item.updatedAt)}` : '尚未保存'}</span></span>
              <Icon name="check" className="tick" size={14} />
            </button>)}
            {kind === 'resume' && !resumes.length && <div className="menu-label">还没有简历</div>}
            {kind === 'profile' && groupedProfiles.map((group) => <div key={group.category}>
              <div className="menu-label">{ProfileCategoryLabel[group.category]}</div>
              {group.items.map((item) => <button className={`menu-item ${item.id === profileId ? 'sel' : ''}`} type="button" key={item.id} role="menuitemradio" aria-checked={item.id === profileId} title={item.title} onClick={() => { SetProfileId(item.id); SetMenuOpen(false); }}>
                <Icon name="profiles" size={16} />
                <span><span className="mt">{item.title}</span><span className="md">{GetProfileSummary(item.content)}</span></span>
                <Icon name="check" className="tick" size={14} />
              </button>)}
            </div>)}
            {kind === 'profile' && !profiles.length && <div className="menu-label">还没有档案条目</div>}
          </div>}
        </div>
      </footer>
    </>}
  </section>;
}

export { DocSidePanel };
