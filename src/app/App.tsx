import { useEffect, useState } from 'react';
import { AppShell } from './AppShell';
import { UiStoreProvider, useUiStore } from './UiStore';
import { useWorkspaceData } from '../features/workspace/api/useWorkspaceData';
import { useSettingsStore } from '../features/settings/api/settingsQueries';
import { useKeepProfiles, useProfiles, useReloadProfiles } from '../features/profile/api/profileQueries';
import { AssistantPage } from '../features/assistant/pages/AssistantPage';
import { ApplicationsPage } from '../features/application/pages/ApplicationsPage';
import { JobsPage } from '../features/job/pages/JobsPage';
import { ResumesPage } from '../features/resume/pages/ResumesPage';
import { ProfilesPage } from '../features/profile/pages/ProfilesPage';
import { SettingsPage } from '../features/settings/pages/SettingsPage';
import { OnboardingPage } from '../features/settings/pages/OnboardingPage';
import { DeveloperPage } from '../features/developer/pages/DeveloperPage';
import { Button, EmptyState, Modal } from '../shared/components/UI';
import { BackendRecoveryGate, IsBackendRecoveryError } from './BackendRecoveryGate';
import { Icon } from '../shared/components/Icon';
import type { PageId } from '../types/domain';

type WindowControls = {
  Minimize: () => Promise<boolean>;
  ToggleMaximize: () => Promise<boolean>;
  Close: () => Promise<boolean>;
};

function NativeTitlebar({ sidebarCollapsed, onToggleSidebar }: { sidebarCollapsed: boolean; onToggleSidebar: () => void }) {
  const controls = (window as Window & { offergetWindow?: WindowControls }).offergetWindow;
  const [isMaximized, setIsMaximized] = useState(false);
  async function ToggleMaximize() {
    setIsMaximized(await controls?.ToggleMaximize() ?? false);
  }
  return <div className="native-titlebar">
    <div className="titlebar-brand">
      <button className="titlebar-brand-toggle" type="button" aria-label={sidebarCollapsed ? '展开导航栏' : '隐藏导航栏'} aria-pressed={!sidebarCollapsed} title={sidebarCollapsed ? '展开导航栏' : '隐藏导航栏'} onClick={onToggleSidebar}>
        <img src="./assets/avery-guiding-elf-icon-v2.png" alt="" />
        <span className="titlebar-brand-toggle-icon" aria-hidden="true"><Icon name={sidebarCollapsed ? 'sidebar-expand' : 'sidebar-collapse'} size={18} /></span>
      </button>
      <span className="titlebar-brand-wordmark">Avery</span>
    </div>
    {controls && <div className="window-controls" aria-label="窗口控制">
      <button className="window-control window-control-minimize" type="button" aria-label="最小化" onClick={() => void controls.Minimize()}><Icon name="window-minimize" size={14} /></button>
      <button className="window-control window-control-maximize" type="button" aria-label="最大化或还原" onClick={() => void ToggleMaximize()}><Icon name={isMaximized ? 'window-restore' : 'window-maximize'} size={14} /></button>
      <button className="window-control window-control-close" type="button" aria-label="关闭窗口" onClick={() => void controls.Close()}><Icon name="close" size={14} /></button>
    </div>}
  </div>;
}

function App() {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  return <UiStoreProvider><NativeTitlebar sidebarCollapsed={sidebarCollapsed} onToggleSidebar={() => setSidebarCollapsed((value) => !value)} /><AppContent sidebarCollapsed={sidebarCollapsed} /></UiStoreProvider>;
}

/** 应用启动阶段的加载占位，替代白屏。 */
function LoadingScreen() {
  return <div className="app-screen app-splash" role="status" aria-live="polite"><div className="app-splash-content"><svg className="app-splash-brand" viewBox="0 0 278 64" role="img" aria-label="Avery"><defs><linearGradient id="avery-splash-reveal-gradient" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stopColor="white" /><stop offset="0.76" stopColor="white" /><stop offset="1" stopColor="white" stopOpacity="0" /></linearGradient><mask id="avery-splash-reveal-mask" maskUnits="userSpaceOnUse" maskContentUnits="userSpaceOnUse"><rect x="-360" y="0" width="360" height="64" fill="url(#avery-splash-reveal-gradient)"><animate attributeName="x" from="-360" to="0" dur="1.2s" fill="freeze" /></rect></mask></defs><g mask="url(#avery-splash-reveal-mask)"><image href="./assets/avery-guiding-elf-icon-v2.png" x="0" y="0" width="64" height="64" preserveAspectRatio="xMidYMid meet" /><text x="78" y="46">Avery</text></g></svg></div></div>;
}

/** 应用启动加载失败的错误页，提供重试入口。 */
function ErrorScreen({ onRetry }: { onRetry: () => void }) {
  return <div className="app-screen"><EmptyState className="app-state app-state-error" role="alert" ariaLive="assertive" icon={<Icon name="error" size={24} />} title="本地数据加载失败" description="无法读取工作空间数据。请确认磁盘可访问后重新加载。" action={<Button variant="primary" onClick={onRetry}>重新加载</Button>} /></div>;
}

function AppContent({ sidebarCollapsed }: { sidebarCollapsed: boolean }) {
  const workspace = useWorkspaceData();
  const { settings, setSettings } = useSettingsStore();
  const { profileConflict, setProfileConflict, ShowNotice } = useUiStore();
  const profiles = useProfiles();
  const reloadProfiles = useReloadProfiles({ onFailure: ShowNotice });
  const keepProfiles = useKeepProfiles({ onFailure: ShowNotice });
  const [page, setPage] = useState<PageId>('assistant');

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
    <AppShell page={page} sidebarCollapsed={sidebarCollapsed} onNavigate={setPage} onRestartOnboarding={() => setSettings((current) => ({ ...current, onboardingCompleted: false }))}>{page === 'assistant' && <AssistantPage onNavigate={setPage} />}{page === 'jobs' && <JobsPage />}{page === 'applications' && <ApplicationsPage />}{page === 'resumes' && <ResumesPage onGoAssistant={() => setPage('assistant')} />}{page === 'profiles' && <ProfilesPage />}{page === 'settings' && <SettingsPage onNavigateDeveloper={() => setPage('developer')} />}{page === 'developer' && <DeveloperPage />}</AppShell>
    <Modal open={profileConflict} title="档案文件已被外部修改" onClose={() => undefined}><p className="modal-copy">本地工作空间的档案文件（profile.json）已被其他程序修改。请选择保留磁盘版本，还是覆盖为应用中的最新版本。</p><div className="modal-actions"><Button onClick={() => void ResolveProfileConflict('reload')}>重新加载磁盘版本</Button><Button variant="primary" onClick={() => void ResolveProfileConflict('keep')}>保留应用版本</Button></div></Modal>
  </>;
}

export { App };
