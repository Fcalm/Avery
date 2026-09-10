import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useUiStore } from '../../../app/UiStore';
import { useSettingsStore } from '../../../features/settings/api/settingsQueries';
import { ClearAgentObservability, ClearBrowserProfile, ConfigureAgent, GetAgentModuleConfiguration, GetAgentStatus, GetBrowserRuntimeStatus, GetCronBrowserAccess, GetDeepSeekModels, GetProviderCatalog, IsDesktopAgentAvailable, ResetAgentModules, RevokeCronBrowserAccess, SelectAgentModuleDirectory, SetAgentTraceRetention, TestAgentConnection } from '../../../features/assistant/api/agentQueries';
import { CreateWorkspaceBackup, MigrateWorkspace } from '../../../features/workspace/api/workspaceActions';
import { WORKSPACE_QUERY_KEY } from '../../../features/workspace/api/workspaceData';
import { Button, FormField, Modal, PageHeader, Select } from '../../../shared/components/UI';
import { Icon } from '../../../shared/components/Icon';
import type { SettingsDraft } from '../../../types/domain';
import type { AgentBrowserRuntimeStatus, AgentModuleConfiguration, CronBrowserAccessStatus } from '@avery/contracts';

export type SettingTab = 'account' | 'workspace' | 'api' | 'browser' | 'developer';
type FieldErrors = Partial<Record<'traceRetention' | 'compressionThreshold' | 'contextLength', string>>;
export const SettingsTabs: Array<{ id: SettingTab; label: string; description: string }> = [
  { id: 'account', label: '账户', description: '管理应用内的显示名称。' },
  { id: 'workspace', label: '工作空间', description: '管理档案、简历版本和导出文件的存放目录。' },
  { id: 'api', label: '模型配置', description: '管理模型供应商、默认模型与上下文能力；凭据加密存储在本机。' },
  { id: 'browser', label: '浏览器设置', description: '选择 Avery 隔离浏览器，或安全连接已登录 BOSS 的个人浏览器。' },
  { id: 'developer', label: '开发者模式', description: '查看本地日志、Trace 和上下文用量界面。' },
];
const FallbackDeepSeekModels = ['deepseek-v4-flash', 'deepseek-v4-pro', 'deepseek-v4-flash-vision-exp'];
const BrowserEngineLabels = { electron: 'Avery 隔离浏览器', chrome: 'Google Chrome', edge: 'Microsoft Edge' } as const;

function NormalizeProviderSettings(settings: SettingsDraft): SettingsDraft {
  const contextLimitMode = settings.contextLimitMode ?? (settings.provider === '自定义' ? 'custom' : 'default');
  const contextLength = settings.provider === 'DeepSeek' && contextLimitMode === 'default' && settings.contextLength === '64K' ? '256K' : settings.contextLength;
  const model = settings.provider === 'Z.AI' ? 'glm-5.3-flash' : settings.provider === 'DeepSeek' && (!settings.model.startsWith('deepseek-') || settings.model === 'deepseek-chat' || settings.model === 'deepseek-reasoner') ? 'deepseek-v4-flash' : settings.model;
  const baseUrl = settings.provider === 'Z.AI' ? 'https://open.bigmodel.cn/api/paas/v4' : settings.provider === 'DeepSeek' ? 'https://api.deepseek.com' : settings.baseUrl;
  const browserEngine = settings.browserEngine === 'electron' || settings.browserEngine === 'chrome' ? settings.browserEngine : 'edge';
  return { ...settings, model, baseUrl, contextLength, contextLimitMode, browserEngine, thinkingEnabled: settings.provider === 'Z.AI' ? true : settings.thinkingEnabled };
}

function IsValidContextLength(value: string): boolean {
  const match = value.trim().match(/^(\d+)\s*([kK])?$/);
  const limit = match ? Number(match[1]) * (match[2] ? 1000 : 1) : Number.NaN;
  return Number.isSafeInteger(limit) && limit >= 8_000 && limit <= 2_000_000;
}

function ParseContextLimit(value: string): number | null {
  const match = value.trim().match(/^(\d+)\s*([kK])?$/);
  const limit = match ? Number(match[1]) * (match[2] ? 1000 : 1) : Number.NaN;
  return Number.isSafeInteger(limit) ? limit : null;
}

function FormatContextLength(value: number): string {
  return value % 1000 === 0 ? `${value / 1000}K` : String(value);
}

function SettingsPage({ onNavigateDeveloper, tab, requestedTab, tabRequestVersion, onTabChange }: { onNavigateDeveloper: () => void; tab: SettingTab; requestedTab: SettingTab; tabRequestVersion: number; onTabChange: (tab: SettingTab) => void }) {
  const { ShowNotice } = useUiStore();
  const queryClient = useQueryClient();
  const { settings, saveSettingsNow } = useSettingsStore();
  const [draft, setDraft] = useState<SettingsDraft>(() => NormalizeProviderSettings(settings));
  const [deepSeekModels, setDeepSeekModels] = useState<string[]>(FallbackDeepSeekModels);
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
  useEffect(() => { setDraft(NormalizeProviderSettings(settings)); }, [settings]);
  /** API Key 不进入 Renderer；只以主进程返回的脱敏配置状态驱动成功标记。 */
  useEffect(() => {
    const isCurrentProviderConfigured = configuredProviders.has(draft.provider) || (apiKeyConfigured && configuredProvider === draft.provider);
    document.body.classList.toggle('settings-has-configured-api-key', isCurrentProviderConfigured);
    return () => document.body.classList.remove('settings-has-configured-api-key');
  }, [apiKeyConfigured, configuredProvider, configuredProviders, draft.provider]);
  async function RefreshDeepSeekModels(manual = false) {
    if (!IsDesktopAgentAvailable()) return;
    setRefreshingModels(true);
    try {
      const result = await GetDeepSeekModels();
      if (result.models.length) setDeepSeekModels(result.models);
      if (manual) ShowNotice(result.models.length ? '已同步最新模型列表' : '未获取到可用模型，已保留默认模型');
    } catch (error) {
      if (manual) ShowNotice(error instanceof Error ? error.message : '模型列表刷新失败');
    } finally {
      setRefreshingModels(false);
    }
  }
  useEffect(() => {
    if (tab === 'api' && draft.provider === 'DeepSeek') void RefreshDeepSeekModels();
  }, [tab, draft.provider]);
  useEffect(() => {
    if (tab !== 'api' || !IsDesktopAgentAvailable()) return;
    void GetProviderCatalog().then((catalog) => {
      setConfiguredProviders(new Set(catalog.providers.filter((item) => item.configured).map((item) => item.provider)));
      setProviderConfigurations(Object.fromEntries(catalog.providers.filter((item) => item.configured).map((item) => [item.provider, item])));
    }).catch(() => undefined);
    void GetAgentStatus().then((status) => {
      setApiKeyConfigured(status.configured);
      setConfiguredProvider(status.provider === 'Z.AI' ? 'Z.AI' : status.provider === '自定义' ? '自定义' : 'DeepSeek');
      const contextLimit = status.contextLimit;
      if (!contextLimit) return;
      setDraft((current) => NormalizeProviderSettings({
        ...current,
        provider: status.provider === '自定义' ? '自定义' : status.provider === 'Z.AI' ? 'Z.AI' : 'DeepSeek',
        model: status.model,
        baseUrl: status.baseUrl ?? current.baseUrl,
        contextLength: FormatContextLength(contextLimit),
        contextLimitMode: status.contextLimitMode ?? 'default',
        compressionThreshold: status.compressionThreshold ?? current.compressionThreshold,
      }));
    }).catch(() => { setApiKeyConfigured(false); setConfiguredProvider(null); });
  }, [tab]);
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
          model: saved.model,
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
    if (draft.contextLimitMode === 'custom' && !IsValidContextLength(draft.contextLength)) nextErrors.contextLength = '请输入 8K–2000K，例如 128K 或 128000。';
    setFieldErrors(nextErrors);
    if (Object.keys(nextErrors).length) { ShowNotice('请修正标记的设置项后再保存'); return false; }
    ShowNotice(tab === 'api' ? '正在保存 API 配置…' : '正在保存设置…', 'pending');
    if (tab === 'api' && IsDesktopAgentAvailable()) {
      try {
        await ConfigureAgent({ provider: draft.provider, apiKey: draft.apiKey, baseUrl: draft.baseUrl, model: draft.model, thinkingEnabled: draft.thinkingEnabled, contextLength: draft.contextLength, contextLimitMode: draft.contextLimitMode, compressionThreshold: draft.compressionThreshold });
        setApiKeyConfigured(true);
        setConfiguredProvider(draft.provider);
        setConfiguredProviders((current) => new Set([...current, draft.provider]));
        setProviderConfigurations((current) => ({ ...current, [draft.provider]: {
          model: draft.model,
          baseUrl: draft.baseUrl,
          contextLimit: ParseContextLimit(draft.contextLength) ?? 256000,
          contextLimitMode: draft.contextLimitMode ?? 'default',
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
    if (provider === 'DeepSeek') {
      UpdateDraft({ provider, baseUrl: 'https://api.deepseek.com', model: draft.model.startsWith('deepseek-') && draft.model !== 'deepseek-chat' && draft.model !== 'deepseek-reasoner' ? draft.model : 'deepseek-v4-flash' });
      return;
    }
    if (provider === 'Z.AI') {
      UpdateDraft({ provider, baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-5.3-flash', thinkingEnabled: true });
      return;
    }
    UpdateDraft({ provider });
  }
  function RenderModelConfiguration() {
    const providerOptions: Array<{ id: SettingsDraft['provider']; label: string; symbol: string }> = [
      { id: 'DeepSeek', label: 'DeepSeek', symbol: 'D' },
      { id: 'Z.AI', label: '智谱 GLM', symbol: 'Z' },
      { id: '自定义', label: '自定义提供商', symbol: '+' },
    ];
    const currentProviderConfigured = configuredProviders.has(draft.provider) || (apiKeyConfigured && configuredProvider === draft.provider);
    const modelOptions = draft.provider === 'DeepSeek'
      ? [...new Set([draft.model, ...deepSeekModels])].map((model) => ({ value: model, label: model }))
      : [{ value: draft.model, label: draft.model }];
    const providerName = providerOptions.find((item) => item.id === draft.provider)?.label ?? '模型提供商';
    return <section className="settings-panel api-panel model-configuration-panel">
      <aside className="model-provider-list" aria-label="模型供应商">
        <div className="model-provider-group">{providerOptions.filter((item) => item.id !== '自定义').map((item) => <button key={item.id} className={item.id === draft.provider ? 'selected' : ''} type="button" aria-pressed={item.id === draft.provider} onClick={() => SelectProvider(item.id)}><span className="model-provider-symbol">{item.symbol}</span><span><b>{item.label}</b></span><i className={configuredProviders.has(item.id) || (apiKeyConfigured && configuredProvider === item.id) ? 'is-configured' : ''} aria-label={configuredProviders.has(item.id) || (apiKeyConfigured && configuredProvider === item.id) ? '已配置' : '未配置'} /></button>)}</div>
        <div className="model-provider-group"><small>自定义提供商</small>{providerOptions.filter((item) => item.id === '自定义').map((item) => <button key={item.id} className={item.id === draft.provider ? 'selected' : ''} type="button" aria-pressed={item.id === draft.provider} onClick={() => SelectProvider(item.id)}><span className="model-provider-symbol">{item.symbol}</span><span><b>{item.label}</b></span><i className={configuredProviders.has(item.id) || (apiKeyConfigured && configuredProvider === item.id) ? 'is-configured' : ''} aria-label={configuredProviders.has(item.id) || (apiKeyConfigured && configuredProvider === item.id) ? '已配置' : '未配置'} /></button>)}</div>
      </aside>
      <div className="model-provider-detail">
        <header><div><h2>{providerName}</h2><p>配置完成后，可在对话输入框中选择此模型。</p></div><div className="model-provider-actions"><span className={currentProviderConfigured ? 'is-configured' : ''}>{currentProviderConfigured ? '已配置' : '待配置'}</span><div className="api-actions"><Button onClick={() => void TestApiConnection()}>测试连接</Button><Button variant="primary" onClick={() => void SaveSettings()}>保存配置</Button></div></div></header>
        <div className="model-provider-fields">
          <div className="model-config-basic-fields"><label className="model-config-field"><span>Base URL</span><input value={draft.baseUrl} readOnly={draft.provider === 'Z.AI'} onChange={(event) => UpdateDraft({ baseUrl: event.target.value })} /></label><label className="model-config-field"><span>接口格式</span><input value="Chat Completions (/chat/completions)" readOnly /></label></div>
          <label className="model-config-field"><span>API Key</span><input type="password" value={draft.apiKey} onChange={(event) => UpdateDraft({ apiKey: event.target.value })} autoComplete="off" placeholder={currentProviderConfigured ? '已安全保存，输入新密钥可覆盖' : '请输入 API Key'} /></label>
          <section className="model-config-models"><div><span>模型列表</span>{draft.provider === 'DeepSeek' && <Button variant="quiet" disabled={refreshingModels} onClick={() => void RefreshDeepSeekModels(true)}>{refreshingModels ? '同步中…' : '刷新模型'}</Button>}</div><article><span className="model-provider-symbol">{draft.provider === '自定义' ? '+' : draft.provider === 'Z.AI' ? 'Z' : 'D'}</span>{draft.provider === 'Z.AI' ? <input value="glm-5.3-flash" readOnly /> : draft.provider === '自定义' ? <input value={draft.model} onChange={(event) => UpdateDraft({ model: event.target.value })} placeholder="输入模型名称" /> : <Select value={draft.model} onChange={(model) => UpdateDraft({ model })} ariaLabel="默认模型" options={modelOptions} />}</article></section>
          <section className="model-config-advanced"><label className="switch-line"><span><b>思考模式</b><small>{draft.provider === 'Z.AI' ? 'GLM 模型始终启用思考模式。' : '开启后，助手会展示可折叠的思考内容。'}</small></span><input type="checkbox" checked={draft.thinkingEnabled} disabled={draft.provider === 'Z.AI'} onChange={(event) => UpdateDraft({ thinkingEnabled: event.target.checked })} /></label><label className="switch-line"><span><b>自定义上下文限制</b><small>关闭时使用模型默认上限。</small></span><input type="checkbox" checked={draft.contextLimitMode === 'custom'} onChange={(event) => UpdateDraft({ contextLimitMode: event.target.checked ? 'custom' : 'default' })} /></label>{draft.contextLimitMode === 'custom' && <label className="model-config-field"><span>上下文限制</span><input value={draft.contextLength} aria-invalid={Boolean(fieldErrors.contextLength)} onChange={(event) => UpdateDraft({ contextLength: event.target.value })} placeholder="例如 128K" /></label>}</section>
        </div>
      </div>
    </section>;
  }
  const current = SettingsTabs.find((item) => item.id === tab)!;
  const usesPersonalBrowser = (draft.browserEngine ?? 'edge') !== 'electron';
  const browserSelectionPending = Boolean(browserRuntime && browserRuntime.engine !== (draft.browserEngine ?? 'edge'));
  if (tab === 'api') return <div className="settings-page"><section className="settings-content"><PageHeader eyebrow="设置" title={current.label} description={current.description} />{RenderModelConfiguration()}</section><Modal open={showLeave} title="存在未保存的修改" onClose={() => setShowLeave(false)}><p className="modal-copy">切换设置项前，请选择如何处理当前修改。</p><div className="modal-actions"><Button onClick={() => setShowLeave(false)}>继续编辑</Button><Button onClick={DiscardAndSwitch}>放弃修改</Button><Button variant="primary" onClick={async () => { if (await SaveSettings() && nextTab) CommitTab(nextTab); setNextTab(null); setShowLeave(false); }}>保存并切换</Button></div></Modal></div>;
  return <div className="settings-page"><section className="settings-content"><PageHeader eyebrow="设置" title={current.label} description={current.description} actions={tab !== 'api' && tab !== 'browser' ? <Button variant="primary" onClick={() => void SaveSettings()}>保存更改</Button> : undefined} />
    {tab === 'developer' && <><div className="setting-note module-settings"><b>本地模块</b><p>{moduleConfiguration?.status === 'active' ? `已启用：${moduleConfiguration.directoryName ?? '已选择目录'}。模块仅在启动会话前校验。` : '当前使用官方默认模块。选择本地模块目录前，请确认其来源可信。'}</p><div className="api-actions"><Button disabled={updatingModules} onClick={() => void SelectUserModules()}>{updatingModules ? '处理中…' : '选择本地模块'}</Button><Button variant="danger" disabled={updatingModules || moduleConfiguration?.status !== 'active'} onClick={() => setShowResetModules(true)}>恢复官方默认模块</Button></div></div><Modal open={showResetModules} title="恢复官方默认模块？" onClose={() => setShowResetModules(false)}><p className="modal-copy">当前本地模块配置将被移除，后续新会话将使用内置模块。运行中的助手任务不会被中断。</p><div className="modal-actions"><Button onClick={() => setShowResetModules(false)}>取消</Button><Button variant="danger" disabled={updatingModules} onClick={() => void ConfirmResetModules()}>确认恢复默认</Button></div></Modal></>}
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
      <Modal open={!usesPersonalBrowser && showClearBrowserProfile} title="清除隔离浏览器登录数据" onClose={() => setShowClearBrowserProfile(false)}><p className="modal-copy">这会关闭 Avery 隔离浏览器并删除其专用 Profile，其中的 Cookie、站点存储和登录状态无法恢复。不会影响你的个人浏览器。</p><div className="modal-actions"><Button onClick={() => setShowClearBrowserProfile(false)}>取消</Button><Button variant="danger" disabled={browserRuntimeBusy} onClick={() => void ClearBrowserProfileHandler()}>确认清除</Button></div></Modal>
    </>}
    {tab === 'api' && <div className="settings-panel api-panel"><div className="segmented"><button className={draft.provider === 'DeepSeek' ? 'selected' : ''} onClick={() => UpdateDraft({ provider: 'DeepSeek', baseUrl: 'https://api.deepseek.com', model: draft.model.startsWith('deepseek-') && draft.model !== 'deepseek-chat' && draft.model !== 'deepseek-reasoner' ? draft.model : 'deepseek-v4-flash' })}>DeepSeek</button><button className={draft.provider === 'Z.AI' ? 'selected' : ''} onClick={() => UpdateDraft({ provider: 'Z.AI', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-5.3-flash', thinkingEnabled: true })}>GLM</button><button className={draft.provider === '自定义' ? 'selected' : ''} onClick={() => UpdateDraft({ provider: '自定义' })}>自定义</button></div><FormField label="API Key"><input type="password" value={draft.apiKey} onChange={(event) => UpdateDraft({ apiKey: event.target.value })} autoComplete="off" /></FormField>{draft.provider === 'DeepSeek' ? <><FormField label="可用模型" hint="从 DeepSeek 官方接口同步，未配置凭据时使用当前 V4 默认模型。"><div className="model-select-row"><Select value={draft.model} onChange={(model) => UpdateDraft({ model })} ariaLabel="可用模型" options={[...new Set([draft.model, ...deepSeekModels])].map((model) => ({ value: model, label: model }))} /><Button variant="quiet" disabled={refreshingModels} onClick={() => void RefreshDeepSeekModels(true)}>{refreshingModels ? '同步中…' : '刷新模型'}</Button></div></FormField><label className="switch-line"><span><b>思考模式</b><small>开启后，助手回复会展示可折叠的思考内容。</small></span><input type="checkbox" checked={draft.thinkingEnabled} onChange={(event) => UpdateDraft({ thinkingEnabled: event.target.checked })} /></label></> : draft.provider === 'Z.AI' ? <><FormField label="模型"><input value="glm-5.3-flash" readOnly /></FormField><FormField label="API 端点"><input value="https://open.bigmodel.cn/api/paas/v4" readOnly /></FormField><div className="setting-note"><b>GLM 思考模式</b><p>使用智谱中国区官方 API。GLM-5.3-Flash 强制启用思考；会话中的思考强度仍可调整，并按官方 low、high、max 三档发送。</p></div></> : <><FormField label="Base URL"><input value={draft.baseUrl} onChange={(event) => UpdateDraft({ baseUrl: event.target.value })} /></FormField><FormField label="模型名称"><input value={draft.model} onChange={(event) => UpdateDraft({ model: event.target.value })} /></FormField></>}<label className="switch-line"><span><b>自定义上下文限制</b><small>关闭时默认使用 256K；若模型上限更小，则自动使用模型上限。</small></span><input type="checkbox" checked={draft.contextLimitMode === 'custom'} onChange={(event) => UpdateDraft({ contextLimitMode: event.target.checked ? 'custom' : 'default' })} /></label>{draft.contextLimitMode === 'custom' && <FormField label="上下文限制" hint="支持 128K 或 128000；已知模型不能超过其官方上限。"><input value={draft.contextLength} aria-invalid={Boolean(fieldErrors.contextLength)} aria-describedby={fieldErrors.contextLength ? 'context-limit-error' : undefined} onChange={(event) => UpdateDraft({ contextLength: event.target.value })} />{fieldErrors.contextLength && <small className="field-error" id="context-limit-error" role="alert">{fieldErrors.contextLength}</small>}</FormField>}<div className="api-actions"><Button onClick={() => void TestApiConnection()}>测试连接</Button><Button variant="primary" onClick={() => void SaveSettings()}>保存配置</Button></div></div>}
    {tab === 'developer' && <div className="settings-panel developer-settings"><label className="switch-line"><span><b>启用开发者模式</b><small>开启后在侧边栏显示本地开发者工具。</small></span><input type="checkbox" checked={draft.developerMode} onChange={(event) => UpdateDraft({ developerMode: event.target.checked })} /></label><FormField label="Trace 保留数量" hint="默认 50，最多保留 100 条本地 Trace。"><input type="number" min="1" max="100" value={draft.traceRetention} aria-invalid={Boolean(fieldErrors.traceRetention)} aria-describedby={fieldErrors.traceRetention ? 'trace-retention-error' : undefined} onChange={(event) => UpdateDraft({ traceRetention: Number(event.target.value) })} />{fieldErrors.traceRetention && <small className="field-error" id="trace-retention-error" role="alert">{fieldErrors.traceRetention}</small>}</FormField><FormField label="自动压缩阈值"><div className="input-suffix"><input type="number" min="1" max="80" value={draft.compressionThreshold} aria-invalid={Boolean(fieldErrors.compressionThreshold)} aria-describedby={fieldErrors.compressionThreshold ? 'compression-threshold-error' : undefined} onChange={(event) => UpdateDraft({ compressionThreshold: Number(event.target.value) })} /><span>%</span></div>{fieldErrors.compressionThreshold && <small className="field-error" id="compression-threshold-error" role="alert">{fieldErrors.compressionThreshold}</small>}<small>按 System、Tools 和 Messages 的完整输入计算；只能配置为 1–80 的整数。</small></FormField><div className="setting-note"><b>Trace 隐私提示</b><p>真实 Trace 可能包含简历、JD 与附件片段，仅保存在本机；关闭开发者模式后不再新增 Trace。</p></div><div className="danger-zone"><div><b>清空 Trace</b><p>删除所有本地 Trace，不可撤销。</p></div><Button variant="danger" onClick={() => setShowClear(true)}>一键清空</Button></div>{draft.developerMode && <Button onClick={onNavigateDeveloper}>打开开发者工具</Button>}</div>}
  </section><Modal open={showLeave} title="存在未保存的修改" onClose={() => setShowLeave(false)}><p className="modal-copy">切换设置项前，请选择如何处理当前修改。</p><div className="modal-actions"><Button onClick={() => setShowLeave(false)}>继续编辑</Button><Button onClick={DiscardAndSwitch}>放弃修改</Button><Button variant="primary" onClick={async () => { if (await SaveSettings() && nextTab) CommitTab(nextTab); setNextTab(null); setShowLeave(false); }}>保存并切换</Button></div></Modal><Modal open={showClear} title="确认清空全部 Trace？" onClose={() => setShowClear(false)}><p className="modal-copy">将删除本地全部运行日志、Trace 索引和事件。此操作不可撤销。</p><div className="modal-actions"><Button onClick={() => setShowClear(false)}>取消</Button><Button variant="danger" onClick={() => void ClearDeveloperObservability()}>确认清空</Button></div></Modal><Modal open={showMigrate} title="确认迁移工作空间？" onClose={() => setShowMigrate(false)}><p className="modal-copy">将复制并校验数据后切换到目标空目录，原工作空间会保留。Agent 运行期间无法迁移。</p><div className="modal-actions"><Button onClick={() => setShowMigrate(false)}>取消</Button><Button variant="primary" onClick={() => void MigrateWorkspaceHandler()}>确认迁移</Button></div></Modal>
  </div>;
}

export { SettingsPage };
