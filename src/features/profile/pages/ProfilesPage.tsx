import { type ChangeEvent, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useUiStore } from '../../../app/UiStore';
import { useProfiles, useSaveProfiles } from '../../../features/profile/api/profileQueries';
import { ProfileEntryView, GetProfileCopyText } from '../components/ProfileEntryView';
import { CompareProfileCategory, GetProfileSummary } from '../profileView';
import { CreateEntityId } from '../../workspace/api/workspaceData';
import { DialogButton, FormField, Modal, Select } from '../../../shared/components/UI';
import { Icon } from '../../../shared/components/Icon';
import { FormatTime, ProfileCategoryLabel } from '../../../shared/utils/format';
import type { ProfileCategory, ProfileItem } from '../../../types/domain';
import {
  ChangeProfileDraftCategory,
  CreateProfileDraft,
  DatePlaceholder,
  GetProfileDraftErrors,
  GetProfileField,
  GetProfileFieldId,
  ProfileTemplateForCategory,
  ProfileTemplateSections,
  UpdateProfileField,
} from '../profileDraft';

const Categories: ProfileCategory[] = ['application', 'education', 'work', 'job_intention', 'project', 'skill_certificate', 'other'];

/** 抽屉的两种形态：阅读态只渲染内容，编辑态才出现输入框（对应原型 dw-foot 的按钮切换）。 */
type ProfileDrawer = { mode: 'view'; item: ProfileItem } | { mode: 'edit'; item: ProfileItem | null };

function ProfileTemplateForm({
  category,
  content,
  errors,
  onFieldChange,
}: {
  category: ProfileCategory;
  content: string;
  errors: Readonly<Record<string, string>>;
  onFieldChange: (sectionTitle: string, field: string, value: string) => void;
}) {
  return <section className="application-profile-form" aria-label={`${ProfileCategoryLabel[category]}字段`}>
    <p className="profile-template-tip"><i className="profile-field-required" aria-hidden="true">*</i> 为必填项。日期请使用 {DatePlaceholder} 格式。</p>
    {ProfileTemplateSections[category].map((section, sectionIndex) => <section className="application-profile-section" key={section.title} aria-labelledby={`profile-section-${sectionIndex}`}>
      <h3 id={`profile-section-${sectionIndex}`}>{section.title}</h3>
      <div className="application-profile-fields">
        {section.fields.map((field, fieldIndex) => {
          const fieldId = GetProfileFieldId(category, sectionIndex, fieldIndex);
          const fieldValue = GetProfileField(content, section.title, field.label);
          const error = errors[fieldId];
          const common = {
            id: fieldId,
            name: fieldId,
            'data-profile-field': field.label,
            placeholder: field.date ? DatePlaceholder : '请输入',
            value: fieldValue,
            'aria-required': Boolean(field.required),
            'aria-invalid': Boolean(error),
            'aria-describedby': error ? `${fieldId}-error` : undefined,
            onChange: (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => onFieldChange(section.title, field.label, event.target.value),
          };
          return <label className={`application-profile-field ${field.multiline ? 'is-multiline' : ''}`} htmlFor={fieldId} key={fieldId}>
            <span>{field.required && <i className="profile-field-required" aria-hidden="true">*</i>}{field.label}：</span>
            {/* 下拉选项统一走共享 Select 的自定义浮层，避免原生 select 的系统菜单破坏视觉一致性。 */}
            {field.options ? <Select id={fieldId} value={fieldValue} ariaLabel={field.label} ariaRequired={Boolean(field.required)} ariaInvalid={Boolean(error)} ariaDescribedBy={error ? `${fieldId}-error` : undefined} options={[{ value: '', label: '请选择' }, ...field.options.map((option) => ({ value: option, label: option }))]} onChange={(value) => onFieldChange(section.title, field.label, value)} /> : field.multiline ? <textarea rows={3} {...common} /> : <input {...common} />}
            {error && <small className="profile-field-error" id={`${fieldId}-error`}>{error}</small>}
          </label>;
        })}
      </div>
    </section>)}
  </section>;
}

/** 标签显示短日期；最近更新的一条用主色标签，对应原型里个别 tag 的 accent 形态。 */
function FormatDay(value?: number): string {
  return typeof value === 'number' ? new Date(value).toLocaleDateString('zh-CN') : '未更新';
}

function ProfilesPage() {
  const { ShowNotice, setProfileConflict } = useUiStore();
  const profiles = useProfiles();
  const saveProfiles = useSaveProfiles({ onConflict: () => setProfileConflict(true), onFailure: () => ShowNotice('档案保存失败，请稍后重试。', "error") });
  const [drawer, SetDrawer] = useState<ProfileDrawer | null>(null);
  const [draft, SetDraft] = useState<Partial<ProfileItem>>({ category: 'project', title: '', content: '' });
  const [deleteTarget, SetDeleteTarget] = useState<ProfileItem | null>(null);
  const [validationAttempt, SetValidationAttempt] = useState(0);
  const fieldErrors = useMemo(() => GetProfileDraftErrors(draft), [draft]);
  const drawerRef = useRef<HTMLElement>(null);
  const editingItem = drawer?.mode === 'edit' ? drawer.item : null;

  // 每次无效保存都重新提示；编辑字段只更新红框，不反复晃动或抢走焦点。
  useEffect(() => {
    if (!validationAttempt) return;
    const controls = Array.from(drawerRef.current?.querySelectorAll<HTMLElement>('[aria-invalid="true"]') ?? []);
    controls[0]?.scrollIntoView({ block: 'nearest' });
    controls[0]?.focus({ preventScroll: true });
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const animations = controls.map((control) => control.animate(
      [{ transform: 'translateX(0)' }, { transform: 'translateX(-4px)' }, { transform: 'translateX(4px)' }, { transform: 'translateX(-3px)' }, { transform: 'translateX(3px)' }, { transform: 'translateX(0)' }],
      { duration: 320, easing: 'ease-in-out' },
    ));
    return () => animations.forEach((animation) => animation.cancel());
  }, [validationAttempt]);

  // 抽屉打开期间 Escape 关闭、初始焦点落在关闭按钮（原型 showDrawer 聚焦 dwClose）。
  useEffect(() => {
    if (!drawer) return undefined;
    const CloseOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !saveProfiles.isPending) { event.preventDefault(); SetDrawer(null); }
    };
    document.addEventListener('keydown', CloseOnEscape);
    drawerRef.current?.focus();
    return () => document.removeEventListener('keydown', CloseOnEscape);
  }, [drawer, saveProfiles.isPending]);

  // 原型档案视图：按固定分类顺序分组，组内按标题排序，保证列表稳定。
  const groups = useMemo(() => {
    const result: Array<{ category: ProfileCategory; items: ProfileItem[] }> = [];
    for (const item of [...profiles].sort((left, right) => CompareProfileCategory(left.category, right.category) || left.title.localeCompare(right.title, 'zh-Hans-CN'))) {
      const group = result.at(-1);
      if (group && group.category === item.category) group.items.push(item);
      else result.push({ category: item.category, items: [item] });
    }
    return result;
  }, [profiles]);
  const newestId = useMemo(() => profiles.reduce<ProfileItem | null>((newest, item) => (!newest || (item.updatedAt ?? 0) > (newest.updatedAt ?? 0) ? item : newest), null)?.id ?? null, [profiles]);

  function OpenNew() {
    SetValidationAttempt(0);
    SetDraft(CreateProfileDraft('project'));
    SetDrawer({ mode: 'edit', item: null });
  }
  function OpenDetail(item: ProfileItem) { SetDrawer({ mode: 'view', item }); }
  function StartEditing() {
    if (drawer?.mode !== 'view') return;
    SetValidationAttempt(0);
    SetDraft(drawer.item);
    SetDrawer({ mode: 'edit', item: drawer.item });
  }
  function SaveProfile() {
    if (saveProfiles.isPending) return;
    const errors = Object.values(fieldErrors);
    if (errors.length) {
      SetValidationAttempt((current) => current + 1);
      ShowNotice(errors[0], 'error');
      return;
    }
    if (!draft.title?.trim() || !draft.content?.trim() || !draft.category) return;
    const title = draft.title; const content = draft.content; const profileCategory = draft.category;
    const next = editingItem ? profiles.map((item) => (item.id === editingItem.id ? { ...editingItem, ...draft, updatedAt: Date.now() } : item)) : [{ id: CreateEntityId('profile'), category: profileCategory, title, content, updatedAt: Date.now() }, ...profiles];
    // 只有磁盘写入成功才关闭；错误与冲突由 mutation 处理，草稿保留供继续编辑。
    saveProfiles.mutate({ items: next }, { onSuccess: () => {
      SetDrawer((current) => current === drawer ? null : current);
      ShowNotice(editingItem ? '资料已保存' : '已新增资料', "success");
    } });
  }
  async function ConfirmDeleteProfile() {
    if (!deleteTarget || saveProfiles.isPending) return;
    const next = profiles.filter((item) => item.id !== deleteTarget.id);
    try {
      await saveProfiles.mutateAsync({ items: next });
      SetDeleteTarget(null); SetDrawer(null); ShowNotice('资料已删除', 'success');
    } catch { /* mutation 已提示失败或冲突，保留确认窗口。 */ }
  }
  function CopyEntry() {
    if (drawer?.mode !== 'view') return;
    // 剪贴板可能被系统策略拒绝；复制失败不打断阅读，只跳过确认提示。
    void navigator.clipboard?.writeText(GetProfileCopyText(drawer.item)).then(() => ShowNotice(`已复制「${drawer.item.title}」的内容`, "success")).catch(() => undefined);
  }

  const drawerTitle = drawer
    ? drawer.mode === 'view'
      ? drawer.item.title
      : draft.title?.trim() || (drawer.item ? drawer.item.title : '新建条目')
    : '';
  const drawerCategory = drawer ? (drawer.mode === 'view' ? drawer.item.category : draft.category ?? 'project') : 'project';
  return <div className="profile-view">
    <div className="view-h">
      <h1>档案</h1>
      <div className="vh-act"><button className="btn-accent" type="button" onClick={OpenNew}><Icon name="plus" size={14} />添加条目</button></div>
    </div>
    {groups.map((group) => <div key={group.category}>
      <div className="vgroup-h">{ProfileCategoryLabel[group.category]}</div>
      {group.items.map((item) => <button className="vrow clickable" type="button" key={item.id} onClick={() => OpenDetail(item)}>
        <span className="vrow-main"><span className="vrow-t">{item.title}</span><span className="vrow-d">{GetProfileSummary(item.content)}</span></span>
        <span className={`tag ${item.id === newestId ? 'accent' : ''}`}>{FormatDay(item.updatedAt)}</span>
        <Icon name="chevron-right" className="vrow-go" size={13} />
      </button>)}
    </div>)}
    {!profiles.length && <div className="profile-view-empty">还没有档案条目。点右上角「添加条目」，把项目、工作、教育和技能资料沉淀下来。</div>}

    {/* 抽屉经 portal 挂到 body：玻璃背景等祖先带动画/滤镜时 fixed 会退化为相对祖先定位，
        脱离该子树后，由共用容器将抽屉及外部点击关闭区域限制在顶部栏下方。 */}
    {drawer && createPortal(<div className="dw-layer" role="presentation">
      <div className="dw-scrim" onClick={() => SetDrawer(null)} />
      <aside className="dw-drawer" role="dialog" aria-modal="true" aria-labelledby="profile-drawer-title" tabIndex={-1} ref={drawerRef}>
        <div className="dw-head">
          <div className="dw-head-main">
            <div className="dw-title" id="profile-drawer-title">{drawerTitle}</div>
            <div className="dw-meta">
              <span>{ProfileCategoryLabel[drawerCategory]}</span>
              {drawer.mode === 'view'
                ? <span>更新于 {FormatTime(drawer.item.updatedAt) || '未知时间'}</span>
                : <span>{editingItem ? '修改后尚未保存' : '尚未保存'}</span>}
            </div>
          </div>
          <button className="icon-btn" type="button" aria-label="关闭详情" title="关闭详情" autoFocus onClick={() => SetDrawer(null)}><Icon name="close" size={16} /></button>
        </div>
        <div className="dw-body">
          {drawer.mode === 'view' ? <ProfileEntryView item={drawer.item} /> : <div className="drawer-form" inert={saveProfiles.isPending}>
            <div className="profile-draft-basics">
              <FormField label={<><i className="profile-field-required" aria-hidden="true">*</i>分类</>}><Select value={draft.category ?? 'project'} ariaLabel="资料分类" ariaRequired onChange={(value) => {
                const nextCategory = value as ProfileCategory;
                SetValidationAttempt(0);
                SetDraft(ChangeProfileDraftCategory(draft, nextCategory));
              }} options={Categories.map((item) => ({ value: item, label: ProfileCategoryLabel[item] }))} /></FormField>
              <FormField label={<><i className="profile-field-required" aria-hidden="true">*</i>标题</>}><input id="profile-title" aria-required="true" aria-invalid={Boolean(validationAttempt && fieldErrors['profile-title'])} aria-describedby={validationAttempt && fieldErrors['profile-title'] ? 'profile-title-error' : undefined} value={draft.title ?? ''} onChange={(event) => SetDraft({ ...draft, title: event.target.value })} />{Boolean(validationAttempt && fieldErrors['profile-title']) && <small className="profile-field-error" id="profile-title-error">{fieldErrors['profile-title']}</small>}</FormField>
            </div>
            {draft.category && <ProfileTemplateForm key={draft.category} category={draft.category} content={draft.content ?? ProfileTemplateForCategory(draft.category)} errors={validationAttempt ? fieldErrors : {}} onFieldChange={(sectionTitle, field, value) => SetDraft((current) => ({ ...current, content: UpdateProfileField(current.content ?? ProfileTemplateForCategory(draft.category!), sectionTitle, field, value) }))} />}
          </div>}
        </div>
        <div className="dw-foot">
          {drawer.mode === 'view' ? <>
            <button className="ghost-btn" type="button" onClick={CopyEntry}><Icon name="copy" size={14} />复制内容</button>
            <button className="btn-accent" type="button" onClick={StartEditing}><Icon name="pencil-simple" size={14} />编辑</button>
          </> : <>
            {editingItem && <button className="ghost-btn is-danger" type="button" disabled={saveProfiles.isPending} onClick={() => SetDeleteTarget(editingItem)}><Icon name="delete" size={14} />删除</button>}
            <button className="ghost-btn" type="button" onClick={() => SetDrawer(null)}>取消</button>
            <button className="btn-accent" type="button" disabled={saveProfiles.isPending} onClick={SaveProfile}><Icon name="check-circle" size={14} />{saveProfiles.isPending ? '保存中…' : '保存资料'}</button>
          </>}
        </div>
      </aside>
    </div>, document.body)}
    <Modal
      open={Boolean(deleteTarget)}
      title="删除这条资料？"
      onClose={() => { if (!saveProfiles.isPending) SetDeleteTarget(null); }}
      footer={<>
        <DialogButton disabled={saveProfiles.isPending} onClick={() => SetDeleteTarget(null)}>取消</DialogButton>
        <DialogButton disabled={saveProfiles.isPending} tone="danger" onClick={() => void ConfirmDeleteProfile()}>{saveProfiles.isPending ? '删除中…' : '确认删除'}</DialogButton>
      </>}
    >
      该操作不可撤销。
    </Modal>
  </div>;
}

export { ProfilesPage };
