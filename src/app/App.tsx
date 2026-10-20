import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { AppShell } from './AppShell';
import { UiStoreProvider, useUiStore } from './UiStore';
import { useWorkspaceData } from '../features/workspace/api/useWorkspaceData';
import { useSettingsStore } from '../features/settings/api/settingsQueries';
import { useKeepProfiles, useProfiles, useReloadProfiles } from '../features/profile/api/profileQueries';
import { useConversations } from '../features/conversation/api/conversationQueries';
import { AssistantPage } from '../features/assistant/pages/AssistantPage';
import { ApplicationsPage } from '../features/application/pages/ApplicationsPage';
import { JobsPage } from '../features/job/pages/JobsPage';
import { ResumesPage } from '../features/resume/pages/ResumesPage';
import { ProfilesPage } from '../features/profile/pages/ProfilesPage';
import { SettingsPage, ChatFontSizes, type SettingTab } from '../features/settings/pages/SettingsPage';
import { OnboardingPage } from '../features/settings/pages/OnboardingPage';
import { DeveloperPage } from '../features/developer/pages/DeveloperPage';
import { DeveloperConsoleProvider } from '../features/developer/components/DeveloperConsoleContext';
import { Button, DialogButton, EmptyState, Modal } from '../shared/components/UI';
import { BackendRecoveryGate, IsBackendRecoveryError } from './BackendRecoveryGate';
import { Icon } from '../shared/components/Icon';
import { StartupScreen } from './StartupScreen';
import type { PageId } from '../types/domain';

/** 「启动时打开-恢复上次的对话」用的本机记录：只存会话 id，随工作空间之外的本机偏好保存。 */
const LastConversationKey = 'avery-last-conversation-id';

function App() {
  useLayoutEffect(() => {
    const root = document.getElementById('root');
    if (!root) return;
    const viewport = window.visualViewport;
    let requestVersion = 0;
    async function UpdateFrameSize() {
      // 非整数显示/页面缩放下，Renderer 的视口可能比原生客户区多出像素。
      // 桌面端使用宿主窗口边界；浏览器预览使用可见视口，并对齐物理像素。
      const scale = window.devicePixelRatio;
      const version = ++requestVersion;
      let frame: { width: number; height: number; unit: 'physical' | 'css'; cornerRadius?: number } | undefined;
      try {
        frame = await window.averyWindow?.GetFrameSize?.();
      } catch (error) {
        console.error('读取窗口边界失败', error);
        return;
      }
      if (version !== requestVersion) return;
      const width = frame ? frame.width / (frame.unit === 'physical' ? scale : 1) : viewport?.width ?? window.innerWidth;
      const height = frame ? frame.height / (frame.unit === 'physical' ? scale : 1) : viewport?.height ?? window.innerHeight;
      if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return;
      root!.style.setProperty('--window-frame-width', `${Math.round(width * scale) / scale}px`);
      root!.style.setProperty('--window-frame-height', `${Math.round(height * scale) / scale}px`);
      root!.style.setProperty('--window-corner-radius', `${frame?.cornerRadius ?? 0}px`);
    }
    UpdateFrameSize();
    const unsubscribe = window.averyWindow?.OnFrameSizeChange?.(() => { void UpdateFrameSize(); });
    const unsubscribeMaximized = window.averyWindow?.OnMaximizedChange?.(() => { void UpdateFrameSize(); });
    window.addEventListener('resize', UpdateFrameSize);
    viewport?.addEventListener('resize', UpdateFrameSize);
    return () => {
      requestVersion += 1;
      unsubscribe?.();
      unsubscribeMaximized?.();
      window.removeEventListener('resize', UpdateFrameSize);
      viewport?.removeEventListener('resize', UpdateFrameSize);
      root.style.removeProperty('--window-frame-width');
      root.style.removeProperty('--window-frame-height');
      root.style.removeProperty('--window-corner-radius');
    };
  }, []);
  return <UiStoreProvider><AppContent /><AppNotice /></UiStoreProvider>;
}

/** 应用启动加载失败的错误页，提供重试入口。 */
function ErrorScreen({ onRetry }: { onRetry: () => void }) {
  return <div className="app-screen"><EmptyState className="app-state app-state-error" role="alert" ariaLive="assertive" icon={<Icon name="error" size={24} />} title="本地数据加载失败" description="无法读取工作空间数据。请确认磁盘可访问后重新加载。" action={<Button variant="primary" onClick={onRetry}>重新加载</Button>} /></div>;
}

function AppContent() {
  const workspace = useWorkspaceData();
  const [startupAnimationComplete, setStartupAnimationComplete] = useState(false);
  const HandleStartupAnimationComplete = useCallback(() => setStartupAnimationComplete(true), []);
  const { settings, setSettings } = useSettingsStore();
  const { profileConflict, setProfileConflict, ShowNotice, activeConversationId, setActiveConversationId } = useUiStore();
  const profiles = useProfiles();
  const reloadProfiles = useReloadProfiles({ onFailure: ShowNotice });
  const keepProfiles = useKeepProfiles({ onFailure: ShowNotice });
  const conversations = useConversations();
  const [page, setPage] = useState<PageId>('assistant');
  const [reviewingTutorial, setReviewingTutorial] = useState(false);
  const [settingsTab, setSettingsTab] = useState<SettingTab>('general');
  const [requestedSettingsTab, setRequestedSettingsTab] = useState<SettingTab>('general');
  const [settingsTabRequestVersion, setSettingsTabRequestVersion] = useState(0);

  // 「启动时打开」：会话数据就绪后回到上次活跃会话（设置选 last 时）；一次性执行，之后才允许持久化写入。
  const startRestoreDoneRef = useRef(false);
  useEffect(() => {
    if (!workspace.data || startRestoreDoneRef.current) return;
    startRestoreDoneRef.current = true;
    if (settings.startPage !== 'last') return;
    const lastId = localStorage.getItem(LastConversationKey) ?? '';
    const target = conversations.find((item) => item.id === lastId && !(item.archived ?? false));
    if (target) setActiveConversationId(target.id);
  }, [workspace.data, conversations, setActiveConversationId, settings.startPage]);
  // 上次会话 id 随切换实时落盘；恢复完成前不写入，避免空值覆盖已保存的 id。
  useEffect(() => {
    if (!startRestoreDoneRef.current) return;
    localStorage.setItem(LastConversationKey, activeConversationId ?? '');
  }, [activeConversationId]);

  function RequestSettingsTab(tab: SettingTab) {
    setRequestedSettingsTab(tab);
    setSettingsTabRequestVersion((current) => current + 1);
  }

  function CloseTutorial(destination?: PageId) {
    if (destination) setPage(destination);
    setReviewingTutorial(false);
    requestAnimationFrame(() => document.querySelector<HTMLButtonElement>('.user-card')?.focus());
  }

  // 开发者页面不是可公开路由；设置关闭后立即退出，即使页面状态由调试工具直接改写也不能继续停留。
  useEffect(() => { if (page === 'developer' && !settings.developerMode) setPage('settings'); }, [page, settings.developerMode]);

  // 旧版本的 DeepSeek 别名已弃用，在读取本地工作空间后立即迁移为当前默认模型。
  useEffect(() => {
    if (settings.provider === 'DeepSeek' && (settings.model === 'deepseek-chat' || settings.model === 'deepseek-reasoner')) {
      setSettings((current) => ({ ...current, model: 'deepseek-v4-flash' }));
    }
  }, [setSettings, settings.model, settings.provider]);

  // 个性化-字号大小：把回复字号挂到根元素，聊天气泡与设置页预览共用同一变量；默认档不注入，跟随样式表原值。
  useEffect(() => {
    const root = document.documentElement;
    const size = ChatFontSizes.find((item) => item.key === (settings.chatFontSize ?? 'md')) ?? ChatFontSizes[1];
    if (size.key === 'md') {
      root.style.removeProperty('--avery-reply-fs');
      root.style.removeProperty('--avery-reply-lh');
    } else {
      root.style.setProperty('--avery-reply-fs', `${size.px}px`);
      root.style.setProperty('--avery-reply-lh', '2em');
    }
  }, [settings.chatFontSize]);

  /** 处理档案外部修改冲突：重新加载磁盘版本或强制保留应用版本。 */
  function ResolveProfileConflict(action: 'reload' | 'keep') {
    if (action === 'reload') {
      void reloadProfiles.mutateAsync({}).then(() => { setProfileConflict(false); ShowNotice('已重新加载磁盘上的档案版本'); });
    } else {
      void keepProfiles.mutateAsync({ items: profiles }).then(() => { setProfileConflict(false); ShowNotice('已保留应用版本并覆盖本地档案'); });
    }
  }

  // 动画与数据并行准备；只有两者都完成才进入应用，查询更新不会重播开屏。
  if (!startupAnimationComplete || workspace.isLoading || (!workspace.data && !workspace.isError)) {
    return <StartupScreen animationComplete={startupAnimationComplete} onAnimationComplete={HandleStartupAnimationComplete} />;
  }
  if (workspace.isError && IsBackendRecoveryError(workspace.error)) return <BackendRecoveryGate onRetry={() => void workspace.refetch()} />;
  if (workspace.isError) return <ErrorScreen onRetry={() => void workspace.refetch()} />;
  if (!settings.onboardingCompleted) return <OnboardingPage onComplete={(destination) => setPage(destination ?? 'profiles')} />;
  return <>
    <div className="tour-workspace" inert={reviewingTutorial}>
    {/* 开发者页的侧栏与主区共享评测配置状态；Provider 常驻挂载，仅在开发者页激活时拉取数据 */}
    <DeveloperConsoleProvider active={page === 'developer'}>
      <AppShell page={page} onNavigate={setPage} onRestartOnboarding={() => setReviewingTutorial(true)} settingsTab={settingsTab} onRequestSettingsTab={RequestSettingsTab}>
        {/* 在途 Agent 依赖 Renderer 流订阅写回消息终态；导航时隐藏而非卸载，避免遗漏流事件。 */}
        <section className="assistant-page-presence" hidden={page !== 'assistant'}><AssistantPage onNavigate={setPage} /></section>
        {page === 'jobs' && <JobsPage onGoAssistant={() => setPage('assistant')} />}{page === 'applications' && <ApplicationsPage />}{page === 'resumes' && <ResumesPage onGoAssistant={() => setPage('assistant')} />}{page === 'profiles' && <ProfilesPage />}{page === 'settings' && <SettingsPage onNavigateDeveloper={() => setPage('developer')} tab={settingsTab} requestedTab={requestedSettingsTab} tabRequestVersion={settingsTabRequestVersion} onTabChange={setSettingsTab} />}{page === 'developer' && <DeveloperPage />}
      </AppShell>
    </DeveloperConsoleProvider>
    <Modal
      open={profileConflict}
      title="档案文件已被外部修改"
      onClose={() => undefined}
      footer={<>
        <DialogButton onClick={() => void ResolveProfileConflict('reload')}>重新加载磁盘版本</DialogButton>
        <DialogButton tone="accent" onClick={() => void ResolveProfileConflict('keep')}>保留应用版本</DialogButton>
      </>}
    >
      本地工作空间的档案文件（profile.json）已被其他程序修改。请选择保留磁盘版本，还是覆盖为应用中的最新版本。
    </Modal>
    </div>
    {reviewingTutorial && <OnboardingPage review onClose={() => CloseTutorial()} onComplete={CloseTutorial} />}
  </>;
}

/** 通知常驻于路由分支之外，确保首次引导和启动错误页也能呈现操作反馈。 */
function AppNotice() {
  const { notice, HideNotice } = useUiStore();
  if (!notice) return null;
  return <div key={notice.id} className={`app-toast${notice.action ? ' has-action' : ''}`} role="status" aria-live="polite">
      <Icon name={notice.tone === 'error' ? 'error' : notice.tone === 'pending' ? 'loading' : 'check-circle'} size={14} />
      <span>{notice.message}</span>
      {notice.action && <button className="app-toast-act" type="button" onClick={() => { HideNotice(); notice.action?.run(); }}>{notice.action.label}</button>}
    </div>;
}

export { App };
