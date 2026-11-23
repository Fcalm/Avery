import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { MainRoutes } from './routes';
import { useUiStore } from './UiStore';
import { useConversations, useRenameConversation, useSetConversationArchived, useSetConversationPinned } from '../features/conversation/api/conversationQueries';
import { GetAgentSessionScenes } from '../features/assistant/api/agentQueries';
import { useSettingsStore } from '../features/settings/api/settingsQueries';
import type { Conversation, PageId, WorkspaceMode } from '../types/domain';
import { DialogButton, Modal } from '../shared/components/UI';
import { Icon } from '../shared/components/Icon';
import { BuildConversationHistory, ExtendProjectConversationOrder } from '../features/conversation/conversationHistory';
import { IsDesktopAgentAvailable } from '../features/assistant/api/agentQueries';
import { ProviderUsagePanel } from '../features/settings/components/ProviderUsagePanel';
import { ASSISTANT_MAIN_MIN_WIDTH } from '../shared/layoutConstants';
import { ListEvalRuns } from '../features/developer/api/evaluationQueries';
import { DeveloperSidebar } from '../features/developer/components/DeveloperSidebar';
import { useDeveloperConsole } from '../features/developer/components/DeveloperConsoleContext';
import type { SettingTab } from '../features/settings/pages/SettingsPage';
import { AppUpdateNotice } from '../features/updates/AppUpdateNotice';

const MinContentWidth = 800;
// 展开导航 268px 加常规页面 800px；按应用整体宽度判断，避免折叠本身反复触发阈值。
const SidebarAutoCollapseWidth = 1068;
const SidebarHoverCloseDelay = 180;
const UserMenuWidth = 332;
const UserMenuViewportPadding = 12;
const UserMenuAnchorGap = 7;

/** 与额度面板的 332px 原型宽度一致；窄窗口保留两侧安全间距。 */
function MeasureUserMenuPosition(trigger: HTMLButtonElement) {
  const rect = trigger.getBoundingClientRect();
  return {
    left: Math.max(UserMenuViewportPadding, Math.min(Math.round(rect.left), window.innerWidth - UserMenuWidth - UserMenuViewportPadding)),
    bottom: Math.round(window.innerHeight - rect.top + UserMenuAnchorGap),
  };
}

type WindowControls = {
  Minimize: () => Promise<boolean>;
  ToggleMaximize: () => Promise<boolean>;
  IsMaximized: () => Promise<boolean>;
  Close: () => Promise<boolean>;
  OnMaximizedChange: (listener: (maximized: boolean) => void) => () => void;
};

type ThemeMode = 'light' | 'dark';

/** 会话行"更多"菜单的固定定位信息：按触发按钮的位置计算， Escape 或点击外部关闭。 */
type RowMenuPosition = { conversationId: string; sectionId: string; left: number; top: number };

/** 项目空间分组"更多"菜单：count 用于删除确认文案。 */
type GroupMenuPosition = { projectId: string; name: string; count: number; left: number; top: number };

/** 分组展示偏好只存本机：别名是侧栏显示名，移除分组只是把板块从侧栏收起，都不改会话的项目绑定。 */
const GroupAliasesKey = 'avery-project-group-aliases';
const RemovedGroupsKey = 'avery-project-group-removed';
const CollapsedHistorySectionsKey = 'avery-history-sections-collapsed';
const ProjectConversationOrderKey = 'avery-project-conversation-order';

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

function AppShell({ page, onNavigate, canGoBack, canGoForward, onBack, onForward, onRestartOnboarding, inert = false, onRequestSettingsTab, children }: { page: PageId; onNavigate: (page: PageId) => void; canGoBack: boolean; canGoForward: boolean; onBack: () => void; onForward: () => void; onRestartOnboarding: () => void; inert?: boolean; onRequestSettingsTab: (tab: SettingTab) => void; children: (conversationToolbar: ReactNode) => ReactNode }) {
  const conversations = useConversations();
  const renameConversation = useRenameConversation({ onConflict: () => ShowNotice('会话已在其他窗口被修改，已刷新为最新版本', "error"), onFailure: () => ShowNotice('会话重命名失败，请稍后重试。', "error") });
  const pinConversation = useSetConversationPinned({ onConflict: () => ShowNotice('会话已在其他窗口被修改，已刷新为最新版本', "error"), onFailure: () => ShowNotice('会话置顶失败，请稍后重试。', "error") });
  const archiveConversation = useSetConversationArchived({ onConflict: () => ShowNotice('会话已在其他窗口被修改，已刷新为最新版本', "error"), onFailure: () => ShowNotice('会话归档失败，请稍后重试。', "error") });
  const { settings, setSettings, saveSettingsNow } = useSettingsStore();
  // 开发者页是带独立侧栏的顶级页面：面包屑、Ctrl K 与导航指示器都要读取评测域的共享状态。
  const { projects: evalProjects, selectedProject: selectedEvalProject, SelectProject: SelectEvalProject, view: developerView, OpenCreate: OpenCreateEval } = useDeveloperConsole();
  const { activeConversationId, setActiveConversationId, resumePanelOpen, setResumePanelOpen, assistantView, setAssistantView, ShowNotice, workspaceMode, setWorkspaceMode } = useUiStore();
  const activeConversation = conversations.find((item) => item.id === activeConversationId);

  const [manuallyCollapsed, SetCollapsed] = useState(false);
  const [autoCollapsed, SetAutoCollapsed] = useState(() => window.innerWidth < SidebarAutoCollapseWidth);
  const [sidebarPreview, SetSidebarPreview] = useState(false);
  const collapsed = manuallyCollapsed || autoCollapsed;
  const sidebarFloating = collapsed && sidebarPreview;
  const sidebarContentCollapsed = collapsed && !sidebarFloating;
  const modeToggleLabel = workspaceMode === 'chat' ? '当前为聊天模式，切换到工作模式' : '当前为工作模式，切换到聊天模式';
  const [theme, SetTheme] = useState<ThemeMode>(() => (localStorage.getItem('avery-theme') === 'dark' ? 'dark' : 'light'));
  const [showCrumbMenu, SetShowCrumbMenu] = useState(false);
  const [userMenuPosition, SetUserMenuPosition] = useState<{ left: number; bottom: number } | null>(null);
  const userMenuTriggerRef = useRef<HTMLButtonElement | null>(null);
  const [rowMenu, SetRowMenu] = useState<RowMenuPosition | null>(null);
  const [renamingConversationId, SetRenamingConversationId] = useState<string | null>(null);
  const [renamingSectionId, SetRenamingSectionId] = useState<string | null>(null);
  const [renameTitle, SetRenameTitle] = useState('');
  const [archiveTarget, SetArchiveTarget] = useState<ArchiveTarget | null>(null);
  const [searchQuery, SetSearchQuery] = useState('');
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
  // 模式只影响展示与新建对话；当前已打开的会话仍按创建时冻结的场景继续。
  const modeConversations = conversations.filter((item) => (SceneOf(item) === '工作' ? 'work' : 'chat') === workspaceMode);

  // 项目空间分组的本机展示偏好：别名与已移除分组。
  const [groupAliases, SetGroupAliases] = useState<Record<string, string>>(() => LoadLocalMap(GroupAliasesKey));
  const [removedGroups, SetRemovedGroups] = useState<Record<string, string>>(() => LoadLocalMap(RemovedGroupsKey));
  const [savedProjectOrder, SetSavedProjectOrder] = useState(() => LoadLocalMap(ProjectConversationOrderKey));
  const projectOrder = useMemo(() => ExtendProjectConversationOrder(conversations, savedProjectOrder), [conversations, savedProjectOrder]);
  useEffect(() => {
    if (projectOrder === savedProjectOrder) return;
    SetSavedProjectOrder(projectOrder);
    SaveLocalMap(ProjectConversationOrderKey, projectOrder);
  }, [projectOrder, savedProjectOrder]);
  // 用稳定项目标识记住折叠状态，重命名或分组重排不会影响偏好；搜索期间的折叠单独暂存。
  const [collapsedHistorySections, SetCollapsedHistorySections] = useState<Record<string, string>>(() => LoadLocalMap(CollapsedHistorySectionsKey));
  const [searchCollapsedSections, SetSearchCollapsedSections] = useState<Record<string, string>>({});
  useEffect(() => { SaveLocalMap(CollapsedHistorySectionsKey, collapsedHistorySections); }, [collapsedHistorySections]);
  const [groupMenu, SetGroupMenu] = useState<GroupMenuPosition | null>(null);
  const [renameGroupTarget, SetRenameGroupTarget] = useState<{ projectId: string; name: string } | null>(null);
  const [renameGroupValue, SetRenameGroupValue] = useState('');
  const [removeGroupTarget, SetRemoveGroupTarget] = useState<{ projectId: string; name: string; count: number } | null>(null);

  const appShellRef = useRef<HTMLDivElement>(null);
  const sidebarRef = useRef<HTMLElement>(null);
  const sidebarToggleRef = useRef<HTMLButtonElement>(null);
  const sidebarCloseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const navRef = useRef<HTMLElement>(null);
  const navIndicatorRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const renamingConversationIdRef = useRef<string | null>(null);
  const activeConversationIdRef = useRef<string | null>(activeConversationId);
  activeConversationIdRef.current = activeConversationId;

  useEffect(() => {
    const shell = appShellRef.current;
    if (!shell) return;
    const UpdateWidth = () => {
      if (shell.clientWidth > 0) SetAutoCollapsed(shell.clientWidth < SidebarAutoCollapseWidth);
    };
    UpdateWidth();
    const observer = new ResizeObserver(UpdateWidth);
    observer.observe(shell);
    return () => { observer.disconnect(); CancelSidebarClose(); };
  }, []);

  function CancelSidebarClose() {
    if (sidebarCloseTimerRef.current !== null) clearTimeout(sidebarCloseTimerRef.current);
    sidebarCloseTimerRef.current = null;
  }

  function RevealSidebar() {
    CancelSidebarClose();
    if (collapsed) SetSidebarPreview(true);
  }

  function ScheduleSidebarClose() {
    if (sidebarCloseTimerRef.current !== null) return;
    // 顶栏按钮到导航之间允许短暂跨越；鼠标或键盘仍在导航内时不关闭。
    sidebarCloseTimerRef.current = setTimeout(() => {
      sidebarCloseTimerRef.current = null;
      if (sidebarRef.current?.matches(':hover') || sidebarToggleRef.current?.matches(':hover')) return;
      SetSidebarPreview(false);
    }, SidebarHoverCloseDelay);
  }

  function ToggleSidebar() {
    CancelSidebarClose();
    if (autoCollapsed) SetSidebarPreview((value) => !value);
    else { SetCollapsed((value) => !value); SetSidebarPreview(false); }
  }

  useEffect(() => {
    if (!sidebarFloating) return;
    // 行菜单和账户菜单挂在导航外；操作这些菜单也视为仍在使用导航。
    const FollowPointer = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (sidebarRef.current?.contains(target) || sidebarToggleRef.current?.contains(target) || target.closest('[data-floating-menu]')) CancelSidebarClose();
      else ScheduleSidebarClose();
    };
    const CloseOnEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') SetSidebarPreview(false); };
    const CloseOnBlur = () => SetSidebarPreview(false);
    document.addEventListener('pointerover', FollowPointer);
    document.addEventListener('keydown', CloseOnEscape);
    window.addEventListener('blur', CloseOnBlur);
    return () => {
      CancelSidebarClose();
      document.removeEventListener('pointerover', FollowPointer);
      document.removeEventListener('keydown', CloseOnEscape);
      window.removeEventListener('blur', CloseOnBlur);
    };
  }, [sidebarFloating]);

  useEffect(() => { SetSidebarPreview(false); CancelSidebarClose(); }, [autoCollapsed]);

  const windowControls = (window as Window & { averyWindow?: WindowControls }).averyWindow;
  useEffect(() => {
    if (!windowControls) return undefined;
    let cancelled = false;
    let changedSinceRead = false;
    const unsubscribe = windowControls.OnMaximizedChange((maximized) => {
      changedSinceRead = true;
      SetIsMaximized(maximized);
    });
    // 先订阅事件，再读取实际窗口状态；避免初始状态遗漏或较旧的 IPC 快照覆盖新事件。
    void windowControls.IsMaximized().then((maximized) => {
      if (!cancelled && !changedSinceRead) SetIsMaximized(maximized);
    }).catch(() => undefined);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [windowControls]);
  const minimumContentWidth = page === 'assistant' ? ASSISTANT_MAIN_MIN_WIDTH : MinContentWidth;
  // 求职入口按流程排列；对话通过新建入口与历史记录进入。
  // 开发者工具不走侧栏导航，
  // 入口在账户菜单（对应原型 umDeveloper），且仅在开启开发者模式后出现。
  const navRouteOrder: PageId[] = ['profiles', 'resumes', 'jobs', 'applications'];
  const navRoutes = navRouteOrder.flatMap((id) => {
    const route = MainRoutes.find((item) => item.id === id);
    return route ? [route] : [];
  });
  const { recent: liveConversations, visible: visibleConversations, groups: conversationGroups } = BuildConversationHistory(modeConversations, projectOrder, groupAliases, removedGroups, searchQuery);
  const searchKeyword = searchQuery.trim().toLowerCase();
  const historySectionState = searchKeyword ? searchCollapsedSections : collapsedHistorySections;
  const crumbLeaf = page === 'assistant' ? (activeConversation?.title ?? '新对话') : MainRoutes.find((route) => route.id === page)?.label ?? '';
  // 助手页没有消息时就是新建对话视图（含刚创建但尚未落消息的会话）；离开该视图才取消选中。
  const newConversationActive = page === 'assistant' && !activeConversation?.messages.length;
  const userMenuOpen = userMenuPosition !== null;
  useEffect(() => {
    if (!userMenuOpen) return;
    // 缩放窗口时同步锚点和剩余高度，不能沿用打开时的像素位置突破 60% 高度边界。
    const Reposition = () => {
      const trigger = userMenuTriggerRef.current;
      if (!trigger?.isConnected) { SetUserMenuPosition(null); return; }
      SetUserMenuPosition(MeasureUserMenuPosition(trigger));
    };
    window.addEventListener('resize', Reposition);
    return () => window.removeEventListener('resize', Reposition);
  }, [userMenuOpen]);

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
    if (inert) return;
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
  }, [inert, page, onNavigate, setActiveConversationId, OpenCreateEval]);

  // 导航滑动指示器：测量当前项的位置，折叠动画结束后再校准一次。
  // 页面或侧栏布局变化时，导航指示器跟随当前入口。
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
  }, [MoveNavIndicator, page, newConversationActive, collapsed, sidebarFloating, settings.developerMode, developerView]);

  function HandleNewConversation() {
    // 仅切换到未保存草稿；首次发送时由助手页创建实际会话，避免空会话进入历史列表。
    setActiveConversationId(null);
    onNavigate('assistant');
  }

  function ChangeWorkspaceMode(next: WorkspaceMode) {
    if (next !== workspaceMode) setWorkspaceMode(next);
  }

  function HandleToggleTrace() {
    setAssistantView(assistantView === 'chat' ? 'trace' : 'chat');
  }

  async function HandleToggleMaximize() {
    // 最大化状态以 Main 进程的 maximize / unmaximize 事件为准；IPC 返回值可能早于系统窗口状态更新。
    await windowControls?.ToggleMaximize();
  }

  async function HandleDeveloperModeChange(enabled: boolean) {
    if (!enabled) {
      try {
        const runs = await ListEvalRuns();
        if (runs.some((run) => !['completed', 'failed', 'cancelled'].includes(run.status))) {
          ShowNotice('存在未结束的测评，请先取消或等待完成', "info");
          return;
        }
      } catch (error) {
        ShowNotice(error instanceof Error ? error.message : '无法确认测评运行状态', "error");
        return;
      }
    }
    const next = { ...settings, developerMode: enabled };
    try {
      await saveSettingsNow(next);
      setSettings(() => next);
    } catch (error) {
      ShowNotice(error instanceof Error ? error.message : '保存开发者模式失败', "error");
      return;
    }
    if (!enabled && page === 'developer') onNavigate('settings');
    ShowNotice(enabled ? '开发者模式已开启' : '开发者模式已关闭', "success");
  }

  function HandleResumePanel() {
    if (resumePanelOpen && page === 'assistant') { setResumePanelOpen(false); return; }
    setResumePanelOpen(true);
    if (page !== 'assistant') onNavigate('assistant');
  }

  function BeginRenameConversation(id: string, title: string, sectionId: string) {
    SetRowMenu(null);
    renamingConversationIdRef.current = id;
    SetRenamingConversationId(id);
    SetRenamingSectionId(sectionId);
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
      onSuccess: () => ShowNotice(pinned ? `已置顶「${conversation.title}」` : `已取消置顶「${conversation.title}」`, "success"),
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
        actions: [{ label: '查看', run: () => { onRequestSettingsTab('archive'); onNavigate('settings'); } }],
        action: {
          label: '撤回',
          run: () => {
            archiveConversation.mutate({ id, archived: false }, {
              onSuccess: () => {
                if (wasActive) setActiveConversationId(id);
                ShowNotice(`已恢复「${title}」`, "success");
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
  function OpenRowMenu(conversationId: string, sectionId: string, trigger: HTMLButtonElement) {
    const rect = trigger.getBoundingClientRect();
    const width = 186;
    const estimatedHeight = 150;
    const sidebarLeft = appShellRef.current?.querySelector<HTMLElement>('.sidebar')?.getBoundingClientRect().left ?? 0;
    const left = Math.max(sidebarLeft + 6, rect.right - width);
    let top = rect.bottom + 6;
    if (top + estimatedHeight > window.innerHeight - 10) top = rect.top - estimatedHeight;
    SetRowMenu({ conversationId, sectionId, left: Math.round(left), top: Math.round(Math.max(8, top)) });
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
  /** 删除分组只隐藏项目入口；最近中的会话、消息及项目绑定保持不变。 */
  function ConfirmRemoveGroup() {
    const target = removeGroupTarget;
    SetRemoveGroupTarget(null);
    if (!target) return;
    const next = { ...removedGroups, [target.projectId]: target.name };
    SetRemovedGroups(next);
    SaveLocalMap(RemovedGroupsKey, next);
    ShowNotice(`已移除分组「${target.name}」，对话仍保留在「最近」`, "success");
  }
  function OpenUserMenu(trigger: HTMLButtonElement) {
    if (userMenuPosition) { SetUserMenuPosition(null); return; }
    userMenuTriggerRef.current = trigger;
    SetUserMenuPosition(MeasureUserMenuPosition(trigger));
  }
  /** 侧栏用户头像：上传过图片直接渲染；否则显示昵称首字并应用个性化底色（设置页与侧栏共用同一份设置）。 */
  function RenderUserAvatar() {
    return <span className="avatar" data-av={settings.avatarStyle ?? 'default'} aria-hidden="true">{settings.avatarImage ? <img src={settings.avatarImage} alt="" /> : settings.nickname.slice(0, 1) || 'A'}</span>;
  }
  function ToggleHistorySection(sectionId: string) {
    const SetSections = searchKeyword ? SetSearchCollapsedSections : SetCollapsedHistorySections;
    SetSections((current) => {
      const next = { ...current };
      if (next[sectionId]) delete next[sectionId];
      else next[sectionId] = 'collapsed';
      return next;
    });
  }
  function ChangeHistorySearch(value: string) {
    SetSearchQuery(value);
    // 新的关键词默认显示所有匹配结果，清空后仍沿用搜索前的持久化折叠偏好。
    SetSearchCollapsedSections({});
  }

  /** 同一会话可出现在最近与项目中，只有操作来源行进入重命名态。 */
  function RenderConversationRow(item: Conversation, sectionId: string) {
    const isCurrent = item.id === activeConversationId && page === 'assistant';
    return <div key={item.id} className="ti-wrap" data-conversation-id={item.id}>
      {renamingConversationId === item.id && renamingSectionId === sectionId ? <input className="ti-rename" value={renameTitle} maxLength={120} aria-label="重命名对话" autoFocus onFocus={(event) => event.currentTarget.select()} onChange={(event) => SetRenameTitle(event.target.value)} onKeyDown={(event) => {
        if (event.key === 'Enter') { event.preventDefault(); CommitConversationRename(); }
        else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); renamingConversationIdRef.current = null; SetRenamingConversationId(null); }
      }} onBlur={CommitConversationRename} /> : <>
        <button className={`thread-item ${item.pinned ? 'pinned' : ''} ${isCurrent ? 'active' : ''}`} type="button" title={item.title} onClick={() => { setActiveConversationId(item.id); onNavigate('assistant'); }}>
          <span className="ti-body"><span className="ti-title">{item.title}</span></span>
        </button>
        <button className="ti-pin-button" type="button" aria-pressed={Boolean(item.pinned)} aria-label={item.pinned ? '取消置顶' : '置顶对话'} title={item.pinned ? '取消置顶' : '置顶对话'} disabled={pinConversation.isPending} onClick={() => HandleToggleConversationPin(item.id)}><Icon name="pin" size={14} weight={item.pinned ? 'fill' : 'regular'} /></button>
        <button className="ti-more" type="button" data-menu-trigger="row" aria-haspopup="menu" aria-expanded={rowMenu?.conversationId === item.id && rowMenu.sectionId === sectionId} aria-label="更多操作" title="更多操作" onClick={(event) => OpenRowMenu(item.id, sectionId, event.currentTarget)}><Icon name="more" size={14} /></button>
      </>}
    </div>;
  }

  /** 会话管理入口在对话页的内容栏展示，其他工作页面沿用顶栏；菜单与会话数据保持共用。 */
  function RenderConversationMenu() {
    return <div className="menu-wrap">
      <button className="crumb-btn" type="button" data-menu-trigger="crumb" aria-expanded={showCrumbMenu} aria-haspopup="menu" title="切换会话" onClick={() => SetShowCrumbMenu((value) => !value)}>
        <span className="crumb-last">{crumbLeaf}</span>
        <Icon name="chevron-down" size={12} className="chev" />
      </button>
      {showCrumbMenu && <div className="menu drop lg open" data-floating-menu role="menu" aria-label="快速切换会话">
        <button className="menu-item plain" type="button" onClick={() => { SetShowCrumbMenu(false); HandleNewConversation(); }}><Icon name="plus" size={16} /><span className="mt">新建对话</span></button>
        <div className="menu-sep" aria-hidden="true" />
        {liveConversations.map((item) => <button key={item.id} type="button" role="menuitemradio" aria-checked={item.id === activeConversationId} className={`menu-item ${item.id === activeConversationId ? 'sel' : ''}`} title={item.title} onClick={() => { setActiveConversationId(item.id); SetShowCrumbMenu(false); onNavigate('assistant'); }}>
          <Icon name={SceneOf(item) === '工作' ? 'briefcase' : 'assistant'} size={16} />
          <span className="mt">{item.title}</span>
          <Icon name="check" size={14} className="tick" />
        </button>)}
        {!liveConversations.length && <div className="menu-label">还没有会话</div>}
      </div>}
    </div>;
  }

  // 菜单数据由外壳维护，操作栏由主区渲染，确保侧栏开合时随主区自然移动。
  const conversationToolbar = <div className="assistant-toolbar" role="group" aria-label="对话视图操作">
    <div className="crumb assistant-toolbar-title">{RenderConversationMenu()}</div>
    <div className="assistant-toolbar-actions">
      <button className="tb-txt-btn" type="button" title={assistantView === 'trace' ? '切换至对话' : '切换至轨迹'} onClick={HandleToggleTrace}><Icon name={assistantView === 'trace' ? 'assistant' : 'trace'} size={14} /><span>{assistantView === 'trace' ? '对话' : '轨迹'}</span></button>
      {!resumePanelOpen && <button className="icon-btn flip" type="button" aria-expanded={false} aria-controls="assistant-resource-panel" aria-label="展开右侧边栏" title="展开右侧边栏" onClick={HandleResumePanel}><Icon name="sidebar-expand" size={17} /></button>}
    </div>
  </div>;

  return <div ref={appShellRef} inert={inert} className={`app-shell ${collapsed ? 'is-collapsed' : ''}${sidebarFloating ? ' is-sidebar-floating' : ''}`} style={{ '--main-content-min-width': `${minimumContentWidth}px` } as CSSProperties}>
    <header className="topbar">
      <div className="tb-group">
        <button ref={sidebarToggleRef} className="icon-btn" type="button" aria-label={collapsed ? '展开侧栏' : '收起侧栏'} aria-pressed={!collapsed} aria-expanded={!sidebarContentCollapsed} aria-controls="app-sidebar" title={collapsed ? '展开侧栏' : '收起侧栏'} onPointerEnter={(event) => { if (event.pointerType !== 'touch') RevealSidebar(); }} onPointerLeave={ScheduleSidebarClose} onFocus={(event) => { if (event.currentTarget.matches(':focus-visible')) RevealSidebar(); }} onBlur={ScheduleSidebarClose} onClick={ToggleSidebar}><Icon name="sidebar-expand" size={17} /></button>
        <div className="tb-history" role="group" aria-label="页面历史">
          <button className="icon-btn tb-history-btn" type="button" aria-label="返回" title={canGoBack ? '返回' : '无返回记录'} disabled={!canGoBack} onClick={onBack}><Icon name="arrow-left" size={16} /></button>
          <button className="icon-btn tb-history-btn" type="button" aria-label="前进" title={canGoForward ? '前进' : '无前进记录'} disabled={!canGoForward} onClick={onForward}><Icon name="arrow-right" size={16} /></button>
        </div>
        {page === 'developer' && <div className="crumb">
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
                {evalProjects.map((project) => <button key={project.id} type="button" role="menuitemradio" aria-checked={project.id === selectedEvalProject?.id} className={`menu-item ${project.id === selectedEvalProject?.id ? 'sel' : ''}`} data-native-title="true" title={project.name} onClick={() => { SelectEvalProject(project.id); SetShowCrumbMenu(false); }}>
                  <Icon name="flask" size={16} />
                  <span><span className="mt">{project.name}</span></span>
                  <Icon name="check" size={14} className="tick" />
                </button>)}
                {!evalProjects.length && <div className="menu-label">还没有评测</div>}
              </div>}
            </div>
        </div>}
      </div>

      <div className="tb-spacer" />

      <div className="tb-group win-ctl">
        <button className="win-btn" type="button" aria-label="最小化" title="最小化" onClick={() => void windowControls?.Minimize()}><Icon name="window-minimize" size={15} /></button>
        <button className="win-btn" type="button" aria-label={isMaximized ? '向下还原' : '最大化'} title={isMaximized ? '向下还原' : '最大化'} onClick={() => void HandleToggleMaximize()}><Icon name={isMaximized ? 'window-restore' : 'window-maximize'} size={15} /></button>
        <button className="win-btn close" type="button" aria-label="关闭" title="关闭" onClick={() => void windowControls?.Close()}><Icon name="close" size={15} /></button>
      </div>
    </header>

    <div className="app-body">
      <div className="sidebar-slot">
      <aside ref={sidebarRef} id="app-sidebar" className="sidebar" onPointerEnter={CancelSidebarClose} onPointerLeave={ScheduleSidebarClose} onFocus={CancelSidebarClose} onBlur={ScheduleSidebarClose} aria-label={page === 'developer' ? '开发者工具' : '主导航'}>
        {page === 'developer' ? <div className="sb-inner">
          {/* 开发者页专属侧栏：新建评测 + 评估/对比/运行日志导航 + 评测记录列表；用户卡与"返回工作区"留在壳层 */}
          <DeveloperSidebar navRef={navRef} indicatorRef={navIndicatorRef} />
          <div className="sb-foot">
            <div className="uc-row">
              <button className="user-card" type="button" data-menu-trigger="user" aria-expanded={userMenuPosition !== null} aria-haspopup="menu" onClick={(event) => OpenUserMenu(event.currentTarget)}>
                <RenderUserAvatar />
                <span className="uc-body"><span className="uc-name">{settings.nickname}</span></span>
                <Icon name="chevron-up" size={12} className="chev" />
              </button>
              <button className="icon-btn" type="button" aria-label="返回工作区" title="返回工作区" data-focus-tooltip onClick={() => onNavigate('assistant')}><Icon name="arrow-left" size={17} /></button>
            </div>
          </div>
        </div> : <div className="sb-inner">
          <div className="mode-switch" data-mode={workspaceMode} role="group" aria-label="聊天或工作模式">
            {sidebarContentCollapsed ? <button className="mode-switch-toggle" type="button" aria-label={modeToggleLabel} title={modeToggleLabel} data-focus-tooltip onClick={() => ChangeWorkspaceMode(workspaceMode === 'chat' ? 'work' : 'chat')}>
              <Icon name={workspaceMode === 'chat' ? 'assistant' : 'briefcase'} size={16} />
            </button> : <>
              <span className="mode-switch-ind" aria-hidden="true" />
              <button type="button" aria-label="聊天模式" title="聊天模式" data-focus-tooltip aria-pressed={workspaceMode === 'chat'} onClick={() => ChangeWorkspaceMode('chat')}>
                <Icon name="assistant" size={16} /><span className="mode-switch-label">聊天</span>
              </button>
              <button type="button" aria-label="工作模式" title="工作模式" data-focus-tooltip aria-pressed={workspaceMode === 'work'} onClick={() => ChangeWorkspaceMode('work')}>
                <Icon name="briefcase" size={16} /><span className="mode-switch-label">工作</span>
              </button>
            </>}
          </div>
          {/* 导航固定不滚动，滚动条只出现在下方的会话列表区域 */}
          <nav className="nav workspace-nav" ref={navRef} aria-label="工作区">
            <div className="nav-ind" ref={navIndicatorRef} aria-hidden="true" />
            <button className={`nav-item sb-new-conversation${newConversationActive ? ' is-active' : ''}`} type="button" aria-label="新建对话" aria-keyshortcuts="Control+K" title="新建对话" data-focus-tooltip aria-current={newConversationActive ? 'true' : undefined} onClick={HandleNewConversation}>
              <Icon name="plus" size={17} />
              <span>新建对话</span>
              <span className="kbd" aria-hidden="true">Ctrl K</span>
            </button>
            {navRoutes.map((route) => <button key={route.id} className={`nav-item ${page === route.id ? 'is-active' : ''}`} type="button" aria-label={route.label} title={route.label} data-focus-tooltip aria-current={page === route.id ? 'page' : undefined} onClick={() => onNavigate(route.id)}>
              <Icon name={route.icon} size={17} />
              <span>{route.label}</span>
            </button>)}
          </nav>

          <div className="sb-search-row">
            <div className="nav-item sb-history-search" role="search" aria-label="搜索对话">
              <button className="sb-history-search-icon" type="button" aria-label="搜索对话" title="搜索对话" onClick={() => { if (autoCollapsed) RevealSidebar(); else SetCollapsed(false); requestAnimationFrame(() => searchInputRef.current?.focus()); }}><Icon name="search" size={17} /></button>
              <input ref={searchInputRef} type="search" value={searchQuery} tabIndex={sidebarContentCollapsed ? -1 : 0} aria-hidden={sidebarContentCollapsed} placeholder="搜索对话" aria-label="搜索对话" autoComplete="off" onChange={(event) => ChangeHistorySearch(event.target.value)} onKeyDown={(event) => { if (event.key === 'Escape') ChangeHistorySearch(''); }} />
            </div>
          </div>

          <div className="sb-scroll sb-conversation-history" inert={sidebarContentCollapsed}>
            <div className="sb-sec" aria-label="项目对话">
              <div className="sb-sec-h">
                <button className="sb-sec-toggle" type="button" aria-expanded={!historySectionState.projects} aria-controls="history-projects" aria-label={`${historySectionState.projects ? '展开' : '折叠'}项目`} onClick={() => ToggleHistorySection('projects')}>
                  <span className="sb-sec-title"><span>项目</span></span>
                  <Icon name="chevron-right" size={12} className="sb-sec-chevron" />
                </button>
              </div>
              <div className="ti-list" id="history-projects" hidden={Boolean(historySectionState.projects)}>
                {conversationGroups.map((group) => <div className="sb-project-group" key={group.projectId} aria-label={`项目空间 ${group.name}`}>
                  <div className="sb-sec-h">
                    <button className="sb-sec-toggle" type="button" aria-expanded={!historySectionState[`project:${group.projectId}`]} aria-controls={`history-project-${encodeURIComponent(group.projectId)}`} aria-label={`${historySectionState[`project:${group.projectId}`] ? '展开' : '折叠'}项目 ${group.name}`} onClick={() => ToggleHistorySection(`project:${group.projectId}`)}>
                      <span className="sb-sec-title"><Icon name={historySectionState[`project:${group.projectId}`] ? 'folder-simple' : 'folder-open'} size={18} /><span>{group.name}</span></span>
                    </button>
                    <button className="sb-sec-more" type="button" data-menu-trigger="group" aria-haspopup="menu" aria-expanded={groupMenu?.projectId === group.projectId} aria-label={`管理项目空间 ${group.name}`} title="更多" onClick={(event) => OpenGroupMenu(group.projectId, group.name, group.items.length, event.currentTarget)}><Icon name="more" size={13} /></button>
                  </div>
                  <div className="ti-list" id={`history-project-${encodeURIComponent(group.projectId)}`} hidden={Boolean(historySectionState[`project:${group.projectId}`])}>{group.items.map((item) => RenderConversationRow(item, `project:${group.projectId}`))}</div>
                </div>)}
                {!conversationGroups.length && <div className="ti-empty">{searchKeyword ? '没有匹配的项目对话' : '暂无项目对话'}</div>}
              </div>
            </div>
            <div className="sb-sec" aria-label="历史会话">
              <div className="sb-sec-h">
                <button className="sb-sec-toggle" type="button" aria-expanded={!historySectionState.recent} aria-controls="history-recent" aria-label={`${historySectionState.recent ? '展开' : '折叠'}最近会话`} onClick={() => ToggleHistorySection('recent')}>
                  <span className="sb-sec-title"><span>最近</span></span>
                  <Icon name="chevron-right" size={12} className="sb-sec-chevron" />
                </button>
              </div>
              <div className="ti-list" id="history-recent" hidden={Boolean(historySectionState.recent)}>
                {visibleConversations.map((item) => RenderConversationRow(item, 'recent'))}
                {!visibleConversations.length && <div className="ti-empty">{searchKeyword ? '没有匹配的对话' : workspaceMode === 'work' ? '还没有工作会话' : '还没有聊天会话'}</div>}
              </div>
            </div>
          </div>

          <div className="sb-foot">
            <div className="uc-row">
              <button className="user-card" type="button" data-menu-trigger="user" aria-expanded={userMenuPosition !== null} aria-haspopup="menu" onClick={(event) => OpenUserMenu(event.currentTarget)}>
                <RenderUserAvatar />
                <span className="uc-body"><span className="uc-name">{settings.nickname}</span></span>
                <Icon name="chevron-up" size={12} className="chev" />
              </button>
            </div>
          </div>
        </div>}
      </aside>
      </div>
      <main className="main-frame">
        <div className="page-container">{children(page === 'assistant' ? conversationToolbar : null)}</div>
      </main>
    </div>

    <AppUpdateNotice />
    {/* 会话行菜单固定定位渲染，避免被侧栏滚动裁剪。 */}
    {rowMenu && (() => {
      const target = conversations.find((item) => item.id === rowMenu.conversationId);
      if (!target) return null;
      return <div className="menu ti-menu open" data-floating-menu role="menu" aria-label="对话操作" style={{ left: rowMenu.left, top: rowMenu.top }}>
        <button className="menu-item plain" type="button" onClick={() => BeginRenameConversation(target.id, target.title, rowMenu.sectionId)}>
          <Icon name="edit" size={16} /><span className="mt">重命名</span>
        </button>
        <div className="menu-sep" aria-hidden="true" />
        <button className="menu-item plain" type="button" onClick={() => { SetArchiveTarget({ id: target.id, title: target.title }); SetRowMenu(null); }}>
          <Icon name="archive" size={16} /><span className="mt">归档</span>
        </button>
      </div>;
    })()}

    {/* 分组管理仅影响侧栏展示，最近中的记录保持不变。 */}
    {groupMenu && <div className="menu ti-menu open" data-floating-menu role="menu" aria-label="分组操作" style={{ left: groupMenu.left, top: groupMenu.top }}>
      <button className="menu-item plain" type="button" onClick={() => BeginRenameGroup(groupMenu.projectId, groupMenu.name)}>
        <Icon name="edit" size={16} /><span className="mt">重命名</span>
      </button>
      <button className="menu-item plain" type="button" onClick={() => { SetRemoveGroupTarget({ projectId: groupMenu.projectId, name: groupMenu.name, count: groupMenu.count }); SetGroupMenu(null); }}>
        <Icon name="delete" size={16} /><span className="mt">删除</span>
      </button>
    </div>}

    {/* 账户菜单锚定在用户卡上方，位于侧栏之外以免被裁剪 */}
    {userMenuPosition && <div className="menu user-menu open" data-floating-menu role="menu" aria-label="账户" style={{ left: userMenuPosition.left, bottom: userMenuPosition.bottom, '--user-menu-bottom': `${userMenuPosition.bottom}px` } as CSSProperties}>
      <ProviderUsagePanel onConfigure={() => { SetUserMenuPosition(null); onRequestSettingsTab('api'); onNavigate('settings'); }} />
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
      <button className="menu-item plain" type="button" role="menuitem" onClick={() => { SetUserMenuPosition(null); onNavigate('settings'); }}><Icon name="settings" size={16} /><span className="mt">设置</span></button>
      <button className="menu-item plain" type="button" onClick={() => { SetUserMenuPosition(null); onRestartOnboarding(); }}><Icon name="recovery" size={16} /><span className="mt">重新查看使用教程</span></button>
      {settings.developerMode && <button className="menu-item plain" type="button" onClick={() => { SetUserMenuPosition(null); onNavigate('developer'); }}><Icon name="code" size={16} /><span className="mt">开发者工具</span></button>}
      <div className="menu-sep" aria-hidden="true" />
      <button className="menu-item plain um-danger" type="button" onClick={() => ShowNotice('退出功能将在 Electron 客户端接入后启用', "info")}><Icon name="logout" size={16} /><span className="mt">退出登录</span></button>
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
      将移除「{removeGroupTarget?.name}」的项目分组入口；其中 {removeGroupTarget?.count} 个对话仍保留在「最近」，项目空间绑定不受影响。
    </Modal>
  </div>;
}

export { AppShell };
