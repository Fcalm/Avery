import { type ChangeEvent, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useUiStore } from '../../../app/UiStore';
import { useProfiles, useSaveProfiles } from '../../../features/profile/api/profileQueries';
import { ProfileEntryView, GetProfileCopyText } from '../components/ProfileEntryView';
import { CompareProfileCategory, GetProfileSummary } from '../profileView';
import { CreateEntityId } from '../../workspace/api/workspaceData';
import { Button, FormField, Modal, Select } from '../../../shared/components/UI';
import { Icon } from '../../../shared/components/Icon';
import { FormatTime, ProfileCategoryLabel } from '../../../shared/utils/format';
import type { ProfileCategory, ProfileItem } from '../../../types/domain';
import {
  ChangeProfileDraftCategory,
  CreateProfileDraft,
  DatePlaceholder,
  GetProfileField,
  IsProfileDateValue,
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
  onFieldChange,
}: {
  category: ProfileCategory;
  content: string;
  onFieldChange: (sectionTitle: string, field: string, value: string) => void;
}) {
  return <section className="application-profile-form" aria-label={`${ProfileCategoryLabel[category]}字段`}>
    <p className="profile-template-tip"><i className="profile-field-optional" aria-hidden="true">*</i> 为选填项，未标记字段为必填项。日期请使用 {DatePlaceholder} 格式。</p>
    {ProfileTemplateSections[category].map((section, sectionIndex) => <section className="application-profile-section" key={section.title} aria-labelledby={`profile-section-${sectionIndex}`}>
      <h3 id={`profile-section-${sectionIndex}`}>{section.title}</h3>
      <div className="application-profile-fields">
        {section.fields.map((field, fieldIndex) => {
          const fieldId = `profile-${category}-${sectionIndex}-${fieldIndex}`;
          const fieldValue = GetProfileField(content, section.title, field.label);
          const common = {
            id: fieldId,
            name: fieldId,
            'data-profile-field': field.label,
            placeholder: field.date ? DatePlaceholder : '请输入',
            value: fieldValue,
            onChange: (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => onFieldChange(section.title, field.label, event.target.value),
          };
          return <label className={`application-profile-field ${field.multiline ? 'is-multiline' : ''}`} htmlFor={fieldId} key={fieldId}>
            <span>{!field.required && <i className="profile-field-optional" aria-hidden="true">*</i>}{field.label}：</span>
            {/* 下拉选项统一走共享 Select 的自定义浮层，避免原生 select 的系统菜单破坏视觉一致性。 */}
            {field.options ? <Select value={fieldValue} ariaLabel={field.label} options={[{ value: '', label: '请选择' }, ...field.options.map((option) => ({ value: option, label: option }))]} onChange={(value) => onFieldChange(section.title, field.label, value)} /> : field.multiline ? <textarea rows={3} {...common} /> : <input {...common} />}
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
  const saveProfiles = useSaveProfiles({ onConflict: () => setProfileConflict(true), onFailure: () => ShowNotice('档案保存失败，请稍后重试。') });
  const [drawer, SetDrawer] = useState<ProfileDrawer | null>(null);
  const [draft, SetDraft] = useState<Partial<ProfileItem>>({ category: 'project', title: '', content: '' });
  const [deleteTarget, SetDeleteTarget] = useState<ProfileItem | null>(null);
  const drawerRef = useRef<HTMLElement>(null);
  const editingItem = drawer?.mode === 'edit' ? drawer.item : null;

  // 抽屉打开期间 Escape 关闭、初始焦点落在关闭按钮（原型 showDrawer 聚焦 dwClose）。
  useEffect(() => {
    if (!drawer) return undefined;
    const CloseOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); SetDrawer(null); }
    };
    document.addEventListener('keydown', CloseOnEscape);
    drawerRef.current?.focus();
    return () => document.removeEventListener('keydown', CloseOnEscape);
  }, [drawer]);

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
    SetDraft(CreateProfileDraft('project'));
    SetDrawer({ mode: 'edit', item: null });
  }
  function OpenDetail(item: ProfileItem) { SetDrawer({ mode: 'view', item }); }
  function StartEditing() {
    if (drawer?.mode !== 'view') return;
    SetDraft(drawer.item);
    SetDrawer({ mode: 'edit', item: drawer.item });
  }
  function SaveProfile() {
    if (!draft.title?.trim() || !draft.content?.trim() || !draft.category) { ShowNotice('请填写资料标题和正文'); return; }
    const requiredField = ProfileTemplateSections[draft.category]
      .flatMap((section) => section.fields.filter((field) => field.required).map((field) => ({ section: section.title, field })))
      .find(({ section, field }) => !GetProfileField(draft.content ?? '', section, field.label));
    if (requiredField) { ShowNotice(`请填写必填项：${requiredField.field.label}`); return; }
    const invalidDateField = ProfileTemplateSections[draft.category]
      .flatMap((section) => section.fields.filter((field) => field.date).map((field) => ({ section: section.title, field })))
      .find(({ section, field }) => {
        const value = GetProfileField(draft.content ?? '', section, field.label);
        return value && !IsProfileDateValue(value);
      });
    if (invalidDateField) { ShowNotice(`${invalidDateField.field.label}请使用 ${DatePlaceholder} 格式`); return; }
    const title = draft.title; const content = draft.content; const profileCategory = draft.category;
    const next = editingItem ? profiles.map((item) => (item.id === editingItem.id ? { ...editingItem, ...draft, updatedAt: Date.now() } : item)) : [{ id: CreateEntityId('profile'), category: profileCategory, title, content, updatedAt: Date.now() }, ...profiles];
    saveProfiles.mutate({ items: next });
    SetDrawer(null); ShowNotice(editingItem ? '资料已保存' : '已新增资料');
  }
  function ConfirmDeleteProfile() {
    if (!deleteTarget) return;
    const next = profiles.filter((item) => item.id !== deleteTarget.id);
    saveProfiles.mutate({ items: next });
    SetDeleteTarget(null); SetDrawer(null); ShowNotice('资料已删除');
  }
  function CopyEntry() {
    if (drawer?.mode !== 'view') return;
    // 剪贴板可能被系统策略拒绝；复制失败不打断阅读，只跳过确认提示。
    void navigator.clipboard?.writeText(GetProfileCopyText(drawer.item)).then(() => ShowNotice(`已复制「${drawer.item.title}」的内容`)).catch(() => undefined);
  }

  const drawerTitle = drawer
    ? drawer.mode === 'view'
      ? drawer.item.title
      : draft.title?.trim() || (drawer.item ? drawer.item.title : '新建条目')
    : '';
  const drawerCategory = drawer ? (drawer.mode === 'view' ? drawer.item.category : draft.category ?? 'project') : 'project';
  return <div className="profile-view">
    <div className="view-h">
      <div><h1>档案</h1><p>你的资料底稿，Avery 写简历、填申请表时都从这里取。点开任意一条可以看到完整内容。</p></div>
      <div className="vh-act"><button className="ghost-btn" type="button" onClick={OpenNew}><Icon name="plus" size={14} />添加条目</button></div>
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
        只有脱离该子树才能像原型一样让遮罩与虚化盖住整个应用窗口。 */}
    {drawer && createPortal(<div className="profile-drawer-layer" role="presentation">
      <div className="profile-scrim" onClick={() => SetDrawer(null)} />
      <aside className="profile-drawer" role="dialog" aria-modal="true" aria-labelledby="profile-drawer-title" tabIndex={-1} ref={drawerRef}>
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
          {drawer.mode === 'view' ? <ProfileEntryView item={drawer.item} /> : <div className="drawer-form">
            <div className="profile-draft-basics">
              <FormField label="分类"><Select value={draft.category ?? 'project'} ariaLabel="资料分类" onChange={(value) => {
                const nextCategory = value as ProfileCategory;
                SetDraft(ChangeProfileDraftCategory(draft, nextCategory));
              }} options={Categories.map((item) => ({ value: item, label: ProfileCategoryLabel[item] }))} /></FormField>
              <FormField label="标题"><input value={draft.title ?? ''} onChange={(event) => SetDraft({ ...draft, title: event.target.value })} /></FormField>
            </div>
            {draft.category && <ProfileTemplateForm key={draft.category} category={draft.category} content={draft.content ?? ProfileTemplateForCategory(draft.category)} onFieldChange={(sectionTitle, field, value) => SetDraft((current) => ({ ...current, content: UpdateProfileField(current.content ?? ProfileTemplateForCategory(draft.category!), sectionTitle, field, value) }))} />}
          </div>}
        </div>
        <div className="dw-foot">
          {drawer.mode === 'view' ? <>
            <button className="ghost-btn" type="button" onClick={CopyEntry}><Icon name="copy" size={14} />复制内容</button>
            <button className="btn-accent" type="button" onClick={StartEditing}><Icon name="pencil-simple" size={14} />编辑</button>
          </> : <>
            {editingItem && <button className="ghost-btn is-danger" type="button" onClick={() => SetDeleteTarget(editingItem)}><Icon name="delete" size={14} />删除</button>}
            <button className="ghost-btn" type="button" onClick={() => SetDrawer(null)}>取消</button>
            <button className="btn-accent" type="button" onClick={SaveProfile}><Icon name="check-circle" size={14} />保存资料</button>
          </>}
        </div>
      </aside>
    </div>, document.body)}
    <Modal open={Boolean(deleteTarget)} title="删除这条资料？" onClose={() => SetDeleteTarget(null)}><p className="modal-copy">该操作不可撤销。</p><div className="modal-actions"><Button onClick={() => SetDeleteTarget(null)}>取消</Button><Button variant="danger" onClick={ConfirmDeleteProfile}>确认删除</Button></div></Modal>
  </div>;
}

export { ProfilesPage };
