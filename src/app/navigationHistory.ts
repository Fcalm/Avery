import type { PageId } from '../types/domain';
import type { SettingTab } from '../features/settings/pages/SettingsPage';

/** 一次可返回的位置：页面、会话与设置分类共同决定用户看到的界面。 */
export type RouteSnapshot = {
  page: PageId;
  conversationId: string | null;
  settingsTab: SettingTab;
};

export type NavigationHistory = { entries: RouteSnapshot[]; index: number };

/** 长期运行时限制栈长，避免只增不减；超出后丢弃最早的位置。 */
export const MaxNavigationHistory = 50;

export function CreateNavigationHistory(route: RouteSnapshot): NavigationHistory {
  return { entries: [route], index: 0 };
}

export function SameRoute(a: RouteSnapshot, b: RouteSnapshot): boolean {
  return a.page === b.page && a.conversationId === b.conversationId && a.settingsTab === b.settingsTab;
}

/** 记录一次真实跳转；后退后再跳转会丢弃原前进分支，与浏览器行为一致。 */
export function AppendRoute(history: NavigationHistory, route: RouteSnapshot): NavigationHistory {
  if (SameRoute(history.entries[history.index], route)) return history;
  const entries = [...history.entries.slice(0, history.index + 1), route];
  if (entries.length > MaxNavigationHistory) entries.splice(0, entries.length - MaxNavigationHistory);
  return { entries, index: entries.length - 1 };
}

/** 计算后退/前进后的位置；到达两端时返回 null。 */
export function MoveNavigationIndex(history: NavigationHistory, delta: -1 | 1): { history: NavigationHistory; route: RouteSnapshot } | null {
  const index = history.index + delta;
  if (index < 0 || index >= history.entries.length) return null;
  return { history: { ...history, index }, route: history.entries[index] };
}
