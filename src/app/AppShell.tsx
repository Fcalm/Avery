import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { MainRoutes } from './routes';
import { useUiStore } from './UiStore';
import { useConversations, useRenameConversation, useSetConversationArchived, useSetConversationPinned } from '../features/conversation/api/conversationQueries';
import { GetAgentSessionScenes } from '../features/assistant/api/agentQueries';
import { useSettingsStore } from '../features/settings/api/settingsQueries';
import type { Conversation, PageId } from '../types/domain';
import { DialogButton, Modal } from '../shared/components/UI';
import { Icon } from '../shared/components/Icon';
import { GetAgentBalance, IsDesktopAgentAvailable } from '../features/assistant/api/agentQueries';
import { ASSISTANT_MAIN_MIN_WIDTH } from '../shared/layoutConstants';
import { ListEvalRuns } from '../features/developer/api/evaluationQueries';
import { DeveloperSidebar } from '../features/developer/components/DeveloperSidebar';
import { useDeveloperConsole } from '../features/developer/components/DeveloperConsoleContext';
import { SettingsTabs, type SettingTab } from '../features/settings/pages/SettingsPage';

const MinContentWidth = 800;

type WindowControls = {
  Minimize: () => Promise<boolean>;
  ToggleMaximize: () => Promise<boolean>;
  Close: () => Promise<boolean>;
};

type ThemeMode = 'light' | 'dark';

/** 会话行"更多"菜单的固定定位信息：按触发按钮的位置计算， Escape 或点击外部关闭。 */
type RowMenuPosition = { conversationId: string; left: number; top: number };

/** 项目空间分组"更多"菜单：count 用于删除确认文案。 */
type GroupMenuPosition = { projectId: string; name: string; count: number; left: number; top: number };

/** 项目空间分组：按创建时定格的 projectId 聚合，展示名支持本地别名。 */
type ProjectGroup = { projectId: string; name: string; items: Conversation[] };

/** 分组展示偏好只存本机：别名是侧栏显示名，移除分组只是把板块从侧栏收起，都不改会话的项目绑定。 */
const GroupAliasesKey = 'avery-project-group-aliases';
const RemovedGroupsKey = 'avery-project-group-removed';

function LoadLocalMap(key: string): Record<string, string> {
  try {
    const parsed = JSON.parse(localStorage.getItem(key) ?? 'null');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
      : {};
  } catch { return {}; }
}

function SaveLocalMap(key: string, value: Record<string, string>): void {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* 存储不可用时偏好仅本次会话生效 */ }
}

/** 待归档会话：确认弹窗标题里需要会话名。 */
type ArchiveTarget = { id: string; title: string };

/** 顶栏品牌标记：与原型一致的 A 字轮廓。 */
const BrandMark = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M5.5 19.5 12 4.5l6.5 15" />
    <path d="M8.6 13.4h6.8" />
  </svg>
);

function FormatBalance(currency: string, total: string) {
  const number = Number(total);
  const amount = Number.isFinite(number) ? number.toFixed(2) : total;
  return currency === 'CNY' ? `¥ ${amount}` : currency === 'USD' ? `$ ${amount}` : `${currency} ${amount}`;
}

function AppShell({ page, onNavigate, onRestartOnboarding, settingsTab, onRequestSettingsTab, children }: { page: PageId; onNavigate: (page: PageId) => void; onRestartOnboarding: () => void; settingsTab: SettingTab; onRequestSettingsTab: (tab: SettingTab) => void; children: ReactNode }) {
  const conversations = useConversations();
  const renameConversation = useRenameConversation({ onConflict: () => ShowNotice('会话已在其他窗口被修改，已刷新为最新版本'), onFailure: () => ShowNotice('会话重命名失败，请稍后重试。') });
  const pinConversation = useSetConversationPinned({ onConflict: () => ShowNotice('会话已在其他窗口被修改，已刷新为最新版本'), onFailure: () => ShowNotice('会话置顶失败，请稍后重试。') });
  const archiveConversation = useSetConversationArchived({ onConflict: () => ShowNotice('会话已在其他窗口被修改，已刷新为最新版本'), onFailure: () => ShowNotice('会话归档失败，请稍后重试。') });
  const { settings, setSettings, saveSettingsNow } = useSettingsStore();
  // 开发者页是带独立侧栏的顶级页面：面包屑、Ctrl K 与导航指示器都要读取评测域的共享状态。
  const { projects: evalProjects, selectedProject: selectedEvalProject, SelectProject: SelectEvalProject, view: developerView, OpenCreate: OpenCreateEval } = useDeveloperConsole();
  const { activeConversationId, setActiveConversationId, resumePanelOpen, setResumePanelOpen, assistantView, setAssistantView, ShowNotice } = useUiStore();
  const activeConversation = conversations.find((item) => item.id === activeConversationId);

  const [collapsed, SetCollapsed] = useState(false);
  const [theme, SetTheme] = useState<ThemeMode>(() => (localStorage.getItem('avery-theme') === 'dark' ? 'dark' : 'light'));
  const [showCrumbMenu, SetShowCrumbMenu] = useState(false);
  const [userMenuPosition, SetUserMenuPosition] = useState<{ left: number; bottom: number } | null>(null);
  const [rowMenu, SetRowMenu] = useState<RowMenuPosition | null>(null);
  const [renamingConversationId, SetRenamingConversationId] = useState<string | null>(null);
  const [renameTitle, SetRenameTitle] = useState('');
  const [archiveTarget, SetArchiveTarget] = useState<ArchiveTarget | null>(null);
  const [searchOpen, SetSearchOpen] = useState(false);
  const [searchQuery, SetSearchQuery] = useState('');
  const [balance, setBalance] = useState<Array<{ currency: string; totalBalance: string }> | null>(null);
  const [refreshingBalance, setRefreshingBalance] = useState(false);
  const [isMaximized, SetIsMaximized] = useState(false);

  // 场景标注以创建时落库的 scenarioId 为准（快照与 Agent 冻结语义一致，无运行态竞态）；
  // 本功能上线前的旧会话缺失元数据时，回退读取 Agent 运行态场景映射，避免旧工作会话被误标为聊天。
  const [legacyScenes, SetLegacyScenes] = useState<Record<string, 'default' | 'application'>>({});
  const conversationIdsKey = conversations.map((item) => item.id).join(',');
  const hasLegacyConversations = conversations.some((item) => item.scenarioId === undefined);
  useEffect(() => {
    if (!hasLegacyConversations) return undefined;
    let cancelled = false;
    GetAgentSessionScenes().then((scenes) => { if (!cancelled) SetLegacyScenes(scenes); }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [hasLegacyConversations, conversationIdsKey]);
  const SceneOf = (item: Conversation) => ((item.scenarioId ?? legacyScenes[item.id]) === 'application' ? '工作' : '聊天');

  // 项目空间分组的本机展示偏好：别名与已移除分组。
  const [groupAliases, SetGroupAliases] = useState<Record<string, string>>(() => LoadLocalMap(GroupAliasesKey));
  const [removedGroups, SetRemovedGroups] = useState<Record<string, string>>(() => LoadLocalMap(RemovedGroupsKey));
  const [groupMenu, SetGroupMenu] = useState<GroupMenuPosition | null>(null);
  const [renameGroupTarget, SetRenameGroupTarget] = useState<{ projectId: string; name: string } | null>(null);
  const [renameGroupValue, SetRenameGroupValue] = useState('');
  const [removeGroupTarget, SetRemoveGroupTarget] = useState<{ projectId: string; name: string; count: number } | null>(null);

  const appShellRef = useRef<HTMLDivElement>(null);
  const navRef = useRef<HTMLElement>(null);
  const navIndicatorRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const renamingConversationIdRef = useRef<string | null>(null);
  const activeConversationIdRef = useRef<string | null>(activeConversationId);
  activeConversationIdRef.current = activeConversationId;

  const windowControls = (window as Window & { averyWindow?: WindowControls }).averyWindow;
  const minimumContentWidth = page === 'assistant' ? ASSISTANT_MAIN_MIN_WIDTH : MinContentWidth;
  // 原型导航顺序与命名：对话、岗位、简历、投递记录、档案；开发者入口仅在开启后出现。
  const navRouteOrder: PageId[] = ['assistant', 'jobs', 'resumes', 'applications', 'profiles', 'developer'];
  const navRoutes = navRouteOrder.flatMap((id) => {
    const route = MainRoutes.find((item) => item.id === id);
    return route && (route.id !== 'developer' || settings.developerMode) ? [route] : [];
  });
  // "最近"与会话切换菜单只展示未归档会话；置顶会话排最前，组内保持最近使用顺序（排序稳定）。
  const liveConversations = conversations.filter((item) => !(item.archived ?? false)).slice().sort((a, b) => Number(b.pinned ?? false) - Number(a.pinned ?? false));
  const searchKeyword = searchQuery.trim().toLowerCase();
  const visibleConversations = searchKeyword ? liveConversations.filter((item) => item.title.toLowerCase().includes(searchKeyword)) : liveConversations;
  // 项目空间分组：按创建时定格的 projectId 聚合，组序跟随组内最近使用时间，组内保持「最近」的置顶优先顺序；
  // 被用户移除的分组（本机偏好）不再成组，其会话回到未分组区。
  const conversationGroups: ProjectGroup[] = (() => {
    const groups = new Map<string, ProjectGroup>();
    for (const item of visibleConversations) {
      if (!item.projectId || removedGroups[item.projectId]) continue;
      const group = groups.get(item.projectId);
      if (group) group.items.push(item);
      else groups.set(item.projectId, { projectId: item.projectId, name: groupAliases[item.projectId] ?? item.projectName ?? item.projectId, items: [item] });
    }
    return [...groups.values()].sort((left, right) => Math.max(...right.items.map((item) => item.updatedAt ?? 0)) - Math.max(...left.items.map((item) => item.updatedAt ?? 0)));
  })();
  const groupedConversationIds = new Set(conversationGroups.flatMap((group) => group.items.map((item) => item.id)));
  const ungroupedConversations = visibleConversations.filter((item) => !groupedConversationIds.has(item.id));
  const crumbLeaf = page === 'assistant' ? (activeConversation?.title ?? '新对话') : MainRoutes.find((route) => route.id === page)?.label ?? '';
  const balanceText = refreshingBalance && !balance ? '刷新中…' : balance?.map((item) => FormatBalance(item.currency, item.totalBalance)).join(' / ') ?? '未配置';

  const RefreshBalance = useCallback(async (manual = false) => {
    if (!IsDesktopAgentAvailable() || settings.provider !== 'DeepSeek') return;
    setRefreshingBalance(true);
    try {
      const result = await GetAgentBalance();
      setBalance(result.balances);
      if (manual) ShowNotice('余额已刷新');
    } catch (error) {
      if (manual) ShowNotice(error instanceof Error ? error.message : '余额刷新失败');
    } finally {
      setRefreshingBalance(false);
    }
  }, [ShowNotice, settings.provider]);

  useEffect(() => {
    void RefreshBalance();
    const timer = window.setInterval(() => void RefreshBalance(), 5 * 60 * 1000);
    return () => window.clearInterval(timer);
  }, [RefreshBalance]);

  // 主题即时生效并持久化；默认浅色，切换入口在账户菜单。
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem('avery-theme', theme);
  }, [theme]);

  // 菜单打开期间统一处理：Escape 关闭，点击触发器与浮层以外的区域关闭。
  const anyMenuOpen = showCrumbMenu || userMenuPosition !== null || rowMenu !== null || groupMenu !== null;
  useEffect(() => {
    if (!anyMenuOpen) return undefined;
    const CloseOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { SetShowCrumbMenu(false); SetUserMenuPosition(null); SetRowMenu(null); SetGroupMenu(null); }
    };
    const CloseOnOutsidePointer = (event: PointerEvent) => {
      const target = event.target as Element | null;
      if (target?.closest('[data-menu-trigger],[data-floating-menu]')) return;
      SetShowCrumbMenu(false); SetUserMenuPosition(null); SetRowMenu(null); SetGroupMenu(null);
    };
    window.addEventListener('keydown', CloseOnEscape);
    document.addEventListener('pointerdown', CloseOnOutsidePointer);
    return () => { window.removeEventListener('keydown', CloseOnEscape); document.removeEventListener('pointerdown', CloseOnOutsidePointer); };
  }, [anyMenuOpen]);

  // 原型同款 Ctrl K：工作区聚焦"新建对话"，开发者页聚焦"新建评测"；输入场景中不拦截。
  useEffect(() => {
    const HandleNewChatShortcut = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 'k') return;
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
      event.preventDefault();
      if (page === 'developer') { OpenCreateEval(); return; }
      setActiveConversationId(null);
      onNavigate('assistant');
    };
    window.addEventListener('keydown', HandleNewChatShortcut);
    return () => window.removeEventListener('keydown', HandleNewChatShortcut);
  }, [page, onNavigate, setActiveConversationId, OpenCreateEval]);

  // 导航滑动指示器：测量当前项的位置，折叠动画结束后再校准一次。
  // settingsTab 变化时设置侧栏的指示器也要跟随移动。
  const MoveNavIndicator = useCallback(() => {
    const nav = navRef.current;
    const indicator = navIndicatorRef.current;
    if (!nav || !indicator) return;
    const active = nav.querySelector<HTMLButtonElement>('.nav-item.is-active');
    if (!active) { indicator.style.opacity = '0'; return; }
    indicator.style.opacity = '1';
    indicator.style.height = `${active.offsetHeight}px`;
    indicator.style.transform = `translateY(${active.offsetTop}px)`;
  }, []);

  useEffect(() => {
    MoveNavIndicator();
    window.addEventListener('resize', MoveNavIndicator);
    const timer = window.setTimeout(MoveNavIndicator, 420);
    document.fonts?.ready.then(MoveNavIndicator).catch(() => undefined);
    return () => { window.removeEventListener('resize', MoveNavIndicator); window.clearTimeout(timer); };
  }, [MoveNavIndicator, page, settingsTab, collapsed, settings.developerMode, developerView]);

  function HandleNewConversation() {
    // 仅切换到未保存草稿；首次发送时由助手页创建实际会话，避免空会话进入历史列表。
    setActiveConversationId(null);
    onNavigate('assistant');
  }

  function HandleToggleTrace() {
    setAssistantView(assistantView === 'chat' ? 'trace' : 'chat');
  }

  async function HandleToggleMaximize() {
    SetIsMaximized(await windowControls?.ToggleMaximize() ?? false);
  }

  async function HandleDeveloperModeChange(enabled: boolean) {
    if (!enabled) {
      try {
        const runs = await ListEvalRuns();
        if (runs.some((run) => !['completed', 'failed', 'cancelled'].includes(run.status))) {
          ShowNotice('存在未结束的测评，请先取消或等待完成');
          return;
        }
      } catch (error) {
        ShowNotice(error instanceof Error ? error.message : '无法确认测评运行状态');
        return;
      }
    }
    const next = { ...settings, developerMode: enabled };
    try {
      await saveSettingsNow(next);
      setSettings(() => next);
    } catch (error) {
      ShowNotice(error instanceof Error ? error.message : '保存开发者模式失败');
      return;
    }
    if (!enabled && page === 'developer') onNavigate('settings');
    ShowNotice(enabled ? '开发者模式已开启' : '开发者模式已关闭');
  }

  function HandleResumePanel() {
    if (resumePanelOpen && page === 'assistant') { setResumePanelOpen(false); return; }
    setResumePanelOpen(true);
    if (page !== 'assistant') onNavigate('assistant');
  }

  function BeginRenameConversation(id: string, title: string) {
    SetRowMenu(null);
    renamingConversationIdRef.current = id;
    SetRenamingConversationId(id);
    SetRenameTitle(title);
  }
  function CommitConversationRename() {
    const id = renamingConversationIdRef.current;
    const title = renameTitle.trim();
    renamingConversationIdRef.current = null;
    SetRenamingConversationId(null);
    if (!id || !title || title === conversations.find((item) => item.id === id)?.title) return;
    const expectedRevision = conversations.find((item) => item.id === id)?.revision;
    renameConversation.mutate({ id, title, expectedRevision });
  }
  function HandleToggleConversationPin(id: string) {
    const conversation = conversations.find((item) => item.id === id);
    if (!conversation) return;
    const pinned = !(conversation.pinned ?? false);
    SetRowMenu(null);
    pinConversation.mutate({ id, pinned, expectedRevision: conversation.revision }, {
      onSuccess: () => ShowNotice(pinned ? `已置顶「${conversation.title}」` : `已取消置顶「${conversation.title}」`),
    });
  }
  async function ConfirmArchiveConversation() {
    if (!archiveTarget) return;
    const { id, title } = archiveTarget;
    const wasActive = activeConversationIdRef.current === id;
    SetArchiveTarget(null);
    try {
      await archiveConversation.mutateAsync({ id, archived: true });
      // 归档当前会话时切换到下一个未归档会话，避免停留在已从"最近"移出的会话上。
      if (wasActive) {
        const next = conversations.find((item) => item.id !== id && !(item.archived ?? false));
        setActiveConversationId(next?.id ?? null);
      }
      ShowNotice(`已归档「${title}」`, 'success', {
        duration: 5200,
        action: {
          label: '撤回',
          run: () => {
            archiveConversation.mutate({ id, archived: false }, {
              onSuccess: () => {
                if (wasActive) setActiveConversationId(id);
                ShowNotice(`已恢复「${title}」`);
              },
            });
          },
        },
      });
    } catch {
      // 失败提示由统一 mutation 处理；归档失败时会话保持原状。
    }
  }

  /** 打开会话行"更多"菜单：菜单宽 186px，贴按钮右缘展开，空间不足时向上翻。 */
  function OpenRowMenu(conversationId: string, trigger: HTMLButtonElement) {
    const rect = trigger.getBoundingClientRect();
    const width = 186;
    const estimatedHeight = 150;
    const sidebarLeft = appShellRef.current?.querySelector<HTMLElement>('.sidebar')?.getBoundingClientRect().left ?? 0;
    const left = Math.max(sidebarLeft + 6, rect.right - width);
    let top = rect.bottom + 6;
    if (top + estimatedHeight > window.innerHeight - 10) top = rect.top - estimatedHeight;
    SetRowMenu({ conversationId, left: Math.round(left), top: Math.round(Math.max(8, top)) });
  }
  /** 打开项目空间分组"更多"菜单：与行菜单同款定位（宽 186px、贴按钮右缘、空间不足向上翻）。 */
  function OpenGroupMenu(projectId: string, name: string, count: number, trigger: HTMLButtonElement) {
    const rect = trigger.getBoundingClientRect();
    const width = 186;
    const estimatedHeight = 96;
    const sidebarLeft = appShellRef.current?.querySelector<HTMLElement>('.sidebar')?.getBoundingClientRect().left ?? 0;
    const left = Math.max(sidebarLeft + 6, rect.right - width);
    let top = rect.bottom + 6;
    if (top + estimatedHeight > window.innerHeight - 10) top = rect.top - estimatedHeight;
    SetGroupMenu({ projectId, name, count, left: Math.round(left), top: Math.round(Math.max(8, top)) });
  }
  function BeginRenameGroup(projectId: string, name: string) {
    SetGroupMenu(null);
    SetRenameGroupValue(groupAliases[projectId] ?? name);
    SetRenameGroupTarget({ projectId, name });
  }
  /** 保存分组别名：留空或与原名相同即移除别名；仅影响侧栏显示名，不改磁盘目录与会话绑定。 */
  function CommitGroupRename() {
    const target = renameGroupTarget;
    SetRenameGroupTarget(null);
    if (!target) return;
    const alias = renameGroupValue.trim().slice(0, 200);
    const next = { ...groupAliases };
    if (!alias || alias === target.name) {
      if (!next[target.projectId]) return;
      delete next[target.projectId];
    } else {
      next[target.projectId] = alias;
    }
    SetGroupAliases(next);
    SaveLocalMap(GroupAliasesKey, next);
  }
  /** 删除分组只是把板块从侧栏收起：组内对话回到「最近」，会话数据与项目空间绑定保持不变。 */
  function ConfirmRemoveGroup() {
    const target = removeGroupTarget;
    SetRemoveGroupTarget(null);
    if (!target) return;
    const next = { ...removedGroups, [target.projectId]: target.name };
    SetRemovedGroups(next);
    SaveLocalMap(RemovedGroupsKey, next);
    ShowNotice(`已移除分组「${target.name}」，组内对话回到「最近」`);
  }
  function OpenUserMenu(trigger: HTMLButtonElement) {
    if (userMenuPosition) { SetUserMenuPosition(null); return; }
    const rect = trigger.getBoundingClientRect();
    SetUserMenuPosition({ left: Math.round(rect.left), bottom: Math.round(window.innerHeight - rect.top + 7) });
  }
  /** 侧栏用户头像：上传过图片直接渲染；否则显示昵称首字并应用个性化底色（设置页与侧栏共用同一份设置）。 */
  function RenderUserAvatar() {
    return <span className="avatar" data-av={settings.avatarStyle ?? 'default'} aria-hidden="true">{settings.avatarImage ? <img src={settings.avatarImage} alt="" /> : settings.nickname.slice(0, 1) || 'A'}</span>;
  }
  function ToggleSearch() {
    SetSearchOpen((open) => {
      if (!open) window.setTimeout(() => searchInputRef.current?.focus(), 120);
      else SetSearchQuery('');
      return !open;
    });
  }

  /** 会话行（阅读态/行内重命名态）：分组内与未分组区共用；图标随置顶与场景切换。 */
  function RenderConversationRow(item: Conversation) {
    const isCurrent = item.id === activeConversationId && page === 'assistant';
    return <div key={item.id} className="ti-wrap" data-conversation-id={item.id}>
      {renamingConversationId === item.id ? <input className="ti-rename" value={renameTitle} maxLength={120} aria-label="重命名对话" autoFocus onFocus={(event) => event.currentTarget.select()} onChange={(event) => SetRenameTitle(event.target.value)} onKeyDown={(event) => {
        if (event.key === 'Enter') { event.preventDefault(); CommitConversationRename(); }
        else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); renamingConversationIdRef.current = null; SetRenamingConversationId(null); }
      }} onBlur={CommitConversationRename} /> : <>
        <button className={`thread-item ${item.pinned ? 'pinned' : ''} ${isCurrent ? 'active' : ''}`} type="button" title={item.title} onClick={() => { setActiveConversationId(item.id); onNavigate('assistant'); }}>
          <Icon name={item.pinned ? 'pin' : item.scenarioId === 'application' ? 'briefcase' : 'assistant'} size={16} weight={item.pinned ? 'fill' : 'regular'} />
          <span className="ti-body"><span className="ti-title">{item.title}</span><span className="ti-meta">{SceneOf(item)}</span></span>
        </button>
        <button className="ti-more" type="button" data-menu-trigger="row" aria-haspopup="menu" aria-label="更多操作" title="更多操作" onClick={(event) => OpenRowMenu(item.id, event.currentTarget)}><Icon name="more" size={14} /></button>
      </>}
    </div>;
  }

  return <div ref={appShellRef} className={`app-shell ${collapsed ? 'is-collapsed' : ''}`} style={{ '--main-content-min-width': `${minimumContentWidth}px` } as CSSProperties}>
    <header className="topbar">
      <div className="tb-group">
        <button className="icon-btn" type="button" aria-label={collapsed ? '展开侧栏' : '收起侧栏'} aria-pressed={!collapsed} title={collapsed ? '展开侧栏' : '收起侧栏'} onClick={() => SetCollapsed((value) => !value)}><Icon name="sidebar-expand" size={17} /></button>
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">{BrandMark}</span>
          <span className="brand-name">Avery</span>
        </div>
        <span className="tb-div" aria-hidden="true" />
        <div className="crumb">
          {page === 'settings' ? <>
            <span className="crumb-root">设置</span>
            <Icon name="chevron-right" size={12} className="crumb-sep" />
            <b className="crumb-last">{SettingsTabs.find((item) => item.id === settingsTab)?.label}</b>
          </> : page === 'developer' ? <>
            {/* 与原型的开发者页一致：面包屑根是页面名，叶子下拉用于快速切换评测记录 */}
            <span className="crumb-root">开发者工具</span>
            <Icon name="chevron-right" size={12} className="crumb-sep" />
            <div className="menu-wrap">
              <button className="crumb-btn" type="button" data-menu-trigger="crumb" aria-expanded={showCrumbMenu} aria-haspopup="menu" title="切换评测记录" onClick={() => SetShowCrumbMenu((value) => !value)}>
                <b className="crumb-last">{selectedEvalProject?.name ?? '评测记录'}</b>
                <Icon name="chevron-down" size={12} className="chev" />
              </button>
              {showCrumbMenu && <div className="menu drop lg open" data-floating-menu role="menu" aria-label="切换评测记录">
                <button className="menu-item plain" type="button" onClick={() => { SetShowCrumbMenu(false); OpenCreateEval(); }}><Icon name="plus" size={16} /><span className="mt">新建评测</span></button>
                <div className="menu-sep" aria-hidden="true" />
                {evalProjects.map((project) => <button key={project.id} type="button" role="menuitemradio" aria-checked={project.id === selectedEvalProject?.id} className={`menu-item ${project.id === selectedEvalProject?.id ? 'sel' : ''}`} title={project.name} onClick={() => { SelectEvalProject(project.id); SetShowCrumbMenu(false); }}>
                  <Icon name="flask" size={16} />
                  <span><span className="mt">{project.name}</span></span>
                  <Icon name="check" size={14} className="tick" />
                </button>)}
                {!evalProjects.length && <div className="menu-label">还没有评测</div>}
              </div>}
            </div>
          </> : <>
            <span className="crumb-root">{page === 'assistant' ? '求职' : '工作区'}</span>
            <Icon name="chevron-right" size={12} className="crumb-sep" />
            <div className="menu-wrap">
              <button className="crumb-btn" type="button" data-menu-trigger="crumb" aria-expanded={showCrumbMenu} aria-haspopup="menu" title="切换会话" onClick={() => SetShowCrumbMenu((value) => !value)}>
                <b className="crumb-last">{crumbLeaf}</b>
                <Icon name="chevron-down" size={12} className="chev" />
              </button>
              {showCrumbMenu && <div className="menu drop lg open" data-floating-menu role="menu" aria-label="快速切换会话">
                <button className="menu-item plain" type="button" onClick={HandleNewConversation}><Icon name="plus" size={16} /><span className="mt">新建对话</span></button>
                <div className="menu-sep" aria-hidden="true" />
                {liveConversations.map((item) => <button key={item.id} type="button" role="menuitemradio" aria-checked={item.id === activeConversationId} className={`menu-item ${item.id === activeConversationId ? 'sel' : ''}`} title={item.title} onClick={() => { setActiveConversationId(item.id); SetShowCrumbMenu(false); onNavigate('assistant'); }}>
                  <Icon name={item.pinned ? 'pin' : 'assistant'} size={16} weight={item.pinned ? 'fill' : 'regular'} />
                  <span><span className="mt">{item.title}</span><span className="md">{SceneOf(item)}</span></span>
                  <Icon name="check" size={14} className="tick" />
                </button>)}
                {!liveConversations.length && <div className="menu-label">还没有会话</div>}
              </div>}
            </div>
          </>}
        </div>
      </div>

      <div className="tb-spacer" />

      {page === 'assistant' && <div className="tb-actions">
        {/* 按钮声明去向：轨迹视图下显示"对话"引导返回，图标随目标切换 */}
        <button className="tb-txt-btn" type="button" aria-pressed={assistantView === 'trace'} title={assistantView === 'trace' ? '切换至对话' : '切换至对话轨迹'} onClick={HandleToggleTrace}><Icon name={assistantView === 'trace' ? 'assistant' : 'trace'} size={14} /><span>{assistantView === 'trace' ? '对话' : '对话轨迹'}</span></button>
        {/* 原型 rsToggle：字形镜像指向右侧面板，展开时用填充字重 */}
        <button className="icon-btn flip" type="button" aria-expanded={resumePanelOpen} aria-label={resumePanelOpen ? '收起右侧边栏' : '展开右侧边栏'} title={resumePanelOpen ? '收起右侧边栏' : '展开右侧边栏'} onClick={HandleResumePanel}><Icon name="sidebar-expand" size={17} weight={resumePanelOpen ? 'fill' : 'regular'} /></button>
      </div>}
      {page === 'assistant' && <span className="tb-div" aria-hidden="true" />}

      <div className="tb-group win-ctl">
        <button className="win-btn" type="button" aria-label="最小化" title="最小化" onClick={() => void windowControls?.Minimize()}><Icon name="window-minimize" size={15} /></button>
        <button className="win-btn" type="button" aria-label={isMaximized ? '向下还原' : '最大化'} title={isMaximized ? '向下还原' : '最大化'} onClick={() => void HandleToggleMaximize()}><Icon name={isMaximized ? 'window-restore' : 'window-maximize'} size={15} /></button>
        <button className="win-btn close" type="button" aria-label="关闭" title="关闭" onClick={() => void windowControls?.Close()}><Icon name="close" size={15} /></button>
      </div>
    </header>

    <div className="app-body">
      <aside className="sidebar" aria-label={page === 'settings' ? '设置导航' : page === 'developer' ? '开发者工具' : '主导航'}>
        {page === 'settings' ? <div className="sb-inner">
          {/* 原型设置侧栏：主色返回入口 + 带指示器的分类导航 + 用户卡 */}
          <button className="sb-new-chat" type="button" onClick={() => onNavigate('assistant')} title="返回工作区">
            <Icon name="arrow-left" size={15} />
            <span>返回工作区</span>
          </button>
          <div className="sb-scroll">
            <nav className="nav" ref={navRef} role="tablist" aria-label="设置分类">
              <div className="nav-ind" ref={navIndicatorRef} aria-hidden="true" />
              {SettingsTabs.map((item) => <button key={item.id} className={`nav-item ${settingsTab === item.id ? 'is-active' : ''}`} type="button" role="tab" aria-selected={settingsTab === item.id} title={item.label} onClick={() => onRequestSettingsTab(item.id)}>
                <Icon name={item.id === 'general' ? 'settings' : item.id === 'persona' ? 'account' : item.id === 'api' ? 'sliders' : item.id === 'browser' ? 'browser' : 'developer-mode'} size={17} />
                <span>{item.label}</span>
              </button>)}
            </nav>
          </div>
          <div className="sb-foot">
            <div className="uc-row">
              <button className="user-card" type="button" data-menu-trigger="user" aria-expanded={userMenuPosition !== null} aria-haspopup="menu" title="账户" onClick={(event) => OpenUserMenu(event.currentTarget)}>
                <RenderUserAvatar />
                <span className="uc-body"><span className="uc-name">{settings.nickname}</span></span>
                <Icon name="chevron-up" size={12} className="chev" />
              </button>
            </div>
          </div>
        </div> : page === 'developer' ? <div className="sb-inner">
          {/* 开发者页专属侧栏：新建评测 + 评估/对比/运行日志导航 + 评测记录列表；用户卡与"返回工作区"留在壳层 */}
          <DeveloperSidebar navRef={navRef} indicatorRef={navIndicatorRef} />
          <div className="sb-foot">
            <div className="uc-row">
              <button className="user-card" type="button" data-menu-trigger="user" aria-expanded={userMenuPosition !== null} aria-haspopup="menu" title="账户" onClick={(event) => OpenUserMenu(event.currentTarget)}>
                <RenderUserAvatar />
                <span className="uc-body"><span className="uc-name">{settings.nickname}</span></span>
                <Icon name="chevron-up" size={12} className="chev" />
              </button>
              <button className="icon-btn" type="button" aria-label="返回工作区" title="返回工作区" onClick={() => onNavigate('assistant')}><Icon name="arrow-left" size={17} /></button>
            </div>
          </div>
        </div> : <div className="sb-inner">
          <button className="sb-new-chat" type="button" onClick={HandleNewConversation} title="与 Avery 开启新聊天">
            <Icon name="plus" size={15} />
            <span>新建对话</span>
            <span className="kbd">Ctrl K</span>
          </button>

          {/* 导航固定不滚动，滚动条只出现在下方的会话列表区域 */}
          <nav className="nav" ref={navRef} aria-label="工作区">
            <div className="nav-ind" ref={navIndicatorRef} aria-hidden="true" />
            {navRoutes.map((route) => <button key={route.id} className={`nav-item ${page === route.id ? 'is-active' : ''}`} type="button" aria-current={page === route.id ? 'page' : undefined} title={route.label} onClick={() => onNavigate(route.id)}>
              <Icon name={route.icon} size={17} />
              <span>{route.label}</span>
              {route.id === 'assistant' && liveConversations.length > 0 && <span className="count">{liveConversations.length}</span>}
            </button>)}
          </nav>

          <div className="sb-scroll">
            {/* 「最近」与项目空间板块同级：各占一个分区、各有分区标题；项目空间标题右侧放「更多」按钮，
                与「最近」标题右侧的搜索按钮占同一位置。未绑定项目的会话留在「最近」。 */}
            <div className="sb-sec" aria-label="历史会话">
              <div className="sb-sec-h">
                <span>最近</span>
                <div className={`sb-search ${searchOpen ? 'open' : ''}`}>
                  <input ref={searchInputRef} type="search" value={searchQuery} placeholder="搜索对话" aria-label="搜索近期对话" autoComplete="off" tabIndex={searchOpen ? 0 : -1} onChange={(event) => SetSearchQuery(event.target.value)} onKeyDown={(event) => { if (event.key === 'Escape') { SetSearchOpen(false); SetSearchQuery(''); } }} />
                  <button className="sb-search-btn" type="button" aria-expanded={searchOpen} aria-label="搜索近期对话" title="搜索近期对话" onClick={ToggleSearch}><Icon name="search" size={13} /></button>
                </div>
              </div>
              <div className="ti-list">
                {ungroupedConversations.map((item) => RenderConversationRow(item))}
                {!ungroupedConversations.length && <div className="ti-empty">{searchKeyword ? '没有匹配的对话' : visibleConversations.length ? '所有对话都在项目空间里' : '还没有会话'}</div>}
              </div>
            </div>
            {conversationGroups.map((group) => <div className="sb-sec" key={group.projectId} aria-label={`项目空间 ${group.name}`}>
              <div className="sb-sec-h">
                <span className="sb-sec-title" title={group.name}><Icon name="folder-simple" size={12} /><span>{group.name}</span></span>
                <button className="sb-sec-more" type="button" data-menu-trigger="group" aria-haspopup="menu" aria-expanded={groupMenu?.projectId === group.projectId} aria-label={`管理项目空间 ${group.name}`} title="更多" onClick={(event) => OpenGroupMenu(group.projectId, group.name, group.items.length, event.currentTarget)}><Icon name="more" size={13} /></button>
              </div>
              <div className="ti-list">{group.items.map((item) => RenderConversationRow(item))}</div>
            </div>)}
          </div>

          <div className="sb-foot">
            <div className="uc-row">
              <button className="user-card" type="button" data-menu-trigger="user" aria-expanded={userMenuPosition !== null} aria-haspopup="menu" title="账户" onClick={(event) => OpenUserMenu(event.currentTarget)}>
                <RenderUserAvatar />
                <span className="uc-body"><span className="uc-name">{settings.nickname}</span></span>
                <Icon name="chevron-up" size={12} className="chev" />
              </button>
              <button className="icon-btn" type="button" aria-label="设置" title="设置" onClick={() => onNavigate('settings')}><Icon name="settings" size={17} /></button>
            </div>
          </div>
        </div>}
      </aside>
      <main className="main-frame">
        <div className="page-container">{children}</div>
      </main>
    </div>

    {/* 会话行菜单固定定位渲染，避免被侧栏滚动裁剪；置顶项按当前状态切换文案 */}
    {rowMenu && (() => {
      const target = conversations.find((item) => item.id === rowMenu.conversationId);
      if (!target) return null;
      const pinned = target.pinned ?? false;
      return <div className="menu ti-menu open" data-floating-menu role="menu" aria-label="对话操作" style={{ left: rowMenu.left, top: rowMenu.top }}>
        <button className="menu-item plain" type="button" onClick={() => HandleToggleConversationPin(target.id)}>
          <Icon name="pin" size={16} weight={pinned ? 'fill' : 'regular'} /><span className="mt">{pinned ? '取消置顶' : '置顶'}</span>
        </button>
        <button className="menu-item plain" type="button" onClick={() => BeginRenameConversation(target.id, target.title)}>
          <Icon name="edit" size={16} /><span className="mt">重命名</span>
        </button>
        <div className="menu-sep" aria-hidden="true" />
        <button className="menu-item plain" type="button" onClick={() => { SetArchiveTarget({ id: target.id, title: target.title }); SetRowMenu(null); }}>
          <Icon name="archive" size={16} /><span className="mt">归档</span>
        </button>
      </div>;
    })()}

    {/* 分组"更多"菜单：重命名改侧栏显示别名，删除仅把板块收起（组内对话回到「最近」） */}
    {groupMenu && <div className="menu ti-menu open" data-floating-menu role="menu" aria-label="分组操作" style={{ left: groupMenu.left, top: groupMenu.top }}>
      <button className="menu-item plain" type="button" onClick={() => BeginRenameGroup(groupMenu.projectId, groupMenu.name)}>
        <Icon name="edit" size={16} /><span className="mt">重命名</span>
      </button>
      <button className="menu-item plain" type="button" onClick={() => { SetRemoveGroupTarget({ projectId: groupMenu.projectId, name: groupMenu.name, count: groupMenu.count }); SetGroupMenu(null); }}>
        <Icon name="delete" size={16} /><span className="mt">删除</span>
      </button>
    </div>}

    {/* 账户菜单锚定在用户卡上方，位于侧栏之外以免被裁剪 */}
    {userMenuPosition && <div className="menu user-menu open" data-floating-menu role="menu" aria-label="账户" style={{ left: userMenuPosition.left, bottom: userMenuPosition.bottom }}>
      <div className="um-balance">
        <span className="l">账户余额</span>
        <span className="v">{balanceText}</span>
        <button className="balance-refresh" type="button" onClick={() => void RefreshBalance(true)} disabled={refreshingBalance} aria-label="刷新余额" title="刷新余额"><Icon name="refresh" size={14} /></button>
      </div>
      <div className="menu-sep" aria-hidden="true" />
      <label className={`menu-item um-row ${settings.developerMode ? 'on' : ''}`}>
        <Icon name="developer-mode" size={16} />
        <span className="mt">开发者模式</span>
        <span className="switch" aria-hidden="true"><span className="knob" /></span>
        <input className="menu-switch-input" type="checkbox" role="switch" aria-label="开发者模式" checked={settings.developerMode} onChange={(event) => void HandleDeveloperModeChange(event.target.checked)} />
      </label>
      <label className={`menu-item um-row ${theme === 'dark' ? 'on' : ''}`}>
        <Icon name={theme === 'dark' ? 'moon' : 'sun'} size={16} />
        <span className="mt">深色模式</span>
        <span className="switch" aria-hidden="true"><span className="knob" /></span>
        <input className="menu-switch-input" type="checkbox" role="switch" aria-label="深色模式" checked={theme === 'dark'} onChange={(event) => SetTheme(event.target.checked ? 'dark' : 'light')} />
      </label>
      <button className="menu-item plain" type="button" onClick={onRestartOnboarding}><Icon name="recovery" size={16} /><span className="mt">重新体验启动页</span></button>
      <div className="menu-sep" aria-hidden="true" />
      <button className="menu-item plain um-danger" type="button" onClick={() => ShowNotice('退出功能将在 Electron 客户端接入后启用')}><Icon name="logout" size={16} /><span className="mt">退出登录</span></button>
    </div>}

    <Modal
      open={Boolean(archiveTarget)}
      title="归档这个对话？"
      onClose={() => SetArchiveTarget(null)}
      footer={<>
        <DialogButton onClick={() => SetArchiveTarget(null)}>取消</DialogButton>
        <DialogButton tone="accent" onClick={() => void ConfirmArchiveConversation()}>归档</DialogButton>
      </>}
    >
      归档后，「{archiveTarget?.title}」会从"最近"里移出；会话与消息仍保留在本机，通知里可立即撤回。
    </Modal>
    <Modal
      open={Boolean(renameGroupTarget)}
      title="重命名分组"
      onClose={() => SetRenameGroupTarget(null)}
      variant="dialog"
      size="sm"
      footer={<>
        <DialogButton onClick={() => SetRenameGroupTarget(null)}>取消</DialogButton>
        <DialogButton tone="accent" onClick={CommitGroupRename}>保存</DialogButton>
      </>}
    >
      <input value={renameGroupValue} maxLength={200} aria-label="分组名称" autoFocus onFocus={(event) => event.currentTarget.select()} onChange={(event) => SetRenameGroupValue(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); CommitGroupRename(); } }} />
      <p className="md-note">只改侧栏里的分组显示名，不会改动磁盘上的项目目录名称。</p>
    </Modal>
    <Modal
      open={Boolean(removeGroupTarget)}
      title="删除这个分组？"
      onClose={() => SetRemoveGroupTarget(null)}
      footer={<>
        <DialogButton onClick={() => SetRemoveGroupTarget(null)}>取消</DialogButton>
        <DialogButton tone="danger" onClick={ConfirmRemoveGroup}>删除分组</DialogButton>
      </>}
    >
      「{removeGroupTarget?.name}」下的 {removeGroupTarget?.count} 个对话会回到「最近」列表；对话与消息保留，项目空间绑定不受影响。
    </Modal>
  </div>;
}

export { AppShell };
