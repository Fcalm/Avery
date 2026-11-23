import type { Conversation } from '../../types/domain';

export type ProjectConversationGroup = { projectId: string; name: string; items: Conversation[] };

/** 项目顺序独立于活动时间保存；新对话追加，归档项保留位置以便恢复。 */
export function ExtendProjectConversationOrder(conversations: Conversation[], saved: Record<string, string>): Record<string, string> {
  const missing = conversations.filter((item) => item.projectId && !Object.hasOwn(saved, item.id));
  if (!missing.length) return saved;
  const next = { ...saved };
  let rank = Object.values(saved).reduce((max, value) => Math.max(max, Number(value) || 0), 0);
  for (const item of missing) next[item.id] = String(++rank);
  return next;
}

/** 最近是全集，项目是其子集；显式置顶优先，其余项目顺序不受消息更新和搜索影响。 */
export function BuildConversationHistory(conversations: Conversation[], order: Record<string, string>, aliases: Record<string, string>, removed: Record<string, string>, query: string) {
  const recent = conversations.filter((item) => !item.archived).sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) || (b.updatedAt ?? 0) - (a.updatedAt ?? 0) || a.id.localeCompare(b.id));
  const keyword = query.trim().toLowerCase();
  const visible = keyword ? recent.filter((item) => item.title.toLowerCase().includes(keyword)) : recent;
  const groups = new Map<string, ProjectConversationGroup>();
  const projectItems = visible.filter((item) => item.projectId && !removed[item.projectId])
    .sort((a, b) => (Number(order[a.id]) || 0) - (Number(order[b.id]) || 0) || a.id.localeCompare(b.id));
  for (const item of projectItems) {
    const projectId = item.projectId!;
    const group = groups.get(projectId);
    if (group) group.items.push(item);
    else groups.set(projectId, { projectId, name: aliases[projectId] ?? item.projectName ?? projectId, items: [item] });
  }
  // 组序仍由固定位置决定，置顶只改变组内顺序；取消后自然回到保存的位置。
  for (const group of groups.values()) group.items.sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)));
  return { recent, visible, groups: [...groups.values()] };
}
