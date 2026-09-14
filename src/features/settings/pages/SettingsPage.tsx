import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useUiStore } from '../../../app/UiStore';
import { useSettingsStore } from '../../../features/settings/api/settingsQueries';
import { ClearAgentObservability, ClearBrowserProfile, ConfigureAgent, GetAgentModuleConfiguration, GetAgentStatus, GetBrowserRuntimeStatus, GetCronBrowserAccess, GetDeepSeekModels, GetProviderCatalog, IsDesktopAgentAvailable, ResetAgentModules, RevokeCronBrowserAccess, SelectAgentModuleDirectory, SetAgentTraceRetention, TestAgentConnection } from '../../../features/assistant/api/agentQueries';
import { ApplyModelRuntime, CreateCatalogModel, DefaultContextWindow, DefaultMaxOutput, FindCatalogModel, FindCatalogProvider, FormatContextWindow, IsValidContextWindow, IsValidMaxOutput, LoadModelCatalog, MergeBackendProviders, MergeProviderModels, ModelApiFormats, SaveModelCatalog, type ModelApiFormat, type ModelCatalog, type ModelCatalogModel, type ModelCatalogProvider } from '../api/modelCatalog';
import { CreateWorkspaceBackup, MigrateWorkspace } from '../../../features/workspace/api/workspaceActions';
import { WORKSPACE_QUERY_KEY } from '../../../features/workspace/api/workspaceData';
import { Button, DialogButton, FormField, Modal, PageHeader, Select } from '../../../shared/components/UI';
import { Icon } from '../../../shared/components/Icon';
import type { SettingsDraft } from '../../../types/domain';
import type { AgentBrowserRuntimeStatus, AgentModuleConfiguration, CronBrowserAccessStatus } from '@avery/contracts';

export type SettingTab = 'account' | 'workspace' | 'api' | 'browser' | 'developer';
type FieldErrors = Partial<Record<'traceRetention' | 'compressionThreshold', string>>;
export const SettingsTabs: Array<{ id: SettingTab; label: string; description: string }> = [
  { id: 'account', label: '账户', description: '管理应用内的显示名称。' },
  { id: 'workspace', label: '工作空间', description: '管理档案、简历版本和导出文件的存放目录。' },
  { id: 'api', label: '模型配置', description: '管理模型供应商、默认模型与上下文能力；凭据加密存储在本机。' },
  { id: 'browser', label: '浏览器设置', description: '选择 Avery 隔离浏览器，或安全连接已登录 BOSS 的个人浏览器。' },
  { id: 'developer', label: '开发者模式', description: '查看本地日志、Trace 和上下文用量界面。' },
];
const BrowserEngineLabels = { electron: 'Avery 隔离浏览器', chrome: 'Google Chrome', edge: 'Microsoft Edge' } as const;
/** 模型配置侧栏的分组：推荐 = 官方供应商，自定义供应商可删除并改用自定义端点。 */
const ProviderGroups = ['推荐', '自定义供应商'];
/** 模型标记：与原型一致，推荐供应商用字母，自定义供应商用加号。 */
const ProviderMarks: Record<SettingsDraft['provider'], string> = { DeepSeek: 'D', 'Z.AI': 'Z', '自定义': '+' };

/** 模型编辑弹窗的草稿：数值字段保留字符串，取消时才不会写回目录。 */
interface ModelDialogDraft {
  index: number;
  id: string;
  contextWindow: string;
  maxOutput: string;
  inputImage: boolean;
  inputPdf: boolean;
  thinking: boolean;
}
interface ModelDialogErrors { id?: boolean; contextWindow?: boolean; maxOutput?: boolean; }

function NormalizeProviderSettings(settings: SettingsDraft): SettingsDraft {
  const contextLimitMode = settings.contextLimitMode ?? (settings.provider === '自定义' ? 'custom' : 'default');
  const contextLength = settings.provider === 'DeepSeek' && contextLimitMode === 'default' && settings.contextLength === '64K' ? '256K' : settings.contextLength;
  const model = settings.provider === 'Z.AI' ? 'glm-5.3-flash' : settings.provider === 'DeepSeek' && (!settings.model.startsWith('deepseek-') || settings.model === 'deepseek-chat' || settings.model === 'deepseek-reasoner') ? 'deepseek-v4-flash' : settings.model;
  const baseUrl = settings.provider === 'Z.AI' ? 'https://open.bigmodel.cn/api/paas/v4' : settings.provider === 'DeepSeek' ? 'https://api.deepseek.com' : settings.baseUrl;
  const browserEngine = settings.browserEngine === 'electron' || settings.browserEngine === 'chrome' ? settings.browserEngine : 'edge';
  return { ...settings, model, baseUrl, contextLength, contextLimitMode, browserEngine, thinkingEnabled: settings.provider === 'Z.AI' ? true : settings.thinkingEnabled };
}

function FormatContextLength(value: number): string {
  return value % 1000 === 0 ? `${value / 1000}K` : String(value);
}

function SettingsPage({ onNavigateDeveloper, tab, requestedTab, tabRequestVersion, onTabChange }: { onNavigateDeveloper: () => void; tab: SettingTab; requestedTab: SettingTab; tabRequestVersion: number; onTabChange: (tab: SettingTab) => void }) {
  const { ShowNotice } = useUiStore();
  const queryClient = useQueryClient();
  const { settings, saveSettingsNow } = useSettingsStore();
  const [draft, setDraft] = useState<SettingsDraft>(() => NormalizeProviderSettings(settings));
  const [refreshingModels, setRefreshingModels] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [showLeave, setShowLeave] = useState(false);
  const [nextTab, setNextTab] = useState<SettingTab | null>(null);
  const [showClear, setShowClear] = useState(false);
  const [showMigrate, setShowMigrate] = useState(false);
  const [showResetModules, setShowResetModules] = useState(false);
  const [browserRuntime, setBrowserRuntime] = useState<AgentBrowserRuntimeStatus | null>(null);
  const [browserRuntimeBusy, setBrowserRuntimeBusy] = useState(false);
  const [cronBrowserAccess, setCronBrowserAccess] = useState<CronBrowserAccessStatus | null>(null);
  const [cronBrowserTaskId, setCronBrowserTaskId] = useState('');
  const browserRuntimeRequest = useRef(0);
  const [showClearBrowserProfile, setShowClearBrowserProfile] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [moduleConfiguration, setModuleConfiguration] = useState<AgentModuleConfiguration | null>(null);
  const [updatingModules, setUpdatingModules] = useState(false);
  const [apiKeyConfigured, setApiKeyConfigured] = useState(false);
  const [configuredProvider, setConfiguredProvider] = useState<SettingsDraft['provider'] | null>(null);
  const [configuredProviders, setConfiguredProviders] = useState<Set<SettingsDraft['provider']>>(new Set());
  const [providerConfigurations, setProviderConfigurations] = useState<Partial<Record<SettingsDraft['provider'], { model: string; baseUrl: string; contextLimit: number; contextLimitMode: 'default' | 'custom'; compressionThreshold: number; thinkingEnabled: boolean }>>>({});
  const [providerReloading, setProviderReloading] = useState(false);
  const providerSpinTimer = useRef(0);
  // 供应商与模型目录只存在于应用本地：启用状态、API 格式、模型增删与模型能力都缓存在这里。
  const [catalog, setCatalog] = useState<ModelCatalog>(() => LoadModelCatalog());
  const [apiKeyShown, setApiKeyShown] = useState(false);
  const [apiFormatOpen, setApiFormatOpen] = useState(false);
  const apiFormatRef = useRef<HTMLDivElement>(null);
  const [modelDialog, setModelDialog] = useState<ModelDialogDraft | null>(null);
  const [modelErrors, setModelErrors] = useState<ModelDialogErrors>({});
  const [providerDeleteTarget, setProviderDeleteTarget] = useState<ModelCatalogProvider | null>(null);
  useEffect(() => { setDraft(NormalizeProviderSettings(settings)); }, [settings]);
  /** 当前模型即生效值：上下文窗口与思考模式始终跟随目录里选中的模型。 */
  useEffect(() => {
    const active = FindCatalogModel(catalog, draft.provider, draft.model);
    if (!active) return;
    const contextLength = FormatContextWindow(active.contextWindow);
    setDraft((current) => current.thinkingEnabled === active.thinking && current.contextLength === contextLength && current.contextLimitMode === 'custom'
      ? current
      : { ...current, thinkingEnabled: active.thinking, contextLength, contextLimitMode: 'custom' });
  }, [catalog, draft.provider, draft.model, draft.contextLength, draft.contextLimitMode, draft.thinkingEnabled]);

  /** 当前模型不在列表里（被删除、或供应商还没有模型）时自动选中第一个模型。 */
  useEffect(() => {
    const provider = FindCatalogProvider(catalog, draft.provider);
    if (!provider || !provider.models.length) return;
    if (provider.models.some((item) => item.id === draft.model)) return;
    setDraft((current) => ({ ...current, model: provider.models[0].id }));
  }, [catalog, draft.provider, draft.model]);
  /** 侧栏供应商被删除后回落到第一个仍启用的供应商，避免面板停在已不存在的条目上。 */
  useEffect(() => {
    if (FindCatalogProvider(catalog, draft.provider)) return;
    const fallback = catalog.providers.find((item) => item.enabled) ?? catalog.providers[0];
    if (fallback) SelectProvider(fallback.id);
  }, [catalog, draft.provider]);
  /** API 格式菜单：点击外部或按 Esc 关闭，与其它下拉菜单行为一致。 */
  useEffect(() => {
    if (!apiFormatOpen) return;
    const closeOnPointer = (event: PointerEvent) => { if (!apiFormatRef.current?.contains(event.target as Node)) setApiFormatOpen(false); };
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') setApiFormatOpen(false); };
    document.addEventListener('pointerdown', closeOnPointer);
    document.addEventListener('keydown', closeOnEscape);
    return () => { document.removeEventListener('pointerdown', closeOnPointer); document.removeEventListener('keydown', closeOnEscape); };
  }, [apiFormatOpen]);
  /** API Key 不进入 Renderer；只以主进程返回的脱敏配置状态驱动成功标记。 */
  useEffect(() => {
    const isCurrentProviderConfigured = configuredProviders.has(draft.provider) || (apiKeyConfigured && configuredProvider === draft.provider);
    document.body.classList.toggle('settings-has-configured-api-key', isCurrentProviderConfigured);
    return () => document.body.classList.remove('settings-has-configured-api-key');
  }, [apiKeyConfigured, configuredProvider, configuredProviders, draft.provider]);
  /** 写入本地模型目录并同步落缓存；目录是对话页过滤可选模型的依据。 */
  function UpdateCatalog(next: ModelCatalog): void {
    setCatalog(next);
    SaveModelCatalog(next);
  }
  async function RefreshDeepSeekModels(manual = false) {
    if (!IsDesktopAgentAvailable()) return;
    setRefreshingModels(true);
    try {
      const result = await GetDeepSeekModels();
      if (result.models.length) UpdateCatalog(MergeProviderModels(catalog, 'DeepSeek', result.models));
      if (manual) ShowNotice(result.models.length ? '已同步最新模型列表' : '未获取到可用模型，已保留现有列表');
    } catch (error) {
      if (manual) ShowNotice(error instanceof Error ? error.message : '模型列表刷新失败');
    } finally {
      setRefreshingModels(false);
    }
  }
  useEffect(() => {
    if (tab === 'api' && draft.provider === 'DeepSeek') void RefreshDeepSeekModels();
  }, [tab, draft.provider]);
  /** 读取主进程侧的供应商目录与当前生效配置；进入页签与页头刷新按钮共用同一份逻辑。 */
  async function LoadProviderConfiguration() {
    const backendCatalog = await GetProviderCatalog();
    setConfiguredProviders(new Set(backendCatalog.providers.filter((item) => item.configured).map((item) => item.provider)));
    setProviderConfigurations(Object.fromEntries(backendCatalog.providers.filter((item) => item.configured).map((item) => [item.provider, item])));
    const status = await GetAgentStatus();
    const runtimeProvider = status.provider === '自定义' ? '自定义' : status.provider === 'Z.AI' ? 'Z.AI' : 'DeepSeek';
    // 宿主目录只提供供应商与可用模型：已有的本地模型不被覆盖，重新加载还能找回被删掉的官方供应商；
    // 宿主返回的上下文窗口与思考模式是当前生效值，要回写到对应模型，避免进入设置页就把用户配置重置成默认值。
    const merged = MergeBackendProviders(catalog, backendCatalog.providers);
    const runtimeEntry = backendCatalog.providers.find((item) => item.provider === runtimeProvider);
    UpdateCatalog(ApplyModelRuntime(merged, runtimeProvider, status.model, { contextWindow: status.contextLimit, thinking: runtimeEntry?.thinkingEnabled }));
    setApiKeyConfigured(status.configured);
    setConfiguredProvider(runtimeProvider);
    const contextLimit = status.contextLimit;
    if (!contextLimit) return;
    setDraft((current) => NormalizeProviderSettings({
      ...current,
      provider: runtimeProvider,
      model: status.model,
      baseUrl: status.baseUrl ?? current.baseUrl,
      contextLength: FormatContextLength(contextLimit),
      contextLimitMode: 'custom',
      compressionThreshold: status.compressionThreshold ?? current.compressionThreshold,
    }));
  }
  useEffect(() => {
    if (tab !== 'api' || !IsDesktopAgentAvailable()) return;
    void LoadProviderConfiguration().catch(() => { setApiKeyConfigured(false); setConfiguredProvider(null); });
  }, [tab]);
  /** 页头的重新加载按钮：先播一次旋转动画，再回读主进程配置。 */
  async function ReloadProviderConfiguration() {
    if (!IsDesktopAgentAvailable()) { ShowNotice('请在桌面客户端中重新加载配置'); return; }
    if (providerSpinTimer.current) window.clearTimeout(providerSpinTimer.current);
    setProviderReloading(true);
    providerSpinTimer.current = window.setTimeout(() => setProviderReloading(false), 640);
    try {
      await LoadProviderConfiguration();
      ShowNotice('配置已重新加载');
    } catch (error) {
      ShowNotice(error instanceof Error ? error.message : '配置重新加载失败');
    }
  }
  useEffect(() => () => { if (providerSpinTimer.current) window.clearTimeout(providerSpinTimer.current); }, []);
  useEffect(() => {
    if (tab === 'developer' && IsDesktopAgentAvailable()) void RefreshModuleConfiguration();
  }, [tab]);
  useEffect(() => {
    if (tab === 'browser') { void RefreshBrowserRuntime(); void RefreshCronBrowserAccess(); }
  }, [tab]);
  function UpdateDraft(patch: Partial<SettingsDraft>) {
    setDraft((current) => {
      const saved = patch.provider && patch.provider !== current.provider ? providerConfigurations[patch.provider] : undefined;
      return {
        ...current,
        ...patch,
        ...(saved ? {
          model: patch.model ?? saved.model,
          baseUrl: saved.baseUrl,
          contextLength: FormatContextLength(saved.contextLimit),
          contextLimitMode: saved.contextLimitMode,
          compressionThreshold: saved.compressionThreshold,
          thinkingEnabled: saved.thinkingEnabled,
        } : {}),
        ...(patch.provider && patch.provider !== current.provider ? { apiKey: '' } : {}),
      };
    });
    if (patch.traceRetention !== undefined || patch.compressionThreshold !== undefined || patch.contextLength !== undefined || patch.contextLimitMode !== undefined) setFieldErrors((current) => ({ ...current, ...(patch.traceRetention !== undefined ? { traceRetention: undefined } : {}), ...(patch.compressionThreshold !== undefined ? { compressionThreshold: undefined } : {}), ...(patch.contextLength !== undefined || patch.contextLimitMode !== undefined ? { contextLength: undefined } : {}) }));
    setDirty(true);
  }
  async function SaveSettings() {
    const nextErrors: FieldErrors = {};
    if (draft.compressionThreshold < 1 || draft.compressionThreshold > 80 || !Number.isInteger(draft.compressionThreshold)) nextErrors.compressionThreshold = '请输入 1–80 之间的整数。';
    if (draft.traceRetention < 1 || draft.traceRetention > 100 || !Number.isInteger(draft.traceRetention)) nextErrors.traceRetention = '请输入 1–100 之间的整数。';
    const activeParameters = ResolveActiveModelParameters();
    if (!activeParameters) { ShowNotice('请先在模型列表里添加或选择一个模型'); return false; }
    setFieldErrors(nextErrors);
    if (Object.keys(nextErrors).length) { ShowNotice('请修正标记的设置项后再保存'); return false; }
    ShowNotice(tab === 'api' ? '正在保存 API 配置…' : '正在保存设置…', 'pending');
    if (tab === 'api' && IsDesktopAgentAvailable()) {
      try {
        await ConfigureAgent({ provider: draft.provider, apiKey: draft.apiKey, baseUrl: draft.baseUrl, model: draft.model, thinkingEnabled: activeParameters.thinkingEnabled, contextLength: activeParameters.contextLength, contextLimitMode: activeParameters.contextLimitMode, compressionThreshold: draft.compressionThreshold });
        setApiKeyConfigured(true);
        setConfiguredProvider(draft.provider);
        setConfiguredProviders((current) => new Set([...current, draft.provider]));
        setProviderConfigurations((current) => ({ ...current, [draft.provider]: {
          model: draft.model,
          baseUrl: draft.baseUrl,
          contextLimit: activeParameters.contextLimit,
          contextLimitMode: activeParameters.contextLimitMode,
          compressionThreshold: draft.compressionThreshold,
          thinkingEnabled: draft.thinkingEnabled,
        } }));
      } catch (error) {
        ShowNotice(error instanceof Error ? error.message : 'API 配置保存失败', 'error');
        return false;
      }
    }
    if (tab === 'developer' && IsDesktopAgentAvailable()) {
      try {
        await SetAgentTraceRetention(draft.traceRetention);
      } catch (error) {
        ShowNotice(error instanceof Error ? error.message : 'Trace 留存设置保存失败', 'error');
        return false;
      }
    }
    // API Key 只保留在当前表单内存与主进程 safeStorage，不能写入全局工作空间缓存。
    const { apiKey: _apiKey, ...safeDraft } = draft;
    try {
      await saveSettingsNow({ ...safeDraft, apiKey: '' });
      if (tab === 'browser') await Promise.all([RefreshBrowserRuntime(), RefreshCronBrowserAccess()]);
    } catch (error) {
      ShowNotice(error instanceof Error ? error.message : '设置持久化失败', 'error');
      return false;
    }
    setDirty(false); setFieldErrors({}); ShowNotice(tab === 'api' ? 'API 配置与上下文限制已保存' : '设置已保存', 'success');
    return true;
  }
  function CommitTab(target: SettingTab) { onTabChange(target); }
  function SwitchTab(target: SettingTab) { if (target === tab) return; if (!dirty) { CommitTab(target); return; } setNextTab(target); setShowLeave(true); }
  function DiscardAndSwitch() { if (!nextTab) return; setDraft(NormalizeProviderSettings(settings)); setDirty(false); CommitTab(nextTab); setNextTab(null); setShowLeave(false); }
  useEffect(() => {
    if (tabRequestVersion > 0) SwitchTab(requestedTab);
  }, [tabRequestVersion]);
  async function ClearDeveloperObservability() {
    if (IsDesktopAgentAvailable()) await ClearAgentObservability();
    setShowClear(false);
    ShowNotice('运行日志与 Trace 已清空');
  }
  async function CreateWorkspaceBackupHandler() {
    try {
      await CreateWorkspaceBackup();
      ShowNotice('工作空间备份已创建，系统将保留最近 7 份');
    } catch (error) {
      ShowNotice(error instanceof Error ? error.message : '创建工作空间备份失败');
    }
  }
  async function MigrateWorkspaceHandler() {
    try {
      await MigrateWorkspace();
      setShowMigrate(false);
      setDirty(false);
      ShowNotice('工作空间已迁移；原目录保留为安全副本。');
      void queryClient.invalidateQueries({ queryKey: WORKSPACE_QUERY_KEY });
    } catch (error) {
      ShowNotice(error instanceof Error ? error.message : '工作空间迁移失败');
    }
  }
  async function TestApiConnection() {
    if (!IsDesktopAgentAvailable()) { ShowNotice('请在桌面客户端中测试 API 连接'); return; }
    const activeParameters = ResolveActiveModelParameters();
    if (!activeParameters) { ShowNotice('请先在模型列表里添加或选择一个模型'); return; }
    try {
      await TestAgentConnection({ provider: draft.provider, apiKey: draft.apiKey, baseUrl: draft.baseUrl, model: draft.model, thinkingEnabled: draft.thinkingEnabled, contextLength: draft.contextLength, contextLimitMode: draft.contextLimitMode, compressionThreshold: draft.compressionThreshold });
      ShowNotice('API 连接测试成功，配置尚未保存');
    } catch (error) {
      ShowNotice(error instanceof Error ? error.message : 'API 连接测试失败');
    }
  }
  async function RefreshModuleConfiguration() {
    try { setModuleConfiguration(await GetAgentModuleConfiguration()); } catch { setModuleConfiguration(null); }
  }
  async function RefreshBrowserRuntime(probeConnection = false) {
    const request = ++browserRuntimeRequest.current;
    setBrowserRuntimeBusy(true);
    try {
      const status = await GetBrowserRuntimeStatus(probeConnection);
      if (request !== browserRuntimeRequest.current) return;
      setBrowserRuntime(status);
      if (probeConnection) {
        const connected = status.running && status.state === 'ready';
        ShowNotice(connected ? '浏览器连接成功' : status.message ?? '浏览器连接检测失败', connected ? 'success' : 'error');
      }
    } catch (error) {
      if (request !== browserRuntimeRequest.current) return;
      setBrowserRuntime(null);
      if (probeConnection) ShowNotice(error instanceof Error ? error.message : '浏览器连接检测失败', 'error');
    } finally {
      if (request === browserRuntimeRequest.current) setBrowserRuntimeBusy(false);
    }
  }
  async function RefreshCronBrowserAccess() {
    if (!IsDesktopAgentAvailable()) return;
    try {
      const status = await GetCronBrowserAccess();
      setCronBrowserAccess(status);
      setCronBrowserTaskId((current) => status.tasks.some((task) => task.id === current)
        ? current
        : status.tasks.find((task) => task.browserAuthorized)?.id ?? status.tasks[0]?.id ?? '');
    } catch { setCronBrowserAccess(null); }
  }
  async function RevokeCronBrowserAccessHandler() {
    if (!cronBrowserTaskId) return;
    setBrowserRuntimeBusy(true);
    try {
      await RevokeCronBrowserAccess(cronBrowserTaskId);
      await RefreshCronBrowserAccess();
      ShowNotice('已撤销定时浏览器授权', 'success');
    } catch (error) { ShowNotice(error instanceof Error ? error.message : '撤销授权失败', 'error'); }
    finally { setBrowserRuntimeBusy(false); }
  }
  async function ClearBrowserProfileHandler() {
    setBrowserRuntimeBusy(true);
    try {
      await ClearBrowserProfile();
      setShowClearBrowserProfile(false);
      ShowNotice('Agent 浏览器登录数据已清除');
      await RefreshBrowserRuntime();
    } catch (error) { ShowNotice(error instanceof Error ? error.message : '浏览器登录数据清理失败'); }
    finally { setBrowserRuntimeBusy(false); }
  }
  async function SelectUserModules() {
    setUpdatingModules(true);
    try {
      const configuration = await SelectAgentModuleDirectory();
      setModuleConfiguration(configuration);
      ShowNotice(configuration.status === 'active' ? '本地模块已校验并启用' : '未选择新的模块目录，已保留当前配置');
    } catch (error) {
      ShowNotice(error instanceof Error ? error.message : '本地模块配置失败');
    } finally { setUpdatingModules(false); }
  }
  async function ConfirmResetModules() {
    setUpdatingModules(true);
    try {
      const configuration = await ResetAgentModules();
      setModuleConfiguration(configuration);
      setShowResetModules(false);
      ShowNotice('已恢复官方默认模块');
    } catch (error) {
      ShowNotice(error instanceof Error ? error.message : '恢复默认模块失败');
    } finally { setUpdatingModules(false); }
  }
  function SelectProvider(provider: SettingsDraft['provider']) {
    const entry = FindCatalogProvider(catalog, provider);
    // 切换供应商时带上它在本地目录里的模型；已配置过的供应商优先沿用上次保存的模型。
    const preferred = providerConfigurations[provider]?.model ?? draft.model;
    const model = entry?.models.some((item) => item.id === preferred) ? preferred : entry?.models[0]?.id ?? preferred;
    const baseUrl = provider === 'DeepSeek' ? 'https://api.deepseek.com' : provider === 'Z.AI' ? 'https://open.bigmodel.cn/api/paas/v4' : draft.baseUrl;
    UpdateDraft({ provider, baseUrl, model });
  }
  /** 主进程侧是否已保存过该供应商的可用凭据（含刚保存但目录尚未回读的状态）。 */
  function IsProviderConfigured(provider: SettingsDraft['provider']): boolean {
    return configuredProviders.has(provider) || (apiKeyConfigured && configuredProvider === provider);
  }
  function ReplaceProvider(next: ModelCatalogProvider): ModelCatalog {
    return { ...catalog, providers: catalog.providers.map((item) => item.id === next.id ? next : item) };
  }
  /** 启用/禁用供应商：禁用后它不再出现在对话的模型选择里。 */
  function ToggleProviderEnabled(provider: ModelCatalogProvider) {
    UpdateCatalog(ReplaceProvider({ ...provider, enabled: !provider.enabled }));
    ShowNotice(provider.enabled ? `${provider.name} 已禁用，不会再出现在对话的模型选择里` : `${provider.name} 已启用，可在对话里选择使用`);
  }
  function RemoveProvider(provider: ModelCatalogProvider) {
    UpdateCatalog({ ...catalog, providers: catalog.providers.filter((item) => item.id !== provider.id) });
    setProviderDeleteTarget(null);
    ShowNotice(`已从模型目录移除 ${provider.name}`);
  }
  function SetApiFormat(apiFormat: ModelApiFormat) {
    const provider = FindCatalogProvider(catalog, draft.provider);
    setApiFormatOpen(false);
    if (!provider) return;
    UpdateCatalog(ReplaceProvider({ ...provider, apiFormat }));
    ShowNotice(`接口格式改为 ${ModelApiFormats.find((item) => item.key === apiFormat)?.label ?? apiFormat}`);
  }
  function RemoveModel(provider: ModelCatalogProvider, model: ModelCatalogModel) {
    UpdateCatalog(ReplaceProvider({ ...provider, models: provider.models.filter((item) => item.id !== model.id) }));
    ShowNotice(`已删除模型 ${model.id}`);
  }
  function OpenModelDialog(index: number) {
    const model = index >= 0 ? FindCatalogProvider(catalog, draft.provider)?.models[index] : undefined;
    setModelErrors({});
    setModelDialog({
      index,
      id: model?.id ?? '',
      contextWindow: String(model?.contextWindow ?? DefaultContextWindow),
      maxOutput: String(model?.maxOutput ?? DefaultMaxOutput),
      inputImage: model?.inputImage ?? false,
      inputPdf: model?.inputPdf ?? false,
      thinking: model?.thinking ?? true,
    });
  }
  function CloseModelDialog() { setModelDialog(null); setModelErrors({}); }
  function SaveModelDialog() {
    const provider = FindCatalogProvider(catalog, draft.provider);
    if (!modelDialog || !provider) return;
    const id = modelDialog.id.trim();
    const contextWindow = Number(modelDialog.contextWindow);
    const maxOutput = Number(modelDialog.maxOutput);
    const duplicate = provider.models.some((item, index) => index !== modelDialog.index && item.id === id);
    setModelErrors({ id: !id || duplicate, contextWindow: !IsValidContextWindow(contextWindow), maxOutput: !IsValidMaxOutput(maxOutput) });
    if (!id || duplicate) { ShowNotice(duplicate ? '已经有同名的模型 ID' : '模型 ID 不能为空'); return; }
    if (!IsValidContextWindow(contextWindow)) { ShowNotice('上下文窗口需为 128000–1000000 之间的整数'); return; }
    if (!IsValidMaxOutput(maxOutput)) { ShowNotice('最大输出 Token 需为正整数'); return; }
    const thinking = provider.id === 'Z.AI' ? true : modelDialog.thinking;
    const next: ModelCatalogModel = { id, contextWindow, maxOutput, inputImage: modelDialog.inputImage, inputPdf: modelDialog.inputPdf, thinking };
    const wasActive = modelDialog.index >= 0 && draft.model === provider.models[modelDialog.index]?.id;
    const models = modelDialog.index >= 0 ? provider.models.map((item, index) => index === modelDialog.index ? next : item) : [...provider.models, next];
    UpdateCatalog(ReplaceProvider({ ...provider, models }));
    // 改名后当前模型要跟着新 ID；编辑当前模型的上下文窗口与思考模式需要保存后才下发宿主。
    if (wasActive) { UpdateDraft({ model: id }); setDirty(true); }
    CloseModelDialog();
    ShowNotice(modelDialog.index >= 0 ? '模型配置已保存' : `已添加模型 ${id}`);
  }
  /** 当前生效模型的宿主端参数：上下文窗口与思考模式取自本地目录里选中的模型。 */
  function ResolveActiveModelParameters() {
    const active = FindCatalogModel(catalog, draft.provider, draft.model);
    if (!active) return null;
    return { thinkingEnabled: draft.provider === 'Z.AI' ? true : active.thinking, contextLength: FormatContextWindow(active.contextWindow), contextLimit: active.contextWindow, contextLimitMode: 'custom' as const };
  }
  function RenderModelConfiguration() {
    const provider = FindCatalogProvider(catalog, draft.provider) ?? catalog.providers[0];
    const providerConfigured = IsProviderConfigured(provider.id);
    const apiFormatLabel = ModelApiFormats.find((item) => item.key === provider.apiFormat)?.label ?? ModelApiFormats[0].label;
    // 分组标签与供应商条目平铺在同一个列表里：包一层容器会打断 .set-group 的间距规则。
    const sideItems: ReactNode[] = [];
    ProviderGroups.forEach((group) => {
      sideItems.push(<div className="set-group" key={`group-${group}`}>{group}</div>);
      catalog.providers.filter((item) => (group === '推荐' ? !item.custom : item.custom)).forEach((item) => {
        const configured = IsProviderConfigured(item.id);
        sideItems.push(<button key={item.id} className={`prov${item.id === draft.provider ? ' sel' : ''}`} type="button" aria-current={item.id === draft.provider ? 'true' : undefined} onClick={() => SelectProvider(item.id)}>
          <span className="prov-mark" aria-hidden="true">{ProviderMarks[item.id]}</span>
          <span className="pn">{item.name}</span>
          <span className={`dot${configured ? ' on' : ''}`} title={configured ? '已配置' : '未配置'} />
        </button>);
      });
    });
    return <div className="set set-root model-set-scope">
      <div className="set-head">
        <div>
          <h1>模型设置</h1>
          <p>管理自定义模型供应商，配置后可在聊天时选择使用。</p>
        </div>
        <button className={`icon-btn set-refresh${providerReloading ? ' is-spinning' : ''}`} type="button" aria-label="重新加载配置" title="重新加载配置" onClick={() => void ReloadProviderConfiguration()}><Icon name="recovery" size={17} /></button>
      </div>
      <div className="set-card">
        <aside className="set-side" aria-label="模型供应商">{sideItems}</aside>
        <div className="set-pane">
          <div className="set-d-head">
            <span className="set-name">{provider.name}</span>
            <span className={`pill ${provider.enabled ? 'on' : 'off'}`}>{provider.enabled ? '已启用' : '未启用'}</span>
            <button className="pill-btn" type="button" onClick={() => ToggleProviderEnabled(provider)}>{provider.enabled ? '禁用' : '启用'}</button>
            <div className="set-d-acts">
              {provider.custom && <button className="icon-btn set-del" type="button" aria-label="删除供应商" title="删除供应商" onClick={() => setProviderDeleteTarget(provider)}><Icon name="delete" size={16} /></button>}
              <button className="ghost-btn" type="button" onClick={() => void TestApiConnection()}><Icon name="gauge" size={14} />测试连接</button>
              <button className="btn-accent" type="button" onClick={() => void SaveSettings()}><Icon name="check-circle" size={14} />保存配置</button>
            </div>
          </div>
          <div className="set-fields">
            <label className="set-field">
              <span className="lb">Base URL</span>
              <input className="set-inp" value={draft.baseUrl} readOnly={!provider.custom} spellCheck={false} placeholder="https://api.example.com/v1" onChange={(event) => UpdateDraft({ baseUrl: event.target.value })} />
            </label>
            <div className="set-field">
              <span className="lb">API 格式</span>
              {/* 推荐供应商固定使用 Chat Completions：选择器保留展示但不可操作。 */}
              {provider.custom ? <div className="menu-wrap" ref={apiFormatRef}>
                <button className="sel-btn menu-trigger" type="button" aria-expanded={apiFormatOpen} aria-haspopup="true" onClick={() => setApiFormatOpen((current) => !current)}>
                  <span className="v">{apiFormatLabel}</span>
                  <Icon name="chevron-down" className="chev" size={11} />
                </button>
                {apiFormatOpen && <div className="menu drop" role="menu" aria-label="API 格式">
                  {ModelApiFormats.map((format) => <button key={format.key} className={`menu-item${format.key === provider.apiFormat ? ' sel' : ''}`} type="button" role="menuitemradio" aria-checked={format.key === provider.apiFormat} onClick={() => SetApiFormat(format.key)}>
                    <span><span className="mt">{format.label}</span><span className="md">{format.note}</span></span>
                    <Icon name="check" size={14} className="tick" />
                  </button>)}
                </div>}
              </div> : <button className="sel-btn" type="button" disabled aria-disabled="true" title="推荐供应商固定使用 Chat Completions，不能修改接口格式">
                <span className="v">{apiFormatLabel}</span>
                <Icon name="chevron-down" className="chev" size={11} />
              </button>}
            </div>
            <label className="set-field">
              <span className="lb">API Key</span>
              <span className="inp-wrap">
                <input className="set-inp" type={apiKeyShown ? 'text' : 'password'} value={draft.apiKey} autoComplete="off" spellCheck={false} placeholder={providerConfigured ? '已安全保存，输入新密钥可覆盖' : '粘贴供应商给你的 Key'} onChange={(event) => UpdateDraft({ apiKey: event.target.value })} />
                <button className="inp-eye" type="button" aria-label={apiKeyShown ? '隐藏 API Key' : '显示 API Key'} title={apiKeyShown ? '隐藏' : '显示'} onClick={() => setApiKeyShown((current) => !current)}><Icon name={apiKeyShown ? 'eye-slash' : 'eye'} size={16} /></button>
              </span>
            </label>
            <div className="set-field">
              <span className="lb-row">
                <span className="lb">模型列表</span>
                <button className={`icon-btn sm lb-get${refreshingModels ? ' is-spinning' : ''}`} type="button" aria-label="获取模型列表" title={provider.id === 'DeepSeek' ? '获取模型列表' : '仅 DeepSeek 支持从官方接口同步模型列表'} disabled={provider.id !== 'DeepSeek' || refreshingModels} onClick={() => void RefreshDeepSeekModels(true)}><Icon name="recovery" size={14} /></button>
              </span>
              <div className="set-models">
                {provider.models.length ? provider.models.map((model, index) => {
                  const isActive = model.id === draft.model;
                  return <div className="mrow" key={model.id}>
                    <span className="mrow-name">{model.id}</span>
                    <span className="mrow-chips">
                      {model.inputImage && <span className="jtag">视觉</span>}
                      <span className="jtag">{FormatContextWindow(model.contextWindow)}</span>
                    </span>
                    <span className="mrow-acts">
                      <button className={`icon-btn sm${isActive ? ' def' : ''}`} type="button" aria-label="设为当前模型" aria-pressed={isActive} title="设为当前模型" onClick={() => UpdateDraft({ model: model.id })}><Icon name="lightning" size={14} weight={isActive ? 'fill' : 'regular'} /></button>
                      <button className="icon-btn sm" type="button" aria-label="编辑模型配置" title="编辑模型配置" onClick={() => OpenModelDialog(index)}><Icon name="pencil-simple" size={14} /></button>
                      <button className="icon-btn sm" type="button" aria-label="删除模型" title="删除模型" onClick={() => RemoveModel(provider, model)}><Icon name="delete" size={14} /></button>
                    </span>
                  </div>;
                }) : <div className="mrow-empty">还没有模型。点下面的「添加模型」填上供应商文档里的模型名。</div>}
              </div>
              <button className="quiet-btn set-add" type="button" onClick={() => OpenModelDialog(-1)}><Icon name="plus" size={15} />添加模型</button>
            </div>
          </div>
        </div>
      </div>

      {/* 模型配置弹窗按原型：模型 ID、上下文窗口、最大输出 Token、思考模式与输入/输出类型都作用于单个模型。 */}
      {modelDialog && <Modal
        open
        title={modelDialog.index >= 0 ? '编辑模型配置' : '添加模型'}
        onClose={CloseModelDialog}
        variant="dialog"
        footer={<>
          <DialogButton onClick={CloseModelDialog}>取消</DialogButton>
          <DialogButton tone="accent" onClick={SaveModelDialog}>保存</DialogButton>
        </>}
      >
        <div className="model-dialog model-set-scope">
          <label className="set-field">
            <span className="lb">模型 ID</span>
            <input className={`set-inp${modelErrors.id ? ' bad' : ''}`} value={modelDialog.id} placeholder="供应商文档里的模型名" spellCheck={false} autoComplete="off" onChange={(event) => { setModelErrors((current) => ({ ...current, id: false })); setModelDialog({ ...modelDialog, id: event.target.value }); }} />
          </label>
          <label className="set-field">
            <span className="lb">上下文窗口</span>
            <input className={`set-inp${modelErrors.contextWindow ? ' bad' : ''}`} value={modelDialog.contextWindow} inputMode="numeric" spellCheck={false} onChange={(event) => { setModelErrors((current) => ({ ...current, contextWindow: false })); setModelDialog({ ...modelDialog, contextWindow: event.target.value.replace(/[^0-9]/g, '') }); }} />
          </label>
          <label className="set-field">
            <span className="lb">最大输出 Token</span>
            <input className={`set-inp${modelErrors.maxOutput ? ' bad' : ''}`} value={modelDialog.maxOutput} inputMode="numeric" spellCheck={false} onChange={(event) => { setModelErrors((current) => ({ ...current, maxOutput: false })); setModelDialog({ ...modelDialog, maxOutput: event.target.value.replace(/[^0-9]/g, '') }); }} />
          </label>
          <div className="set-field is-switch">
            <span className="sw-txt">
              <b>思考模式</b>
              <small>{draft.provider === 'Z.AI' ? 'GLM 模型始终启用思考模式。' : '开启后助手会展示可折叠的思考内容；当前模型的取值随配置一起保存。'}</small>
            </span>
            <button className="switch" type="button" role="switch" aria-checked={draft.provider === 'Z.AI' ? true : modelDialog.thinking} aria-label="思考模式" aria-disabled={draft.provider === 'Z.AI' || undefined} disabled={draft.provider === 'Z.AI'} onClick={() => setModelDialog({ ...modelDialog, thinking: !modelDialog.thinking })}><span className="knob" /></button>
          </div>
          <div className="set-field">
            <span className="lb">输入类型</span>
            <div className="chk-row">
              <label className="chk locked"><input type="checkbox" checked readOnly disabled /><span className="box"><Icon name="check" size={11} /></span><span>文本</span><Icon name="lock-simple" className="lock" size={12} /></label>
              <label className="chk"><input type="checkbox" checked={modelDialog.inputImage} onChange={(event) => setModelDialog({ ...modelDialog, inputImage: event.target.checked })} /><span className="box"><Icon name="check" size={11} /></span><span>图片</span></label>
              <label className="chk"><input type="checkbox" checked={modelDialog.inputPdf} onChange={(event) => setModelDialog({ ...modelDialog, inputPdf: event.target.checked })} /><span className="box"><Icon name="check" size={11} /></span><span>PDF</span></label>
            </div>
          </div>
          <div className="set-field">
            <span className="lb">输出类型</span>
            <div className="chk-row">
              <label className="chk locked"><input type="checkbox" checked readOnly disabled /><span className="box"><Icon name="check" size={11} /></span><span>文本</span><Icon name="lock-simple" className="lock" size={12} /></label>
            </div>
          </div>
        </div>
      </Modal>}

      <Modal
        open={Boolean(providerDeleteTarget)}
        title="从模型目录移除这个供应商？"
        onClose={() => setProviderDeleteTarget(null)}
        footer={<>
          <DialogButton onClick={() => setProviderDeleteTarget(null)}>取消</DialogButton>
          <DialogButton tone="danger" onClick={() => providerDeleteTarget && RemoveProvider(providerDeleteTarget)}>移除供应商</DialogButton>
        </>}
      >
        移除后 {providerDeleteTarget?.name} 不再出现在设置页与对话的模型选择里；点页头的「重新加载配置」可以把它找回来。
      </Modal>
    </div>;
  }

  /** 「存在未保存的修改」确认框：模型配置页与常规设置页共用同一份版式与处理逻辑。 */
  function RenderLeaveDialog() {
    return <Modal
      open={showLeave}
      title="存在未保存的修改"
      onClose={() => setShowLeave(false)}
      footer={<>
        <DialogButton onClick={() => setShowLeave(false)}>继续编辑</DialogButton>
        <DialogButton onClick={DiscardAndSwitch}>放弃修改</DialogButton>
        <DialogButton tone="accent" onClick={async () => { if (await SaveSettings() && nextTab) CommitTab(nextTab); setNextTab(null); setShowLeave(false); }}>保存并切换</DialogButton>
      </>}
    >
      切换设置项前，请选择如何处理当前修改。
    </Modal>;
  }

  const current = SettingsTabs.find((item) => item.id === tab)!;
  const usesPersonalBrowser = (draft.browserEngine ?? 'edge') !== 'electron';
  const browserSelectionPending = Boolean(browserRuntime && browserRuntime.engine !== (draft.browserEngine ?? 'edge'));
  if (tab === 'api') return <div className="settings-page is-model-set">{RenderModelConfiguration()}{RenderLeaveDialog()}</div>;
  return <div className="settings-page"><section className="settings-content"><PageHeader eyebrow="设置" title={current.label} description={current.description} actions={tab !== 'api' && tab !== 'browser' ? <Button variant="primary" onClick={() => void SaveSettings()}>保存更改</Button> : undefined} />
    {tab === 'developer' && <><div className="setting-note module-settings"><b>本地模块</b><p>{moduleConfiguration?.status === 'active' ? `已启用：${moduleConfiguration.directoryName ?? '已选择目录'}。模块仅在启动会话前校验。` : '当前使用官方默认模块。选择本地模块目录前，请确认其来源可信。'}</p><div className="api-actions"><Button disabled={updatingModules} onClick={() => void SelectUserModules()}>{updatingModules ? '处理中…' : '选择本地模块'}</Button><Button variant="danger" disabled={updatingModules || moduleConfiguration?.status !== 'active'} onClick={() => setShowResetModules(true)}>恢复官方默认模块</Button></div></div><Modal
      open={showResetModules}
      title="恢复官方默认模块？"
      onClose={() => setShowResetModules(false)}
      footer={<>
        <DialogButton onClick={() => setShowResetModules(false)}>取消</DialogButton>
        <DialogButton tone="danger" disabled={updatingModules} onClick={() => void ConfirmResetModules()}>确认恢复默认</DialogButton>
      </>}
    >
      当前本地模块配置将被移除，后续新会话将使用内置模块。运行中的助手任务不会被中断。
    </Modal></>}
     {tab === 'account' && <div className="settings-panel"><FormField label="账户昵称"><input value={draft.nickname} onChange={(event) => UpdateDraft({ nickname: event.target.value })} /><small>将显示在侧边栏与欢迎页面中。</small></FormField><FormField label="会话自定义上下文"><textarea rows={6} value={draft.customContext ?? ''} onChange={(event) => UpdateDraft({ customContext: event.target.value })} placeholder="例如：我偏好简洁直白的表达，简历经历需包含量化成果…" /><small>该上下文将注入每个 Avery 会话，不会读取你开发项目目录中的规则文档。</small></FormField></div>}
    {tab === 'workspace' && <div className="settings-panel"><FormField label="当前工作空间"><input value={draft.workspaceName ?? ''} readOnly disabled /><small>工作空间目录由本地服务管理；迁移时通过下方按钮选择目标空目录。</small></FormField><div className="setting-note"><b>迁移说明</b><p>迁移会复制数据库、档案、附件、导出和备份文件，校验后切换到目标空目录；原目录不会删除。Agent 运行中不可迁移。</p><Button onClick={() => setShowMigrate(true)}>迁移工作空间</Button></div><div className="setting-note"><b>本地备份</b><p>立即备份数据库与档案文件；系统仅保留最近 7 份每日备份。</p><Button onClick={() => void CreateWorkspaceBackupHandler()}>立即创建备份</Button></div></div>}
    {tab === 'browser' && <>
      <div className="settings-panel browser-settings-panel">
        <FormField label="Agent 使用的浏览器" hint="Chrome 和 Edge 使用轻量连接复用你已打开并登录 BOSS 的浏览器；Avery 不创建独立 Profile，也不读取其他标签页。">
          <Select
            value={draft.browserEngine ?? 'edge'}
            onChange={(value) => UpdateDraft({ browserEngine: value as NonNullable<SettingsDraft['browserEngine']> })}
            ariaLabel="Agent 使用的浏览器"
            options={Object.entries(BrowserEngineLabels).map(([value, label]) => ({ value, label }))}
          />
        </FormField>
        <div className={`browser-runtime-bar ${browserRuntime?.running ? 'is-running' : ''} ${browserRuntime?.state === 'unhealthy' ? 'is-unhealthy' : ''} ${browserRuntimeBusy || browserSelectionPending ? 'is-pending' : ''}`}>
          <div className="browser-runtime-summary">
            <span className="browser-runtime-icon"><Icon name="browser" size={16} /></span>
            <span className="browser-runtime-copy">
              <small className="browser-runtime-label">运行状态</small>
              <b>{!browserRuntime ? '浏览器状态未知' : browserRuntime.state === 'not_installed' ? `${BrowserEngineLabels[browserRuntime.engine]} 未安装` : browserRuntime.state === 'unhealthy' ? '浏览器连接异常' : browserRuntime.running ? 'Agent 浏览器运行中' : browserRuntime.state === 'ready' ? '浏览器可以附着' : usesPersonalBrowser ? '等待浏览器连接' : 'Agent 浏览器已就绪'}</b>
              <small className="browser-runtime-detail" title={browserRuntime?.message ?? (usesPersonalBrowser ? '使用受限轻量连接，只操作专用 BOSS 任务标签页' : '招聘网页运行在独立的受控浏览器进程中')}>{browserRuntimeBusy && usesPersonalBrowser ? `正在请求 ${BrowserEngineLabels[draft.browserEngine ?? 'edge']} 授权，请切换到浏览器并点击“允许”` : browserRuntime?.message ?? browserRuntime?.currentUrl ?? (usesPersonalBrowser ? `${BrowserEngineLabels[browserRuntime?.engine ?? draft.browserEngine ?? 'edge']} · 等待连接已登录的 BOSS 页面` : 'Avery 隔离浏览器 · 专用 Profile')}</small>
            </span>
          </div>
          <div><Button variant="quiet" disabled={browserRuntimeBusy || browserSelectionPending} onClick={() => void RefreshBrowserRuntime(usesPersonalBrowser)}>{browserSelectionPending ? '请先保存' : browserRuntimeBusy ? usesPersonalBrowser ? '连接中…' : '刷新中…' : usesPersonalBrowser ? '检测并连接' : '刷新状态'}</Button></div>
        </div>
        {usesPersonalBrowser
          ? <div className="setting-note browser-access-note is-personal"><small>个人浏览器</small><b>轻量连接现有登录状态</b><p>请先在所选浏览器中开启仅限本机的远程调试，并打开、登录 BOSS 直聘。首次连接时浏览器会弹出远程调试授权，请点击“允许”。Avery 会新建并只操作一个 BOSS 任务标签页，不会显示或切换到其他个人页面；关闭任务也不会关闭你的浏览器。</p></div>
          : <div className="setting-note browser-access-note is-isolated"><small>本地隔离</small><b>隔离浏览器登录数据</b><p>Cookie、站点存储和登录状态保存在 Avery 专用 Profile 中；清除后不会影响你的个人浏览器数据。</p><Button variant="danger" disabled={browserRuntimeBusy || !browserRuntime?.profileExists} onClick={() => setShowClearBrowserProfile(true)}>清除登录数据</Button></div>}
        <div className="setting-note browser-access-note is-personal"><small>定时任务授权</small><b>授权随任务创建确认保存</b><p>创建投递场景定时任务时，确认弹窗会同时授予该任务个人浏览器权限，无需在设置中再次配置。浏览器未连接或未登录 BOSS 时，任务仍会暂停并等待你处理。</p><div className="model-select-row"><Select value={cronBrowserTaskId} onChange={setCronBrowserTaskId} ariaLabel="查看投递定时任务授权" options={cronBrowserAccess?.tasks.length ? cronBrowserAccess.tasks.map((task) => ({ value: task.id, label: `${task.browserAuthorized ? '已授权' : '未授权'} · ${task.title}` })) : [{ value: '', label: '暂无活动的投递定时任务' }]} /></div>{cronBrowserAccess?.tasks.find((task) => task.id === cronBrowserTaskId)?.browserAuthorized && <div className="api-actions"><Button variant="danger" disabled={browserRuntimeBusy} onClick={() => void RevokeCronBrowserAccessHandler()}>撤销该任务授权</Button></div>}</div>
        <div className="api-actions"><Button variant="primary" onClick={() => void SaveSettings()}>保存浏览器设置</Button></div>
      </div>
      <Modal
        open={!usesPersonalBrowser && showClearBrowserProfile}
        title="清除隔离浏览器登录数据"
        onClose={() => setShowClearBrowserProfile(false)}
        variant="dialog"
        size="sm"
        footer={<>
          <DialogButton onClick={() => setShowClearBrowserProfile(false)}>取消</DialogButton>
          <DialogButton tone="danger" disabled={browserRuntimeBusy} onClick={() => void ClearBrowserProfileHandler()}>确认清除</DialogButton>
        </>}
      >
        {/* 破坏性操作先逐条列出会被清掉的内容（原型 .cf-warn） */}
        <div className="cf-warn">
          <Icon name="error" size={18} />
          <div>
            <p>这会关闭 Avery 隔离浏览器并删除其专用 Profile，其中的这些内容会一并清空：</p>
            <ul>
              <li>Cookie 与登录状态</li>
              <li>站点存储</li>
            </ul>
            <p>清空后无法恢复；不会影响你的个人浏览器。</p>
          </div>
        </div>
      </Modal>
    </>}
    {tab === 'developer' && <div className="settings-panel developer-settings"><label className="switch-line"><span><b>启用开发者模式</b><small>开启后在侧边栏显示本地开发者工具。</small></span><input type="checkbox" checked={draft.developerMode} onChange={(event) => UpdateDraft({ developerMode: event.target.checked })} /></label><FormField label="Trace 保留数量" hint="默认 50，最多保留 100 条本地 Trace。"><input type="number" min="1" max="100" value={draft.traceRetention} aria-invalid={Boolean(fieldErrors.traceRetention)} aria-describedby={fieldErrors.traceRetention ? 'trace-retention-error' : undefined} onChange={(event) => UpdateDraft({ traceRetention: Number(event.target.value) })} />{fieldErrors.traceRetention && <small className="field-error" id="trace-retention-error" role="alert">{fieldErrors.traceRetention}</small>}</FormField><FormField label="自动压缩阈值"><div className="input-suffix"><input type="number" min="1" max="80" value={draft.compressionThreshold} aria-invalid={Boolean(fieldErrors.compressionThreshold)} aria-describedby={fieldErrors.compressionThreshold ? 'compression-threshold-error' : undefined} onChange={(event) => UpdateDraft({ compressionThreshold: Number(event.target.value) })} /><span>%</span></div>{fieldErrors.compressionThreshold && <small className="field-error" id="compression-threshold-error" role="alert">{fieldErrors.compressionThreshold}</small>}<small>按 System、Tools 和 Messages 的完整输入计算；只能配置为 1–80 的整数。</small></FormField><div className="setting-note"><b>Trace 隐私提示</b><p>真实 Trace 可能包含简历、JD 与附件片段，仅保存在本机；关闭开发者模式后不再新增 Trace。</p></div><div className="danger-zone"><div><b>清空 Trace</b><p>删除所有本地 Trace，不可撤销。</p></div><Button variant="danger" onClick={() => setShowClear(true)}>一键清空</Button></div>{draft.developerMode && <Button onClick={onNavigateDeveloper}>打开开发者工具</Button>}</div>}
  </section>{RenderLeaveDialog()}<Modal
    open={showClear}
    title="确认清空全部 Trace？"
    onClose={() => setShowClear(false)}
    footer={<>
      <DialogButton onClick={() => setShowClear(false)}>取消</DialogButton>
      <DialogButton tone="danger" onClick={() => void ClearDeveloperObservability()}>确认清空</DialogButton>
    </>}
  >
    将删除本地全部运行日志、Trace 索引和事件。此操作不可撤销。
  </Modal><Modal
    open={showMigrate}
    title="确认迁移工作空间？"
    onClose={() => setShowMigrate(false)}
    footer={<>
      <DialogButton onClick={() => setShowMigrate(false)}>取消</DialogButton>
      <DialogButton tone="accent" onClick={() => void MigrateWorkspaceHandler()}>确认迁移</DialogButton>
    </>}
  >
    将复制并校验数据后切换到目标空目录，原工作空间会保留。Agent 运行期间无法迁移。
  </Modal>
  </div>;
}

export { SettingsPage };
