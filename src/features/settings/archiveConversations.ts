import type { Conversation } from '../../types/domain';

export const ArchiveRetentionDays = 30;
export const ArchiveDayMs = 86_400_000;
export type ArchiveSort = 'expiry' | 'archive';

/** 归档管理的展示契约；时间由服务端提供，缺省不以消息更新时间或本机时间冒充。 */
export interface ArchivedConversationItem {
  id: string;
  title: string;
  revision?: number;
  projectId: string | null;
  projectName: string;
  projectRemoved: boolean;
  archivedAt: number | null;
  autoDeleteAt: number | null;
}

type ArchiveSource = Conversation & { archivedAt?: number | null; autoDeleteAt?: number | null };
export interface ArchiveProjectPreferences { aliases: Record<string, string>; removed: Record<string, string> }

/** 与导航栏共用本机分组展示偏好；移除分组不会改变会话原有项目绑定。 */
export function ReadArchiveProjectPreferences(): ArchiveProjectPreferences {
  function Read(key: string): Record<string, string> {
    try {
      const value: unknown = JSON.parse(localStorage.getItem(key) ?? 'null');
      return value && typeof value === 'object' && !Array.isArray(value)
        ? Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string')) : {};
    } catch { return {}; }
  }
  return { aliases: Read('avery-project-group-aliases'), removed: Read('avery-project-group-removed') };
}

function Timestamp(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 8_640_000_000_000_000 ? value : null;
}

export function BuildArchivedConversations(conversations: readonly ArchiveSource[], preferences: ArchiveProjectPreferences): ArchivedConversationItem[] {
  return conversations.filter((item) => item.archived).map((item) => ({
    id: item.id, title: item.title, revision: item.revision,
    projectId: item.projectId || null,
    projectName: item.projectId ? preferences.aliases[item.projectId] ?? item.projectName ?? item.projectId : '未分组',
    projectRemoved: Boolean(item.projectId && preferences.removed[item.projectId]),
    archivedAt: Timestamp(item.archivedAt), autoDeleteAt: Timestamp(item.autoDeleteAt),
  }));
}

export function ArchiveProjectLabel(item: ArchivedConversationItem): string {
  return item.projectName + (item.projectRemoved ? '（已移除）' : '');
}

export function ArchiveProjectKey(item: ArchivedConversationItem): string {
  return item.projectId ? `project:${item.projectId}` : 'ungrouped';
}

/** 无截止时间的历史记录排在最后；同名项目仍按 ID 区分，排序不改变源数组。 */
export function FilterArchivedConversations(items: readonly ArchivedConversationItem[], query: string, project: string, sort: ArchiveSort): ArchivedConversationItem[] {
  const keyword = query.trim().toLocaleLowerCase();
  return items.filter((item) => item.title.toLocaleLowerCase().includes(keyword) && (project === 'all' || ArchiveProjectKey(item) === project))
    .sort((left, right) => {
      const a = sort === 'expiry' ? left.autoDeleteAt : left.archivedAt;
      const b = sort === 'expiry' ? right.autoDeleteAt : right.archivedAt;
      if (a === null) return b === null ? 0 : 1;
      if (b === null) return -1;
      return sort === 'expiry' ? a - b : b - a;
    });
}

/** 到期仅显示待清理，实际删除须由后端确认；页面计时不会移除会话。 */
export function FormatArchiveRemaining(expiresAt: number | null, now: number): string {
  if (expiresAt === null) return '未设定';
  if (expiresAt <= now) return '待清理';
  const minutes = Math.ceil((expiresAt - now) / 60_000);
  if (minutes >= 1440) {
    const hours = Math.floor(minutes % 1440 / 60);
    return `${Math.floor(minutes / 1440)} 天${hours ? ` ${hours} 小时` : ''}`;
  }
  if (minutes >= 60) return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分钟`;
  return `${minutes} 分钟`;
}
