import { useMemo, useState } from 'react';
import { useUiStore } from '../../../app/UiStore';
import { useProfiles, useSaveProfiles } from '../../../features/profile/api/profileQueries';
import { CreateEntityId } from '../../workspace/api/workspaceData';
import { Button, Drawer, EmptyState, FormField, Modal, Select } from '../../../shared/components/UI';
import { Icon } from '../../../shared/components/Icon';
import { FormatTime, GetExcerpt, ProfileCategoryLabel } from '../../../shared/utils/format';
import type { ProfileCategory, ProfileItem } from '../../../types/domain';

const Categories: ProfileCategory[] = ['project', 'work', 'education', 'skill_certificate', 'other'];
type ProfileFilterCategory = ProfileCategory | 'all';
const FilterCategories: ProfileFilterCategory[] = ['all', ...Categories];

function ProfilesPage() {
  const { ShowNotice, setProfileConflict } = useUiStore();
  const profiles = useProfiles();
  const saveProfiles = useSaveProfiles({ onConflict: () => setProfileConflict(true), onFailure: () => ShowNotice('档案保存失败，请稍后重试。') });
  const [category, setCategory] = useState<ProfileFilterCategory>('all');
  const [query, setQuery] = useState('');
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [editing, setEditing] = useState<ProfileItem | null>(null);
  const [draft, setDraft] = useState<Partial<ProfileItem>>({ category: 'project', title: '', content: '' });
  const [deleteTarget, setDeleteTarget] = useState<ProfileItem | null>(null);
  const items = useMemo(() => profiles.filter((item) => (category === 'all' || item.category === category) && `${item.title}${item.content}`.toLowerCase().includes(query.toLowerCase())), [profiles, category, query]);
  function OpenNew() { setEditing(null); setDraft({ category: category === 'all' ? 'project' : category, title: '', content: '' }); setDrawerOpen(true); }
  function OpenEdit(item: ProfileItem) { setEditing(item); setDraft(item); setDrawerOpen(true); }
  function SaveProfile() {
    if (!draft.title?.trim() || !draft.content?.trim() || !draft.category) { ShowNotice('请填写资料标题和正文'); return; }
    const title = draft.title; const content = draft.content; const profileCategory = draft.category;
    const next = editing ? profiles.map((item) => (item.id === editing.id ? { ...editing, ...draft, updatedAt: Date.now() } : item)) : [{ id: CreateEntityId('profile'), category: profileCategory, title, content, updatedAt: Date.now() }, ...profiles];
    saveProfiles.mutate({ items: next });
    setDrawerOpen(false); ShowNotice(editing ? '资料已保存' : '已新增资料');
  }
  function ConfirmDeleteProfile() {
    if (!deleteTarget) return;
    const next = profiles.filter((item) => item.id !== deleteTarget.id);
    saveProfiles.mutate({ items: next });
    setDeleteTarget(null); setDrawerOpen(false); ShowNotice('资料已删除');
  }
  return <div className="standard-page profiles-page">
    <section className="paper-block profiles-data-card">
      <div><p className="eyebrow">档案库</p><h1>可复用的真实经历</h1><p>把项目、工作、教育和技能资料沉淀为可直接引用的内容。</p></div>
      <div className="profiles-data-summary"><span><b>{profiles.length}</b> 条资料</span><span><b>{items.length}</b> 条当前显示</span></div>
      <Button variant="primary" onClick={OpenNew}><Icon name="plus" size={16} />新建资料</Button>
    </section>
    <section className="paper-block profiles-filter-card" aria-label="档案筛选">
      <div className="tabs">{FilterCategories.map((item) => <button key={item} className={category === item ? 'selected' : ''} aria-pressed={category === item} onClick={() => setCategory(item)}>{item === 'all' ? '全部' : ProfileCategoryLabel[item]}</button>)}</div>
      <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索资料" aria-label="搜索资料" />
    </section>
    <section className="paper-block profiles-list-card">
      <header><div><h2>档案资料</h2><p>当前分类：{category === 'all' ? '全部' : ProfileCategoryLabel[category]} · {items.length} 条</p></div></header>
      {items.length === 0 ? <EmptyState icon={<Icon name="profiles" size={24} />} title="该分类还没有资料" description="新增一张资料卡，后续可以在简历中复用。" action={<Button onClick={OpenNew}>新建资料</Button>} /> : <section className="profile-grid">{items.map((item) => <article className="profile-card" key={item.id} onClick={() => OpenEdit(item)}><div className="profile-card-top"><p className="card-kicker">{ProfileCategoryLabel[item.category]}</p><Icon name="profiles" size={18} /></div><h2>{item.title}</h2><pre>{GetExcerpt(item.content)}</pre><footer>更新于 {FormatTime(item.updatedAt)}<span>查看资料</span></footer></article>)}</section>}
    </section>
    <Drawer open={drawerOpen} title={editing ? '编辑资料' : '新建资料'} onClose={() => setDrawerOpen(false)}><div className="drawer-form"><FormField label="分类"><Select value={draft.category ?? 'project'} ariaLabel="资料分类" onChange={(category) => setDraft({ ...draft, category: category as ProfileCategory })} options={Categories.map((item) => ({ value: item, label: ProfileCategoryLabel[item] }))} /></FormField><FormField label="标题"><input value={draft.title ?? ''} onChange={(event) => setDraft({ ...draft, title: event.target.value })} /></FormField><FormField label="正文"><textarea rows={12} value={draft.content ?? ''} onChange={(event) => setDraft({ ...draft, content: event.target.value })} /></FormField><div className="drawer-actions">{editing && <Button variant="danger" onClick={() => setDeleteTarget(editing)}>删除</Button>}<span /><Button onClick={() => setDrawerOpen(false)}>取消</Button><Button variant="primary" onClick={SaveProfile}>保存资料</Button></div></div></Drawer>
    <Modal open={Boolean(deleteTarget)} title="删除这条资料？" onClose={() => setDeleteTarget(null)}><p className="modal-copy">该操作不可撤销。</p><div className="modal-actions"><Button onClick={() => setDeleteTarget(null)}>取消</Button><Button variant="danger" onClick={ConfirmDeleteProfile}>确认删除</Button></div></Modal>
  </div>;
}

export { ProfilesPage };
