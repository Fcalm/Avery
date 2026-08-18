import { useCallback, useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { MainRoutes } from './routes';
import { useUiStore } from './UiStore';
import { useConversations, useCreateConversation, useDeleteConversation, useRenameConversation } from '../features/conversation/api/conversationQueries';
import { useSettingsStore } from '../features/settings/api/settingsQueries';
import type { PageId } from '../types/domain';
import { Button, Modal } from '../shared/components/UI';
import { Icon } from '../shared/components/Icon';
import { GetAgentBalance, IsDesktopAgentAvailable } from '../features/assistant/api/agentQueries';
import { ASSISTANT_MAIN_MIN_WIDTH } from '../shared/layoutConstants';

const ChineseDigits = ['〇', '一', '二', '三', '四', '五', '六', '七', '八', '九'];
const Weekdays = ['日', '一', '二', '三', '四', '五', '六'];
const MinSidebarWidth = 192;
const MaxSidebarWidth = 360;
const MinContentWidth = 800;

function ToChineseNumber(value: number) {
  if (value < 10) return ChineseDigits[value];
  if (value === 10) return '十';
  if (value < 20) return `十${ChineseDigits[value - 10]}`;
  return `${ChineseDigits[Math.floor(value / 10)]}十${value % 10 ? ChineseDigits[value % 10] : ''}`;
}

function FormatChineseDate(date = new Date()) {
  const year = String(date.getFullYear()).split('').map((digit) => ChineseDigits[Number(digit)]).join('');
  return `${year}年${ToChineseNumber(date.getMonth() + 1)}月${ToChineseNumber(date.getDate())}日 星期${Weekdays[date.getDay()]}`;
}

function FormatBalance(currency: string, total: string) {
  const number = Number(total);
  const amount = Number.isFinite(number) ? number.toFixed(2) : total;
  return currency === 'CNY' ? `¥ ${amount}` : currency === 'USD' ? `$ ${amount}` : `${currency} ${amount}`;
}

function AppShell({ page, onNavigate, onRestartOnboarding, children }: { page: PageId; onNavigate: (page: PageId) => void; onRestartOnboarding: () => void; children: ReactNode }) {
  const conversations = useConversations();
  const createConversation = useCreateConversation({ onFailure: (message) => ShowNotice(message || '会话创建失败，请稍后重试。') });
  const renameConversation = useRenameConversation({ onConflict: () => ShowNotice('会话已在其他窗口被修改，已刷新为最新版本'), onFailure: () => ShowNotice('会话重命名失败，请稍后重试。') });
  const deleteConversation = useDeleteConversation({ onFailure: () => ShowNotice('会话删除失败，请稍后重试。') });
  const { settings, setSettings } = useSettingsStore();
  const { activeConversationId, setActiveConversationId, resumePanelOpen, setResumePanelOpen, ShowNotice } = useUiStore();
  const activeConversation = conversations.find((item) => item.id === activeConversationId);
  const [renameConversationId, setRenameConversationId] = useState<string | null>(null);
  const [renameTitle, setRenameTitle] = useState('');
  const [deleteConversationId, setDeleteConversationId] = useState<string | null>(null);
  const [balance, setBalance] = useState<Array<{ currency: string; totalBalance: string }> | null>(null);
  const [refreshingBalance, setRefreshingBalance] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const appShellRef = useRef<HTMLDivElement>(null);
  const sidebarWidthRef = useRef(224);
  const minimumContentWidth = page === 'assistant' ? ASSISTANT_MAIN_MIN_WIDTH : MinContentWidth;

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

  useEffect(() => {
    const KeepContentReadable = () => {
      const shellWidth = appShellRef.current?.clientWidth ?? window.innerWidth;
      const maximum = Math.min(MaxSidebarWidth, Math.max(MinSidebarWidth, shellWidth - minimumContentWidth));
      const width = Math.min(sidebarWidthRef.current, maximum);
      sidebarWidthRef.current = width;
      appShellRef.current?.style.setProperty('--sidebar-width', `${width}px`);
    };
    KeepContentReadable();
    window.addEventListener('resize', KeepContentReadable);
    return () => window.removeEventListener('resize', KeepContentReadable);
  }, [minimumContentWidth]);

  async function HandleNewConversation() {
    const id = await createConversation('新的求职会话');
    setActiveConversationId(id);
    onNavigate('assistant');
  }

  function HandleDeveloperModeChange(enabled: boolean) {
    setSettings((current) => ({ ...current, developerMode: enabled }));
    ShowNotice(enabled ? '开发者模式已开启，请重启客户端后查看开发者界面' : '开发者模式已关闭');
  }

  function HandleResumePanel() {
    setResumePanelOpen(!resumePanelOpen);
    if (page !== 'assistant') onNavigate('assistant');
  }
  function BeginRenameConversation(id: string, title: string) { setRenameConversationId(id); setRenameTitle(title); }
  function SaveConversationRename() {
    const title = renameTitle.trim();
    if (!renameConversationId || !title) return;
    const expectedRevision = conversations.find((item) => item.id === renameConversationId)?.revision;
    renameConversation.mutate({ id: renameConversationId, title, expectedRevision });
    setRenameConversationId(null);
  }
  function ConfirmDeleteConversation() {
    if (!deleteConversationId) return;
    deleteConversation.mutate({ id: deleteConversationId });
    setDeleteConversationId(null);
  }

  function StartSidebarResize(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0 || sidebarCollapsed) return;
    event.preventDefault();
    const shell = appShellRef.current;
    if (!shell) return;
    const bounds = shell.getBoundingClientRect();
    document.body.classList.add('is-resizing-sidebar');
    const Resize = (moveEvent: PointerEvent) => {
      const maximum = Math.min(MaxSidebarWidth, Math.max(MinSidebarWidth, shell.clientWidth - minimumContentWidth));
      const width = Math.min(maximum, Math.max(MinSidebarWidth, moveEvent.clientX - bounds.left));
      sidebarWidthRef.current = width;
      shell.style.setProperty('--sidebar-width', `${width}px`);
    };
    const Stop = () => {
      document.body.classList.remove('is-resizing-sidebar');
      window.removeEventListener('pointermove', Resize);
      window.removeEventListener('pointerup', Stop);
      window.removeEventListener('pointercancel', Stop);
    };
    window.addEventListener('pointermove', Resize);
    window.addEventListener('pointerup', Stop, { once: true });
    window.addEventListener('pointercancel', Stop, { once: true });
  }

  return <div ref={appShellRef} className={`app-shell ${sidebarCollapsed ? 'is-sidebar-collapsed' : ''}`} style={{ '--main-content-min-width': `${minimumContentWidth}px` } as CSSProperties}>
    <aside className="sidebar" aria-label="主导航">
      <button className="sidebar-collapse-toggle" type="button" aria-label={sidebarCollapsed ? '展开导航栏' : '隐藏导航栏'} title={sidebarCollapsed ? '展开导航栏' : '隐藏导航栏'} onClick={() => setSidebarCollapsed((value) => !value)}><Icon name="chevron-down" size={15} className={sidebarCollapsed ? 'points-right' : 'points-left'} /></button>
      <div className="brand">
        <div><b>OfferGet</b></div>
      </div>

      <nav className="sidebar-nav">
        <p className="nav-label">场景</p>
        <div className={`assistant-nav ${page === 'assistant' ? 'is-active' : ''}`}>
          <button className="nav-entry" type="button" aria-current={page === 'assistant' ? 'page' : undefined} title="求职助手" onClick={() => onNavigate('assistant')}><i><Icon name="assistant" /></i><span>求职助手</span></button>
          <button className="new-chat" type="button" onClick={() => void HandleNewConversation()} aria-label="新建会话" title="新建会话"><Icon name="plus" size={18} /></button>
        </div>
        <div className="conversation-nav" aria-label="历史会话">
          {conversations.slice(0, 6).map((item) => <div key={item.id} className={`conversation-entry ${item.id === activeConversationId && page === 'assistant' ? 'is-current' : ''}`}><button type="button" onClick={() => { setActiveConversationId(item.id); onNavigate('assistant'); }}><span>{item.title}</span></button><div><button type="button" aria-label="重命名会话" title="重命名会话" onClick={() => BeginRenameConversation(item.id, item.title)}><Icon name="edit" size={15} /></button><button type="button" aria-label="删除会话" title="删除会话" onClick={() => setDeleteConversationId(item.id)}><Icon name="delete" size={15} /></button></div></div>)}
        </div>
        {MainRoutes.filter((route) => route.group === 'scene' && route.id !== 'assistant').map((route) => <button key={route.id} className={`nav-entry ${page === route.id ? 'is-active' : ''}`} type="button" aria-current={page === route.id ? 'page' : undefined} title={route.label} onClick={() => onNavigate(route.id)}><i><Icon name={route.icon} /></i><span>{route.label}</span></button>)}
        <p className="nav-label mine-label">我的</p>
        {MainRoutes.filter((route) => route.group === 'mine').map((route) => <button key={route.id} className={`nav-entry ${page === route.id ? 'is-active' : ''}`} type="button" aria-current={page === route.id ? 'page' : undefined} title={route.label} onClick={() => onNavigate(route.id)}><i><Icon name={route.icon} /></i><span>{route.label}</span></button>)}
        {settings.developerMode && <><p className="nav-label mine-label">开发者</p>{MainRoutes.filter((route) => route.group === 'developer').map((route) => <button key={route.id} className={`nav-entry ${page === route.id ? 'is-active' : ''}`} type="button" aria-current={page === route.id ? 'page' : undefined} title={route.label} onClick={() => onNavigate(route.id)}><i><Icon name={route.icon} /></i><span>{route.label}</span></button>)}</>}
      </nav>

      <div className="sidebar-user">
        <div className="user-menu-wrap">
          <button className="sidebar-user-trigger" type="button"><span className="avatar">{settings.nickname.slice(0, 1)}</span><span><b>{settings.nickname}</b><small>账户与偏好</small></span><em><Icon name="more" size={16} /></em></button>
          <div className="user-flyout" aria-label="账户菜单">
            <button type="button" onClick={() => onNavigate('settings')}><span className="user-menu-item-label"><Icon name="settings" size={16} /><span>设置</span></span></button>
            <label className="developer-toggle"><span className="user-menu-item-label"><Icon name="developer-mode" size={16} /><span>开发者模式</span></span><input className="switch-control" type="checkbox" role="switch" aria-label="开发者模式" checked={settings.developerMode} onChange={(event) => HandleDeveloperModeChange(event.target.checked)} /></label>
            <div className="balance-line"><span className="user-menu-item-label"><Icon name="balance" size={16} /><span>账户余额</span></span><div><b>{refreshingBalance && !balance ? '刷新中…' : balance?.map((item) => FormatBalance(item.currency, item.totalBalance)).join(' / ') ?? '未配置'}</b><button className="balance-refresh" type="button" onClick={() => void RefreshBalance(true)} disabled={refreshingBalance} aria-label="刷新余额" title="刷新余额"><Icon name="refresh" size={15} /></button></div></div>
            <button className="sign-out-button" type="button" onClick={() => ShowNotice('退出功能将在 Electron 客户端接入后启用')}><span className="user-menu-item-label"><Icon name="logout" size={16} /><span>退出</span></span></button>
          </div>
        </div>
        <button className="restart-onboarding" type="button" onClick={onRestartOnboarding}>重新体验启动页</button>
      </div>
      <div className="sidebar-resizer" aria-hidden="true" onPointerDown={StartSidebarResize} />
    </aside>
    <main className="main-frame">
      <header className="letterhead"><div className="letterhead-context"><strong>{FormatChineseDate().replace(/^.*?年/, '')}</strong><span>当前场景 · {MainRoutes.find((route) => route.id === page)?.label ?? '设置'}</span></div><div className="letterhead-note">{page === 'assistant' && <button className="letterhead-resume-button" type="button" onClick={HandleResumePanel} aria-expanded={resumePanelOpen} aria-label={resumePanelOpen ? '隐藏侧边栏' : '展开侧边栏'} title={resumePanelOpen ? '隐藏侧边栏' : '展开侧边栏'}><Icon name={resumePanelOpen ? 'sidebar-collapse' : 'sidebar-expand'} size={17} /></button>}</div></header>
      <div className="letter-rule" />
      <div className="page-container">{children}</div>
    </main>
    <Modal open={Boolean(renameConversationId)} title="重命名会话" onClose={() => setRenameConversationId(null)}><input value={renameTitle} maxLength={120} onChange={(event) => setRenameTitle(event.target.value)} autoFocus /><div className="modal-actions"><Button onClick={() => setRenameConversationId(null)}>取消</Button><Button variant="primary" onClick={SaveConversationRename}>保存</Button></div></Modal>
    <Modal open={Boolean(deleteConversationId)} title="删除会话？" onClose={() => setDeleteConversationId(null)}><p className="modal-copy">会话及其本地消息将被删除，此操作不可撤销。</p><div className="modal-actions"><Button onClick={() => setDeleteConversationId(null)}>取消</Button><Button variant="danger" onClick={ConfirmDeleteConversation}>删除</Button></div></Modal>
  </div>;
}

export { AppShell };
