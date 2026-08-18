import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useUiStore } from '../../../app/UiStore';
import { useSettingsStore } from '../../../features/settings/api/settingsQueries';
import { ClearAgentObservability, ConfigureAgent, GetAgentModuleConfiguration, GetDeepSeekModels, IsDesktopAgentAvailable, ResetAgentModules, SelectAgentModuleDirectory, SetAgentTraceRetention, TestAgentConnection } from '../../../features/assistant/api/agentQueries';
import { CreateWorkspaceBackup, MigrateWorkspace } from '../../../features/workspace/api/workspaceActions';
import { WORKSPACE_QUERY_KEY } from '../../../features/workspace/api/workspaceData';
import { Button, FormField, Modal, PageHeader } from '../../../shared/components/UI';
import type { SettingsDraft } from '../../../types/domain';
import type { AgentModuleConfiguration } from '@offerget/contracts';

type SettingTab = 'account' | 'workspace' | 'api' | 'developer';
type FieldErrors = Partial<Record<'traceRetention' | 'compressionThreshold', string>>;
const Tabs: Array<{ id: SettingTab; label: string; description: string }> = [
  { id: 'account', label: '账户', description: '管理应用内的显示名称。' },
  { id: 'workspace', label: '工作空间', description: '管理档案、简历版本和导出文件的存放目录。' },
  { id: 'api', label: 'API 配置', description: '配置模型服务；测试连接不会保存，保存后凭据加密存储在本机。' },
  { id: 'developer', label: '开发者模式', description: '查看本地日志、Trace 和上下文用量界面。' },
];
const FallbackDeepSeekModels = ['deepseek-v4-flash', 'deepseek-v4-pro'];

function UpgradeDeepSeekSettings(settings: SettingsDraft): SettingsDraft {
  if (settings.provider !== 'DeepSeek' || (settings.model !== 'deepseek-chat' && settings.model !== 'deepseek-reasoner')) return settings;
  return { ...settings, model: 'deepseek-v4-flash' };
}

function SettingsPage({ onNavigateDeveloper }: { onNavigateDeveloper: () => void }) {
  const { ShowNotice } = useUiStore();
  const queryClient = useQueryClient();
  const { settings, setSettings } = useSettingsStore();
  const [tab, setTab] = useState<SettingTab>('account');
  const [draft, setDraft] = useState<SettingsDraft>(() => UpgradeDeepSeekSettings(settings));
  const [deepSeekModels, setDeepSeekModels] = useState<string[]>(FallbackDeepSeekModels);
  const [refreshingModels, setRefreshingModels] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [showLeave, setShowLeave] = useState(false);
  const [nextTab, setNextTab] = useState<SettingTab | null>(null);
  const [showClear, setShowClear] = useState(false);
  const [showMigrate, setShowMigrate] = useState(false);
  const [showResetModules, setShowResetModules] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [moduleConfiguration, setModuleConfiguration] = useState<AgentModuleConfiguration | null>(null);
  const [updatingModules, setUpdatingModules] = useState(false);
  useEffect(() => { setDraft(UpgradeDeepSeekSettings(settings)); }, [settings]);
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
    if (tab === 'developer' && IsDesktopAgentAvailable()) void RefreshModuleConfiguration();
  }, [tab]);
  function UpdateDraft(patch: Partial<SettingsDraft>) {
    setDraft((current) => ({ ...current, ...patch }));
    if (patch.traceRetention !== undefined || patch.compressionThreshold !== undefined) setFieldErrors((current) => ({ ...current, ...(patch.traceRetention !== undefined ? { traceRetention: undefined } : {}), ...(patch.compressionThreshold !== undefined ? { compressionThreshold: undefined } : {}) }));
    setDirty(true);
  }
  async function SaveSettings() {
    const nextErrors: FieldErrors = {};
    if (draft.compressionThreshold < 1 || draft.compressionThreshold > 80 || !Number.isInteger(draft.compressionThreshold)) nextErrors.compressionThreshold = '请输入 1–80 之间的整数。';
    if (draft.traceRetention < 1 || draft.traceRetention > 100 || !Number.isInteger(draft.traceRetention)) nextErrors.traceRetention = '请输入 1–100 之间的整数。';
    setFieldErrors(nextErrors);
    if (Object.keys(nextErrors).length) { ShowNotice('请修正标记的设置项后再保存'); return false; }
    if (tab === 'api' && IsDesktopAgentAvailable()) {
      try {
        await ConfigureAgent({ provider: draft.provider, apiKey: draft.apiKey, baseUrl: draft.baseUrl, model: draft.model, thinkingEnabled: draft.thinkingEnabled, contextLength: draft.contextLength, compressionThreshold: draft.compressionThreshold });
      } catch (error) {
        ShowNotice(error instanceof Error ? error.message : 'API 配置保存失败');
        return false;
      }
    }
    if (tab === 'developer' && IsDesktopAgentAvailable()) {
      try {
        await SetAgentTraceRetention(draft.traceRetention);
      } catch (error) {
        ShowNotice(error instanceof Error ? error.message : 'Trace 留存设置保存失败');
        return false;
      }
    }
    // API Key 只保留在当前表单内存与主进程 safeStorage，不能写入全局工作空间缓存。
    const { apiKey: _apiKey, ...safeDraft } = draft;
    setSettings(() => ({ ...safeDraft, apiKey: '' })); setDirty(false); setFieldErrors({}); ShowNotice(tab === 'api' ? 'API 配置已加密保存到桌面端' : '设置已保存');
    return true;
  }
  function SwitchTab(target: SettingTab) { if (!dirty) { setTab(target); return; } setNextTab(target); setShowLeave(true); }
  function DiscardAndSwitch() { if (!nextTab) return; setDraft(UpgradeDeepSeekSettings(settings)); setDirty(false); setTab(nextTab); setNextTab(null); setShowLeave(false); }
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
      await TestAgentConnection({ provider: draft.provider, apiKey: draft.apiKey, baseUrl: draft.baseUrl, model: draft.model, thinkingEnabled: draft.thinkingEnabled, contextLength: draft.contextLength, compressionThreshold: draft.compressionThreshold });
      ShowNotice('API 连接测试成功，配置尚未保存');
    } catch (error) {
      ShowNotice(error instanceof Error ? error.message : 'API 连接测试失败');
    }
  }
  async function RefreshModuleConfiguration() {
    try { setModuleConfiguration(await GetAgentModuleConfiguration()); } catch { setModuleConfiguration(null); }
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
  const current = Tabs.find((item) => item.id === tab)!;
  return <div className="settings-page"><aside className="settings-nav"><div><p className="eyebrow">设置</p><h1>应用设置</h1></div>{Tabs.map((item) => <button key={item.id} className={tab === item.id ? 'selected' : ''} onClick={() => SwitchTab(item.id)}>{item.label}</button>)}</aside><section className="settings-content"><PageHeader eyebrow="设置" title={current.label} description={current.description} actions={tab !== 'api' ? <Button variant="primary" onClick={() => void SaveSettings()}>保存更改</Button> : undefined} />
    {tab === 'developer' && <><div className="setting-note module-settings"><b>本地模块</b><p>{moduleConfiguration?.status === 'active' ? `已启用：${moduleConfiguration.directoryName ?? '已选择目录'}。模块仅在启动会话前校验。` : '当前使用官方默认模块。选择本地模块目录前，请确认其来源可信。'}</p><div className="api-actions"><Button disabled={updatingModules} onClick={() => void SelectUserModules()}>{updatingModules ? '处理中…' : '选择本地模块'}</Button><Button variant="danger" disabled={updatingModules || moduleConfiguration?.status !== 'active'} onClick={() => setShowResetModules(true)}>恢复官方默认模块</Button></div></div><Modal open={showResetModules} title="恢复官方默认模块？" onClose={() => setShowResetModules(false)}><p className="modal-copy">当前本地模块配置将被移除，后续新会话将使用内置模块。运行中的助手任务不会被中断。</p><div className="modal-actions"><Button onClick={() => setShowResetModules(false)}>取消</Button><Button variant="danger" disabled={updatingModules} onClick={() => void ConfirmResetModules()}>确认恢复默认</Button></div></Modal></>}
    {tab === 'account' && <div className="settings-panel"><FormField label="账户昵称"><input value={draft.nickname} onChange={(event) => UpdateDraft({ nickname: event.target.value })} /><small>将显示在侧边栏与欢迎页面中。</small></FormField><FormField label="会话自定义上下文"><textarea rows={6} value={draft.customContext ?? ''} onChange={(event) => UpdateDraft({ customContext: event.target.value })} placeholder="例如：我偏好简洁直白的表达，简历经历需包含量化成果…" /><small>该上下文将注入每个 OfferGet 会话，不会读取你开发项目目录中的规则文档。</small></FormField></div>}
    {tab === 'workspace' && <div className="settings-panel"><FormField label="当前工作空间"><input value={draft.workspaceName ?? ''} readOnly disabled /><small>工作空间目录由本地服务管理；迁移时通过下方按钮选择目标空目录。</small></FormField><div className="setting-note"><b>迁移说明</b><p>迁移会复制数据库、档案、附件、导出和备份文件，校验后切换到目标空目录；原目录不会删除。Agent 运行中不可迁移。</p><Button onClick={() => setShowMigrate(true)}>迁移工作空间</Button></div><div className="setting-note"><b>本地备份</b><p>立即备份数据库与档案文件；系统仅保留最近 7 份每日备份。</p><Button onClick={() => void CreateWorkspaceBackupHandler()}>立即创建备份</Button></div></div>}
    {tab === 'api' && <div className="settings-panel api-panel"><div className="segmented"><button className={draft.provider === 'DeepSeek' ? 'selected' : ''} onClick={() => UpdateDraft({ provider: 'DeepSeek', model: draft.model === 'deepseek-chat' || draft.model === 'deepseek-reasoner' ? 'deepseek-v4-flash' : draft.model })}>DeepSeek</button><button className={draft.provider === '自定义' ? 'selected' : ''} onClick={() => UpdateDraft({ provider: '自定义' })}>自定义</button></div><FormField label="API Key"><input type="password" value={draft.apiKey} onChange={(event) => UpdateDraft({ apiKey: event.target.value })} /></FormField>{draft.provider === 'DeepSeek' ? <><FormField label="可用模型" hint="从 DeepSeek 官方接口同步，未配置凭据时使用当前 V4 默认模型。"><div className="model-select-row"><select value={draft.model} onChange={(event) => UpdateDraft({ model: event.target.value })}>{[...new Set([draft.model, ...deepSeekModels])].map((model) => <option key={model} value={model}>{model}</option>)}</select><Button variant="quiet" disabled={refreshingModels} onClick={() => void RefreshDeepSeekModels(true)}>{refreshingModels ? '同步中…' : '刷新模型'}</Button></div></FormField><label className="switch-line"><span><b>思考模式</b><small>开启后，助手回复会展示可折叠的思考内容。</small></span><input type="checkbox" checked={draft.thinkingEnabled} onChange={(event) => UpdateDraft({ thinkingEnabled: event.target.checked })} /></label></> : <><FormField label="Base URL"><input value={draft.baseUrl} onChange={(event) => UpdateDraft({ baseUrl: event.target.value })} /></FormField><FormField label="模型名称"><input value={draft.model} onChange={(event) => UpdateDraft({ model: event.target.value })} /></FormField><FormField label="上下文长度"><input value={draft.contextLength} onChange={(event) => UpdateDraft({ contextLength: event.target.value })} /></FormField></>}<div className="api-actions"><Button onClick={() => void TestApiConnection()}>测试连接</Button><Button variant="primary" onClick={() => void SaveSettings()}>保存配置</Button></div></div>}
    {tab === 'developer' && <div className="settings-panel developer-settings"><label className="switch-line"><span><b>启用开发者模式</b><small>开启后在侧边栏显示本地开发者工具。</small></span><input type="checkbox" checked={draft.developerMode} onChange={(event) => UpdateDraft({ developerMode: event.target.checked })} /></label><FormField label="Trace 保留数量" hint="默认 50，最多保留 100 条本地 Trace。"><input type="number" min="1" max="100" value={draft.traceRetention} aria-invalid={Boolean(fieldErrors.traceRetention)} aria-describedby={fieldErrors.traceRetention ? 'trace-retention-error' : undefined} onChange={(event) => UpdateDraft({ traceRetention: Number(event.target.value) })} />{fieldErrors.traceRetention && <small className="field-error" id="trace-retention-error" role="alert">{fieldErrors.traceRetention}</small>}</FormField><FormField label="自动压缩阈值"><div className="input-suffix"><input type="number" min="1" max="80" value={draft.compressionThreshold} aria-invalid={Boolean(fieldErrors.compressionThreshold)} aria-describedby={fieldErrors.compressionThreshold ? 'compression-threshold-error' : undefined} onChange={(event) => UpdateDraft({ compressionThreshold: Number(event.target.value) })} /><span>%</span></div>{fieldErrors.compressionThreshold && <small className="field-error" id="compression-threshold-error" role="alert">{fieldErrors.compressionThreshold}</small>}<small>按 System、Tools 和 Messages 的完整输入计算；只能配置为 1–80 的整数。</small></FormField><div className="setting-note"><b>Trace 隐私提示</b><p>真实 Trace 可能包含简历、JD 与附件片段，仅保存在本机；关闭开发者模式后不再新增 Trace。</p></div><div className="danger-zone"><div><b>清空 Trace</b><p>删除所有本地 Trace，不可撤销。</p></div><Button variant="danger" onClick={() => setShowClear(true)}>一键清空</Button></div>{draft.developerMode && <Button onClick={onNavigateDeveloper}>打开开发者工具</Button>}</div>}
  </section><Modal open={showLeave} title="存在未保存的修改" onClose={() => setShowLeave(false)}><p className="modal-copy">切换设置项前，请选择如何处理当前修改。</p><div className="modal-actions"><Button onClick={() => setShowLeave(false)}>继续编辑</Button><Button onClick={DiscardAndSwitch}>放弃修改</Button><Button variant="primary" onClick={async () => { if (await SaveSettings() && nextTab) setTab(nextTab); setNextTab(null); setShowLeave(false); }}>保存并切换</Button></div></Modal><Modal open={showClear} title="确认清空全部 Trace？" onClose={() => setShowClear(false)}><p className="modal-copy">将删除本地全部运行日志、Trace 索引和事件。此操作不可撤销。</p><div className="modal-actions"><Button onClick={() => setShowClear(false)}>取消</Button><Button variant="danger" onClick={() => void ClearDeveloperObservability()}>确认清空</Button></div></Modal><Modal open={showMigrate} title="确认迁移工作空间？" onClose={() => setShowMigrate(false)}><p className="modal-copy">将复制并校验数据后切换到目标空目录，原工作空间会保留。Agent 运行期间无法迁移。</p><div className="modal-actions"><Button onClick={() => setShowMigrate(false)}>取消</Button><Button variant="primary" onClick={() => void MigrateWorkspaceHandler()}>确认迁移</Button></div></Modal>
  </div>;
}

export { SettingsPage };
