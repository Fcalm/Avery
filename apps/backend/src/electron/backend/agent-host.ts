import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { RunAgentLoop, ScrubTraceContent } from '@avery/agent-core';
import { CreateRunSnapshot, ResolveModules } from '@avery/agent-module-host';
import { ApplicationScenario, BuildApplicationCompiledInstructions, BuildDefaultCompiledInstructions, CreateDefaultModules, DefaultScenario } from '@avery/agent-modules-defaults';
import type { AgentMessage, AgentModules, BrowserAutomationPort, CompiledInstructions, ConfirmationMode, ProviderUsageFact, ReasoningEffort, ScenarioSnapshot, SkillSnapshot } from '@avery/agent-sdk';
import { AgentFileReader } from './agent-file-reader';
import { AgentResumePort } from './agent-resume-port';
import { ResumeLockStore } from './resume-lock-store';
import { CreateVisionUserMessage, HydrateVisionMessage, SupportsVisionInput } from './vision-input';
import { AgentBrowserRuntime } from './agent-browser-runtime';
import { AgentSkillRegistry } from './agent-skill-registry';
import { CreateCronTaskSchema } from '@avery/contracts';

/** 用户编辑锁的稳定 ownerId；前端经 bridge 加解锁都以此为准。 */
const UserLockOwnerId = 'user-main';
const SessionSnapshotTtlMs = 24 * 60 * 60 * 1000;
const RuntimeTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

/** 兼容迁移旧版中文权限值；所有新运行统一使用稳定的英文枚举。 */
function NormalizeConfirmationMode(value: unknown): ConfirmationMode {
  if (value === 'always_confirm' || value === 'allow_low_risk' || value === 'fully_trusted') return value;
  if (value === '无需确认') return 'fully_trusted';
  return 'always_confirm';
}

/** 只接受前端公开的五档会话值；旧快照或非法 IPC 输入回退中档。 */
function NormalizeReasoningEffort(value: unknown): ReasoningEffort {
  return value === 'low' || value === 'medium' || value === 'high' || value === 'xhigh' || value === 'max' ? value : 'medium';
}

function ResolveScenario(value: unknown) {
  if (value === 'application') return ApplicationScenario;
  if (value === undefined || value === null || value === '' || value === 'default') return DefaultScenario;
  throw Object.assign(new Error('Scenario is invalid.'), { code: 'VALIDATION_ERROR' });
}

function NormalizeProjectBinding(value: unknown): any {
  if (typeof value === 'string' && value) return { rootPath: value, projectId: null, name: path.basename(value) };
  if (!value || typeof value !== 'object') return null;
  const objectValue = value as { rootPath?: unknown; path?: unknown; projectId?: unknown; name?: unknown };
  const rootPath = typeof objectValue.rootPath === 'string' ? objectValue.rootPath : typeof objectValue.path === 'string' ? objectValue.path : '';
  if (!rootPath) return null;
  return {
    rootPath,
    projectId: typeof objectValue.projectId === 'string' ? objectValue.projectId : null,
    name: typeof objectValue.name === 'string' && objectValue.name ? objectValue.name.slice(0, 200) : path.basename(rootPath),
  };
}

/** 读取持久化 usage 时只保留已校验的会话事实；旧估算数据绝不标记为真实。 */
function NormalizeSessionUsage(value: unknown): any {
  if (!value || typeof value !== 'object') return null;
  const objectValue = value as Record<string, unknown>;
  const number = (field: string): number => Number.isSafeInteger(objectValue[field]) && (objectValue[field] as number) >= 0 ? objectValue[field] as number : 0;
  const source = ['actual', 'unavailable', 'legacy_estimate'].includes(objectValue.source as string) ? objectValue.source as string : 'legacy_estimate';
  return {
    source,
    inputTokens: number('inputTokens'), contextLimit: number('contextLimit'), compressionCount: number('compressionCount'), compressionThreshold: number('compressionThreshold'),
    promptTokens: number('promptTokens'), completionTokens: number('completionTokens'), totalTokens: number('totalTokens'), reportedRequestCount: number('reportedRequestCount'), unreportedRequestCount: number('unreportedRequestCount'), updatedAt: number('updatedAt'),
  };
}

/** 会话级助手偏好不含凭据；模型仅保存可公开的 Provider 模型 ID。 */
interface SessionAssistantState {
  model: string;
  confirmationMode: ConfirmationMode;
  reasoningEffort: ReasoningEffort;
}

function NormalizeSessionAssistantState(value: unknown): SessionAssistantState | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as { model?: unknown; confirmationMode?: unknown; reasoningEffort?: unknown };
  if (typeof candidate.model !== 'string') return null;
  const model = candidate.model.trim();
  if (!model || model.length > 200) return null;
  return { model, confirmationMode: NormalizeConfirmationMode(candidate.confirmationMode), reasoningEffort: NormalizeReasoningEffort(candidate.reasoningEffort) };
}

/** 校验字符串字段，避免 IPC 输入直接进入请求层。 */
function RequireString(value: unknown, field: string, maxLength = 20000): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maxLength) throw new Error(`${field} is invalid.`);
  return value.trim();
}

/** 逐事件 token 仅用于开发者 Trace 的量级观察，不替代 Provider 最终账单。 */
function EstimateTraceTokens(value: unknown): number {
  const text = String(value ?? '');
  if (!text) return 0;
  let units = 0;
  for (const character of text) units += /[\u3400-\u9fff\uf900-\ufaff]/.test(character) ? 1 : 0.25;
  return Math.max(1, Math.ceil(units));
}

type AgentHostBrowserRuntime = BrowserAutomationPort & {
  Close(): Promise<void>;
  ResetPageReferences(): void;
  GetStatus(): Promise<unknown>;
  ClearProfile(): Promise<unknown>;
};

export interface AgentHostOptions {
  userDataPath: string;
  workspacePath: string;
  Emit(event: unknown): void;
  business: any;
  observability: any;
  credentialPort: any;
  resolveProjectEnvironment?: (projectId: string) => Promise<unknown> | unknown;
  resumeLockStore?: ResumeLockStore;
  agentBrowserExecutablePath?: string;
  browserCompanionExecutablePath?: string;
  browserCompanionAppPath?: string;
  /** 构造期 Skill 固定目录测试接缝；生产环境使用应用内置 skills 目录。 */
  skillRootPath?: string;
  /** 构造期测试接缝；生产组合根不传入，不能由 Renderer、IPC 或环境变量选择。 */
  createDefaultModules?: (ports: Parameters<typeof CreateDefaultModules>[0]) => AgentModules;
  /** 构造期测试接缝；用于完整链路测试连接精确本地 fixture origin。 */
  browserRuntime?: AgentHostBrowserRuntime;
  /** 测评宿主专用接缝：生产组合根不传入，候选 Prompt 只能在隔离 AgentHost 内生效。 */
  compileInstructions?: (scenarioId: 'default' | 'application', toolPolicyHash: string) => CompiledInstructions;
  /** 测评宿主专用冻结场景；可收窄工具和轮数，不能由生产 Renderer 请求设置。 */
  scenarioOverride?: ScenarioSnapshot;
  /** Cron 数据写入后的 OS 唤醒同步由 Backend 组合根提供。 */
  onCronScheduleChanged?: () => Promise<void> | void;
}

/**
 * Agent 宿主组合根：替代 agent-runtime.cjs。
 * 持有配置凭据、会话/任务/项目环境内存态与快照持久化；Send 委托 agent-core RunAgentLoop，
 * 六槽默认实现由 defaults 包提供、经 module-host ResolveModules 校验装配。
 */
export class AgentHost {
  private statePath: string;
  private moduleConfigPath: string;
  private Emit: (event: unknown) => void;
  private business: any;
  private observabilityPort: any;
  private credentialPort: any;
  private resolveProjectEnvironment: (projectId: string) => Promise<unknown> | unknown;
  private controllers = new Map<string, AbortController>();
  private runtimeControls = new Map<string, { sessionId: string; confirmationMode: ConfirmationMode; toolContext: any }>();
  private histories = new Map<string, any[]>();
  private tasks = new Map<string, Map<string, any>>();
  private pendingQuestions = new Map<string, unknown>();
  private pendingEdits = new Map<string, unknown>();
  private pendingBrowserActions = new Map<string, any>();
  private pendingCronTasks = new Map<string, any>();
  private browserRunId: string | null = null;
  private toolLedger = new Map<string, any>();
  private projectEnvironments = new Map<string, any>();
  private sessionSnapshots = new Map<string, any>();
  private runSnapshots = new Map<string, any>();
  private sessionUsage = new Map<string, any>();
  private sessionScenarios = new Map<string, 'default' | 'application'>();
  private sessionAssistantStates = new Map<string, SessionAssistantState>();
  private loadedSkills = new Map<string, Map<string, string>>();
  private loadedSkillResources = new Map<string, Set<string>>();
  private lastContextUsage: { inputTokens: number; contextLimit: number } = { inputTokens: 0, contextLimit: 256000 };
  private compressionCount = 0;
  private fileReader: AgentFileReader;
  private resumePort: AgentResumePort;
  private resumeReadPort: AgentResumePort;
  private resumeWritePort: AgentResumePort;
  private browserRuntime: AgentHostBrowserRuntime;
  private createDefaultModules: (ports: Parameters<typeof CreateDefaultModules>[0]) => AgentModules;
  private moduleError: string | null = null;
  private moduleConfiguration: any = { enabled: false, trusted: false, status: 'default', directoryName: null, modules: [] };
  private moduleSnapshot: any = null;
  private modules: any;
  private compileInstructions: (scenarioId: 'default' | 'application', toolPolicyHash: string) => CompiledInstructions;
  private scenarioOverride?: ScenarioSnapshot;
  private skillRegistry: AgentSkillRegistry;
  private onCronScheduleChanged: () => Promise<void> | void;
  private scheduledRequestIds = new Set<string>();
  private scheduledOutput = new Map<string, { content: string; thinkingContent: string; terminal?: string; needsAttention: boolean }>();

  constructor(options: AgentHostOptions) {
    this.statePath = path.join(options.userDataPath, 'agent-state.json');
    this.moduleConfigPath = path.join(options.userDataPath, 'agent-modules.json');
    this.Emit = (event: any) => {
      const output = typeof event?.requestId === 'string' ? this.scheduledOutput.get(event.requestId) : undefined;
      if (output) {
        if (event.type === 'content_delta' && typeof event.delta === 'string') output.content += event.delta;
        if (event.type === 'thinking_delta' && typeof event.delta === 'string') output.thinkingContent += event.delta;
        if (['completed', 'cancelled', 'error', 'waiting_user_input', 'waiting_confirmation', 'paused'].includes(event.type)) output.terminal = event.type;
        if (event.type === 'browser_user_action' || event.type === 'question_requested' || event.type === 'waiting_user_input' || event.type === 'waiting_confirmation') output.needsAttention = true;
      }
      options.Emit(event);
    };
    this.business = options.business;
    this.observabilityPort = options.observability;
    this.credentialPort = options.credentialPort;
    this.resolveProjectEnvironment = options.resolveProjectEnvironment ?? (() => null);
    this.onCronScheduleChanged = options.onCronScheduleChanged ?? (() => undefined);
    this.fileReader = new AgentFileReader((uri: string) => this.business?.ResolveAttachmentMarkdownUri?.(uri) ?? Promise.resolve(null), {
      ocrRuntimeRoot: path.join(options.userDataPath, 'ocr-runtime'),
      ocrCacheRoot: options.workspacePath ? path.join(options.workspacePath, 'derived', 'ocr') : null,
    });
    this.resumePort = new AgentResumePort({ lockStore: options.resumeLockStore ?? new ResumeLockStore(), business: this.business });
    this.resumeReadPort = this.resumePort;
    this.resumeWritePort = this.resumePort;
    this.createDefaultModules = options.createDefaultModules ?? CreateDefaultModules;
    this.compileInstructions = options.compileInstructions ?? ((scenarioId, toolPolicyHash) => scenarioId === 'application'
      ? BuildApplicationCompiledInstructions(toolPolicyHash)
      : BuildDefaultCompiledInstructions(toolPolicyHash));
    this.scenarioOverride = options.scenarioOverride;
    this.skillRegistry = new AgentSkillRegistry(options.skillRootPath);
    this.browserRuntime = options.browserRuntime ?? new AgentBrowserRuntime({
      executablePath: options.agentBrowserExecutablePath ?? path.join(options.userDataPath, 'agent-browser', 'runtime-unavailable'),
      companionExecutablePath: options.browserCompanionExecutablePath ?? path.join(options.userDataPath, 'agent-browser', 'companion-unavailable'),
      companionAppPath: options.browserCompanionAppPath,
      runtimeRoot: path.join(options.userDataPath, 'agent-browser'),
      resolveUploadFile: async (fileId) => {
        const resolved = await this.business?.ResolveAttachmentUri?.(fileId);
        return typeof resolved === 'string' ? resolved : resolved?.physicalPath ?? null;
      },
    });
    this.moduleError = null;
    this.moduleConfiguration = { enabled: false, trusted: false, status: 'default', directoryName: null, modules: [] };
    this.modules = this.BuildModules();
    this.LoadState();
  }

  SetWorkspacePath(workspacePath: string): void {
    this.fileReader.SetOcrCacheRoot(workspacePath ? path.join(workspacePath, 'derived', 'ocr') : null);
  }

  async Close(): Promise<void> {
    await this.browserRuntime.Close();
    await this.fileReader.Close();
  }

  /** 构造官方默认六槽；端口全部由宿主持有。 */
  private CreateDefaults(): any {
    const defaults = this.createDefaultModules({
      getConfig: async () => (await this.credentialPort?.Load?.()) ?? null,
      saveConfig: async (config: unknown) => { await this.credentialPort?.Save?.(config); },
      getStoredSettings: async () => (await this.business?.GetStoredSettings?.()) ?? {},
      file: this.fileReader,
      resumeRead: this.resumeReadPort,
      resumeWrite: this.resumeWritePort,
      observabilityStore: this.observabilityPort,
    });
    return defaults;
  }

  /** 从受信任目录读取 avery-modules.json，并把入口约束在该目录真实路径内。 */
  private LoadModuleOverrides(directoryPath: string, defaults: any): any {
    const base = realpathSync(directoryPath);
    const currentManifestPath = path.join(base, 'avery-modules.json');
    const legacyManifestPath = path.join(base, `${['offer', 'get'].join('')}-modules.json`);
    const manifestPath = existsSync(currentManifestPath) ? currentManifestPath : legacyManifestPath;
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as any;
    if (!manifest || typeof manifest !== 'object' || !manifest.modules || typeof manifest.modules !== 'object') throw new Error('avery-modules.json modules is missing.');
    const overrides: Record<string, any> = {};
    for (const [slot, descriptor] of Object.entries(manifest.modules)) {
      if (!['model-provider', 'context-builder', 'compaction', 'tools', 'interaction', 'observability'].includes(slot)) throw new Error(`Unknown module slot: ${slot}.`);
      if (!descriptor || typeof descriptor !== 'object' || typeof (descriptor as any).entry !== 'string') throw new Error(`Module ${slot} entry is invalid.`);
      const entry = realpathSync(path.resolve(base, (descriptor as any).entry));
      if (!(entry === base || entry.startsWith(`${base}${path.sep}`))) throw new Error(`Module ${slot} entry escapes the trusted directory.`);
      if (!['.cjs', '.js'].includes(path.extname(entry).toLowerCase())) throw new Error(`Module ${slot} entry must be .cjs or .js.`);
      const moduleKey = { 'model-provider': 'modelProvider', 'context-builder': 'contextBuilder', compaction: 'compaction', tools: 'tools', interaction: 'interaction', observability: 'observability' }[slot] as keyof typeof defaults;
      const defaultModule = defaults[moduleKey];
      overrides[slot] = {
        packageName: String((descriptor as any).packageName || `local.${slot}`),
        name: String((descriptor as any).name || `local.${slot}`),
        version: String((descriptor as any).version || '0.1.0'),
        sdkVersion: String((descriptor as any).sdkVersion || '0.1.0'),
        create: () => {
          delete require.cache[entry];
          const loaded = require(entry);
          const factory = loaded?.create ?? loaded?.default?.create ?? loaded?.default ?? loaded;
          if (typeof factory !== 'function') throw new Error(`Module ${slot} must export a create function.`);
          const candidate = factory({ defaultModule });
          const allowed = new Set(defaultModule.capabilities ?? []);
          for (const capability of candidate?.capabilities ?? []) if (!allowed.has(capability)) throw new Error(`Module ${slot} requests unauthorized capability ${capability}.`);
          return candidate;
        },
      };
    }
    return overrides;
  }

  /** 装配默认或用户覆盖六槽；失败配置保持阻断状态，不静默回退执行 Agent。 */
  private BuildModules(): any {
    const defaults = this.CreateDefaults();
    let stored: any = null;
    try {
      stored = JSON.parse(readFileSync(this.moduleConfigPath, 'utf8'));
    } catch {
      stored = null;
    }
    if (!stored?.enabled) {
      const resolved = ResolveModules({ sessionId: 'host', sessionRevision: 0, defaults, createId: () => randomUUID() });
      this.moduleSnapshot = resolved.snapshot;
      this.moduleError = null;
      this.moduleConfiguration = { enabled: false, trusted: false, status: 'default', directoryName: null, modules: resolved.snapshot.modules };
      return resolved.modules;
    }
    try {
      if (stored.trusted !== true || typeof stored.directoryPath !== 'string') throw new Error('User module directory is not trusted.');
      const overrides = this.LoadModuleOverrides(stored.directoryPath, defaults);
      const resolved = ResolveModules({ sessionId: 'host', sessionRevision: 0, defaults, overrides, createId: () => randomUUID() });
      this.moduleSnapshot = resolved.snapshot;
      this.moduleError = null;
      this.moduleConfiguration = { enabled: true, trusted: true, status: 'active', directoryName: path.basename(stored.directoryPath), modules: resolved.snapshot.modules };
      return resolved.modules;
    } catch (error) {
      const fallback = ResolveModules({ sessionId: 'blocked', sessionRevision: 0, defaults, createId: () => randomUUID() });
      this.moduleSnapshot = fallback.snapshot;
      this.moduleError = error instanceof Error ? error.message : String(error);
      this.moduleConfiguration = { enabled: true, trusted: true, status: 'blocked', directoryName: path.basename(String(stored?.directoryPath || '')), error: this.moduleError, modules: [] };
      return fallback.modules;
    }
  }

  private EnsureModulesReady(): void {
    if (this.moduleError) throw Object.assign(new Error(`User module configuration is blocked: ${this.moduleError}`), { code: 'VALIDATION_ERROR' });
  }

  GetModuleConfiguration(): any { return { ...this.moduleConfiguration }; }

  /** 用户在原生目录选择器中明确选择并信任目录后启用；无效配置被持久化为 blocked，供 UI 显式恢复默认。 */
  ConfigureUserModules(directoryPath: string): any {
    if (this.IsBusy()) throw Object.assign(new Error('Stop the current Agent run before changing modules.'), { code: 'AGENT_BUSY' });
    const base = realpathSync(directoryPath);
    writeFileSync(this.moduleConfigPath, JSON.stringify({ enabled: true, trusted: true, directoryPath: base }, null, 2), { encoding: 'utf8', mode: 0o600 });
    this.modules = this.BuildModules();
    return this.GetModuleConfiguration();
  }

  ResetUserModules(): any {
    if (this.IsBusy()) throw Object.assign(new Error('Stop the current Agent run before resetting modules.'), { code: 'AGENT_BUSY' });
    try {
      unlinkSync(this.moduleConfigPath);
    } catch (error: any) {
      if (error?.code !== 'ENOENT') throw error;
    }
    this.modules = this.BuildModules();
    return this.GetModuleConfiguration();
  }

  /** 返回是否有未结束的 Agent 请求；工作空间迁移期间必须保持空闲。 */
  IsBusy(): boolean { return this.controllers.size > 0 || this.browserRunId !== null; }

  /** 读取不含密钥的会话与任务状态；损坏文件只会回退为空状态。 */
  private LoadState(): void {
    try {
      const state = JSON.parse(readFileSync(this.statePath, 'utf8')) as any;
      this.histories = new Map(Array.isArray(state.histories) ? state.histories : []);
      this.tasks = new Map((Array.isArray(state.tasks) ? state.tasks : []).map(([sessionId, tasks]: [string, any[]]) => [sessionId, new Map(Array.isArray(tasks) ? tasks : [])]));
      this.projectEnvironments = new Map((Array.isArray(state.projectEnvironments) ? state.projectEnvironments : [])
        .map(([sessionId, value]: [string, unknown]) => [sessionId, NormalizeProjectBinding(value)])
        .filter(([sessionId, value]: [string, any]) => typeof sessionId === 'string' && value));
      this.sessionUsage = new Map((Array.isArray(state.sessionUsage) ? state.sessionUsage : [])
        .map(([sessionId, value]: [string, unknown]) => [sessionId, NormalizeSessionUsage(value)])
        .filter(([sessionId, value]: [string, any]) => typeof sessionId === 'string' && value));
      this.sessionScenarios = new Map((Array.isArray(state.sessionScenarios) ? state.sessionScenarios : [])
        .filter((entry: unknown) => Array.isArray(entry) && typeof entry[0] === 'string' && (entry[1] === 'default' || entry[1] === 'application')));
      this.sessionAssistantStates = new Map((Array.isArray(state.sessionAssistantStates) ? state.sessionAssistantStates : [])
        .map(([sessionId, value]: [string, unknown]) => [sessionId, NormalizeSessionAssistantState(value)] as const)
        .filter(([sessionId, value]: readonly [string, SessionAssistantState | null]) => typeof sessionId === 'string' && value !== null) as Array<[string, SessionAssistantState]>);
      this.toolLedger = new Map((Array.isArray(state.toolLedger) ? state.toolLedger : [])
        .filter((entry: unknown) => Array.isArray(entry) && typeof entry[0] === 'string' && entry[1] && typeof entry[1] === 'object'));
      this.pendingBrowserActions = new Map((Array.isArray(state.pendingBrowserActions) ? state.pendingBrowserActions : [])
        .filter((entry: unknown) => Array.isArray(entry) && typeof entry[0] === 'string' && entry[1] && typeof entry[1] === 'object'));
      this.pendingCronTasks = new Map((Array.isArray(state.pendingCronTasks) ? state.pendingCronTasks : [])
        .filter((entry: unknown) => Array.isArray(entry) && typeof entry[0] === 'string' && entry[1] && typeof entry[1] === 'object'));
      this.runSnapshots = new Map((Array.isArray(state.runSnapshots) ? state.runSnapshots : [])
        .filter((entry: unknown) => Array.isArray(entry) && typeof entry[0] === 'string' && entry[1] && typeof entry[1] === 'object'));
      this.loadedSkills = new Map((Array.isArray(state.loadedSkills) ? state.loadedSkills : [])
        .filter((entry: unknown) => Array.isArray(entry) && typeof entry[0] === 'string' && Array.isArray(entry[1]))
        .map(([sessionId, skills]: [string, unknown[]]) => [sessionId, new Map(skills.filter((entry) => Array.isArray(entry) && typeof entry[0] === 'string' && typeof entry[1] === 'string') as Array<[string, string]>)]));
      this.loadedSkillResources = new Map((Array.isArray(state.loadedSkillResources) ? state.loadedSkillResources : [])
        .filter((entry: unknown) => Array.isArray(entry) && typeof entry[0] === 'string' && Array.isArray(entry[1]))
        .map(([sessionId, resources]: [string, unknown[]]) => [sessionId, new Set(resources.filter((entry): entry is string => typeof entry === 'string'))]));
    } catch {
      // First launch or corrupted state starts with empty runtime data.
    }
  }

  /** 原子写入不含 API Key 的受保护运行状态。 */
  private SaveState(): void {
    const payload = {
      histories: [...this.histories.entries()],
      tasks: [...this.tasks.entries()].map(([sessionId, tasks]) => [sessionId, [...tasks.entries()]]),
      projectEnvironments: [...this.projectEnvironments.entries()],
      sessionUsage: [...this.sessionUsage.entries()],
      sessionScenarios: [...this.sessionScenarios.entries()],
      sessionAssistantStates: [...this.sessionAssistantStates.entries()],
      toolLedger: [...this.toolLedger.entries()],
      pendingBrowserActions: [...this.pendingBrowserActions.entries()],
      pendingCronTasks: [...this.pendingCronTasks.entries()],
      runSnapshots: [...this.runSnapshots.entries()],
      loadedSkills: [...this.loadedSkills.entries()].map(([sessionId, skills]) => [sessionId, [...skills.entries()]]),
      loadedSkillResources: [...this.loadedSkillResources.entries()].map(([sessionId, resources]) => [sessionId, [...resources]]),
    };
    const temporaryPath = `${this.statePath}.tmp`;
    mkdirSync(path.dirname(this.statePath), { recursive: true });
    writeFileSync(temporaryPath, JSON.stringify(payload), 'utf8');
    renameSync(temporaryPath, this.statePath);
  }

  /** 保存经校验的模型配置，API Key 经端口移交主进程 safeStorage 加密落盘。 */
  Configure(input: unknown): any { this.EnsureModulesReady(); return this.modules.modelProvider.Configure(input); }
  /** 使用表单临时配置测试连通性，不写入配置。 */
  TestConnection(config: unknown): any { this.EnsureModulesReady(); return this.modules.modelProvider.TestConnection(config); }
  /** 查询已加密保存的 DeepSeek Key 对应余额；不会向渲染层暴露凭据。 */
  GetBalance(): any { this.EnsureModulesReady(); return this.modules.modelProvider.GetBalance(); }
  /** 查询当前凭据可访问的 DeepSeek 模型；不会向渲染层暴露凭据。 */
  GetModels(): any { this.EnsureModulesReady(); return this.modules.modelProvider.GetModels(); }
  /** 返回脱敏的配置状态。 */
  GetStatus(): any { return this.modules.modelProvider.GetStatus(); }

  /** 持久化写工具账本：每次状态迁移与会话状态一并原子落盘，供重启后幂等回放与对账。 */
  private CreateToolLedgerPort(): any {
    return {
      Start: (entry: any) => {
        this.toolLedger.set(entry.ledgerId, { ...entry, status: 'started' });
        this.SaveState();
      },
      Finish: (ledgerId: string, status: string, extra?: any) => {
        const current = this.toolLedger.get(ledgerId);
        if (!current) throw new Error(`Tool Ledger entry ${ledgerId} does not exist.`);
        if (current.status === 'status_unknown' && status !== 'status_unknown') {
          throw new Error(`Tool Ledger entry ${ledgerId} requires explicit reconciliation before leaving status_unknown.`);
        }
        this.toolLedger.set(ledgerId, { ...current, status, ...(extra ?? {}) });
        this.SaveState();
      },
      FindByIdempotencyKey: (idempotencyKey: string) => [...this.toolLedger.values()]
        .find((entry: any) => entry.idempotencyKey === idempotencyKey && entry.status !== 'started'),
    };
  }

  /** 中止指定在途请求。 */
  Cancel(requestId: string): any {
    const controller = this.controllers.get(requestId);
    if (!controller) return { cancelled: false };
    controller.abort();
    return { cancelled: true };
  }

  /** 更新当前 Run 的确认权限；不扩展场景白名单、资源授权或工具能力。 */
  async UpdateConfirmationMode(requestId: string, value: unknown): Promise<any> {
    const control = this.runtimeControls.get(requestId);
    if (!control) return { updated: false, reason: 'not_running' };
    const confirmationMode = NormalizeConfirmationMode(value);
    control.confirmationMode = confirmationMode;
    control.toolContext.confirmationMode = confirmationMode;
    const current = this.sessionAssistantStates.get(control.sessionId);
    if (current) {
      await this.PersistSessionAssistantState(control.sessionId, { ...current, confirmationMode });
    }
    return { updated: true, confirmationMode };
  }

  /** 保存会话级思考强度；当前 Run 保持启动时快照，下一 Run 使用新值。 */
  async UpdateReasoningEffort(sessionId: string, value: unknown): Promise<any> {
    const normalizedSessionId = RequireString(sessionId, 'sessionId', 200);
    const reasoningEffort = NormalizeReasoningEffort(value);
    const current = await this.RestoreSessionAssistantState(normalizedSessionId);
    await this.PersistSessionAssistantState(normalizedSessionId, { ...current, reasoningEffort });
    return { updated: true, reasoningEffort };
  }

  /** 应用或丢弃待确认的简历补丁：接受时经简历写端口落库并释放 Agent 锁。 */
  ConfirmResumeEdit(confirmationId: string, accepted: boolean): any {
    return this.modules.interaction.ConfirmResumeEdit(confirmationId, accepted, {
      pendingEdits: this.pendingEdits,
      ports: { resumeWrite: this.resumeWritePort },
      ledger: this.CreateToolLedgerPort(),
      emit: (event: unknown) => this.Emit(event),
    });
  }

  /** 冻结 CronTask 创建参数；投递任务必须绑定当前会话已选择的简历，避免后台运行时缺少授权材料。 */
  private PrepareCronTask(input: unknown, context: { requestId: string; resumeId?: string }): { confirmationId: string; summary: string; scenarioId: 'default' | 'application' } {
    const parsed = CreateCronTaskSchema.parse(input);
    if (parsed.scenarioId === 'application' && !context.resumeId) {
      throw Object.assign(new Error('Select a resume before creating an unattended application CronTask.'), { code: 'VALIDATION_ERROR' });
    }
    const confirmationId = `cron-confirmation-${randomUUID()}`;
    const summary = parsed.scenarioId === 'application'
      ? '系统可在计划时间唤醒或后台启动应用。该计划将在整个周期内以无人值守完全信任模式复用独立浏览器登录，可能填写表单、发送招聘消息并提交投递；执行时不会逐项确认。第一版只能读取所选简历内容，不携带临时附件；网页强制上传文件时会标记为需要你接管。'
      : '系统可在计划时间唤醒或后台启动应用。该计划将在整个周期内以无人值守完全信任模式创建新会话并执行指定消息；执行时不会逐项确认。';
    this.pendingCronTasks.set(confirmationId, { input: parsed, resumeId: context.resumeId, requestId: context.requestId, createdAt: Date.now(), summary });
    this.SaveState();
    return { confirmationId, summary, scenarioId: parsed.scenarioId };
  }

  /** 用户一次性确认整个 CronTask 周期；拒绝或过期均不写数据库，也不注册 OS 唤醒。 */
  async ConfirmCronTask(confirmationId: string, accepted: boolean): Promise<any> {
    const normalizedId = RequireString(confirmationId, 'confirmationId', 200);
    const pending = this.pendingCronTasks.get(normalizedId);
    if (!pending) throw Object.assign(new Error('CronTask confirmation is unavailable or expired.'), { code: 'VALIDATION_ERROR' });
    this.pendingCronTasks.delete(normalizedId);
    this.SaveState();
    if (!accepted) return { created: false };
    if (!Number.isFinite(pending.createdAt) || Date.now() - pending.createdAt > SessionSnapshotTtlMs) {
      throw Object.assign(new Error('CronTask confirmation expired. Create the schedule again.'), { code: 'VALIDATION_ERROR' });
    }
    const task = await this.business.CreateCronTask(pending.input, { ...(pending.resumeId ? { resumeId: pending.resumeId } : {}) });
    try {
      await this.onCronScheduleChanged();
    } catch (error) {
      await this.business.DeleteCronTask(task.id);
      await Promise.resolve(this.onCronScheduleChanged()).catch(() => undefined);
      throw Object.assign(new Error('CronTask could not register the operating-system wake and was cancelled.'), { code: 'INTERNAL_ERROR', cause: error });
    }
    this.Emit({ type: 'cron_task_changed', requestId: pending.requestId, cronTask: task });
    return { created: true, task };
  }

  /** 执行被冻结的浏览器提案；确认后仍重新校验页面 revision 和目标引用，拒绝模型重建动作。 */
  async ConfirmBrowserAction(confirmationId: string, accepted: boolean, execution: { signal?: AbortSignal } = {}): Promise<any> {
    const normalizedId = RequireString(confirmationId, 'confirmationId', 200);
    if (this.browserRunId) throw Object.assign(new Error('Another browser Agent run is already active.'), { code: 'AGENT_BUSY' });
    const confirmationRunId = `confirmation:${normalizedId}`;
    this.browserRunId = confirmationRunId;
    try {
    const pending = this.pendingBrowserActions.get(normalizedId) as any;
    if (!pending) throw Object.assign(new Error('Browser confirmation is unavailable or expired.'), { code: 'VALIDATION_ERROR' });
    this.pendingBrowserActions.delete(normalizedId);
    this.SaveState();
    if (!Number.isFinite(pending.createdAt) || Date.now() - pending.createdAt > SessionSnapshotTtlMs) {
      throw Object.assign(new Error('Browser confirmation expired. Take a new snapshot and prepare the action again.'), { code: 'VALIDATION_ERROR' });
    }
    if (!accepted) {
      const result = { confirmationId: normalizedId, status: 'rejected', summary: pending.proposal?.summary };
      this.Emit({ type: 'browser_action_completed', requestId: pending.requestId, confirmationId: normalizedId, browserAction: result });
      return result;
    }
    if (execution.signal?.aborted) throw Object.assign(new Error('Browser action was cancelled before execution.'), { code: 'CANCELLED' });

    const ledger = this.CreateToolLedgerPort();
    const previous = await ledger.FindByIdempotencyKey(pending.idempotencyKey);
    if (previous?.status === 'succeeded' && previous.receipt) {
      const replayed = { confirmationId: normalizedId, status: 'succeeded', replayed: true, receipt: previous.receipt, summary: pending.proposal?.summary };
      this.Emit({ type: 'browser_action_completed', requestId: pending.requestId, confirmationId: normalizedId, browserAction: replayed });
      return replayed;
    }
    if (previous?.status === 'status_unknown') {
      const unknown = { confirmationId: normalizedId, status: 'status_unknown', summary: pending.proposal?.summary, message: '该动作此前结果未知，请先在目标网站核对，不能自动重试。' };
      this.Emit({ type: 'browser_action_completed', requestId: pending.requestId, confirmationId: normalizedId, browserAction: unknown });
      return unknown;
    }

    const ledgerId = `ledger-${randomUUID()}`;
    await ledger.Start({
      ledgerId,
      runId: pending.runId,
      toolCallId: pending.toolCallId,
      toolName: pending.proposal.toolName,
      idempotencyKey: pending.idempotencyKey,
      argumentsHash: createHash('sha256').update(JSON.stringify(pending.proposal.canonicalArguments)).digest('hex'),
      actor: 'agent',
      resourceIds: pending.proposal.resourceIds,
      startedAt: Date.now(),
    });
    try {
      const timeoutMs = pending.proposal.toolName === 'BrowserFillForm' ? 60_000 : 30_000;
      const outcome = await this.browserRuntime.Execute({ proposal: pending.proposal, signal: execution.signal, deadline: Date.now() + timeoutMs });
      if (execution.signal?.aborted) throw Object.assign(new Error('Browser action completion arrived after cancellation.'), { code: 'CANCELLED' });
      if (outcome.status === 'status_unknown') {
        await ledger.Finish(ledgerId, 'status_unknown', { errorCode: 'BROWSER_STATUS_UNKNOWN', finishedAt: Date.now() });
        const unknown = { confirmationId: normalizedId, status: 'status_unknown', data: outcome.data, summary: pending.proposal.summary };
        this.Emit({ type: 'browser_action_completed', requestId: pending.requestId, confirmationId: normalizedId, browserAction: unknown });
        return unknown;
      }
      const receipt = {
        receiptId: `receipt-${randomUUID()}`,
        toolDefinitionId: pending.proposal.toolName,
        resourceIds: pending.proposal.resourceIds,
        idempotencyKey: pending.idempotencyKey,
      };
      await ledger.Finish(ledgerId, 'succeeded', { receipt, finishedAt: Date.now() });
      const succeeded = { confirmationId: normalizedId, status: 'succeeded', data: outcome.data, receipt, summary: pending.proposal.summary };
      this.Emit({ type: 'browser_action_completed', requestId: pending.requestId, confirmationId: normalizedId, browserAction: succeeded });
      return succeeded;
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? String((error as { code: unknown }).code) : 'BROWSER_COMMAND_FAILED';
      await ledger.Finish(ledgerId, code === 'CANCELLED' ? 'status_unknown' : 'failed', { errorCode: code, finishedAt: Date.now() });
      const failed = { confirmationId: normalizedId, status: code === 'CANCELLED' ? 'status_unknown' : 'failed', code, summary: pending.proposal.summary, message: error instanceof Error ? error.message : 'Browser action failed.' };
      this.Emit({ type: 'browser_action_completed', requestId: pending.requestId, confirmationId: normalizedId, browserAction: failed });
      return failed;
    }
    } finally {
      if (this.browserRunId === confirmationRunId) this.browserRunId = null;
    }
  }

  /** 测评 UserSimulator 只读检查被冻结提案；该方法未注册 IPC，生产 Renderer 无法获取参数。 */
  InspectPendingBrowserAction(confirmationId: string): any {
    const normalizedId = RequireString(confirmationId, 'confirmationId', 200);
    const pending = this.pendingBrowserActions.get(normalizedId) as any;
    if (!pending?.proposal) return null;
    return structuredClone({
      toolName: pending.proposal.toolName,
      canonicalArguments: pending.proposal.canonicalArguments,
      summary: pending.proposal.summary,
      url: pending.proposal.url,
      risk: pending.proposal.risk,
      resourceIds: pending.proposal.resourceIds,
    });
  }

  /** 返回浏览器运行时状态；Renderer 看不到可执行文件和 Profile 物理路径。 */
  GetBrowserRuntimeStatus(): any { return this.browserRuntime.GetStatus(); }

  /** 清除 Avery 独立浏览器身份；调用方必须先展示破坏性确认。 */
  async ClearBrowserProfile(): Promise<any> {
    if (this.IsBusy()) throw Object.assign(new Error('Stop the current Agent run before clearing the browser profile.'), { code: 'AGENT_BUSY' });
    this.browserRunId = 'maintenance:clear';
    try {
      this.pendingBrowserActions.clear();
      this.SaveState();
      return await this.browserRuntime.ClearProfile();
    }
    finally { if (this.browserRunId === 'maintenance:clear') this.browserRunId = null; }
  }

  /** 用户开始编辑简历前获取互斥锁；Agent 占用时返回未获取及原因。 */
  async AcquireResumeEditLock(resumeId: string): Promise<any> {
    const normalizedId = typeof resumeId === 'string' ? resumeId : '';
    if (!normalizedId || normalizedId.length > 200) throw new Error('Resume id is invalid.');
    const result = await this.resumePort.AcquireLock({ resumeId: normalizedId, owner: 'user', ownerId: UserLockOwnerId });
    if (!result.acquired) {
      const lock = this.resumePort.lockStore.GetLock(normalizedId);
      return { acquired: false, reason: lock?.owner === 'agent' ? 'Agent 正在编辑这份简历，请稍后再试' : '简历正被其他操作占用' };
    }
    return { acquired: true };
  }

  /** 用户保存或取消编辑后释放简历锁。 */
  async ReleaseResumeEditLock(resumeId: string): Promise<any> {
    const normalizedId = typeof resumeId === 'string' ? resumeId : '';
    if (!normalizedId || normalizedId.length > 200) throw new Error('Resume id is invalid.');
    await this.resumePort.ReleaseLock(normalizedId, UserLockOwnerId);
    return { released: true };
  }

  /** 绑定单会话单项目目录；会话一旦绑定，后续请求不得切换到其它目录；项目只经 projectId 掩码解析真实路径。 */
  async BindProjectEnvironment(sessionId: string, projectId: string): Promise<string | null> {
    const existing = this.projectEnvironments.get(sessionId) ?? null;
    if (!projectId) return existing?.rootPath ?? null;
    const requested = (await this.resolveProjectEnvironment(projectId)) ?? null;
    const requestedBinding = NormalizeProjectBinding(requested);
    if (requestedBinding && !requestedBinding.projectId) requestedBinding.projectId = projectId;
    if (existing && requestedBinding && existing.rootPath !== requestedBinding.rootPath) throw new Error('A project environment is already bound to this session. Create a new conversation to switch projects.');
    const project = existing && requestedBinding && existing.rootPath === requestedBinding.rootPath ? { ...existing, ...requestedBinding } : existing ?? requestedBinding;
    if (project) {
      const stat = statSync(project.rootPath);
      if (!stat.isDirectory()) throw new Error('The selected project environment is unavailable.');
      this.projectEnvironments.set(sessionId, project);
      this.SaveState();
    }
    return project?.rootPath ?? null;
  }

  /** 从会话快照的可序列化部分读取偏好，工作空间数据库优先于本机运行态。 */
  private async ReadPersistedSessionAssistantState(sessionId: string): Promise<SessionAssistantState | null> {
    const stored = await this.business?.GetConversationSnapshots?.(sessionId);
    if (stored?.toolSnapshotJson) {
      try {
        const combined = JSON.parse(stored.toolSnapshotJson);
        const state = NormalizeSessionAssistantState(combined?.assistantState);
        if (state) {
          this.sessionAssistantStates.set(sessionId, state);
          return state;
        }
      } catch {
        // 会话快照损坏时保留内存态或安全默认值；不因偏好恢复阻断会话读取。
      }
    }
    return this.sessionAssistantStates.get(sessionId) ?? null;
  }

  /** 解析已保存模型：无效值回退当前 Provider 默认；网络不可用时保留本地结构校验后的选择。 */
  private async ResolvePersistedSessionModel(value: unknown, status: any): Promise<string> {
    const fallback = this.modules.modelProvider.ResolveRequestModel(undefined);
    if (typeof value !== 'string' || !value.trim()) return fallback;
    let model: string;
    try {
      model = this.modules.modelProvider.ResolveRequestModel(value.trim());
    } catch {
      return fallback;
    }
    if (!status.configured || status.provider !== 'DeepSeek') return model;
    try {
      const result = await this.modules.modelProvider.GetModels();
      const models = Array.isArray(result?.models) ? result.models.filter((item: unknown): item is string => typeof item === 'string') : [];
      if (!models.length || models.includes(model)) return model;
      if (models.includes(fallback)) return fallback;
      const providerFallback = models.find((item: string) => {
        try {
          return this.modules.modelProvider.ResolveRequestModel(item) === item;
        } catch {
          return false;
        }
      });
      return providerFallback ?? fallback;
    } catch {
      // /models 是在线能力；暂时无法联网时不把结构有效的会话选择误判为失效。
      return model;
    }
  }

  /** 恢复并校验会话偏好，模型回退后立即写回会话快照，避免下次重载重复命中失效值。 */
  private async RestoreSessionAssistantState(sessionId: string): Promise<SessionAssistantState> {
    const stored = await this.ReadPersistedSessionAssistantState(sessionId);
    const status = await this.modules.modelProvider.GetStatus();
    const next: SessionAssistantState = {
      model: await this.ResolvePersistedSessionModel(stored?.model, status),
      confirmationMode: stored?.confirmationMode ?? 'always_confirm',
      reasoningEffort: stored?.reasoningEffort ?? 'medium',
    };
    if (!stored || stored.model !== next.model || stored.confirmationMode !== next.confirmationMode || stored.reasoningEffort !== next.reasoningEffort) {
      await this.PersistSessionAssistantState(sessionId, next);
    }
    return next;
  }

  /** 将会话偏好并入既有快照包，绝不覆盖会话前缀、工具、Skill 或场景冻结信息。 */
  private async PersistSessionAssistantState(sessionId: string, state: SessionAssistantState): Promise<void> {
    this.sessionAssistantStates.set(sessionId, state);
    const cached = this.sessionSnapshots.get(sessionId);
    if (cached) {
      await this.business?.SetConversationSnapshots?.(sessionId, {
        toolSnapshotJson: JSON.stringify({
          module: cached.module,
          tool: cached.tool,
          skills: cached.skills,
          instructions: cached.instructions,
          scenarioId: cached.scenarioId,
          assistantState: state,
        }),
      });
      this.SaveState();
      return;
    }
    const stored = await this.business?.GetConversationSnapshots?.(sessionId);
    if (!stored?.toolSnapshotJson) {
      this.SaveState();
      return;
    }
    try {
      const combined = JSON.parse(stored.toolSnapshotJson);
      if (!combined || typeof combined !== 'object' || Array.isArray(combined)) {
        this.SaveState();
        return;
      }
      await this.business?.SetConversationSnapshots?.(sessionId, {
        toolSnapshotJson: JSON.stringify({ ...combined, assistantState: state }),
      });
    } catch {
      // 无法验证的旧快照不写回，下一次 Send 会以新快照和当前偏好原子替换。
    }
    this.SaveState();
  }

  /** 返回会话专属 usage、项目标签及已校验的模型与确认权限；默认值绝不回退到其它会话。 */
  async GetSessionAssistantState(sessionId: string): Promise<any> {
    const normalizedSessionId = RequireString(sessionId, 'sessionId', 200);
    const assistantState = await this.RestoreSessionAssistantState(normalizedSessionId);
    const { contextLimit, threshold } = this.modules.modelProvider.GetRuntimeLimits();
    const storedUsage = this.sessionUsage.get(normalizedSessionId) ?? null;
    const project = this.projectEnvironments.get(normalizedSessionId) ?? null;
    return {
      usage: {
        inputTokens: storedUsage?.inputTokens ?? 0,
        contextLimit: storedUsage?.contextLimit || contextLimit,
        compressionCount: storedUsage?.compressionCount ?? 0,
        compressionThreshold: storedUsage?.compressionThreshold || threshold,
        source: storedUsage?.source ?? 'unavailable',
        promptTokens: storedUsage?.promptTokens ?? 0,
        completionTokens: storedUsage?.completionTokens ?? 0,
        totalTokens: storedUsage?.totalTokens ?? 0,
        reportedRequestCount: storedUsage?.reportedRequestCount ?? 0,
        unreportedRequestCount: storedUsage?.unreportedRequestCount ?? 0,
      },
      project: project ? { projectId: project.projectId, name: project.name } : null,
      scenarioId: this.sessionScenarios.get(normalizedSessionId) ?? 'default',
      model: assistantState.model,
      confirmationMode: assistantState.confirmationMode,
      reasoningEffort: assistantState.reasoningEffort,
    };
  }

  /** 为旧版自定义观测模块保留兼容降级，但无论哪条路径都写入同一 Provider usage 事实。 */
  private RecordProviderUsageFact(requestId: string, fact: ProviderUsageFact): void {
    const observability = this.modules.observability as {
      RecordTraceUsage?: (id: string, usage: typeof fact) => void;
      AppendTraceEvent: (id: string, eventType: string, payload: unknown, tokenCount?: number) => void;
    };
    if (typeof observability.RecordTraceUsage === 'function') {
      observability.RecordTraceUsage(requestId, fact);
      return;
    }
    observability.AppendTraceEvent(requestId, 'provider_usage', fact, 0);
  }

  /** 将每次已完成模型请求的 usage 合并到单会话账本；缺失值仅记未上报，绝不估算。 */
  private RecordSessionUsage(requestId: string, sessionId: string, usage: ProviderUsageFact, contextLimit: number, threshold: number): void {
    const previous = this.sessionUsage.get(sessionId);
    const base = previous?.source === 'actual' ? previous : { promptTokens: 0, completionTokens: 0, totalTokens: 0, reportedRequestCount: 0, unreportedRequestCount: 0, compressionCount: 0 };
    const providerUsageIsValid = usage?.source === 'provider'
      && [usage.promptTokens, usage.completionTokens, usage.totalTokens].every((value) => Number.isSafeInteger(value) && value >= 0)
      && usage.totalTokens === usage.promptTokens + usage.completionTokens;
    if (!providerUsageIsValid) {
      this.RecordProviderUsageFact(requestId, { source: 'unavailable', promptTokens: 0, completionTokens: 0, totalTokens: 0 });
      const next = previous?.source === 'actual'
        ? { ...previous, contextLimit, compressionThreshold: threshold, unreportedRequestCount: previous.unreportedRequestCount + 1, updatedAt: Date.now() }
        : {
          source: 'unavailable', inputTokens: 0, contextLimit, compressionCount: previous?.compressionCount ?? 0, compressionThreshold: threshold,
          promptTokens: 0, completionTokens: 0, totalTokens: 0, reportedRequestCount: 0, unreportedRequestCount: (previous?.unreportedRequestCount ?? 0) + 1, updatedAt: Date.now(),
        };
      this.sessionUsage.set(sessionId, next);
      this.SaveState();
      return;
    }
    this.RecordProviderUsageFact(requestId, {
      source: 'provider', promptTokens: usage.promptTokens, completionTokens: usage.completionTokens, totalTokens: usage.totalTokens,
    });
    const next = {
      source: 'actual', inputTokens: usage.promptTokens, contextLimit, compressionCount: base.compressionCount, compressionThreshold: threshold,
      promptTokens: base.promptTokens + usage.promptTokens, completionTokens: base.completionTokens + usage.completionTokens, totalTokens: base.totalTokens + usage.totalTokens,
      reportedRequestCount: base.reportedRequestCount + 1, unreportedRequestCount: base.unreportedRequestCount, updatedAt: Date.now(),
    };
    this.sessionUsage.set(sessionId, next);
    this.lastContextUsage = { inputTokens: next.inputTokens, contextLimit };
    this.modules.observability.RecordLog('INFO', 'context.usage', `${usage.promptTokens} / ${contextLimit} actual tokens`);
    this.SaveState();
  }

  /** 构建不可变的 Tool Array 快照：内置工具固定前缀、MCP 预留末尾；不保存 MCP 凭据。 */
  private BuildToolSnapshot(sessionId: string, sessionRevision: number, scenarioId: 'default' | 'application'): any {
    const registeredTools = this.modules.tools.GetToolDefinitions(scenarioId);
    const builtInTools = this.scenarioOverride
      ? registeredTools.filter((tool: any) => this.scenarioOverride?.toolNames.includes(tool.definition.function.name))
      : registeredTools;
    const orderedToolNames = builtInTools.map((tool: any) => tool.definition.function.name);
    const toolsetHash = createHash('sha256').update(JSON.stringify(builtInTools.map((tool: any) => tool.definition))).digest('hex');
    return { snapshotId: randomUUID(), sessionId, sessionRevision, scenarioId, builtInTools, mcpTools: [], orderedToolNames, toolsetHash };
  }

  private BuildModuleSnapshot(sessionId: string, sessionRevision: number): any {
    return { ...this.moduleSnapshot, snapshotId: randomUUID(), sessionId, sessionRevision };
  }

  private HasCompleteSkillSnapshot(value: any): value is SkillSnapshot {
    if (!value || !Array.isArray(value.skills) || typeof value.snapshotHash !== 'string') return false;
    return createHash('sha256').update(JSON.stringify(value.skills)).digest('hex') === value.snapshotHash;
  }

  /** 快照刷新不删除旧消息，而是追加失效标记；后续索引和正文以新 revision 为准。 */
  private ResetSkillState(sessionId: string, reason: 'ttl_elapsed' | 'user_reload', sessionRevision: number): void {
    this.loadedSkills.delete(sessionId);
    this.loadedSkillResources.delete(sessionId);
    const history = this.histories.get(sessionId) ?? [];
    const resetMessage: AgentMessage = {
      role: 'user',
      content: `<skill-state-reset>\nPreviously loaded Skill instructions are no longer active. Use the next Skill index for this session.\n</skill-state-reset>`,
      metadata: { source: 'runtime', visibility: 'hidden', kind: 'skill_state_reset', reason, sessionRevision },
    };
    this.histories.set(sessionId, [...history, resetMessage]);
  }

  /** 创建完整会话前缀快照并原子写入会话表；普通 Run 只复用，不重编译。 */
  private async CreateAndPersistSnapshots(sessionId: string, sessionRevision: number, refreshReason: 'session_created' | 'ttl_elapsed' | 'user_reload', scenarioId: 'default' | 'application'): Promise<any> {
    const session = await this.modules.contextBuilder.BuildSessionContextSnapshot(sessionId, sessionRevision, {
      now: Date.now(), ttlMs: SessionSnapshotTtlMs, refreshReason,
    });
    const module = this.BuildModuleSnapshot(sessionId, sessionRevision);
    const tool = this.BuildToolSnapshot(sessionId, sessionRevision, scenarioId);
    const skills = await this.skillRegistry.BuildSnapshot(sessionId, sessionRevision, scenarioId);
    const instructions = this.compileInstructions(scenarioId, tool.toolsetHash);
    const entry = { session, module, tool, skills, instructions, scenarioId };
    const assistantState = this.sessionAssistantStates.get(sessionId);
    await this.business?.SetConversationSnapshots?.(sessionId, {
      sessionSnapshotJson: JSON.stringify(session),
      toolSnapshotJson: JSON.stringify({ module, tool, skills, instructions, scenarioId, ...(assistantState ? { assistantState } : {}) }),
    });
    this.sessionSnapshots.set(sessionId, entry);
    this.sessionScenarios.set(sessionId, scenarioId);
    if (refreshReason === 'ttl_elapsed' || refreshReason === 'user_reload') this.ResetSkillState(sessionId, refreshReason, sessionRevision);
    this.SaveState();
    return entry;
  }

  /** 持久化 JSON 不包含执行函数；按名称接回当前同版本注册表，同时保留快照中的协议定义。 */
  private HydrateToolSnapshot(toolSnapshot: any, scenarioId: 'default' | 'application'): any[] {
    const activeTools = this.modules.tools.GetToolDefinitions(scenarioId);
    const activeByName = new Map(activeTools.map((tool: any) => [tool.definition.function.name, tool]));
    const storedTools = Array.isArray(toolSnapshot?.builtInTools) ? toolSnapshot.builtInTools : [];
    return storedTools.map((stored: any) => {
      const name = stored?.definition?.function?.name;
      const active: any = activeByName.get(name);
      if (!active) throw new Error(`Session tool ${String(name)} is unavailable. Use /reload after restoring the module.`);
      return { ...active, ...stored, definition: stored.definition, execute: active.execute };
    });
  }

  private HasCompleteSessionSnapshot(session: any): boolean {
    return Boolean(session
      && typeof session.compiledPrefix === 'string'
      && typeof session.compiledHash === 'string'
      && typeof session.createdAt === 'string'
      && typeof session.expiresAt === 'string'
      && Number.isFinite(Date.parse(session.expiresAt))
      && createHash('sha256').update(session.compiledPrefix).digest('hex') === session.compiledHash);
  }

  private IsUsableSessionSnapshot(session: any, now = Date.now()): boolean {
    return this.HasCompleteSessionSnapshot(session) && Date.parse(session.expiresAt) > now;
  }

  private HasCompleteToolBundle(tool: any, instructions: any): boolean {
    if (!Array.isArray(tool?.builtInTools) || !Array.isArray(tool?.orderedToolNames) || typeof tool?.toolsetHash !== 'string') return false;
    if (typeof instructions?.compiled !== 'string' || typeof instructions?.manifest?.compiledHash !== 'string') return false;
    const definitionsHash = createHash('sha256').update(JSON.stringify(tool.builtInTools.map((item: any) => item?.definition))).digest('hex');
    const orderedNames = tool.builtInTools.map((item: any) => item?.definition?.function?.name);
    const promptHash = createHash('sha256').update(instructions.compiled).digest('hex');
    return definitionsHash === tool.toolsetHash
      && JSON.stringify(orderedNames) === JSON.stringify(tool.orderedToolNames)
      && instructions.manifest.toolPolicyHash === tool.toolsetHash
      && instructions.manifest.compiledHash === promptHash;
  }

  /** 模块变化不能偷换既有 Session 的工具实现；必须由用户 /reload 创建新快照。 */
  private EnsureModuleSnapshotCompatible(moduleSnapshot: any): void {
    const signature = (snapshot: any) => JSON.stringify((Array.isArray(snapshot?.modules) ? snapshot.modules : []).map((module: any) => ({
      slot: module.slot,
      name: module.name,
      version: module.version,
      sdkVersion: module.sdkVersion,
      capabilities: module.capabilities,
    })));
    if (signature(moduleSnapshot) !== signature(this.moduleSnapshot)) {
      throw new Error('Session modules changed. Use /reload before starting the next run.');
    }
  }

  /** 读取或惰性创建会话快照：内存缓存优先，其次会话表，最后新建并持久化。 */
  private async LoadOrCreateSnapshots(sessionId: string, requestedScenarioId?: 'default' | 'application'): Promise<any> {
    const cached = this.sessionSnapshots.get(sessionId);
    const cachedScenarioId = cached?.scenarioId ?? cached?.tool?.scenarioId ?? this.sessionScenarios.get(sessionId) ?? 'default';
    if (requestedScenarioId && cached && requestedScenarioId !== cachedScenarioId) throw new Error('A scenario is already bound to this conversation. Create a new conversation to switch scenarios.');
    if (cached && this.IsUsableSessionSnapshot(cached.session) && this.HasCompleteToolBundle(cached.tool, cached.instructions) && this.HasCompleteSkillSnapshot(cached.skills)) return { ...cached, scenarioId: cachedScenarioId };
    if (cached) {
      const expiredCompleteBundle = this.HasCompleteSessionSnapshot(cached.session)
        && this.HasCompleteToolBundle(cached.tool, cached.instructions)
        && this.HasCompleteSkillSnapshot(cached.skills);
      return this.CreateAndPersistSnapshots(sessionId, (cached.session?.sessionRevision ?? 0) + 1, expiredCompleteBundle ? 'ttl_elapsed' : 'session_created', cachedScenarioId);
    }
    const stored = await this.business?.GetConversationSnapshots?.(sessionId);
    let session: any = null;
    let module: any = null;
    let tool: any = null;
    let instructions: any = null;
    let skills: any = null;
    let storedScenarioId: 'default' | 'application' = 'default';
    let hasStoredSnapshot = false;
    if (stored?.sessionSnapshotJson) {
      try {
        session = JSON.parse(stored.sessionSnapshotJson);
        hasStoredSnapshot = session !== null;
      } catch { session = null; }
    }
    if (stored?.toolSnapshotJson) {
      try {
        const combined = JSON.parse(stored.toolSnapshotJson);
        // 新建会话的数据库默认值是 `[]`，它只是“尚未生成快照”的占位符，不能冻结为默认场景。
        // 其他非空值即使结构损坏也视为已有快照并保持场景冻结，避免借损坏快照切换权限边界。
        const isUninitializedPlaceholder = Array.isArray(combined) && combined.length === 0;
        if (!isUninitializedPlaceholder) {
          hasStoredSnapshot = true;
          module = combined?.module ?? null;
          tool = combined?.tool ?? combined;
          instructions = combined?.instructions ?? null;
          skills = combined?.skills ?? null;
          const assistantState = NormalizeSessionAssistantState(combined?.assistantState);
          if (assistantState) this.sessionAssistantStates.set(sessionId, assistantState);
          storedScenarioId = combined?.scenarioId === 'application' || tool?.scenarioId === 'application' ? 'application' : 'default';
        }
      } catch { tool = null; }
    }
    if (requestedScenarioId && requestedScenarioId !== storedScenarioId && hasStoredSnapshot) throw new Error('A scenario is already bound to this conversation. Create a new conversation to switch scenarios.');
    const scenarioId = requestedScenarioId ?? storedScenarioId;
    if (this.IsUsableSessionSnapshot(session) && this.HasCompleteToolBundle(tool, instructions) && this.HasCompleteSkillSnapshot(skills)) {
      const entry = { session, module: module ?? this.BuildModuleSnapshot(sessionId, session.sessionRevision ?? 1), tool, skills, instructions, scenarioId };
      this.sessionSnapshots.set(sessionId, entry);
      this.sessionScenarios.set(sessionId, scenarioId);
      return entry;
    }
    const nextRevision = Math.max(1, (session?.sessionRevision ?? 0) + 1);
    const hadCompleteBundle = this.HasCompleteSessionSnapshot(session)
      && this.HasCompleteToolBundle(tool, instructions)
      && this.HasCompleteSkillSnapshot(skills);
    return this.CreateAndPersistSnapshots(sessionId, nextRevision, hadCompleteBundle ? 'ttl_elapsed' : 'session_created', scenarioId);
  }

  /** 空闲时原子重载会话上下文与 Tool 快照；任一步失败保留旧快照。 */
  async ReloadSession(sessionId: string): Promise<any> {
    if (typeof sessionId !== 'string' || sessionId.length === 0 || sessionId.length > 200) throw new Error('Session id is invalid.');
    if (this.IsBusy()) return { reloaded: false, reason: 'busy' };
    await this.RestoreSessionAssistantState(sessionId);
    const current = this.sessionSnapshots.get(sessionId) ?? await this.LoadOrCreateSnapshots(sessionId);
    const nextRevision = (current.session?.sessionRevision ?? 0) + 1;
    try {
      const { session } = await this.CreateAndPersistSnapshots(sessionId, nextRevision, 'user_reload', current.scenarioId ?? 'default');
      return { reloaded: true, sessionRevision: session.sessionRevision };
    } catch (error) {
      return { reloaded: false, reason: error instanceof Error ? error.message : 'reload failed' };
    }
  }

  /** Backend Cron Runner 专用入口；Renderer 无法设置 scheduledRequestIds，也不能伪造无人值守权限。 */
  async SendScheduled(input: any): Promise<any> {
    const requestId = RequireString(input?.requestId, 'requestId', 200);
    this.scheduledRequestIds.add(requestId);
    const output = { content: '', thinkingContent: '', needsAttention: false };
    this.scheduledOutput.set(requestId, output);
    await this.browserRuntime.SetUnattended?.(true);
    try {
      const result = await this.Send({ ...input, confirmationMode: 'fully_trusted', attachments: [], projectId: undefined });
      return { ...result, ...output };
    } finally {
      this.scheduledRequestIds.delete(requestId);
      this.scheduledOutput.delete(requestId);
      await this.browserRuntime.SetUnattended?.(false);
    }
  }

  /** 在显式状态机内执行一次受限的流式对话回合：编排完成后委托 Kernel 运行循环。 */
  async Send(input: any): Promise<any> {
    this.EnsureModulesReady();
    const requestId = RequireString(input?.requestId, 'requestId', 200);
    const sessionId = RequireString(input?.sessionId, 'sessionId', 200);
    const userContent = RequireString(input?.content, 'content');
    const requestedScenario = ResolveScenario(input?.scenarioId);
    const scenario = this.scenarioOverride ?? requestedScenario;
    if (this.scenarioOverride && requestedScenario.id !== this.scenarioOverride.id) {
      throw Object.assign(new Error('Evaluation scenario does not match the frozen host scenario.'), { code: 'VALIDATION_ERROR' });
    }
    const scenarioId = scenario.id as 'default' | 'application';
    const unattended = this.scheduledRequestIds.has(requestId);
    const cronToolNames = new Set(['CreateCronTask', 'ReadCronTask', 'UpdateCronTask', 'DeleteCronTask']);
    const runScenario = unattended ? { ...scenario, toolNames: scenario.toolNames.filter((name) => !cronToolNames.has(name)) } : scenario;
    if (scenarioId === 'application' && this.browserRunId) throw Object.assign(new Error('Another browser Agent run is already active.'), { code: 'AGENT_BUSY' });
    if (scenarioId === 'application') {
      this.browserRunId = requestId;
      // 页面元素引用不得跨 Run 复用；用户可能在两次发送之间接管可见浏览器并改变 DOM。
      this.browserRuntime.ResetPageReferences();
    }
    try {
    const status = await this.modules.modelProvider.GetStatus();
    if (!status.configured) throw new Error('API Key is not configured.');
    const restoredAssistantState = await this.RestoreSessionAssistantState(sessionId);
    const hasRequestedModel = input?.model !== undefined;
    const model = hasRequestedModel
      ? this.modules.modelProvider.ResolveRequestModel(input.model)
      : restoredAssistantState.model;
    if (this.controllers.has(requestId)) throw new Error('The request is already running.');
    const confirmationMode = input?.confirmationMode === undefined
      ? restoredAssistantState.confirmationMode
      : NormalizeConfirmationMode(input.confirmationMode);
    const reasoningEffort = input?.reasoningEffort === undefined
      ? restoredAssistantState.reasoningEffort
      : NormalizeReasoningEffort(input.reasoningEffort);
    const assistantStateChanged = model !== restoredAssistantState.model || confirmationMode !== restoredAssistantState.confirmationMode || reasoningEffort !== restoredAssistantState.reasoningEffort;
    this.sessionAssistantStates.set(sessionId, { model, confirmationMode, reasoningEffort });
    const attachments = Array.isArray(input?.attachments) ? input.attachments.slice(0, 10).map((attachment: any) => ({
      name: String(attachment?.name ?? '').slice(0, 200), path: String(attachment?.path ?? '').slice(0, 1000),
    })).filter((attachment: any) => attachment.name && attachment.path) : [];
    const resumeId = typeof input?.resumeId === 'string' && input.resumeId ? input.resumeId.slice(0, 200) : '';
    const projectId = typeof input?.projectId === 'string' ? input.projectId.slice(0, 200) : '';
    // 快照可能因 TTL 刷新并追加 Skill reset；必须先完成刷新，再读取本次请求历史。
    const snapshots = await this.LoadOrCreateSnapshots(sessionId, scenarioId);
    this.EnsureModuleSnapshotCompatible(snapshots.module);
    if (assistantStateChanged) await this.PersistSessionAssistantState(sessionId, { model, confirmationMode, reasoningEffort });
    const projectRoot = await this.BindProjectEnvironment(sessionId, projectId);
    const profiles = (await this.business?.GetProfiles?.())?.items ?? [];
    const resumeSnapshot = resumeId ? (await this.resumeReadPort.ReadCurrent(resumeId)) ?? null : null;
    const resumeEditing = resumeId ? this.resumePort.IsUserEditing(resumeId) : false;
    const runtimeContext = { resumeEditing, resume: resumeSnapshot, profiles, attachments, projectId };
    const history = this.histories.get(sessionId) || [];
    const sessionLoadedSkills = this.loadedSkills.get(sessionId) ?? new Map<string, string>();
    const sessionLoadedResources = this.loadedSkillResources.get(sessionId) ?? new Set<string>();
    this.loadedSkills.set(sessionId, sessionLoadedSkills);
    this.loadedSkillResources.set(sessionId, sessionLoadedResources);
    const loadedSkillsBeforeRun = new Map(sessionLoadedSkills);
    const loadedResourcesBeforeRun = new Set(sessionLoadedResources);
    const RestoreSkillState = () => {
      sessionLoadedSkills.clear();
      loadedSkillsBeforeRun.forEach((version, id) => sessionLoadedSkills.set(id, version));
      sessionLoadedResources.clear();
      loadedResourcesBeforeRun.forEach((resource) => sessionLoadedResources.add(resource));
    };
    const messagesBeforeUser: AgentMessage[] = history.some((message: AgentMessage) => message.metadata?.kind === 'skill_index' && message.metadata.snapshotId === snapshots.skills.snapshotId)
      ? []
      : [this.skillRegistry.CreateIndexMessage(snapshots.skills)];
    const explicitSkill = this.skillRegistry.MatchExplicitCommand(userContent, snapshots.skills);
    const alreadyLoadedVersion = explicitSkill
      ? [...sessionLoadedSkills.entries()].find(([id]) => id.toLowerCase() === explicitSkill.manifest.id.toLowerCase())?.[1]
      : undefined;
    const messagesAfterUser: AgentMessage[] = explicitSkill && alreadyLoadedVersion !== explicitSkill.manifest.version
      ? [this.skillRegistry.Load(snapshots.skills, scenarioId, { skillId: explicitSkill.manifest.id }).message]
      : [];
    const snapshot = this.modules.contextBuilder.CreateDynamicSnapshot(sessionId, runtimeContext);
    const baseRequestHistory = snapshot.changed ? [...history, snapshot.message] : history;
    const usesVisionInput = SupportsVisionInput(status.provider, model);
    const resolveAttachment = (uri: string) => this.business?.ResolveAttachmentUri?.(uri) ?? Promise.resolve(null);
    const requestHistory: AgentMessage[] = usesVisionInput
      ? await Promise.all(baseRequestHistory.map((message: AgentMessage) => HydrateVisionMessage(message, resolveAttachment)))
      : baseRequestHistory;
    const userMessage = usesVisionInput
      ? await CreateVisionUserMessage(userContent, attachments, resolveAttachment)
      : { role: 'user' as const, content: userContent };
    const controller = new AbortController();
    this.modules.observability.RecordLog('INFO', 'conversation.send', `session=${sessionId}`);
    this.modules.observability.StartTrace(requestId, sessionId, model);
    this.pendingQuestions.delete(sessionId);
    const activeTools = this.HydrateToolSnapshot(snapshots.tool, scenarioId)
      .filter((tool: any) => runScenario.toolNames.includes(tool.definition.function.name));
    const activeToolNames = activeTools.map((tool: any) => tool.definition.function.name);
    const missingScenarioTools = runScenario.toolNames.filter((name) => !activeToolNames.includes(name));
    if (missingScenarioTools.length) {
      throw new Error(`Active tool registry does not match the ${scenario.id} scenario: missing=${missingScenarioTools.join(',') || 'none'}.`);
    }
    const { contextLimit, threshold } = this.modules.modelProvider.GetRuntimeLimits();
    const runSnapshot = CreateRunSnapshot({
      snapshotId: randomUUID(),
      sessionId,
      sessionRevision: snapshots.session.sessionRevision,
      scenario: runScenario,
      instructions: snapshots.instructions,
      tools: activeTools,
      dataScope: {
        ...(projectId ? { projectId } : {}),
        ...(projectRoot ? { projectRoot } : {}),
        ...(resumeId ? { resumeId } : {}),
        attachmentPaths: attachments.map((attachment: any) => attachment.path),
      },
      provider: {
        moduleName: this.modules.modelProvider.name,
        moduleVersion: this.modules.modelProvider.version,
        model,
        capabilities: [...this.modules.modelProvider.capabilities],
        contextLimit,
        compressionThreshold: threshold,
      },
    });
    // 函数型调度元数据不进入状态文件；可序列化副本保留完整授权清单、Prompt、数据范围与 Provider 选择供审计/恢复。
    this.runSnapshots.set(requestId, JSON.parse(JSON.stringify(runSnapshot)));
    while (this.runSnapshots.size > 100) {
      const oldestRunId = this.runSnapshots.keys().next().value as string | undefined;
      if (oldestRunId === undefined) break;
      this.runSnapshots.delete(oldestRunId);
    }
    this.SaveState();
    const contextContent = this.modules.contextBuilder.SerializeSessionContext(snapshots.session);
    const systemPrompt = ScrubTraceContent(contextContent);
    const tracedUserMessage = ScrubTraceContent(userContent);
    this.modules.observability.AppendTraceEvent(requestId, 'system_prompt', { content: systemPrompt }, EstimateTraceTokens(systemPrompt));
    this.modules.observability.AppendTraceEvent(requestId, 'user_message', { content: tracedUserMessage }, EstimateTraceTokens(tracedUserMessage));
    const sessionTasks = this.tasks.get(sessionId) ?? new Map();
    this.tasks.set(sessionId, sessionTasks);
    const toolContext = {
      sessionId,
      requestId,
      confirmationMode,
      resumeEditing,
      projectRoot,
      attachments,
      profileSnapshot: profiles,
      resumeSnapshot,
      resumeId: resumeId || undefined,
      ports: {
        file: this.fileReader,
        resumeRead: this.resumeReadPort,
        resumeWrite: this.resumeWritePort,
        profileWrite: {
          Save: async ({ profiles: nextProfiles }: any) => {
            const saved = await this.business?.SaveProfiles?.(nextProfiles, false);
            if (!saved || !Number.isSafeInteger(saved.count)) throw new Error('Profile persistence is unavailable.');
            return { count: saved.count };
          },
        },
        browser: scenarioId === 'application' ? this.browserRuntime : undefined,
        skill: {
          Load: async (skillInput: { skillId: string; resource?: string }) => this.skillRegistry.Load(snapshots.skills, scenarioId, skillInput),
        },
        ...(!unattended ? { cronTask: {
          PrepareCreate: async (cronInput: Record<string, unknown>) => this.PrepareCronTask(cronInput, { requestId, ...(resumeId ? { resumeId } : {}) }),
          Read: async (cronInput: { cronTaskId?: string; includeRuns?: boolean }) => this.business.ReadCronTask(cronInput),
          Update: async (cronInput: Record<string, unknown>) => {
            const task = await this.business.UpdateCronTask(cronInput);
            try { await this.onCronScheduleChanged(); }
            catch (error) {
              if (task.state === 'active') await this.business.UpdateCronTask({ cronTaskId: task.id, state: 'paused' });
              await Promise.resolve(this.onCronScheduleChanged()).catch(() => undefined);
              throw Object.assign(new Error('CronTask was saved as paused because the operating-system wake could not be registered.'), { code: 'INTERNAL_ERROR', cause: error });
            }
            return task;
          },
          Delete: async (cronTaskId: string) => { const result = await this.business.DeleteCronTask(cronTaskId); await this.onCronScheduleChanged(); return result; },
        } } : {}),
        ...(scenarioId === 'application' ? { applicationTracking: {
          Read: async (filters: { company?: string; title?: string; url?: string } = {}) => {
            const view = await this.business.LoadViewModel();
            const allJobs = Array.isArray(view.jobs) ? view.jobs : [];
            const allApplications = Array.isArray(view.applications) ? view.applications : [];
            const maxRecords = 200;
            const NormalizeText = (value: unknown) => String(value ?? '').trim().toLocaleLowerCase();
            const NormalizeUrl = (value: unknown) => {
              try {
                const url = new URL(String(value ?? ''));
                url.hash = '';
                url.pathname = url.pathname.replace(/\/+$/, '') || '/';
                return url.toString().toLocaleLowerCase();
              } catch { return NormalizeText(value); }
            };
            const hasFilters = Boolean(filters.company || filters.title || filters.url);
            const matchedJobs = hasFilters ? allJobs.filter((job: any) => (
              (!filters.company || NormalizeText(job.company).includes(NormalizeText(filters.company)))
              && (!filters.title || NormalizeText(job.title).includes(NormalizeText(filters.title)))
              && (!filters.url || NormalizeUrl(job.url) === NormalizeUrl(filters.url))
            )) : allJobs;
            const matchedJobIds = new Set(matchedJobs.map((job: any) => job.id));
            const matchedApplications = hasFilters ? allApplications.filter((application: any) => matchedJobIds.has(application.jobId)) : allApplications;
            return {
              jobs: matchedJobs.slice(0, maxRecords),
              applications: matchedApplications.slice(0, maxRecords),
              truncated: matchedJobs.length > maxRecords || matchedApplications.length > maxRecords,
            };
          },
          Update: async (trackingInput: Record<string, unknown>) => this.business.UpdateApplicationTracking(trackingInput),
        } } : {}),
      },
      tasks: sessionTasks,
      pendingEdits: this.pendingEdits,
      pendingQuestions: this.pendingQuestions,
      pendingBrowserActions: this.pendingBrowserActions,
      ledger: this.CreateToolLedgerPort(),
      runId: requestId,
      scenarioSnapshotId: runSnapshot.snapshotId,
      scenarioId,
      emit: (event: unknown) => this.Emit(event),
      persistSessionState: () => this.SaveState(),
      loadedSkills: sessionLoadedSkills,
      loadedSkillResources: sessionLoadedResources,
      pendingSkillLoads: new Set<string>(),
      unattended,
    };
    const runtimeControl = { sessionId, confirmationMode, toolContext };
    this.runtimeControls.set(requestId, runtimeControl);
    this.controllers.set(requestId, controller);
    try {
      let modelRequestCompleted = false;
      const result = await RunAgentLoop({
        requestId, sessionId, model: runSnapshot.provider.model, reasoningEffort,
        systemContext: contextContent, requestHistory, userContent, userMessage,
        messagesBeforeUser, messagesAfterUser,
        histories: this.histories,
        toolArray: runSnapshot.tools,
        modules: this.modules, toolContext,
        emit: (event: unknown) => this.Emit(event),
        signal: controller.signal, maxTurns: runSnapshot.scenario.budgets?.maxModelTurns ?? 30,
        runtimeReminder: {
          confirmationMode,
          getConfirmationMode: () => runtimeControl.confirmationMode,
          interval: runSnapshot.scenario.id === 'application' ? 10 : 5,
          timeZone: RuntimeTimeZone,
          getLoadedSkillIds: () => [...sessionLoadedSkills.keys()],
        },
        contextLimit, thresholdPercent: threshold,
        createId: () => randomUUID(),
        scenario: runSnapshot.scenario,
        instructions: runSnapshot.instructions,
        onModelUsage: (usage) => { modelRequestCompleted = true; this.RecordSessionUsage(requestId, sessionId, usage, contextLimit, threshold); },
      });
      if (result.outcome === 'cancelled') RestoreSkillState();
      this.compressionCount += result.compressionCount;
      const currentUsage = this.sessionUsage.get(sessionId);
      if (currentUsage?.source === 'actual') {
        currentUsage.compressionCount += result.compressionCount;
        currentUsage.contextLimit = contextLimit;
        currentUsage.compressionThreshold = threshold;
        currentUsage.updatedAt = Date.now();
        this.lastContextUsage = { inputTokens: currentUsage.inputTokens, contextLimit };
      } else if (!modelRequestCompleted) {
        this.sessionUsage.set(sessionId, {
          source: 'unavailable', inputTokens: 0, contextLimit, compressionCount: result.compressionCount, compressionThreshold: threshold,
          promptTokens: 0, completionTokens: 0, totalTokens: 0, reportedRequestCount: 0, unreportedRequestCount: 1, updatedAt: Date.now(),
        });
      }
      this.SaveState();
      return { accepted: true, ...(result.outcome === 'cancelled' ? { cancelled: true } : {}) };
    } catch (error) {
      RestoreSkillState();
      this.SaveState();
      throw error;
    } finally {
      this.controllers.delete(requestId);
      this.runtimeControls.delete(requestId);
    }
    } finally {
      if (this.browserRunId === requestId) this.browserRunId = null;
    }
  }

  /** 聚合运行时内存态与可观测性库数据，供开发者界面展示脱敏日志与 Trace。 */
  async GetObservability(): Promise<any> {
    const status = await this.modules.modelProvider.GetStatus();
    const { contextLimit, threshold } = this.modules.modelProvider.GetRuntimeLimits();
    const contextUsage = { ...(this.lastContextUsage ?? { inputTokens: 0, contextLimit }), compressionCount: this.compressionCount, compressionThreshold: threshold };
    const logs = await this.modules.observability.GetLogs();
    const traces = await this.modules.observability.GetTraces();
    return { configured: status.configured, model: status.model, historySessions: this.histories.size, taskCount: [...this.tasks.values()].reduce((count: number, tasks: Map<string, any>) => count + tasks.size, 0), contextUsage, logs: logs ?? [...this.modules.observability.SnapshotLocalLogs()].reverse(), traces: traces ?? [] };
  }

  /** 按请求标识读取开发者主动展开的 Trace 事件。 */
  GetTraceEvents(requestId: string): any { return this.modules.observability.GetTraceEvents(requestId); }
  /** 按会话删除对应的 Trace 索引及其事件，不影响日志或业务会话。 */
  DeleteTraces(sessionIds: string[]): any { return this.modules.observability.DeleteTraces(sessionIds); }
  /** 更新开发者可见的 Trace 留存量，不接收任何敏感配置。 */
  SetTraceRetention(value: number): any { return this.modules.observability.SetTraceRetention(value); }
  /** 清空开发者模式可见的日志与 Trace，不影响会话、任务和 API 配置。 */
  ClearObservability(): any { return this.modules.observability.ClearObservability(); }
}
