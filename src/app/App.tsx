import { useEffect, useRef, useState } from 'react';
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
import { SettingsPage, type SettingTab } from '../features/settings/pages/SettingsPage';
import { OnboardingPage } from '../features/settings/pages/OnboardingPage';
import { DeveloperPage } from '../features/developer/pages/DeveloperPage';
import { Button, DialogButton, EmptyState, Modal } from '../shared/components/UI';
import { BackendRecoveryGate, IsBackendRecoveryError } from './BackendRecoveryGate';
import { Icon } from '../shared/components/Icon';
import type { PageId } from '../types/domain';

/** 「启动时打开-恢复上次的对话」用的本机记录：只存会话 id，随工作空间之外的本机偏好保存。 */
const LastConversationKey = 'avery-last-conversation-id';

function App() {
  return <UiStoreProvider><AppContent /></UiStoreProvider>;
}

/** 应用启动阶段的加载占位，替代白屏。 */
function LoadingScreen() {
  return <div className="app-screen app-splash" role="status" aria-live="polite"><div className="app-splash-content"><svg className="app-splash-brand" viewBox="0 0 278 64" role="img" aria-label="Avery"><defs><linearGradient id="avery-splash-reveal-gradient" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stopColor="white" /><stop offset="0.76" stopColor="white" /><stop offset="1" stopColor="white" stopOpacity="0" /></linearGradient><mask id="avery-splash-reveal-mask" maskUnits="userSpaceOnUse" maskContentUnits="userSpaceOnUse"><rect x="-360" y="0" width="360" height="64" fill="url(#avery-splash-reveal-gradient)"><animate attributeName="x" from="-360" to="0" dur="1.2s" fill="freeze" /></rect></mask></defs><g mask="url(#avery-splash-reveal-mask)"><image href="./assets/avery-guiding-elf-icon-v2.png" x="0" y="0" width="64" height="64" preserveAspectRatio="xMidYMid meet" /><text x="78" y="46">Avery</text></g></svg></div></div>;
}

/** 应用启动加载失败的错误页，提供重试入口。 */
function ErrorScreen({ onRetry }: { onRetry: () => void }) {
  return <div className="app-screen"><EmptyState className="app-state app-state-error" role="alert" ariaLive="assertive" icon={<Icon name="error" size={24} />} title="本地数据加载失败" description="无法读取工作空间数据。请确认磁盘可访问后重新加载。" action={<Button variant="primary" onClick={onRetry}>重新加载</Button>} /></div>;
}

function AppContent() {
  const workspace = useWorkspaceData();
  const { settings, setSettings } = useSettingsStore();
  const { profileConflict, setProfileConflict, notice, ShowNotice, HideNotice, activeConversationId, setActiveConversationId } = useUiStore();
  const profiles = useProfiles();
  const reloadProfiles = useReloadProfiles({ onFailure: ShowNotice });
  const keepProfiles = useKeepProfiles({ onFailure: ShowNotice });
  const conversations = useConversations();
  const [page, setPage] = useState<PageId>('assistant');
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

  // 开发者页面不是可公开路由；设置关闭后立即退出，即使页面状态由调试工具直接改写也不能继续停留。
  useEffect(() => { if (page === 'developer' && !settings.developerMode) setPage('settings'); }, [page, settings.developerMode]);

  // 旧版本的 DeepSeek 别名已弃用，在读取本地工作空间后立即迁移为当前默认模型。
  useEffect(() => {
    if (settings.provider === 'DeepSeek' && (settings.model === 'deepseek-chat' || settings.model === 'deepseek-reasoner')) {
      setSettings((current) => ({ ...current, model: 'deepseek-v4-flash' }));
    }
  }, [setSettings, settings.model, settings.provider]);

  /** 处理档案外部修改冲突：重新加载磁盘版本或强制保留应用版本。 */
  function ResolveProfileConflict(action: 'reload' | 'keep') {
    if (action === 'reload') {
      void reloadProfiles.mutateAsync({}).then(() => { setProfileConflict(false); ShowNotice('已重新加载磁盘上的档案版本'); });
    } else {
      void keepProfiles.mutateAsync({ items: profiles }).then(() => { setProfileConflict(false); ShowNotice('已保留应用版本并覆盖本地档案'); });
    }
  }

  if (workspace.isError && IsBackendRecoveryError(workspace.error)) return <BackendRecoveryGate onRetry={() => void workspace.refetch()} />;
  if (workspace.isError) return <ErrorScreen onRetry={() => void workspace.refetch()} />;
  if (workspace.isLoading || !workspace.data) return <LoadingScreen />;
  if (!settings.onboardingCompleted) return <OnboardingPage onComplete={() => setSettings((current) => ({ ...current, onboardingCompleted: true }))} />;
  return <>
    <AppShell page={page} onNavigate={setPage} onRestartOnboarding={() => setSettings((current) => ({ ...current, onboardingCompleted: false }))} settingsTab={settingsTab} onRequestSettingsTab={RequestSettingsTab}>
      {/* 在途 Agent 依赖 Renderer 流订阅写回消息终态；导航时隐藏而非卸载，避免遗漏流事件。 */}
      <section className="assistant-page-presence" hidden={page !== 'assistant'}><AssistantPage onNavigate={setPage} /></section>
      {page === 'jobs' && <JobsPage onGoAssistant={() => setPage('assistant')} />}{page === 'applications' && <ApplicationsPage />}{page === 'resumes' && <ResumesPage onGoAssistant={() => setPage('assistant')} />}{page === 'profiles' && <ProfilesPage />}{page === 'settings' && <SettingsPage onNavigateDeveloper={() => setPage('developer')} tab={settingsTab} requestedTab={requestedSettingsTab} tabRequestVersion={settingsTabRequestVersion} onTabChange={setSettingsTab} />}{page === 'developer' && <DeveloperPage />}
    </AppShell>
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
    {/* 原型同款通知：底部居中药丸，图标随语气区分；点击动作先收起再执行 */}
    {notice && <div key={notice.id} className={`app-toast${notice.action ? ' has-action' : ''}`} role="status" aria-live="polite">
      <Icon name={notice.tone === 'error' ? 'error' : notice.tone === 'pending' ? 'loading' : 'check-circle'} size={14} />
      <span>{notice.message}</span>
      {notice.action && <button className="app-toast-act" type="button" onClick={() => { HideNotice(); notice.action?.run(); }}>{notice.action.label}</button>}
    </div>}
  </>;
}

export { App };
