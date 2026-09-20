import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useUiStore } from '../../../app/UiStore';
import { useSettingsStore } from '../../../features/settings/api/settingsQueries';
import { ClearAgentObservability, ClearBrowserProfile, ConfigureAgent, GetAgentModuleConfiguration, GetAgentStatus, GetBrowserRuntimeStatus, GetCronBrowserAccess, GetDeepSeekModels, GetProviderCatalog, IsDesktopAgentAvailable, ResetAgentModules, RevokeCronBrowserAccess, SelectAgentModuleDirectory, SetAgentTraceRetention, TestAgentConnection } from '../../../features/assistant/api/agentQueries';
import { ApplyModelRuntime, CreateCatalogModel, DefaultContextWindow, DefaultMaxOutput, FindCatalogModel, FindCatalogProvider, FormatContextWindow, IsValidContextWindow, IsValidMaxOutput, LoadModelCatalog, MergeBackendProviders, MergeProviderModels, ModelApiFormats, SaveModelCatalog, type ModelApiFormat, type ModelCatalog, type ModelCatalogModel, type ModelCatalogProvider } from '../api/modelCatalog';
import { MigrateWorkspace } from '../../../features/workspace/api/workspaceActions';
import { WORKSPACE_QUERY_KEY } from '../../../features/workspace/api/workspaceData';
import { Button, DialogButton, Modal, Select } from '../../../shared/components/UI';
import { Icon } from '../../../shared/components/Icon';
import type { SettingsDraft } from '../../../types/domain';
import type { AgentBrowserRuntimeStatus, AgentModuleConfiguration, CronBrowserAccessStatus } from '@avery/contracts';

export type SettingTab = 'general' | 'persona' | 'api' | 'browser' | 'developer';
export const SettingsTabs: Array<{ id: SettingTab; label: string; description: string }> = [
  { id: 'general', label: '常规', description: '语言、工作空间、通知与更新的默认行为，改完就生效。' },
  { id: 'persona', label: '个性化', description: '头像、昵称、说话方式和界面外观，都按你的习惯来。' },
  { id: 'api', label: '模型配置', description: '管理模型供应商、默认模型与上下文能力；凭据加密存储在本机。' },
  { id: 'browser', label: '浏览器控制', description: '连接日常使用的 Chrome 或 Edge，查看连接状态，管理隔离浏览器留下的数据。' },
  { id: 'developer', label: '开发者模式', description: '查看本地日志、Trace 和上下文用量界面。' },
];
/** 浏览器显示名：选择项只保留 Chrome/Edge（隔离浏览器已整体迁移），electron 仅用于展示运行时上报的旧引擎。 */
const BrowserEngineLabels = { electron: 'Avery 隔离浏览器（兼容）', chrome: 'Google Chrome', edge: 'Microsoft Edge' } as const;
/** 模型配置侧栏的分组：推荐 = 官方供应商，自定义供应商可删除并改用自定义端点。 */
const ProviderGroups = ['推荐', '自定义供应商'];
/** 模型标记：与原型一致，推荐供应商用字母，自定义供应商用加号。 */
/** 供应商标记：品牌供应商用品牌图标（mask 随文字色），自定义无品牌保留加号字符。 */
const ProviderMarks: Record<SettingsDraft['provider'], ReactNode> = { DeepSeek: <Icon name="deepseek" size={13} />, 'Z.AI': <Icon name="zai" size={13} />, '自定义': '+' };
/** 个性化页选项：与原型 avery-settings.html 的 AV_STYLES / SIZES / ACCENTS / RESUMES 一一对应。 */
export const AvatarStyles = [{ key: 'default', label: '默认底色' }, { key: 'accent', label: '主题色' }, { key: 'ink', label: '反色' }] as const;
/** 回复字号档位：默认档必须等于当前正文的 14px，「默认」才与实际渲染一致；App 用它给聊天气泡挂 CSS 变量。 */
export const ChatFontSizes = [{ key: 'sm', label: '小', px: 13 }, { key: 'md', label: '默认', px: 14 }, { key: 'lg', label: '大', px: 16 }] as const;
const AccentColors = [{ key: 'pine', label: '松绿', hex: '#17654f' }, { key: 'indigo', label: '靛蓝', hex: '#3f5bd6' }, { key: 'plum', label: '茄紫', hex: '#7a4fd0' }, { key: 'amber', label: '琥珀', hex: '#b45309' }] as const;
const ResumeTemplates = [{ key: 'classic', label: '经典单栏' }, { key: 'compact', label: '双栏紧凑' }, { key: 'timeline', label: '时间线' }] as const;
/** 自定义上下文的字数上限，与原型 CTX_MAX 一致。 */
const ContextMax = 500;

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
  // 隔离浏览器已整体迁移到 Chrome/Edge：设置里残留的 electron 不再是可选项，草稿统一按 Edge 处理。
  const browserEngine = settings.browserEngine === 'chrome' ? 'chrome' : 'edge';
  return { ...settings, model, baseUrl, contextLength, contextLimitMode, browserEngine, thinkingEnabled: settings.provider === 'Z.AI' ? true : settings.thinkingEnabled };
}

function FormatContextLength(value: number): string {
  return value % 1000 === 0 ? `${value / 1000}K` : String(value);
}

/** 昵称首字头像的初始字：空昵称回落 A，拉丁字母统一大写，其余文字保持原样（与原型 initialOf 一致）。 */
function InitialOf(name: string): string {
  const first = name.trim().charAt(0);
  return /[a-z]/i.test(first) ? first.toUpperCase() : first || 'A';
}

/** 把上传的图片居中裁成 256×256 并压成 JPEG data URL：设置以 JSON 整体存储，头像必须足够小。 */
async function CreateAvatarDataUrl(file: File): Promise<string> {
  const source = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('读取图片失败'));
    reader.readAsDataURL(file);
  });
  const image = await new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('图片解析失败'));
    img.src = source;
  });
  const side = Math.min(image.naturalWidth, image.naturalHeight);
  if (!side) throw new Error('图片内容为空');
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 256;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('当前环境不支持图片处理');
  context.drawImage(image, (image.naturalWidth - side) / 2, (image.naturalHeight - side) / 2, side, side, 0, 0, 256, 256);
  return canvas.toDataURL('image/jpeg', 0.85);
}

/** 常规页的开关行：左标题与说明，右开关；依赖上级开关的行以 disabled 呈现。 */
function RenderGeneralSwitch({ label, description, checked, disabled = false, onToggle }: { label: string; description: string; checked: boolean; disabled?: boolean; onToggle: () => void }) {
  return <div className="gn-row">
    <div className="gn-txt"><span className="gn-t">{label}</span><span className="gn-d">{description}</span></div>
    <div className="gn-ctl"><button className="switch" type="button" role="switch" aria-checked={checked} aria-label={label} aria-disabled={disabled || undefined} disabled={disabled} onClick={onToggle}><span className="knob" /></button></div>
  </div>;
}

function SettingsPage({ onNavigateDeveloper, tab, requestedTab, tabRequestVersion, onTabChange }: { onNavigateDeveloper: () => void; tab: SettingTab; requestedTab: SettingTab; tabRequestVersion: number; onTabChange: (tab: SettingTab) => void }) {
  const { ShowNotice } = useUiStore();
  const queryClient = useQueryClient();
  const { settings, setSettings, saveSettingsNow } = useSettingsStore();
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
  // 开发者页的数值输入草稿：失焦或回车才提交，避免逐键把 1、15 这类过渡值发给后端。
  const [traceDraft, setTraceDraft] = useState(() => String(settings.traceRetention));
  const [thresholdDraft, setThresholdDraft] = useState(() => String(settings.compressionThreshold));
  useEffect(() => { setTraceDraft(String(settings.traceRetention)); setThresholdDraft(String(settings.compressionThreshold)); }, [settings.traceRetention, settings.compressionThreshold]);
  /** 工作空间的实际存放路径：只在常规页展示与打开，后端设置里不含绝对路径。 */
  const [workspacePath, setWorkspacePath] = useState<string | null>(null);
  /** 头像上传用的隐藏文件选择器；上传结果经压缩后写入设置的 avatarImage。 */
  const avatarFileRef = useRef<HTMLInputElement>(null);
  /** 自定义上下文的本地草稿：与原型一致保留显式保存，未保存前切换页签会被确认框拦下。 */
  const [contextDraft, setContextDraft] = useState(() => settings.customContext ?? '');
  useEffect(() => { setContextDraft(settings.customContext ?? ''); }, [settings.customContext]);
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
  // 隔离浏览器已整体迁移到 Chrome/Edge：旧设置里的 electron 没有对应选项，进入设置页时静默迁到 Edge。
  useEffect(() => {
    if (settings.browserEngine === 'electron') ApplySettings({ browserEngine: 'edge' });
  }, [settings.browserEngine]);
  useEffect(() => {
    if (tab !== 'general') return;
    let cancelled = false;
    window.averyWindow?.GetWorkspaceDirectory().then((path) => { if (!cancelled && path) setWorkspacePath(path); }).catch(() => { if (!cancelled) setWorkspacePath(null); });
    return () => { cancelled = true; };
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
    setDirty(true);
  }
  // 只剩模型配置页还走显式保存：常规/个性化/浏览器控制/开发者页都是即改即存，不经过这里。
  async function SaveSettings() {
    const activeParameters = ResolveActiveModelParameters();
    if (!activeParameters) { ShowNotice('请先在模型列表里添加或选择一个模型'); return false; }
    ShowNotice('正在保存 API 配置…', 'pending');
    if (IsDesktopAgentAvailable()) {
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
    // API Key 只保留在当前表单内存与主进程 safeStorage，不能写入全局工作空间缓存。
    const { apiKey: _apiKey, ...safeDraft } = draft;
    try {
      await saveSettingsNow({ ...safeDraft, apiKey: '' });
    } catch (error) {
      ShowNotice(error instanceof Error ? error.message : '设置持久化失败', 'error');
      return false;
    }
    setDirty(false); ShowNotice('API 配置与上下文限制已保存', 'success');
    return true;
  }
  function CommitTab(target: SettingTab) { onTabChange(target); }
  // 个性化页的自定义上下文是显式保存的草稿：与手动保存页签一起纳入离开确认。
  function SwitchTab(target: SettingTab) { if (target === tab) return; if (!dirty && !contextDirty) { CommitTab(target); return; } setNextTab(target); setShowLeave(true); }
  function DiscardAndSwitch() { if (!nextTab) return; setDraft(NormalizeProviderSettings(settings)); setContextDraft(settings.customContext ?? ''); setDirty(false); CommitTab(nextTab); setNextTab(null); setShowLeave(false); }
  useEffect(() => {
    if (tabRequestVersion > 0) SwitchTab(requestedTab);
  }, [tabRequestVersion]);
  async function ClearDeveloperObservability() {
    if (IsDesktopAgentAvailable()) await ClearAgentObservability();
    setShowClear(false);
    ShowNotice('运行日志与 Trace 已清空');
  }
  async function OpenWorkspaceDirectoryHandler() {
    try {
      const opened = await window.averyWindow?.OpenWorkspaceDirectory();
      if (opened !== true) ShowNotice('无法打开工作空间目录');
    } catch (error) {
      ShowNotice(error instanceof Error ? error.message : '无法打开工作空间目录');
    }
  }
  /** 更新发布通道尚未接入：只如实报告当前版本，不伪造「已是最新」的检查结果。 */
  function CheckForUpdatesNotice() {
    ShowNotice(`当前版本 v${__APP_VERSION__}；自动更新通道尚未接入`);
  }
  /** 常规/个性化页即改即存：直接写入设置存储（乐观更新 + 300ms 防抖持久化），没有页头保存按钮。 */
  function ApplySettings(patch: Partial<SettingsDraft>) {
    setSettings((current) => ({ ...current, ...patch }));
  }
  /** 恢复默认（原型标题行右侧的 quiet 按钮）：常规项回到默认值，开机自启同步从系统登录项移除。 */
  async function ResetGeneralDefaults() {
    ApplySettings({ language: 'zh', startPage: 'last', notifyOnComplete: true, notifySound: true, autoUpdate: true, autoLaunch: false, closeToTray: true });
    try { await window.averyWindow?.SetLoginItemSettings(false); }
    catch { ShowNotice('已恢复默认，但开机自启未能在系统移除', 'error'); }
  }
  /** 开机自启：写入设置的同时同步系统登录项，两处状态保持一致；失败时如实提示。 */
  async function ToggleAutoLaunch() {
    const next = !(settings.autoLaunch ?? false);
    ApplySettings({ autoLaunch: next });
    try { await window.averyWindow?.SetLoginItemSettings(next); }
    catch { ShowNotice('设置已保存，但开机自启未能在系统生效', 'error'); }
  }
  /** 自定义上下文（原型 pf-save）：显式保存草稿，保存后与已存值一致。 */
  function CommitContext() {
    ApplySettings({ customContext: contextDraft });
  }
  /** 头像上传：只收图片文件，先在本地压缩成小图再写入设置；失败时如实提示，不写半成品数据。 */
  async function UploadAvatarHandler(file: File | undefined) {
    if (!file) return;
    if (!file.type.startsWith('image/')) { ShowNotice('请选择图片文件', 'error'); return; }
    if (file.size > 8 * 1024 * 1024) { ShowNotice('图片太大，请选择 8MB 以内的文件', 'error'); return; }
    try {
      ApplySettings({ avatarImage: await CreateAvatarDataUrl(file) });
    } catch (error) {
      ShowNotice(error instanceof Error ? error.message : '头像处理失败', 'error');
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
  /** 失焦提交 Trace 保留数量：合法才写后端与设置；非法恢复原值并明确提示，不静默吞掉。 */
  async function CommitTraceRetention() {
    const value = Number(traceDraft);
    if (!Number.isInteger(value) || value < 1 || value > 100) {
      setTraceDraft(String(settings.traceRetention));
      ShowNotice('Trace 保留数量需为 1–100 的整数，已恢复原值', 'error');
      return;
    }
    if (value === settings.traceRetention) return;
    try {
      if (IsDesktopAgentAvailable()) await SetAgentTraceRetention(value);
      ApplySettings({ traceRetention: value });
    } catch (error) {
      setTraceDraft(String(settings.traceRetention));
      ShowNotice(error instanceof Error ? error.message : 'Trace 留存设置保存失败', 'error');
    }
  }
  /** 失焦提交自动压缩阈值：只落设置，压缩发生在会话装配时按此值读取。 */
  function CommitCompressionThreshold() {
    const value = Number(thresholdDraft);
    if (!Number.isInteger(value) || value < 1 || value > 80) {
      setThresholdDraft(String(settings.compressionThreshold));
      ShowNotice('自动压缩阈值需为 1–80 的整数，已恢复原值', 'error');
      return;
    }
    if (value !== settings.compressionThreshold) ApplySettings({ compressionThreshold: value });
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
        <DialogButton tone="accent" onClick={async () => { if (contextDirty) CommitContext(); if (await SaveSettings() && nextTab) CommitTab(nextTab); setNextTab(null); setShowLeave(false); }}>保存并切换</DialogButton>
      </>}
    >
      切换设置项前，请选择如何处理当前修改。
    </Modal>;
  }

  const current = SettingsTabs.find((item) => item.id === tab)!;
  // 个性化页：上下文是否相对已保存值有改动；预览字号取当前档位的像素值。
  const contextDirty = contextDraft !== (settings.customContext ?? '');
  const replyFontSizePx = (ChatFontSizes.find((size) => size.key === (settings.chatFontSize ?? 'md')) ?? ChatFontSizes[1]).px;
  // 常规与个性化与模型配置同一版式：set-root 自带留白与最大宽度，标题行右侧放常规页的恢复默认。
  if (tab === 'general' || tab === 'persona') {
    return <div className="settings-page is-set-page"><div className="set-root">
      <div className="set-head">
        <div>
          <h1>{current.label}</h1>
          <p>{current.description}</p>
        </div>
        {tab === 'general' && <button className="quiet-btn gn-reset" type="button" onClick={() => void ResetGeneralDefaults()}><Icon name="recovery" size={14} />恢复默认</button>}
      </div>
      {tab === 'general' ? <div className="gn-card">
        <div className="gn-cap">通用</div>
        <div className="gn-row">
          <div className="gn-txt"><span className="gn-t">语言</span><span className="gn-d">界面与系统通知的语言；当前版本界面文案仅提供中文。</span></div>
          <div className="gn-ctl"><Select value={settings.language ?? 'zh'} onChange={(value) => ApplySettings({ language: value as 'zh' | 'en' })} ariaLabel="语言" options={[{ value: 'zh', label: '简体中文' }, { value: 'en', label: 'English' }]} /></div>
        </div>
        <div className="gn-row">
          <div className="gn-txt"><span className="gn-t">启动时打开</span><span className="gn-d">每次打开应用先停在哪里。</span></div>
          <div className="gn-ctl"><Select value={settings.startPage ?? 'last'} onChange={(value) => ApplySettings({ startPage: value as 'last' | 'home' })} ariaLabel="启动时打开" options={[{ value: 'last', label: '恢复上次的对话' }, { value: 'home', label: '打开工作区首页' }]} /></div>
        </div>
        <div className="gn-cap">工作空间</div>
        <div className="gn-row">
          <div className="gn-txt">
            <span className="gn-line"><span className="gn-t">内容存放路径</span>{workspacePath && <span className="gn-path" title={workspacePath}>{workspacePath}</span>}</span>
            <span className="gn-d">对话记录、附件和导出的文件都放在这个目录下；更改会走工作空间迁移流程。</span>
          </div>
          <div className="gn-ctl">
            <button className="icon-btn" type="button" aria-label="打开目录" title="打开目录" onClick={() => void OpenWorkspaceDirectoryHandler()}><Icon name="folder-open" size={16} /></button>
            <button className="quiet-btn" type="button" onClick={() => setShowMigrate(true)}><Icon name="folder-simple" size={15} />更改</button>
          </div>
        </div>
        <div className="gn-cap">通知</div>
        <RenderGeneralSwitch label="任务完成通知" description="长任务跑完后弹一条系统通知，切到别的窗口也不会错过。" checked={settings.notifyOnComplete ?? true} onToggle={() => ApplySettings({ notifyOnComplete: !(settings.notifyOnComplete ?? true) })} />
        <RenderGeneralSwitch label="完成时播放提示音" description="通知出现时带一声轻提示。关掉上面的通知，这一项也不再生效。" checked={settings.notifySound ?? true} disabled={!(settings.notifyOnComplete ?? true)} onToggle={() => ApplySettings({ notifySound: !(settings.notifySound ?? true) })} />
        <div className="gn-cap">更新</div>
        <RenderGeneralSwitch label="自动下载更新" description="检测到新版本就在后台下载，下次启动时装上。" checked={settings.autoUpdate ?? true} onToggle={() => ApplySettings({ autoUpdate: !(settings.autoUpdate ?? true) })} />
        <div className="gn-row">
          <div className="gn-txt"><span className="gn-t">当前版本</span><span className="gn-d">Avery {__APP_VERSION__}</span></div>
          <div className="gn-ctl"><button className="quiet-btn" type="button" onClick={CheckForUpdatesNotice}><Icon name="refresh" size={14} />检查更新</button></div>
        </div>
        <div className="gn-cap">系统</div>
        <RenderGeneralSwitch label="开机时自动启动" description="登录系统后在后台启动，随时可以唤起。" checked={settings.autoLaunch ?? false} onToggle={() => void ToggleAutoLaunch()} />
        <RenderGeneralSwitch label="关闭主窗口时最小化到托盘" description="点关闭按钮不退出应用，正在跑的任务继续。" checked={settings.closeToTray ?? true} onToggle={() => ApplySettings({ closeToTray: !(settings.closeToTray ?? true) })} />
      </div> : <div className="gn-card">
        <div className="gn-cap">头像与昵称</div>
        <div className="gn-row">
          <span className="avatar lg persona-avatar" data-av={settings.avatarStyle ?? 'default'} aria-hidden="true">{settings.avatarImage ? <img src={settings.avatarImage} alt="" /> : InitialOf(settings.nickname)}</span>
          <div className="gn-txt">
            <span className="gn-t">头像</span>
            <span className="gn-d">不上传图片时，用昵称的首个字做默认头像，挑一套底色就行。</span>
          </div>
          <div className="gn-ctl pf-avs">
            {AvatarStyles.map((style) => <button key={style.key} className="av-sw" type="button" data-av={style.key} aria-pressed={style.key === (settings.avatarStyle ?? 'default')} aria-label={style.label} title={style.label} onClick={() => ApplySettings({ avatarStyle: style.key })} />)}
            <button className="quiet-btn" type="button" onClick={() => avatarFileRef.current?.click()}><Icon name="upload-simple" size={14} />上传图片</button>
            {settings.avatarImage ? <button className="quiet-btn" type="button" onClick={() => ApplySettings({ avatarImage: '' })}>移除</button> : null}
          </div>
          <input ref={avatarFileRef} type="file" accept="image/*" className="pf-file" aria-hidden="true" tabIndex={-1} onChange={(event) => { void UploadAvatarHandler(event.target.files?.[0]); event.target.value = ''; }} />
        </div>
        <div className="gn-row">
          <div className="gn-txt">
            <span className="gn-t">昵称</span>
            <span className="gn-d">侧边栏和欢迎页显示的名字，改完即生效。</span>
          </div>
          <div className="gn-ctl"><input className="set-inp pf-name" value={settings.nickname} maxLength={20} spellCheck={false} autoComplete="off" aria-label="昵称" onChange={(event) => ApplySettings({ nickname: event.target.value })} /></div>
        </div>
        <div className="gn-cap">自定义上下文</div>
        <div className="gn-row stack">
          <div className="gn-txt">
            <span className="gn-t">语气与说话方式</span>
            <span className="gn-d">写下希望 Avery 保持的语气、称呼和回答习惯，每次聊天都会带上这段内容。最多 {ContextMax} 字。</span>
          </div>
          <textarea className="set-inp pf-ctx" maxLength={ContextMax} rows={6} aria-label="自定义上下文" placeholder="例如：先给结论，再讲理由，语气像一个熟悉的同事。" value={contextDraft} onChange={(event) => setContextDraft(event.target.value)} onKeyDown={(event) => { if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); CommitContext(); } }} />
          <div className="pf-ctx-foot">
            <span className={`pf-count${contextDraft.length >= ContextMax ? ' full' : ''}`}>{contextDraft.length} / {ContextMax}</span>
            <span className={`pf-state${contextDirty ? ' dirty' : ''}`}>{contextDirty ? '有改动还没保存' : '已保存'}</span>
            <button className="pf-save" type="button" disabled={!contextDirty} onClick={CommitContext}>保存</button>
          </div>
        </div>
        <div className="gn-cap">外观</div>
        <div className="gn-row">
          <div className="gn-txt"><span className="gn-t">字号大小</span><span className="gn-d">对话里 Avery 回复的字号，选完下面的预览跟着变。</span></div>
          <div className="gn-ctl">
            <div className="seg pf-seg" role="radiogroup" aria-label="字号大小">
              {ChatFontSizes.map((size) => <button key={size.key} className={`seg-i${size.key === (settings.chatFontSize ?? 'md') ? ' sel' : ''}`} type="button" role="radio" aria-checked={size.key === (settings.chatFontSize ?? 'md')} aria-label={size.label} onClick={() => ApplySettings({ chatFontSize: size.key })}>{size.label}</button>)}
            </div>
          </div>
        </div>
        <div className="gn-preview" style={{ '--gp-fs': `${replyFontSizePx}px` } as CSSProperties}>
          <div className="gp-head"><span className="lb">预览</span><span className="gp-size">{replyFontSizePx}px</span></div>
          <div className="gp-msg">
            <span className="avatar" aria-hidden="true">{InitialOf(settings.nickname)}</span>
            <p>我把这份简历的实习经历按时间倒序重排了一遍，删掉了两处重复的描述。要我再压到一页吗？</p>
          </div>
        </div>
        <div className="gn-row">
          <div className="gn-txt"><span className="gn-t">主题颜色</span><span className="gn-d">按钮和强调色跟着变；真实换肤暂未接入，先记录你的选择。</span></div>
          <div className="gn-ctl pf-accs">
            {AccentColors.map((color) => <button key={color.key} className="acc-sw" type="button" style={{ background: color.hex }} aria-pressed={color.key === (settings.accentColor ?? 'pine')} aria-label={color.label} title={color.label} onClick={() => ApplySettings({ accentColor: color.key })} />)}
          </div>
        </div>
        <div className="gn-row">
          <div className="gn-txt"><span className="gn-t">简历模板</span><span className="gn-d">Avery 改简历时用的版式；模板渲染暂未接入，先记录你的选择。</span></div>
          <div className="gn-ctl"><Select value={settings.resumeTemplate ?? 'classic'} onChange={(value) => ApplySettings({ resumeTemplate: value as NonNullable<SettingsDraft['resumeTemplate']> })} ariaLabel="简历模板" dropUp options={ResumeTemplates.map((item) => ({ value: item.key, label: item.label }))} /></div>
        </div>
      </div>}
      {/* 迁移确认弹窗跟着常规页渲染：触发按钮在常规页的工作空间行，此前被留在旧版最终 return 里导致点「更改」无响应。 */}
      <Modal
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
    </div>{RenderLeaveDialog()}</div>;
  }
  if (tab === 'browser') {
    // 可选项只剩 Chrome/Edge；electron 只可能短暂存在于迁移 effect 生效前，这里统一按 Edge 兜底。
    const engine = settings.browserEngine === 'chrome' ? 'chrome' : 'edge';
    const engineLabel = BrowserEngineLabels[engine];
    // 未连接时告诉用户如何建立连接（原型 statusDesc 的 need 文案，按扩展模型改写）。
    const needCopy = `在 ${engineLabel} 里加载 Avery Browser 扩展，再点击“检测状态”；Avery 只操作自己创建的任务标签页，不读取其他个人页面，关闭任务也不会关闭浏览器。`;
    let statusCopy: string;
    let pill: 'busy' | 'on' | 'off' | 'undetected';
    if (browserRuntimeBusy) { statusCopy = `正在连接 ${engineLabel}，完成扩展配对前不会操作任何页面。`; pill = 'busy'; }
    else if (!browserRuntime) { statusCopy = `还没有检测过。${needCopy}`; pill = 'undetected'; }
    else if (browserRuntime.running) { statusCopy = `已连接。${browserRuntime.message || browserRuntime.currentUrl || `已经连上 ${BrowserEngineLabels[browserRuntime.engine]}，可以接管任务标签页。`}`; pill = 'on'; }
    else if (browserRuntime.state === 'not_installed') { statusCopy = `没有连上。${BrowserEngineLabels[browserRuntime.engine]} 未安装或无法启动。`; pill = 'off'; }
    else if (browserRuntime.state === 'unhealthy') { statusCopy = `连接异常。${browserRuntime.message || '可以再检测一次。'}`; pill = 'off'; }
    else { statusCopy = `还没有连接。${browserRuntime.message || needCopy}`; pill = 'off'; }
    const pillClass = pill === 'on' ? 'on' : pill === 'busy' ? 'busy' : 'off';
    const pillText = pill === 'busy' ? '检测中' : pill === 'on' ? '已连接' : pill === 'undetected' ? '未检测' : '未连接';
    return <div className="settings-page is-set-page"><div className="set-root">
      <div className="set-head"><div><h1>浏览器控制</h1><p>连接日常使用的 Chrome 或 Edge，查看连接状态，管理隔离浏览器留下的数据。</p></div></div>
      <div className="gn-card">
        <div className="gn-cap">浏览器</div>
        <div className="gn-row">
          <div className="gn-txt"><span className="gn-t">使用的浏览器</span><span className="gn-d">执行网页任务时打开哪一个，切换后立刻生效。</span></div>
          <div className="gn-ctl"><Select value={engine} onChange={(value) => {
            // 切换引擎后旧状态不再代表当前选择：作废在途刷新并把状态复位为未检测。
            browserRuntimeRequest.current += 1;
            ApplySettings({ browserEngine: value as 'chrome' | 'edge' });
            setBrowserRuntime(null);
          }} ariaLabel="使用的浏览器" options={(['chrome', 'edge'] as const).map((value) => ({ value, label: BrowserEngineLabels[value] }))} /></div>
        </div>
        <div className="gn-row">
          <div className="gn-txt"><span className="gn-t">连接状态</span><span className="gn-d">{statusCopy}</span></div>
          <div className="gn-ctl">
            <span className={`pill ${pillClass}`}>{pill === 'busy' && <Icon name="loading" size={13} />}{pillText}</span>
            <button className="quiet-btn" type="button" disabled={browserRuntimeBusy} onClick={() => void RefreshBrowserRuntime(true)}><Icon name="plugs-connected" size={14} />检测状态</button>
          </div>
        </div>
        <div className="gn-cap">隔离浏览器数据</div>
        <div className="bw-hint"><Icon name="info" size={14} /><span>下面的清理只作用于 Avery 隔离浏览器留下的数据，和当前选用的浏览器没有关系。</span></div>
        <div className="gn-row">
          <div className="gn-txt"><span className="gn-t">登录数据</span><span className="gn-d">Cookie、站点存储和登录状态保存在 Avery 专用 Profile 中；清除后不会影响你的个人浏览器数据。</span></div>
          <div className="gn-ctl"><button className="quiet-btn danger" type="button" disabled={browserRuntimeBusy || !browserRuntime?.profileExists} onClick={() => setShowClearBrowserProfile(true)}><Icon name="trash-simple" size={14} />清除登录数据</button></div>
        </div>
        <div className="gn-cap">行为</div>
        <RenderGeneralSwitch label="任务结束后自动关闭标签页" description="Avery 自己打开的标签页在任务结束时关掉，你自己开的窗口不动；真实关闭策略暂未接入，先记录你的选择。" checked={settings.closeTaskTabs ?? true} onToggle={() => ApplySettings({ closeTaskTabs: !(settings.closeTaskTabs ?? true) })} />
      </div>
      <div className="gn-card">
        <div className="gn-cap">定时任务授权</div>
        <div className="gn-row stack">
          <div className="gn-txt"><span className="gn-t">投递定时任务的浏览器授权</span><span className="gn-d">创建投递场景定时任务时，确认弹窗会同时授予该任务个人浏览器权限。到期后 Avery 可在后台启动浏览器并创建任务标签页；BOSS 或企业官网登录失效、验证码或站点风控仍会暂停任务。</span></div>
          <div className="gn-ctl">
            <Select value={cronBrowserTaskId} onChange={setCronBrowserTaskId} ariaLabel="查看投递定时任务授权" options={cronBrowserAccess?.tasks.length ? cronBrowserAccess.tasks.map((task) => ({ value: task.id, label: `${task.browserAuthorized ? '已授权' : '未授权'} · ${task.title}` })) : [{ value: '', label: '暂无活动的投递定时任务' }]} />
            {cronBrowserAccess?.tasks.find((task) => task.id === cronBrowserTaskId)?.browserAuthorized && <button className="quiet-btn danger" type="button" disabled={browserRuntimeBusy} onClick={() => void RevokeCronBrowserAccessHandler()}>撤销该任务授权</button>}
          </div>
        </div>
      </div>
      <Modal
        open={showClearBrowserProfile}
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
    </div></div>;
  }
  if (tab === 'api') return <div className="settings-page is-model-set">{RenderModelConfiguration()}{RenderLeaveDialog()}</div>;
  if (tab === 'developer') {
    return <div className="settings-page is-set-page"><div className="set-root">
      <div className="set-head"><div><h1>开发者模式</h1><p>查看本地日志、Trace 和上下文用量界面。</p></div></div>
      <div className="gn-card">
        <div className="gn-cap">开发者工具</div>
        <RenderGeneralSwitch label="启用开发者模式" description="开启后在侧边栏显示本地开发者工具。" checked={settings.developerMode} onToggle={() => ApplySettings({ developerMode: !settings.developerMode })} />
        <div className="gn-row">
          <div className="gn-txt"><span className="gn-t">打开开发者工具</span><span className="gn-d">查看本地日志、Trace 轨迹与上下文用量界面。</span></div>
          <div className="gn-ctl"><button className="quiet-btn" type="button" disabled={!settings.developerMode} onClick={onNavigateDeveloper}><Icon name="developer-mode" size={14} />打开</button></div>
        </div>
        <div className="gn-cap">Trace 与上下文</div>
        <div className="bw-hint"><Icon name="info" size={14} /><span>真实 Trace 可能包含简历、JD 与附件片段，仅保存在本机；关闭开发者模式后不再新增 Trace。</span></div>
        <div className="gn-row">
          <div className="gn-txt"><span className="gn-t">Trace 保留数量</span><span className="gn-d">默认 50，最多保留 100 条本地 Trace，失焦或回车保存。</span></div>
          <div className="gn-ctl"><input className="gn-num" type="number" min="1" max="100" value={traceDraft} aria-label="Trace 保留数量" onChange={(event) => setTraceDraft(event.target.value)} onBlur={() => void CommitTraceRetention()} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); void CommitTraceRetention(); } }} /></div>
        </div>
        <div className="gn-row">
          <div className="gn-txt"><span className="gn-t">自动压缩阈值</span><span className="gn-d">按 System、Tools 和 Messages 的完整输入计算，只能配置为 1–80 的整数。</span></div>
          <div className="gn-ctl"><div className="gn-num-wrap"><input className="gn-num" type="number" min="1" max="80" value={thresholdDraft} aria-label="自动压缩阈值" onChange={(event) => setThresholdDraft(event.target.value)} onBlur={CommitCompressionThreshold} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); CommitCompressionThreshold(); } }} /><span className="gn-num-suffix">%</span></div></div>
        </div>
        <div className="gn-cap">本地模块</div>
        <div className="gn-row stack">
          <div className="gn-txt"><span className="gn-t">本地模块目录</span><span className="gn-d">{moduleConfiguration?.status === 'active' ? `已启用：${moduleConfiguration.directoryName ?? '已选择目录'}。模块仅在启动会话前校验。` : '当前使用官方默认模块。选择本地模块目录前，请确认其来源可信。'}</span></div>
          <div className="gn-ctl">
            <button className="quiet-btn" type="button" disabled={updatingModules} onClick={() => void SelectUserModules()}><Icon name="folder-open" size={14} />{updatingModules ? '处理中…' : '选择本地模块'}</button>
            <button className="quiet-btn danger" type="button" disabled={updatingModules || moduleConfiguration?.status !== 'active'} onClick={() => setShowResetModules(true)}>恢复官方默认模块</button>
          </div>
        </div>
        <div className="gn-cap">危险操作</div>
        <div className="gn-row">
          <div className="gn-txt"><span className="gn-t">清空 Trace</span><span className="gn-d">删除所有本地 Trace，不可撤销。</span></div>
          <div className="gn-ctl"><button className="quiet-btn danger" type="button" onClick={() => setShowClear(true)}><Icon name="trash-simple" size={14} />一键清空</button></div>
        </div>
      </div>
      <Modal
        open={showResetModules}
        title="恢复官方默认模块？"
        onClose={() => setShowResetModules(false)}
        footer={<>
          <DialogButton onClick={() => setShowResetModules(false)}>取消</DialogButton>
          <DialogButton tone="danger" disabled={updatingModules} onClick={() => void ConfirmResetModules()}>确认恢复默认</DialogButton>
        </>}
      >
        当前本地模块配置将被移除，后续新会话将使用内置模块。运行中的助手任务不会被中断。
      </Modal>
      <Modal
        open={showClear}
        title="确认清空全部 Trace？"
        onClose={() => setShowClear(false)}
        footer={<>
          <DialogButton onClick={() => setShowClear(false)}>取消</DialogButton>
          <DialogButton tone="danger" onClick={() => void ClearDeveloperObservability()}>确认清空</DialogButton>
        </>}
      >
        将删除本地全部运行日志、Trace 索引和事件。此操作不可撤销。
      </Modal>
    </div></div>;
  }
  // 页签是封闭联合，全部在前置分支返回；走到这里说明状态异常，不渲染内容。
  return null;
}

export { SettingsPage };
