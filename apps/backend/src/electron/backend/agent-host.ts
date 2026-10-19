import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { readFile, realpath } from 'node:fs/promises';
import * as path from 'node:path';
import { RunAgentLoop } from '@avery/agent-core';
import { CreateRunSnapshot, HostSdkVersion, ResolveModules } from '@avery/agent-module-host';
import { ApplicationScenario, BuildApplicationCompiledInstructions, BuildDefaultCompiledInstructions, CreateDefaultModules, DefaultScenario, ScenarioPolicyVersion } from '@avery/agent-modules-defaults';
import { IsRuntimeContextMessage } from '@avery/agent-sdk';
import type { AgentMessage, AgentModules, AgentStreamEvent, BossContactPort, BrowserAutomationPort, BrowserEngine, CompiledInstructions, ConfirmationMode, JobLibraryPort, KernelCheckpoint, ProviderUsageFact, ReasoningEffort, ResumeSnapshot, ScenarioSnapshot, SkillSnapshot } from '@avery/agent-sdk';
import { AgentFileReader } from './agent-file-reader';
import { ConversationRecorder } from './conversation-recorder';
import { ReadConversationResource } from './conversation-resource-reader';
import { AgentResumePort } from './agent-resume-port';
import { ResumeLockStore } from './resume-lock-store';
import { CreateVisionUserMessage, HydrateVisionMessage, SupportsVisionInput } from './vision-input';
import { AgentBrowserRuntime } from './agent-browser-runtime';
import { BrowserExtensionBridge, type BrowserTaskCleanupOutcome } from './browser-extension-bridge';
import { AgentSkillRegistry } from './agent-skill-registry';
import { CollectBossJobsToLibrary } from './job-collection-service';
import { CreateAgentJobLibrary } from './agent-job-library';
import type { JobLibraryCollectionService } from './job-library-collection-service';
import { BossContactService } from './boss-contact-service';
import { AgentInteractionResponseSchema, BrowserTaskGrantSchema, CreateCronTaskSchema, type AgentInteractionResponse, type AgentSendRequest, type BrowserTaskGrant, type BrowserTaskGrantPurpose } from '@avery/contracts';

/** 一个逻辑 Run 的等待点；状态、决定和结果与历史共用原子状态文件，不包含模型凭据。 */
interface PausedAgentRun {
  input: AgentSendRequest;
  checkpoint: KernelCheckpoint;
  interactionId: string;
  kind: 'approval' | 'answer';
  status: 'waiting' | 'executing' | 'ready' | 'resuming';
  result?: AgentMessage;
  event?: AgentStreamEvent;
}

/** 用户编辑锁的稳定 ownerId；前端经 bridge 加解锁都以此为准。 */
const UserLockOwnerId = 'user-main';
const SessionSnapshotTtlMs = 24 * 60 * 60 * 1000;
const RuntimeTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
type SupportedProvider = 'DeepSeek' | 'Z.AI' | 'MIMO' | '自定义';

function NormalizeProvider(value: unknown, fallback: SupportedProvider = 'DeepSeek'): SupportedProvider {
  return value === 'DeepSeek' || value === 'Z.AI' || value === 'MIMO' || value === '自定义' ? value : fallback;
}

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
    promptTokens: number('promptTokens'), completionTokens: number('completionTokens'), totalTokens: number('totalTokens'), cachedInputTokens: number('cachedInputTokens'), reportedRequestCount: number('reportedRequestCount'), unreportedRequestCount: number('unreportedRequestCount'), updatedAt: number('updatedAt'),
  };
}

/** 会话级助手偏好不含凭据；模型仅保存可公开的 Provider 模型 ID。 */
interface SessionAssistantState {
  provider: SupportedProvider;
  model: string;
  confirmationMode: ConfirmationMode;
  reasoningEffort: ReasoningEffort;
}

interface SessionResumeBinding {
  resumeId: string;
  revision?: number;
  boundAt: number;
}

function NormalizeSessionResumeBinding(value: unknown): SessionResumeBinding | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as { resumeId?: unknown; revision?: unknown; boundAt?: unknown };
  if (typeof candidate.resumeId !== 'string' || !candidate.resumeId || candidate.resumeId.length > 200) return null;
  if (!Number.isFinite(candidate.boundAt)) return null;
  if (candidate.revision !== undefined && !Number.isSafeInteger(candidate.revision)) return null;
  return { resumeId: candidate.resumeId, ...(candidate.revision !== undefined ? { revision: candidate.revision as number } : {}), boundAt: candidate.boundAt as number };
}

function NormalizeSessionAssistantState(value: unknown): SessionAssistantState | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as { provider?: unknown; model?: unknown; confirmationMode?: unknown; reasoningEffort?: unknown };
  if (typeof candidate.model !== 'string') return null;
  const model = candidate.model.trim();
  if (!model || model.length > 200) return null;
  const inferredProvider: SupportedProvider = model === 'glm-5.3-flash' ? 'Z.AI' : model.startsWith('mimo-') ? 'MIMO' : model.startsWith('deepseek-') ? 'DeepSeek' : '自定义';
  return { provider: NormalizeProvider(candidate.provider, inferredProvider), model, confirmationMode: NormalizeConfirmationMode(candidate.confirmationMode), reasoningEffort: NormalizeReasoningEffort(candidate.reasoningEffort) };
}

/** 校验字符串字段，避免 IPC 输入直接进入请求层。 */
function RequireString(value: unknown, field: string, maxLength = 20000): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maxLength) throw new Error(`${field} is invalid.`);
  return value.trim();
}

type BrowserTaskGrantDraft = Omit<BrowserTaskGrant, 'grantedAt' | 'revokedAt'>;

/** 未明确表达外部写入时按岗位搜索收窄；确认页会展示最终推断结果。 */
function InferBrowserTaskGrant(input: { title: string; message: string }, resources: { resumeId?: string; profileIds?: string[] }): BrowserTaskGrantDraft {
  const text = `${input.title}\n${input.message}`.toLocaleLowerCase();
  const bossContact = /(?:boss|直聘).{0,20}(?:打招呼|沟通|联系|发消息|发送消息)|(?:打招呼|联系招聘者|contact recruiter|send message)/i.test(text);
  const application = /投递|申请|网申|填写(?:申请|表单)|填表|提交(?:申请|简历)|上传(?:简历|附件)|\bapply\b|application form|submit application|fill (?:in )?(?:the )?form|upload (?:a )?resume/i.test(text);
  const purpose: BrowserTaskGrantPurpose = bossContact ? 'boss_contact' : application ? 'job_application' : 'job_search';
  const allowFormFill = purpose !== 'job_search';
  const resourceIds = [
    ...(resources.resumeId ? [`resume:${resources.resumeId}`] : []),
    ...(allowFormFill ? (resources.profileIds ?? []).map((id) => `profile:${id}`) : []),
  ];
  return {
    mode: 'personal_browser_extension',
    purpose,
    allowNavigation: true,
    allowFormFill,
    // 第一版 CronTask 不继承临时附件；没有持久文件资源时不得承诺后台上传。
    allowFileUpload: false,
    allowExternalSend: purpose !== 'job_search',
    resourceIds: [...new Set(resourceIds)],
  };
}

function BrowserGrantSummary(grant: BrowserTaskGrantDraft): string {
  const purpose = grant.purpose === 'job_search' ? '岗位搜索/读取' : grant.purpose === 'boss_contact' ? 'BOSS 沟通' : '企业官网投递';
  const permissions = [
    grant.allowNavigation && '导航和读取',
    grant.allowFormFill && '填写表单或消息',
    grant.allowFileUpload && '上传文件',
    grant.allowExternalSend && '发送消息或提交',
  ].filter(Boolean).join('、');
  return `任务用途：${purpose}；授权能力：${permissions || '无浏览器写入'}；冻结持久资源：${grant.resourceIds.length} 项。`;
}

type AgentHostBrowserRuntime = BrowserAutomationPort & {
  Close(): Promise<void>;
  GetBrowserTaskId?(): string | undefined;
  /** 收回当前交互 browserTaskId，保留共享扩展 Bridge 以便后续任务复用。 */
  CloseTask?(options?: { deadline: number }): Promise<BrowserTaskCleanupOutcome | void>;
  ResetPageReferences(): void;
  GetStatus(probeConnection?: boolean): Promise<unknown>;
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
  externalBrowserPaths?: Partial<Record<'chrome' | 'edge', string>>;
  browserExtensionBridge?: BrowserExtensionBridge;
  /** 桌面主进程复用现有 PDF/PNG 渲染；仅 Backend AgentHost 能接收生成路径。 */
  renderResumeFile?: (input: { resume: { name: string; summary: string; content: string }; format: 'pdf' | 'png'; assetId: string }) => Promise<{ path: string; fileName: string }>;
  /** 构造期 Skill 固定目录测试接缝；生产环境使用应用内置 skills 目录。 */
  skillRootPath?: string;
  /** 构造期测试接缝；生产组合根不传入，不能由 Renderer、IPC 或环境变量选择。 */
  createDefaultModules?: (ports: Parameters<typeof CreateDefaultModules>[0]) => AgentModules;
  /** 构造期测试接缝；用于完整链路测试连接精确本地 fixture origin。 */
  browserRuntime?: AgentHostBrowserRuntime;
  /** 构造期测试接缝；生产环境在组合根绑定与岗位页面共享的持久采集服务。 */
  jobLibraryPort?: JobLibraryPort;
  /** 测评宿主专用接缝：生产组合根不传入，候选 Prompt 只能在隔离 AgentHost 内生效。 */
  compileInstructions?: (scenarioId: 'default' | 'application', toolPolicyHash: string) => CompiledInstructions;
  /** 测评宿主专用冻结场景；可收窄工具和轮数，不能由生产 Renderer 请求设置。 */
  scenarioOverride?: ScenarioSnapshot;
  /** Cron 数据写入后的 OS 唤醒同步由 Backend 组合根提供。 */
  onCronScheduleChanged?: () => Promise<void> | void;
  /** Cleanup deadline test seam; production defaults to six seconds. */
  browserTaskCleanupTimeoutMs?: number;
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
  private EmitPresentation: (event: unknown) => void;
  private requestSessions = new Map<string, string>();
  private business: any;
  private workspacePath: string;
  private renderResumeFile?: AgentHostOptions['renderResumeFile'];
  private generatedAssets = new Map<string, { sessionId: string; physicalPath: string; name: string; mimeType: 'application/pdf' | 'image/png' }>();
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
  private pausedRuns = new Map<string, PausedAgentRun>();
  private interactionDecisions = new Map<string, AgentInteractionResponse>();
  /** 旧执行释放与重复确认使用独立屏障；不依赖 Renderer 保存的 IPC Promise。 */
  private runReleases = new Map<string, Promise<unknown>>();
  private executingSessions = new Set<string>();
  private interactionFlights = new Map<string, Promise<{ accepted: boolean; requestId: string; replayed?: boolean }>>();
  private structuredInteractionRequests = new Set<string>();
  private browserRunId: string | null = null;
  private browserSessionId: string | null = null;
  private currentSessionId: string | null = null;
  /**
   * Host 侧的 task 收尾幂等屏障。Runtime 会在 CloseTask 前把自身引用清空，
   * 但测试接缝/迟到 promise 可能暂时仍返回旧 ID；同一 Host 生命周期内绝不
   * 对已经进入收尾的 task 再发第二次 CloseTask。
   */
  private closedBrowserTaskIds = new Set<string>();
  private toolLedger = new Map<string, any>();
  private projectEnvironments = new Map<string, any>();
  private sessionSnapshots = new Map<string, any>();
  private runSnapshots = new Map<string, any>();
  private sessionUsage = new Map<string, any>();
  private sessionScenarios = new Map<string, 'default' | 'application'>();
  private sessionAssistantStates = new Map<string, SessionAssistantState>();
  private sessionResumeBindings = new Map<string, SessionResumeBinding>();
  private loadedSkills = new Map<string, Map<string, string>>();
  private loadedSkillResources = new Map<string, Set<string>>();
  private lastContextUsage: { inputTokens: number; contextLimit: number } = { inputTokens: 0, contextLimit: 256000 };
  private compressionCount = 0;
  private fileReader: AgentFileReader;
  private resumePort: AgentResumePort;
  private resumeReadPort: AgentResumePort;
  private resumeWritePort: AgentResumePort;
  private browserRuntime: AgentHostBrowserRuntime;
  private jobLibraryPort: JobLibraryPort | null = null;
  private bossContactPort: BossContactPort | null = null;
  private createDefaultModules: (ports: Parameters<typeof CreateDefaultModules>[0]) => AgentModules;
  private moduleError: string | null = null;
  private moduleConfiguration: any = { enabled: false, trusted: false, status: 'default', directoryName: null, modules: [] };
  private moduleSnapshot: any = null;
  private modules: any;
  private compileInstructions: (scenarioId: 'default' | 'application', toolPolicyHash: string) => CompiledInstructions;
  private scenarioOverride?: ScenarioSnapshot;
  private readonly defaultBrowserEngine: BrowserEngine;
  private readonly browserTaskCleanupTimeoutMs: number;
  /** 旧 pending binding 只允许显式注入的测试 Runtime 适配器读取；生产组合根永不打开此兼容口。 */
  private readonly allowLegacyBrowserBindings: boolean;
  private skillRegistry: AgentSkillRegistry;
  private onCronScheduleChanged: () => Promise<void> | void;
  private scheduledRequestIds = new Set<string>();
  private conversationRecorders = new Map<string, ConversationRecorder>();
  private scheduledOutput = new Map<string, { content: string; thinkingContent: string; terminal?: string; needsAttention: boolean }>();

  constructor(options: AgentHostOptions) {
    this.EmitPresentation = options.Emit;
    this.statePath = path.join(options.userDataPath, 'agent-state.json');
    this.moduleConfigPath = path.join(options.userDataPath, 'agent-modules.json');
    this.Emit = (event: any) => {
      if (event?.requestId && !event.sessionId) event = { ...event, sessionId: this.requestSessions.get(event.requestId) };
      const recorder = typeof event?.requestId === 'string' ? this.conversationRecorders.get(event.requestId) : undefined;
      if (recorder) {
        event = { ...event, sessionId: event.sessionId ?? recorder.sessionId };
        recorder.Accept(event);
      }
      const output = typeof event?.requestId === 'string' ? this.scheduledOutput.get(event.requestId) : undefined;
      if (output) {
        if (event.type === 'content_delta' && typeof event.delta === 'string') output.content += event.delta;
        if (event.type === 'thinking_delta' && typeof event.delta === 'string') output.thinkingContent += event.delta;
        if (['completed', 'cancelled', 'error', 'waiting_user_input', 'waiting_confirmation', 'paused'].includes(event.type)) output.terminal = event.type;
        if (event.type === 'browser_user_action' || event.type === 'question_requested' || event.type === 'waiting_user_input' || event.type === 'waiting_confirmation' || event.type === 'paused') output.needsAttention = true;
      }
      options.Emit(event);
    };
    this.business = options.business;
    this.workspacePath = options.workspacePath;
    this.renderResumeFile = options.renderResumeFile;
    this.observabilityPort = options.observability;
    this.credentialPort = options.credentialPort;
    this.resolveProjectEnvironment = options.resolveProjectEnvironment ?? (() => null);
    this.onCronScheduleChanged = options.onCronScheduleChanged ?? (() => undefined);
    this.fileReader = new AgentFileReader((uri: string) => this.business?.ResolveAttachmentMarkdownUri?.(uri) ?? Promise.resolve(null));
    this.resumePort = new AgentResumePort({ lockStore: options.resumeLockStore ?? new ResumeLockStore(), business: this.business });
    this.resumeReadPort = this.resumePort;
    this.resumeWritePort = this.resumePort;
    this.createDefaultModules = options.createDefaultModules ?? CreateDefaultModules;
    this.compileInstructions = options.compileInstructions ?? ((scenarioId, toolPolicyHash) => scenarioId === 'application'
      ? BuildApplicationCompiledInstructions(toolPolicyHash)
      : BuildDefaultCompiledInstructions(toolPolicyHash));
    this.scenarioOverride = options.scenarioOverride;
    this.defaultBrowserEngine = options.externalBrowserPaths?.edge
        ? 'edge'
        : options.externalBrowserPaths?.chrome
          ? 'chrome'
          : 'edge';
    this.browserTaskCleanupTimeoutMs = Number.isSafeInteger(options.browserTaskCleanupTimeoutMs) && (options.browserTaskCleanupTimeoutMs as number) > 0
      ? Math.min(options.browserTaskCleanupTimeoutMs as number, 30_000)
      : 6_000;
    this.allowLegacyBrowserBindings = options.browserRuntime !== undefined;
    this.skillRegistry = new AgentSkillRegistry(options.skillRootPath);
    this.browserRuntime = options.browserRuntime ?? new AgentBrowserRuntime({
      externalBrowserPaths: options.externalBrowserPaths,
      browserExtensionBridge: options.browserExtensionBridge ?? new BrowserExtensionBridge({
        statePath: path.join(options.userDataPath, 'browser-extension', 'bridge.json'),
        browserPaths: options.externalBrowserPaths,
      }),
      runtimeRoot: path.join(options.userDataPath, 'browser-runtime'),
      resolveUploadFile: async (fileId) => {
        const generated = this.generatedAssets.get(fileId);
        if (generated) return generated.physicalPath;
        const resolved = await this.business?.ResolveAttachmentUri?.(fileId);
        return typeof resolved === 'string' ? resolved : resolved?.physicalPath ?? null;
      },
      recordLog: (level, event, detail) => options.observability?.RecordLog?.(level, event, detail),
    });
    this.jobLibraryPort = options.jobLibraryPort ?? null;
    if (typeof this.browserRuntime.EvaluateTrustedPage === 'function') {
      this.bossContactPort = new BossContactService({
        browser: this.browserRuntime,
        loadViewModel: () => this.business.LoadViewModel(),
        saveJob: (input) => this.business.SaveTrackedJob(input),
        resolveAsset: async (assetId) => {
          const generated = this.generatedAssets.get(assetId);
          return generated ? { name: generated.name, mimeType: generated.mimeType, physicalPath: generated.physicalPath } : this.business.ResolveAttachmentUri(assetId);
        },
        readResume: (resumeId) => this.resumeReadPort.ReadCurrent(resumeId),
        getBrowserStatus: () => this.browserRuntime.GetStatus(true),
        createBatch: (input) => this.business.CreateBossContactBatch(input),
        checkpointBatch: (batchId, jobId, step, result) => this.business.CheckpointBossContactBatch(batchId, jobId, step, result),
        finishBatch: (batchId, status, result) => this.business.FinishBossContactBatch(batchId, status, result),
      });
    }
    this.moduleError = null;
    this.moduleConfiguration = { enabled: false, trusted: false, status: 'default', directoryName: null, modules: [] };
    this.modules = this.BuildModules();
    this.LoadState();
  }

  SetWorkspacePath(workspacePath: string): void {
    this.workspacePath = workspacePath;
    this.generatedAssets.clear();
  }

  /** 组合根注入同一个采集实例；Agent采集沿用当前运行的浏览器及Cron授权，不走页面独占启动流程。 */
  SetJobLibraryCollectionService(collection: JobLibraryCollectionService, assertBrowserAvailable: () => void = () => undefined): void {
    this.jobLibraryPort = CreateAgentJobLibrary({ collection,
      query: (query) => this.business.ReadJobLibrary(query),
      collectBoss: (input) => { assertBrowserAvailable(); return CollectBossJobsToLibrary(this.browserRuntime, input); },
    });
  }

  async Close(): Promise<void> {
    await this.browserRuntime.Close();
    this.generatedAssets.clear();
    this.browserSessionId = null;
    this.browserRunId = null;
  }

  /** 仅从已绑定的当前简历生成文件；资源 ID 在当前会话授权，物理路径只留在 Host。 */
  private async ExportBoundResumeFile(resume: ResumeSnapshot, format: 'pdf' | 'png', sessionId: string, signal?: AbortSignal): Promise<{ fileId: string; fileName: string; mimeType: 'application/pdf' | 'image/png'; resumeId: string; resumeRevision: number; sizeBytes: number; sha256: string }> {
    if (!this.renderResumeFile) throw Object.assign(new Error('Resume file export is unavailable.'), { code: 'RESUME_EXPORT_UNAVAILABLE' });
    if (signal?.aborted) throw Object.assign(new Error('Resume file export was cancelled.'), { code: 'CANCELLED' });
    if (!Number.isSafeInteger(resume.revision) || (resume.revision as number) < 1) throw Object.assign(new Error('The bound resume revision is unavailable.'), { code: 'RESUME_BINDING_STALE' });
    const assetId = randomUUID();
    const exported = await this.renderResumeFile({ resume: { name: resume.name, summary: resume.summary ?? '', content: resume.content }, format, assetId });
    const assetRoot = await realpath(path.join(this.workspacePath, 'exports', 'agent-resume-files', assetId));
    const physicalPath = await realpath(exported.path);
    if (path.dirname(physicalPath) !== assetRoot || path.basename(physicalPath) !== exported.fileName || path.extname(physicalPath).toLowerCase() !== `.${format}`) throw Object.assign(new Error('The exported resume path is invalid.'), { code: 'RESUME_EXPORT_INVALID' });
    const bytes = await readFile(physicalPath);
    if (bytes.length === 0 || bytes.length > 25 * 1024 * 1024) throw Object.assign(new Error('The exported resume exceeds the browser upload size limit.'), { code: 'RESUME_EXPORT_INVALID' });
    const validPdf = format === 'pdf' && bytes.subarray(0, 5).equals(Buffer.from('%PDF-'));
    const validPng = format === 'png' && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    if (!validPdf && !validPng) throw Object.assign(new Error('The exported resume format is invalid.'), { code: 'RESUME_EXPORT_INVALID' });
    const current = await this.resumeReadPort.ReadCurrent(resume.id);
    if (signal?.aborted) throw Object.assign(new Error('Resume file export was cancelled.'), { code: 'CANCELLED' });
    if (!current || current.revision !== resume.revision) throw Object.assign(new Error('The resume changed during export. Read it again before exporting.'), { code: 'RESUME_BINDING_STALE' });
    const fileId = `asset://resume/${assetId}`;
    const mimeType = format === 'pdf' ? 'application/pdf' : 'image/png';
    this.generatedAssets.set(fileId, { sessionId, physicalPath, name: exported.fileName, mimeType });
    return { fileId, fileName: exported.fileName, mimeType, resumeId: resume.id, resumeRevision: resume.revision as number, sizeBytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  }

  /** 会话删除后清除全部会话私有运行态；Tool Ledger 与 Trace 作为外部动作审计继续保留。 */
  DeleteSessionResources(sessionId: string): void {
    for (const [fileId, asset] of this.generatedAssets) if (asset.sessionId === sessionId) this.generatedAssets.delete(fileId);
    const requestIds = new Set<string>();
    for (const [requestId, owner] of this.requestSessions) {
      if (owner === sessionId) requestIds.add(requestId);
    }
    for (const [requestId, snapshot] of this.runSnapshots) {
      if (snapshot?.sessionId === sessionId) requestIds.add(requestId);
    }
    for (const [requestId, control] of this.runtimeControls) {
      if (control.sessionId !== sessionId) continue;
      requestIds.add(requestId);
      this.controllers.get(requestId)?.abort();
    }
    this.histories.delete(sessionId);
    this.tasks.delete(sessionId);
    this.pendingQuestions.delete(sessionId);
    this.projectEnvironments.delete(sessionId);
    this.sessionSnapshots.delete(sessionId);
    this.sessionUsage.delete(sessionId);
    this.sessionScenarios.delete(sessionId);
    this.sessionAssistantStates.delete(sessionId);
    this.sessionResumeBindings.delete(sessionId);
    this.loadedSkills.delete(sessionId);
    this.loadedSkillResources.delete(sessionId);
    for (const [confirmationId, pending] of this.pendingEdits) {
      if ((pending as any)?.sessionId === sessionId) this.pendingEdits.delete(confirmationId);
    }
    for (const [confirmationId, pending] of this.pendingBrowserActions) {
      if (requestIds.has((pending as any)?.requestId)) this.pendingBrowserActions.delete(confirmationId);
    }
    for (const [confirmationId, pending] of this.pendingCronTasks) {
      if (requestIds.has((pending as any)?.requestId)) this.pendingCronTasks.delete(confirmationId);
    }
    for (const requestId of requestIds) {
      this.pausedRuns.delete(requestId);
      this.runSnapshots.delete(requestId);
      this.requestSessions.delete(requestId);
      this.conversationRecorders.get(requestId)?.Dispose();
      this.conversationRecorders.delete(requestId);
    }
    for (const [id, response] of this.interactionDecisions) if (response.sessionId === sessionId) this.interactionDecisions.delete(id);
    this.SaveState();
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
        sdkVersion: String((descriptor as any).sdkVersion || HostSdkVersion),
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

  /** 岗位页短期占用同一授权浏览器；同步加锁防止 Agent/Cron 与采集互相导航或清理。 */
  async WithCollectionBrowser<T>(taskId: string, run: (browser: BrowserAutomationPort) => Promise<T>): Promise<T> {
    if (this.IsBusy()) throw Object.assign(new Error('Agent 正在运行，请稍后采集 BOSS 岗位。'), { code: 'AGENT_BUSY' });
    this.browserRunId = taskId;
    try {
      await this.SyncBrowserEngine(true);
      await this.CloseBrowserTask();
      this.browserSessionId = null;
      await this.browserRuntime.SetUnattended?.(false);
      this.browserRuntime.ResetPageReferences();
      return await run(this.browserRuntime);
    } finally {
      await this.CloseBrowserTask();
      if (this.browserRunId === taskId) this.browserRunId = null;
    }
  }

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
      this.sessionResumeBindings = new Map((Array.isArray(state.sessionResumeBindings) ? state.sessionResumeBindings : [])
        .map(([sessionId, value]: [string, unknown]) => [sessionId, NormalizeSessionResumeBinding(value)] as const)
        .filter(([sessionId, value]: readonly [string, SessionResumeBinding | null]) => typeof sessionId === 'string' && value !== null) as Array<[string, SessionResumeBinding]>);
      this.toolLedger = new Map((Array.isArray(state.toolLedger) ? state.toolLedger : [])
        .filter((entry: unknown) => Array.isArray(entry) && typeof entry[0] === 'string' && entry[1] && typeof entry[1] === 'object'));
      this.pendingBrowserActions = new Map((Array.isArray(state.pendingBrowserActions) ? state.pendingBrowserActions : [])
        .filter((entry: unknown) => Array.isArray(entry) && typeof entry[0] === 'string' && entry[1] && typeof entry[1] === 'object'));
      this.pendingCronTasks = new Map((Array.isArray(state.pendingCronTasks) ? state.pendingCronTasks : [])
        .filter((entry: unknown) => Array.isArray(entry) && typeof entry[0] === 'string' && entry[1] && typeof entry[1] === 'object'));
      this.pendingEdits = new Map(Array.isArray(state.pendingEdits) ? state.pendingEdits : []);
      this.pendingQuestions = new Map(Array.isArray(state.pendingQuestions) ? state.pendingQuestions : []);
      this.pausedRuns = new Map(Array.isArray(state.pausedRuns) ? state.pausedRuns : []);
      this.interactionDecisions = new Map(Array.isArray(state.interactionDecisions) ? state.interactionDecisions : []);
      // 进程中断时执行结果不可猜测，也不能重放有副作用的原操作。
      for (const run of this.pausedRuns.values()) {
        if (run.status === 'executing') {
          run.result = { role: 'tool', tool_call_id: run.checkpoint.pendingCall.id, content: JSON.stringify({ ok: false, code: 'STATUS_UNKNOWN', message: 'The application stopped while handling this interaction. Verify the target state; do not repeat the action automatically.' }) };
          run.status = 'ready';
        } else if (run.status === 'resuming') run.status = 'ready';
      }
      this.requestSessions = new Map((Array.isArray(state.requestSessions) ? state.requestSessions : [])
        .filter((entry: unknown) => Array.isArray(entry) && typeof entry[0] === 'string' && typeof entry[1] === 'string'));
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
      sessionResumeBindings: [...this.sessionResumeBindings.entries()],
      toolLedger: [...this.toolLedger.entries()],
      pendingBrowserActions: [...this.pendingBrowserActions.entries()],
      pendingCronTasks: [...this.pendingCronTasks.entries()],
      pendingEdits: [...this.pendingEdits.entries()],
      pendingQuestions: [...this.pendingQuestions.entries()],
      pausedRuns: [...this.pausedRuns.entries()],
      interactionDecisions: [...this.interactionDecisions.entries()],
      requestSessions: [...this.requestSessions.entries()],
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
  /**
   * 查询指定 Provider 当前凭据可访问的模型；缺省 DeepSeek。显式未知 Provider 传给模块层按错误拒绝，
   * 不静默归一化——归一化会把其它供应商的模型列表交出去并被合并进错误的供应商。
   */
  GetModels(provider?: unknown): any {
    this.EnsureModulesReady();
    return this.modules.modelProvider.GetModels(provider === undefined ? 'DeepSeek' : typeof provider === 'string' ? provider : String(provider));
  }

  /** 返回全部已配置 Provider 的模型目录；不包含 Base URL 之外的私有配置或凭据。 */
  GetProviderCatalog(): any { this.EnsureModulesReady(); return this.modules.modelProvider.GetProviderCatalog(); }
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

  /** 取消在途或等待中的逻辑 Run；取消不是批准，迟到的决定不得再启动任务。 */
  async Cancel(requestId: string): Promise<any> {
    const controller = this.controllers.get(requestId);
    controller?.abort();
    const paused = this.pausedRuns.get(requestId);
    if (paused) {
      this.pausedRuns.delete(requestId);
      this.DiscardPendingInteraction(paused);
      const result: AgentMessage = { role: 'tool', tool_call_id: paused.checkpoint.pendingCall.id, content: JSON.stringify({ ok: false, code: paused.status === 'executing' ? 'STATUS_UNKNOWN' : 'CANCELLED', message: 'The user cancelled this run. Do not resume or repeat its pending action.' }) };
      this.histories.set(paused.input.sessionId, [...(this.histories.get(paused.input.sessionId) ?? []), result, ...paused.checkpoint.remainingResults]);
      this.SaveState();
      this.Emit({ type: 'cancelled', requestId, sessionId: paused.input.sessionId });
      await this.conversationRecorders.get(requestId)?.Flush();
      if (this.browserSessionId === paused.input.sessionId && !controller) await this.CloseBrowserTask();
    }
    return { cancelled: Boolean(controller || paused) };
  }

  /** 丢弃已消费或取消的交互提案；不删除审计账本，也不把未执行操作记作成功。 */
  private DiscardPendingInteraction(run: PausedAgentRun): void {
    this.pendingEdits.delete(run.interactionId);
    this.pendingCronTasks.delete(run.interactionId);
    this.pendingBrowserActions.delete(run.interactionId);
    this.pendingQuestions.delete(run.input.sessionId);
  }

  /** 统一审批与问答入口；决定只绑定原等待点，重试不能再次执行原操作。 */
  async RespondToInteraction(value: unknown): Promise<{ accepted: boolean; requestId: string; replayed?: boolean }> {
    const parsed = AgentInteractionResponseSchema.safeParse(value);
    if (!parsed.success) throw Object.assign(new Error('交互响应格式无效。'), { code: 'VALIDATION_ERROR' });
    const response = parsed.data;
    // 卡片事件可能先于 Kernel 检查点；等待宿主释放，不能把用户的早确认静默丢弃。
    await this.runReleases.get(response.requestId);
    const previous = this.interactionDecisions.get(response.interactionId);
    const signature = (decision: AgentInteractionResponse) => JSON.stringify({ ...decision, ...(decision.kind === 'answer' ? { answers: Object.fromEntries(Object.entries(decision.answers).sort(([a], [b]) => a.localeCompare(b))) } : {}) });
    if (previous && signature(previous) !== signature(response)) throw Object.assign(new Error('该交互已经提交了不同的决定。'), { code: 'REVISION_CONFLICT' });
    const running = this.interactionFlights.get(response.interactionId);
    if (running) return running;
    const run = this.pausedRuns.get(response.requestId);
    if (!run || run.interactionId !== response.interactionId) {
      if (previous) return { accepted: true, requestId: response.requestId, replayed: true };
      throw Object.assign(new Error('该交互已失效或任务已取消，请刷新会话状态。'), { code: 'VALIDATION_ERROR' });
    }
    if (run.input.sessionId !== response.sessionId || this.requestSessions.get(response.requestId) !== response.sessionId) throw Object.assign(new Error('交互不属于当前会话。'), { code: 'VALIDATION_ERROR' });
    if (response.kind !== 'cancel' && response.kind !== run.kind) throw Object.assign(new Error('交互响应类型不匹配。'), { code: 'VALIDATION_ERROR' });
    if (response.kind === 'answer') {
      const questions = this.pendingQuestions.get(response.sessionId) as Array<{ id: string }> | undefined;
      if (!previous && (!Array.isArray(questions) || questions.length !== Object.keys(response.answers).length || questions.some((question) => !response.answers[question.id]?.trim()))) throw Object.assign(new Error('请回答全部问题，且不要提交额外的问题 ID。'), { code: 'VALIDATION_ERROR' });
    }
    this.interactionDecisions.set(response.interactionId, response);
    this.SaveState();
    const promise = this.ResumeInteraction(run, response).finally(() => this.interactionFlights.delete(response.interactionId));
    this.interactionFlights.set(response.interactionId, promise);
    return promise;
  }

  /** 后端等待旧执行释放，执行被冻结的动作，再用真实工具结果恢复同一个逻辑 Run。 */
  private async ResumeInteraction(run: PausedAgentRun, response: AgentInteractionResponse): Promise<{ accepted: boolean; requestId: string }> {
    const { requestId, sessionId } = response;
    await this.runReleases.get(requestId);
    if (this.pausedRuns.get(requestId) !== run) throw Object.assign(new Error('任务已取消或会话已删除。'), { code: 'CANCELLED' });
    if (response.kind === 'cancel') {
      await this.Cancel(requestId);
      return { accepted: true, requestId };
    }
    if (this.browserRunId || [...this.runtimeControls.values()].some((control) => control.sessionId === sessionId)) throw Object.assign(new Error('已有任务正在执行，请稍后重试此决定。'), { code: 'AGENT_BUSY' });
    const recorder = await this.RestoreConversationRecorder(requestId, sessionId);
    this.Emit({ type: 'run_resumed', requestId, sessionId, confirmationId: response.interactionId });
    if (!run.result) {
      run.status = 'executing';
      this.SaveState();
      const controller = new AbortController();
      this.controllers.set(requestId, controller);
      let payload: Record<string, unknown>;
      try {
        if (response.kind === 'answer') {
          const questions = this.pendingQuestions.get(sessionId);
          const draft = JSON.parse(run.checkpoint.pendingResult.content) as { draftId?: string; uncertainItems?: unknown };
          payload = draft.draftId
            ? { ok: false, code: 'DRAFT_REVIEWED', draftId: draft.draftId, uncertainItems: draft.uncertainItems, questions, answers: response.answers, saved: false, message: 'The user reviewed these uncertain facts. No resume was saved. Apply the answers, remove confirmed markers, and use the resume write tool if appropriate.' }
            : { ok: true, questions, answers: response.answers };
        } else if (this.pendingEdits.has(run.interactionId)) {
          const proposal = this.pendingEdits.get(run.interactionId) as { resumeId?: string; idempotencyKey?: string };
          this.structuredInteractionRequests.add(requestId);
          const result = await this.ConfirmResumeEdit(run.interactionId, response.approved);
          const receipt = proposal.idempotencyKey ? (await this.CreateToolLedgerPort().FindByIdempotencyKey(proposal.idempotencyKey))?.receipt : undefined;
          payload = { ok: result.applied === true, resumeId: proposal.resumeId, ...(receipt ? { receipt } : {}), ...(response.approved ? {} : { code: 'USER_REJECTED' }), ...result };
        } else if (this.pendingCronTasks.has(run.interactionId)) {
          this.structuredInteractionRequests.add(requestId);
          const result = await this.ConfirmCronTask(run.interactionId, response.approved);
          payload = { ok: result.created === true, ...(response.approved ? {} : { code: 'USER_REJECTED' }), ...result };
        } else if (this.pendingBrowserActions.has(run.interactionId)) {
          this.structuredInteractionRequests.add(requestId);
          const result = await this.ConfirmBrowserAction(run.interactionId, response.approved, { sessionId, signal: controller.signal });
          payload = { ok: result.status === 'succeeded', ...result, ...(result.status === 'status_unknown' ? { code: 'STATUS_UNKNOWN', message: 'Verify the target state. Do not automatically repeat this action.' } : result.status === 'rejected' ? { code: 'USER_REJECTED' } : {}) };
        } else {
          payload = { ok: false, code: 'STATUS_UNKNOWN', message: 'The proposal is unavailable. Verify the actual state; do not repeat the action automatically.' };
        }
      } catch (error) {
        payload = { ok: false, code: typeof error === 'object' && error && 'code' in error ? String(error.code) : 'INTERACTION_FAILED', message: error instanceof Error ? error.message : 'Interaction failed.' };
      } finally {
        this.structuredInteractionRequests.delete(requestId);
        if (this.controllers.get(requestId) === controller) this.controllers.delete(requestId);
      }
      // 删除会话或取消可能发生在外部动作 await 中，不能让迟到回执复活任务。
      if (this.pausedRuns.get(requestId) !== run) {
        if (!this.browserRunId && this.browserSessionId === sessionId) await this.CloseBrowserTask();
        return { accepted: true, requestId };
      }
      run.result = { role: 'tool', tool_call_id: run.checkpoint.pendingCall.id, content: JSON.stringify(payload) };
      run.status = 'ready';
      this.DiscardPendingInteraction(run);
      this.SaveState();
      this.modules.observability.AppendTraceEvent(requestId, 'interaction_resolved', { interactionId: run.interactionId, toolCallId: run.checkpoint.pendingCall.id, kind: response.kind, approved: response.kind === 'approval' ? response.approved : undefined, ok: payload.ok, code: payload.code });
      await recorder?.ResolveInteraction(response.kind === 'answer' || response.approved, payload.ok === true ? 'succeeded' : payload.code === 'USER_REJECTED' ? 'skipped' : 'failed', response.kind === 'answer' ? '已收到用户回答' : undefined, true);
    }
    this.DiscardPendingInteraction(run);
    run.status = 'resuming';
    this.SaveState();
    try { await this.StartRun(run.input, run); }
    catch (error) {
      if (this.pausedRuns.get(requestId) === run) { run.status = 'ready'; this.SaveState(); }
      this.Emit({ type: 'error', requestId, sessionId, message: error instanceof Error ? error.message : '恢复任务失败，请重试。' });
      throw error;
    }
    return { accepted: true, requestId };
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
  async ConfirmResumeEdit(confirmationId: string, accepted: boolean): Promise<any> {
    const pending = this.pendingEdits.get(confirmationId) as { kind?: string; sessionId?: string; resumeId?: string; ownerId?: string } | undefined;
    const requestId = pending?.ownerId?.replace(/^agent-/, '');
    if (requestId && pending?.sessionId) await this.RestoreConversationRecorder(requestId, pending.sessionId);
    let result: { applied: boolean };
    try {
      result = await this.modules.interaction.ConfirmResumeEdit(confirmationId, accepted, {
        requestId,
        runId: requestId,
        pendingEdits: this.pendingEdits,
        ports: { resumeWrite: this.resumeWritePort },
        ledger: this.CreateToolLedgerPort(),
        emit: (event: object) => this.Emit({ ...event, requestId, sessionId: pending?.sessionId }),
      });
    } catch (error) {
      // 一次性提案无论执行是否成功均已消费；失败也必须结束原消息的等待态。
      if (requestId && !this.pendingEdits.has(confirmationId)) await this.SettleConversationInteraction(requestId, pending?.sessionId, accepted, 'failed', '简历确认未能完成，请核对当前简历后继续。');
      throw error;
    } finally {
      this.SaveState();
    }
    if (result.applied && pending?.kind === 'edit' && pending.sessionId && pending.resumeId) {
      const current = await this.resumeReadPort.ReadCurrent(pending.resumeId);
      if (current) {
        this.sessionResumeBindings.set(pending.sessionId, { resumeId: current.id, ...(current.revision !== undefined ? { revision: current.revision } : {}), boundAt: Date.now() });
        this.SaveState();
      }
    }
    this.SaveState();
    if (requestId) await this.SettleConversationInteraction(requestId, pending?.sessionId, result.applied === true);
    return result;
  }

  /** 冻结 CronTask 创建参数；简历是可选授权资源，纯岗位搜索和 JD 阅读不得被强制绑定。 */
  private PrepareCronTask(input: unknown, context: { requestId: string; resumeId?: string; profileIds?: string[] }): { confirmationId: string; summary: string; scenarioId: 'default' | 'application' } {
    const parsed = CreateCronTaskSchema.parse(input);
    const confirmationId = `cron-confirmation-${randomUUID()}`;
    const browserTaskGrantDraft = parsed.scenarioId === 'application' ? InferBrowserTaskGrant(parsed, context) : undefined;
    const summary = parsed.scenarioId === 'application'
      ? `系统可在计划时间唤醒或后台启动应用。${BrowserGrantSummary(browserTaskGrantDraft!)}确认创建即冻结以上 BrowserTaskGrant，并允许任务在整个周期内以无人值守模式执行；执行时不会逐项确认。授权只属于此任务，任务结束、删除或手动撤销后失效；登录失效、验证码或站点风控时任务会暂停。${context.resumeId ? '任务可通过 ReadResume 读取创建前已绑定的简历；第一版不携带临时附件，网页要求上传文件时会标记为需要你接管。' : '当前未绑定简历；任何需要简历内容或投递状态写入的步骤都必须停止并请你接管。'}`
      : '系统可在计划时间唤醒或后台启动应用。该计划将在整个周期内以无人值守完全信任模式创建新会话并执行指定消息；执行时不会逐项确认。';
    this.pendingCronTasks.set(confirmationId, { input: parsed, resumeId: context.resumeId, browserTaskGrantDraft, requestId: context.requestId, createdAt: Date.now(), summary });
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
    if (!accepted) {
      await this.SettleConversationInteraction(pending.requestId, this.requestSessions.get(pending.requestId), false);
      return { created: false };
    }
    try {
    if (!Number.isFinite(pending.createdAt) || Date.now() - pending.createdAt > SessionSnapshotTtlMs) {
      throw Object.assign(new Error('CronTask confirmation expired. Create the schedule again.'), { code: 'VALIDATION_ERROR' });
    }
    const browserTaskGrant = pending.input.scenarioId === 'application'
      ? BrowserTaskGrantSchema.parse({ ...pending.browserTaskGrantDraft, grantedAt: new Date().toISOString() })
      : undefined;
    const task = await this.business.CreateCronTask(pending.input, {
      ...(pending.resumeId ? { resumeId: pending.resumeId } : {}),
      ...(browserTaskGrant ? { browserTaskGrant } : {}),
    });
    try {
      await this.onCronScheduleChanged();
    } catch (error) {
      await this.business.DeleteCronTask(task.id);
      await Promise.resolve(this.onCronScheduleChanged()).catch(() => undefined);
      throw Object.assign(new Error('CronTask could not register the operating-system wake and was cancelled.'), { code: 'INTERNAL_ERROR', cause: error });
    }
    this.Emit({ type: 'cron_task_changed', requestId: pending.requestId, cronTask: task });
    await this.SettleConversationInteraction(pending.requestId, this.requestSessions.get(pending.requestId), true);
    return { created: true, task };
    } catch (error) {
      await this.SettleConversationInteraction(pending.requestId, this.requestSessions.get(pending.requestId), accepted, 'failed', '定时任务确认未能完成，请核对任务列表后继续。');
      throw error;
    }
  }

  /** 执行被冻结的浏览器提案；确认后仍重新校验页面 revision 和目标引用，拒绝模型重建动作。 */
  async ConfirmBrowserAction(confirmationId: string, accepted: boolean, execution: { signal?: AbortSignal; sessionId?: string } = {}): Promise<any> {
    const normalizedId = RequireString(confirmationId, 'confirmationId', 200);
    if (this.browserRunId) throw Object.assign(new Error('Another browser Agent run is already active.'), { code: 'AGENT_BUSY' });
    const confirmationRunId = `confirmation:${normalizedId}`;
    this.browserRunId = confirmationRunId;
    let resolved: { requestId: string; sessionId: string; accepted: boolean; outcome: 'succeeded' | 'failed' | 'skipped'; summary?: string } | undefined;
    const pending = this.pendingBrowserActions.get(normalizedId) as any;
    try {
    if (!pending) throw Object.assign(new Error('Browser confirmation is unavailable or expired.'), { code: 'VALIDATION_ERROR' });
    const pendingTaskId = typeof pending.browserTaskId === 'string' && pending.browserTaskId.length > 0 ? pending.browserTaskId : null;
    const pendingTaskIdentityValid = pending.browserTaskId === null
      || (typeof pending.browserTaskId === 'string' && pending.browserTaskId.length > 0);
    const currentTaskId = this.browserRuntime.GetBrowserTaskId?.() ?? null;
    if (typeof pending.sessionId !== 'string'
      || pending.sessionId !== execution.sessionId
      || pending.sessionId !== this.currentSessionId
      || pendingTaskId !== currentTaskId) {
      this.pendingBrowserActions.delete(normalizedId);
      this.SaveState();
      throw Object.assign(new Error('Browser confirmation belongs to a different session or browser task.'), { code: 'BROWSER_CONFIRMATION_SESSION_MISMATCH' });
    }
    const binding = pending.binding;
    const proposal = pending.proposal;
    const uploadRequiresBinding = proposal?.toolName === 'BrowserUploadFile';
    // Versioned production records require the explicit proposalId field; a
    // proposalHash is a content digest, not an authorization identity.
    const proposalId = typeof proposal?.proposalId === 'string' && proposal.proposalId.length > 0
      ? proposal.proposalId
      : '';
    const proposalHash = typeof proposal?.proposalHash === 'string' && proposal.proposalHash.length > 0
      ? proposal.proposalHash
      : '';
    const canonicalFileId = typeof proposal?.canonicalArguments?.fileId === 'string'
      ? proposal.canonicalArguments.fileId
      : '';
    const canonicalRef = typeof proposal?.canonicalArguments?.ref === 'string'
      ? proposal.canonicalArguments.ref
      : '';
    // 生产 pending 记录带 bindingVersion；所有身份字段一起比较，不能因为
    // toolName 看似安全就绕过 session/task/run/proposal/page/file 绑定。
    const bindingMatches = pending.bindingVersion === 1
      && Boolean(binding)
      && pendingTaskIdentityValid
      && typeof pending.sessionId === 'string'
      && pending.sessionId.length > 0
      && typeof pending.runId === 'string'
      && pending.runId.length > 0
      && proposalId.length > 0
      && proposalHash.length > 0
      && typeof binding.sessionId === 'string'
      && binding.sessionId.length > 0
      && binding.sessionId === pending.sessionId
      && binding.browserTaskId === pendingTaskId
      && (binding.browserTaskId === null || (typeof binding.browserTaskId === 'string' && binding.browserTaskId.length > 0))
      && typeof binding.runId === 'string'
      && binding.runId.length > 0
      && binding.runId === pending.runId
      && typeof binding.proposalId === 'string'
      && binding.proposalId.length > 0
      && binding.proposalId === proposalId
      && typeof binding.proposalHash === 'string'
      && binding.proposalHash.length > 0
      && binding.proposalHash === proposalHash
      && Number.isSafeInteger(binding.pageRevision)
      && binding.pageRevision >= 0
      && Number.isSafeInteger(proposal?.pageRevision)
      && proposal.pageRevision >= 0
      && binding.pageRevision === proposal?.pageRevision
      && (!uploadRequiresBinding || (
        canonicalFileId.length > 0
        && canonicalRef.length > 0
        && typeof binding.fileId === 'string'
        && binding.fileId === canonicalFileId
        && typeof binding.ref === 'string'
        && binding.ref === canonicalRef
      ));
    // Legacy test/runtime ports predating bindingVersion may still carry a
    // complete hash/page binding. They are accepted only for an explicitly
    // injected test Runtime; every production tool path above always emits
    // version 1 and production IPC cannot reach this compatibility branch.
    const legacyBindingMatches = this.allowLegacyBrowserBindings
      && pending.bindingVersion === undefined
      && (!uploadRequiresBinding && !binding || Boolean(binding && (
        binding.sessionId === pending.sessionId
        && binding.browserTaskId === pendingTaskId
        && binding.runId === pending.runId
        && binding.proposalHash === proposal?.proposalHash
        && Number.isSafeInteger(binding.pageRevision)
        && binding.pageRevision >= 0
        && Number.isSafeInteger(proposal?.pageRevision)
        && proposal.pageRevision >= 0
        && binding.pageRevision === proposal?.pageRevision
        && (!uploadRequiresBinding || (
          canonicalFileId.length > 0
          && typeof binding.fileId === 'string'
          && binding.fileId === canonicalFileId
        ))
      )))
    if (!bindingMatches && !legacyBindingMatches) {
      this.pendingBrowserActions.delete(normalizedId);
      this.SaveState();
      throw Object.assign(new Error('Browser confirmation proposal binding is invalid or stale.'), { code: 'BROWSER_CONFIRMATION_BINDING_MISMATCH' });
    }
    // Consume before the first await. Two concurrent clicks must never both
    // observe the same pending record and execute the external action.
    this.pendingBrowserActions.delete(normalizedId);
    this.SaveState();
    // Runtime.Execute also re-prepares the frozen action. This read-only
    // revision check makes a changed page fail after the one-time pending
    // claim, while remaining compatible with older test/runtime ports that do
    // not expose a numeric pageRevision in GetStatus().
    try {
      const status = await this.browserRuntime.GetStatus(false);
      if (Number.isSafeInteger(proposal?.pageRevision) && Number.isSafeInteger(status?.pageRevision)
        && proposal.pageRevision !== status.pageRevision) {
        throw Object.assign(new Error('The browser page changed after this confirmation was shown.'), { code: 'BROWSER_CONFIRMATION_STALE' });
      }
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && String((error as { code: unknown }).code) === 'BROWSER_CONFIRMATION_STALE') throw error;
      // Execute remains the final authority for runtimes whose status probe is
      // unavailable; a probe failure must not turn a safe fail-closed action
      // into a guessed page/task selection.
    }
    if (!Number.isFinite(pending.createdAt) || Date.now() - pending.createdAt > SessionSnapshotTtlMs) {
      throw Object.assign(new Error('Browser confirmation expired. Take a new snapshot and prepare the action again.'), { code: 'VALIDATION_ERROR' });
    }
    if (!accepted) {
      if (pending.proposal?.toolName === 'ContactBossJobs') await this.bossContactPort?.Cancel(pending.proposal);
      const result = { confirmationId: normalizedId, status: 'rejected', summary: pending.proposal?.summary };
      this.Emit({ type: 'browser_action_completed', requestId: pending.requestId, confirmationId: normalizedId, browserAction: result });
      resolved = { requestId: pending.requestId, sessionId: pending.sessionId, accepted, outcome: result.status === 'succeeded' ? 'succeeded' : result.status === 'rejected' ? 'skipped' : 'failed', summary: result.status === 'status_unknown' ? '执行结果未知，请核对目标网站，禁止重复操作' : result.summary };
      return result;
    }
    if (execution.signal?.aborted) throw Object.assign(new Error('Browser action was cancelled before execution.'), { code: 'CANCELLED' });

    const ledger = this.CreateToolLedgerPort();
    const previous = await ledger.FindByIdempotencyKey(pending.idempotencyKey);
    if (previous?.status === 'succeeded' && previous.receipt) {
      const replayed = { confirmationId: normalizedId, status: 'succeeded', replayed: true, receipt: previous.receipt, summary: pending.proposal?.summary };
      this.Emit({ type: 'browser_action_completed', requestId: pending.requestId, confirmationId: normalizedId, browserAction: replayed });
      resolved = { requestId: pending.requestId, sessionId: pending.sessionId, accepted, outcome: replayed.status === 'succeeded' ? 'succeeded' : replayed.status === 'rejected' ? 'skipped' : 'failed', summary: replayed.status === 'status_unknown' ? '执行结果未知，请核对目标网站，禁止重复操作' : replayed.summary };
      return replayed;
    }
    if (previous?.status === 'status_unknown') {
      const unknown = { confirmationId: normalizedId, status: 'status_unknown', summary: pending.proposal?.summary, message: '该动作此前结果未知，请先在目标网站核对，不能自动重试。' };
      this.Emit({ type: 'browser_action_completed', requestId: pending.requestId, confirmationId: normalizedId, browserAction: unknown });
      resolved = { requestId: pending.requestId, sessionId: pending.sessionId, accepted, outcome: unknown.status === 'succeeded' ? 'succeeded' : unknown.status === 'rejected' ? 'skipped' : 'failed', summary: unknown.status === 'status_unknown' ? '执行结果未知，请核对目标网站，禁止重复操作' : unknown.summary };
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
      const timeoutMs = pending.proposal.toolName === 'ContactBossJobs' ? 600_000 : pending.proposal.toolName === 'BrowserFillForm' ? 120_000 : 30_000;
      const outcome = pending.proposal.toolName === 'ContactBossJobs'
        ? await this.bossContactPort!.Execute({ proposal: pending.proposal, signal: execution.signal, deadline: Date.now() + timeoutMs })
        : await this.browserRuntime.Execute({ proposal: pending.proposal, signal: execution.signal, deadline: Date.now() + timeoutMs });
      if (execution.signal?.aborted) throw Object.assign(new Error('Browser action completion arrived after cancellation.'), { code: 'CANCELLED' });
      if (outcome.status === 'status_unknown') {
        await ledger.Finish(ledgerId, 'status_unknown', { errorCode: 'BROWSER_STATUS_UNKNOWN', finishedAt: Date.now() });
        const unknown = { confirmationId: normalizedId, status: 'status_unknown', data: outcome.data, summary: pending.proposal.summary };
        this.Emit({ type: 'browser_action_completed', requestId: pending.requestId, confirmationId: normalizedId, browserAction: unknown });
        resolved = { requestId: pending.requestId, sessionId: pending.sessionId, accepted, outcome: unknown.status === 'succeeded' ? 'succeeded' : unknown.status === 'rejected' ? 'skipped' : 'failed', summary: unknown.status === 'status_unknown' ? '执行结果未知，请核对目标网站，禁止重复操作' : unknown.summary };
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
      resolved = { requestId: pending.requestId, sessionId: pending.sessionId, accepted, outcome: succeeded.status === 'succeeded' ? 'succeeded' : succeeded.status === 'rejected' ? 'skipped' : 'failed', summary: succeeded.status === 'status_unknown' ? '执行结果未知，请核对目标网站，禁止重复操作' : succeeded.summary };
      return succeeded;
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? String((error as { code: unknown }).code) : 'BROWSER_COMMAND_FAILED';
      const statusUnknown = code === 'CANCELLED' || (error && typeof error === 'object' && 'statusUnknown' in error && (error as { statusUnknown?: unknown }).statusUnknown === true);
      await ledger.Finish(ledgerId, statusUnknown ? 'status_unknown' : 'failed', { errorCode: code, finishedAt: Date.now() });
      const failed = { confirmationId: normalizedId, status: statusUnknown ? 'status_unknown' : 'failed', code, summary: pending.proposal.summary, message: error instanceof Error ? error.message : 'Browser action failed.' };
      this.Emit({ type: 'browser_action_completed', requestId: pending.requestId, confirmationId: normalizedId, browserAction: failed });
      resolved = { requestId: pending.requestId, sessionId: pending.sessionId, accepted, outcome: failed.status === 'succeeded' ? 'succeeded' : failed.status === 'rejected' ? 'skipped' : 'failed', summary: failed.status === 'status_unknown' ? '执行结果未知，请核对目标网站，禁止重复操作' : failed.summary };
      return failed;
    }
    } catch (error) {
      // 校验拒绝也可能消费旧提案，不能让原消息永久显示等待确认。
      if (pending && !resolved && !this.pendingBrowserActions.has(normalizedId)) {
        await this.SettleConversationInteraction(pending.requestId, pending.sessionId, accepted, 'failed', '浏览器确认已失效，请重新读取页面后继续。');
      }
      throw error;
    } finally {
      if (this.browserRunId === confirmationRunId) this.browserRunId = null;
      if (resolved) await this.SettleConversationInteraction(resolved.requestId, resolved.sessionId, resolved.accepted, resolved.outcome, resolved.summary);
    }
  }

  /** 测评 UserSimulator 只读检查被冻结提案；该方法未注册 IPC，生产 Renderer 无法获取参数。 */
  InspectPendingBrowserAction(confirmationId: string): any {
    const normalizedId = RequireString(confirmationId, 'confirmationId', 200);
    const pending = this.pendingBrowserActions.get(normalizedId) as any;
    if (!pending?.proposal) return null;
    const proposal = pending.proposal;
    // Inspect 是只读的测评接缝，但仍必须保留与生产确认相同的授权身份。
    // 旧 proposalHash 只是内容摘要，不能替代 proposalId。
    if (typeof proposal.proposalId !== 'string' || !proposal.proposalId.trim()) return null;
    const binding = pending.binding;
    return structuredClone({
      // 该方法不会注册到 Renderer IPC；检查结果显式携带确认绑定，调用方
      // 只能核对完整绑定，不能把 hash 或 toolName 当作授权依据。
      confirmationId: normalizedId,
      requestId: pending.requestId,
      sessionId: pending.sessionId,
      runId: pending.runId,
      browserTaskId: pending.browserTaskId,
      proposalId: proposal.proposalId,
      toolName: proposal.toolName,
      canonicalArguments: proposal.canonicalArguments,
      summary: proposal.summary,
      url: proposal.url,
      risk: proposal.risk,
      resourceIds: proposal.resourceIds,
      proposal: {
        proposalId: proposal.proposalId,
        proposalHash: proposal.proposalHash,
        toolName: proposal.toolName,
        canonicalArguments: proposal.canonicalArguments,
        pageRevision: proposal.pageRevision,
      },
      ...(binding ? {
        binding: {
          bindingVersion: pending.bindingVersion,
          sessionId: binding.sessionId,
          browserTaskId: binding.browserTaskId,
          runId: binding.runId,
          proposalId: binding.proposalId,
          proposalHash: binding.proposalHash,
          pageRevision: binding.pageRevision,
          ...(typeof binding.ref === 'string' ? { ref: binding.ref } : {}),
          ...(typeof binding.fileId === 'string' ? { fileId: binding.fileId } : {}),
        },
      } : {}),
    });
  }

  private async SyncBrowserEngine(force = false): Promise<void> {
    // 设置页可能在投递 Run 期间刷新状态；此时只保存偏好，不得关闭正在使用的浏览器。
    if (this.browserRunId && !force) return;
    const settings = (await this.business?.GetStoredSettings?.()) ?? {};
    const engine = settings.browserEngine === 'chrome' || settings.browserEngine === 'edge'
      ? settings.browserEngine
      : this.defaultBrowserEngine;
    await this.browserRuntime.SetEngine?.(engine);
  }

  /** 返回浏览器运行时状态；显式探测会做只读握手，Renderer 始终看不到本地物理路径。 */
  async GetBrowserRuntimeStatus(probeConnection: unknown = false): Promise<any> {
    if (typeof probeConnection !== 'boolean') throw Object.assign(new Error('probeConnection must be a boolean.'), { code: 'VALIDATION_ERROR' });
    await this.SyncBrowserEngine();
    return this.browserRuntime.GetStatus(probeConnection);
  }

  /** 返回投递 CronTask 的持久授权状态；不暴露任务消息、浏览器端点或本地路径。 */
  async GetCronBrowserAccess(): Promise<any> {
    const result = await this.business.ReadCronTask({});
    const tasks = (Array.isArray(result?.tasks) ? result.tasks : [])
      .filter((task: any) => task?.scenarioId === 'application' && task?.state === 'active')
      .map((task: any) => ({
        id: String(task.id), title: String(task.title).slice(0, 200), nextRunAt: typeof task.nextRunAt === 'number' ? task.nextRunAt : null,
        browserAuthorized: Boolean(task.browserTaskGrant && !task.browserTaskGrant.revokedAt),
        ...(task.browserTaskGrant ? { browserTaskGrant: task.browserTaskGrant } : {}),
      }));
    return { tasks };
  }

  async RevokeCronBrowserAccess(input: unknown): Promise<any> {
    if (this.IsBusy()) throw Object.assign(new Error('Stop the current Agent run before revoking CronTask browser access.'), { code: 'AGENT_BUSY' });
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw Object.assign(new Error('Cron browser access is invalid.'), { code: 'VALIDATION_ERROR' });
    const cronTaskId = RequireString((input as any).cronTaskId, 'cronTaskId', 200);
    const task = await this.business.RevokeCronTaskBrowserAuthorization(cronTaskId);
    return { revoked: Boolean(task?.browserTaskGrant?.revokedAt) || !task?.browserTaskGrant, task };
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
  private async ResolvePersistedSessionModel(value: unknown, provider: SupportedProvider, status: any): Promise<string> {
    const fallback = this.modules.modelProvider.ResolveRequestModel(undefined, provider);
    if (typeof value !== 'string' || !value.trim()) return fallback;
    let model: string;
    try {
      model = this.modules.modelProvider.ResolveRequestModel(value.trim(), provider);
    } catch {
      return fallback;
    }
    // /models 是 DeepSeek 的在线校验能力；MiMo 允许手工添加官方列表之外的新模型，会话恢复不按列表剔除。
    if (!status.configured || provider !== 'DeepSeek') return model;
    try {
      const result = await this.modules.modelProvider.GetModels(provider);
      const models = Array.isArray(result?.models) ? result.models.filter((item: unknown): item is string => typeof item === 'string') : [];
      if (!models.length || models.includes(model)) return model;
      if (models.includes(fallback)) return fallback;
      const providerFallback = models.find((item: string) => {
        try {
          return this.modules.modelProvider.ResolveRequestModel(item, provider) === item;
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
    const activeStatus = await this.modules.modelProvider.GetStatus();
    const provider = stored?.provider ?? NormalizeProvider(activeStatus.provider);
    const status = await this.modules.modelProvider.GetStatus(provider);
    const next: SessionAssistantState = {
      provider,
      model: await this.ResolvePersistedSessionModel(stored?.model, provider, status),
      confirmationMode: stored?.confirmationMode ?? 'always_confirm',
      reasoningEffort: stored?.reasoningEffort ?? 'medium',
    };
    if (!stored || stored.provider !== next.provider || stored.model !== next.model || stored.confirmationMode !== next.confirmationMode || stored.reasoningEffort !== next.reasoningEffort) {
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

  /** 经业务消息中的引用授权读取产物，资源路径不进入 IPC。 */
  async ReadConversationResource(sessionId: string, resource: import('@avery/contracts').ConversationResource): Promise<import('@avery/contracts').ConversationResourceView> {
    return ReadConversationResource(sessionId, resource, {
      workspacePath: this.workspacePath,
      presentations: (id) => this.business.GetConversationPresentations(id),
      workspace: () => this.business.LoadViewModel(), profiles: () => this.business.GetProfiles(),
      revisions: (id) => this.business.GetResumeRevisions(id), revision: (id, version) => this.business.GetResumeRevision(id, version),
    });
  }

  /** 待交互数据仅返回该会话，内部授权提案与浏览器绑定不传到页面。 */
  private GetPendingConversationEvents(sessionId: string): AgentStreamEvent[] {
    const events: AgentStreamEvent[] = [];
    for (const [id, value] of this.pendingEdits) {
      if (!value || typeof value !== 'object' || !id.startsWith('resume-confirmation-')) continue;
      const pending = value as { sessionId?: string; ownerId?: string; content?: string; reason?: string; resumeId?: string; name?: string };
      if (pending.sessionId === sessionId && typeof pending.content === 'string') events.push({
        type: 'resume_confirmation', sessionId, requestId: pending.ownerId?.replace(/^agent-/, ''), confirmationId: id,
        content: pending.content, reason: pending.reason, resumeId: pending.resumeId, resumeName: pending.name,
      });
    }
    for (const [id, pending] of this.pendingCronTasks) {
      if (this.requestSessions.get(pending.requestId) === sessionId) events.push({ type: 'cron_task_confirmation', sessionId, requestId: pending.requestId,
        confirmationId: id, cronTask: { title: pending.input?.title, message: pending.input?.message, schedule: pending.input?.schedule, summary: pending.summary, scenarioId: pending.input?.scenarioId } });
    }
    for (const [id, pending] of this.pendingBrowserActions) {
      if (pending.sessionId === sessionId) events.push({ type: 'browser_confirmation', sessionId, requestId: pending.requestId, browserAction: {
        confirmationId: id, toolName: pending.proposal?.toolName, summary: pending.proposal?.summary, url: pending.proposal?.url, risk: pending.proposal?.risk,
      } });
    }
    const questions = this.pendingQuestions.get(sessionId);
    const requestId = [...this.requestSessions].reverse().find((entry) => entry[1] === sessionId)?.[0];
    if (Array.isArray(questions) && requestId) events.push({ type: 'question_requested', requestId, sessionId, confirmationId: this.pausedRuns.get(requestId)?.interactionId, questions });
    for (const run of this.pausedRuns.values()) {
      if (run.input.sessionId === sessionId && run.event && !events.some((event) => (event.confirmationId ?? event.browserAction?.confirmationId) === run.interactionId)) events.push(run.event);
    }
    return events;
  }

  /** 交互结果归入产生它的 Run；只标记已核实的结果，不把未知执行状态当作成功。 */
  private async SettleConversationInteraction(requestId: string, sessionId: string | undefined, accepted: boolean, outcome?: 'succeeded' | 'failed' | 'skipped', summary?: string): Promise<void> {
    if (!sessionId) return;
    // 新协议由统一恢复入口在真实回执落盘后结算，旧底层确认方法不得提前终结整个 Run。
    if (this.pausedRuns.has(requestId) && this.structuredInteractionRequests.has(requestId)) return;
    const recorder = await this.RestoreConversationRecorder(requestId, sessionId);
    if (!recorder) return;
    await recorder.ResolveInteraction(accepted, outcome, summary);
    this.conversationRecorders.delete(requestId);
    const legacyRun = this.pausedRuns.get(requestId);
    if (legacyRun) {
      this.pausedRuns.delete(requestId);
      this.DiscardPendingInteraction(legacyRun);
      this.SaveState();
    }
  }

  /** 只恢复当前业务消息的投影，确认在重启后仍更新原始消息。 */
  private async RestoreConversationRecorder(requestId: string, sessionId: string): Promise<ConversationRecorder | undefined> {
    const existing = this.conversationRecorders.get(requestId);
    if (existing) return existing;
    if (typeof this.business?.GetConversationPresentations !== 'function') return undefined;
    const presentations: import('@avery/agent-sdk').ConversationPresentation[] = await this.business.GetConversationPresentations(sessionId);
    const initial = presentations.find((item) => item.requestId === requestId);
    if (!initial) return undefined;
    const recorder = new ConversationRecorder(requestId, sessionId, (id, value) => this.business.SaveConversationPresentation(id, value), (event) => this.EmitPresentation(event), initial);
    this.conversationRecorders.set(requestId, recorder);
    return recorder;
  }

  /** 返回会话专属 usage、项目标签及已校验的模型与确认权限；默认值绝不回退到其它会话。 */
  async GetSessionAssistantState(sessionId: string): Promise<any> {
    const normalizedSessionId = RequireString(sessionId, 'sessionId', 200);
    const assistantState = await this.RestoreSessionAssistantState(normalizedSessionId);
    const { contextLimit, threshold } = this.modules.modelProvider.GetRuntimeLimits(assistantState.provider);
    const storedUsage = this.sessionUsage.get(normalizedSessionId) ?? null;
    const project = this.projectEnvironments.get(normalizedSessionId) ?? null;
    return {
      tasks: [...(this.tasks.get(normalizedSessionId)?.values() ?? [])],
      pendingEvents: this.GetPendingConversationEvents(normalizedSessionId),
      activeRequestId: [...this.runtimeControls].find(([, control]) => control.sessionId === normalizedSessionId)?.[0],
      usage: {
        inputTokens: storedUsage?.inputTokens ?? 0,
        contextLimit: storedUsage?.contextLimit || contextLimit,
        compressionCount: storedUsage?.compressionCount ?? 0,
        compressionThreshold: storedUsage?.compressionThreshold || threshold,
        source: storedUsage?.source ?? 'unavailable',
        promptTokens: storedUsage?.promptTokens ?? 0,
        completionTokens: storedUsage?.completionTokens ?? 0,
        totalTokens: storedUsage?.totalTokens ?? 0,
        cachedInputTokens: storedUsage?.cachedInputTokens ?? 0,
        reportedRequestCount: storedUsage?.reportedRequestCount ?? 0,
        unreportedRequestCount: storedUsage?.unreportedRequestCount ?? 0,
      },
      project: project ? { projectId: project.projectId, name: project.name } : null,
      scenarioId: this.sessionScenarios.get(normalizedSessionId) ?? 'default',
      model: assistantState.model,
      provider: assistantState.provider,
      confirmationMode: assistantState.confirmationMode,
      reasoningEffort: assistantState.reasoningEffort,
    };
  }

  /** 批量返回会话场景映射（只读）；数据与 GetSessionAssistantState 同源，随宿主状态快照持久化。 */
  async GetSessionScenes(): Promise<Record<string, 'default' | 'application'>> {
    return Object.fromEntries(this.sessionScenarios);
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
    const base = previous?.source === 'actual' ? previous : { promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedInputTokens: 0, reportedRequestCount: 0, unreportedRequestCount: 0, compressionCount: 0 };
    const providerUsageIsValid = usage?.source === 'provider'
      && [usage.promptTokens, usage.completionTokens, usage.totalTokens, usage.cachedInputTokens].every((value) => Number.isSafeInteger(value) && value >= 0)
      && usage.totalTokens === usage.promptTokens + usage.completionTokens
      && usage.cachedInputTokens <= usage.promptTokens;
    if (!providerUsageIsValid) {
      this.RecordProviderUsageFact(requestId, { source: 'unavailable', promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedInputTokens: 0 });
      const next = previous?.source === 'actual'
        ? { ...previous, contextLimit, compressionThreshold: threshold, unreportedRequestCount: previous.unreportedRequestCount + 1, updatedAt: Date.now() }
        : {
          source: 'unavailable', inputTokens: 0, contextLimit, compressionCount: previous?.compressionCount ?? 0, compressionThreshold: threshold,
          promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedInputTokens: 0, reportedRequestCount: 0, unreportedRequestCount: (previous?.unreportedRequestCount ?? 0) + 1, updatedAt: Date.now(),
        };
      this.sessionUsage.set(sessionId, next);
      this.SaveState();
      return;
    }
    this.RecordProviderUsageFact(requestId, {
      source: 'provider', promptTokens: usage.promptTokens, completionTokens: usage.completionTokens, totalTokens: usage.totalTokens, cachedInputTokens: usage.cachedInputTokens,
    });
    const next = {
      source: 'actual', inputTokens: usage.promptTokens, contextLimit, compressionCount: base.compressionCount, compressionThreshold: threshold,
      promptTokens: base.promptTokens + usage.promptTokens, completionTokens: base.completionTokens + usage.completionTokens, totalTokens: base.totalTokens + usage.totalTokens, cachedInputTokens: base.cachedInputTokens + usage.cachedInputTokens,
      reportedRequestCount: base.reportedRequestCount + 1, unreportedRequestCount: base.unreportedRequestCount, updatedAt: Date.now(),
    };
    this.sessionUsage.set(sessionId, next);
    this.lastContextUsage = { inputTokens: next.inputTokens, contextLimit };
    this.modules.observability.RecordLog('INFO', 'context.usage', `${usage.promptTokens} / ${contextLimit} actual tokens`);
    this.SaveState();
  }

  /** 构建不可变的 Tool Array 快照：内置工具固定前缀、MCP 预留末尾；不保存 MCP 凭据。 */
  private HashToolPolicy(tools: any[]): string {
    const policy = tools.map((tool: any) => ({
      definition: tool.definition,
      timeoutMs: tool.timeoutMs,
      isConcurrencySafe: tool.isConcurrencySafe,
      sideEffect: tool.sideEffect,
      risk: tool.risk,
      confirmation: tool.confirmation,
      idempotency: tool.idempotency,
      limits: tool.limits,
      allowedScenarios: tool.allowedScenarios,
      requiredResources: tool.requiredResources,
    }));
    return createHash('sha256').update(JSON.stringify(policy)).digest('hex');
  }

  private BuildToolSnapshot(sessionId: string, sessionRevision: number, scenarioId: 'default' | 'application'): any {
    const registeredTools = this.modules.tools.GetToolDefinitions(scenarioId);
    const builtInTools = this.scenarioOverride
      ? registeredTools.filter((tool: any) => this.scenarioOverride?.toolNames.includes(tool.definition.function.name))
      : registeredTools;
    const orderedToolNames = builtInTools.map((tool: any) => tool.definition.function.name);
    const toolsetHash = this.HashToolPolicy(builtInTools);
    return { snapshotId: randomUUID(), sessionId, sessionRevision, scenarioId, scenarioPolicyVersion: ScenarioPolicyVersion, builtInTools, mcpTools: [], orderedToolNames, toolsetHash };
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
    const definitionsHash = this.HashToolPolicy(tool.builtInTools);
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
    const browserTaskGrant = input?.browserTaskGrant === undefined ? undefined : BrowserTaskGrantSchema.parse(input.browserTaskGrant);
    this.scheduledRequestIds.add(requestId);
    const output = { content: '', thinkingContent: '', needsAttention: false };
    this.scheduledOutput.set(requestId, output);
    await this.browserRuntime.SetUnattended?.(true, {
      cronTaskId: typeof input?.cronTaskId === 'string' ? input.cronTaskId : undefined,
      browserTaskGrant,
    });
    try {
      const result = await this.Send({ ...input, confirmationMode: 'fully_trusted', attachments: [], projectId: undefined });
      return { ...result, ...output };
    } finally {
      this.scheduledRequestIds.delete(requestId);
      this.scheduledOutput.delete(requestId);
      await this.browserRuntime.SetUnattended?.(false);
    }
  }

  private async CloseBrowserTask(): Promise<BrowserTaskCleanupOutcome | null> {
    const closeTask = this.browserRuntime.CloseTask;
    if (!closeTask) return null;
    const browserTaskId = this.browserRuntime.GetBrowserTaskId?.() ?? null;
    // 没有任务页时不应向 Bridge 发送 close_task(null)，也不应制造一个
    // 虚假的 cleanup failure；没有 GetBrowserTaskId 的旧 Runtime 仍保留旧兼容路径。
    if (browserTaskId && this.closedBrowserTaskIds.has(browserTaskId)) return null;
    if (!browserTaskId && this.browserRuntime.GetBrowserTaskId) return null;
    if (browserTaskId) this.closedBrowserTaskIds.add(browserTaskId);
    const deadline = Date.now() + this.browserTaskCleanupTimeoutMs;
    let timer: NodeJS.Timeout | undefined;
    try {
      const work = Promise.resolve(closeTask.call(this.browserRuntime, { deadline }));
      const timeout = new Promise<BrowserTaskCleanupOutcome>((resolveTimeout) => {
        timer = setTimeout(() => resolveTimeout({
          status: 'status_unknown', browserTaskId, code: 'BROWSER_COMMAND_TIMEOUT',
          message: 'The browser task cleanup exceeded its deadline.', closedTabs: 0, unknownTabs: null,
        }), Math.max(0, deadline - Date.now()));
      });
      const result = await Promise.race([work, timeout]);
      if (result && (result.status === 'confirmed' || result.status === 'status_unknown' || result.status === 'failed')) {
        return {
          ...result,
          browserTaskId: result.browserTaskId ?? browserTaskId,
          closedTabs: Number.isSafeInteger(result.closedTabs) ? result.closedTabs : 0,
          unknownTabs: Number.isSafeInteger(result.unknownTabs) ? result.unknownTabs : null,
        };
      }
      return { status: 'confirmed', browserTaskId, closedTabs: 0, unknownTabs: 0 };
    } catch (error) {
      const statusUnknown = Boolean(error && typeof error === 'object' && 'statusUnknown' in error && (error as { statusUnknown?: unknown }).statusUnknown === true);
      const code = error && typeof error === 'object' && 'code' in error ? String((error as { code: unknown }).code) : 'BROWSER_TASK_CLEANUP_FAILED';
      return {
        status: statusUnknown ? 'status_unknown' : 'failed', browserTaskId, code,
        message: error instanceof Error ? error.message.slice(0, 300) : 'Browser task cleanup failed.',
        closedTabs: 0, unknownTabs: statusUnknown ? null : 0,
      };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private RecordBrowserTaskCleanup(requestId: string, outcome: BrowserTaskCleanupOutcome, index: number): void {
    const now = Date.now();
    const ledgerId = `browser-cleanup-${randomUUID()}`;
    this.toolLedger.set(ledgerId, {
      ledgerId,
      runId: requestId,
      toolCallId: `cleanup-${index + 1}`,
      toolName: 'BrowserTaskCleanup',
      idempotencyKey: `browser-cleanup:${requestId}:${outcome.browserTaskId ?? index + 1}`,
      argumentsHash: createHash('sha256').update(JSON.stringify(outcome)).digest('hex'),
      actor: 'system',
      resourceIds: outcome.browserTaskId ? [`browser-task:${outcome.browserTaskId}`] : [],
      status: outcome.status === 'confirmed' ? 'succeeded' : outcome.status,
      ...(outcome.code ? { errorCode: outcome.code } : {}),
      startedAt: now,
      finishedAt: now,
      cleanupOutcome: outcome,
    });
    this.SaveState();
  }

  /** 在显式状态机内执行一次受限的流式对话回合：编排完成后委托 Kernel 运行循环。 */
  async Send(input: any): Promise<any> {
    const sessionId = RequireString(input?.sessionId, 'sessionId', 200);
    if ([...this.pausedRuns.values()].some((run) => run.input.sessionId === sessionId)) throw Object.assign(new Error('请先回答、确认或取消当前待处理交互。'), { code: 'AGENT_BUSY' });
    return this.StartRun(input);
  }

  /** 执行片段有独立释放屏障，但恢复继续使用原 requestId、历史与预算。 */
  private StartRun(input: any, resume?: PausedAgentRun): Promise<any> {
    const requestId = RequireString(input?.requestId, 'requestId', 200);
    const sessionId = RequireString(input?.sessionId, 'sessionId', 200);
    if (this.runReleases.has(requestId) || this.executingSessions.has(sessionId)) return Promise.reject(Object.assign(new Error('The session is already running.'), { code: 'AGENT_BUSY' }));
    if (this.requestSessions.has(requestId) && !resume) return Promise.reject(Object.assign(new Error('Run ID cannot be reused.'), { code: 'VALIDATION_ERROR' }));
    this.executingSessions.add(sessionId);
    const promise = this.ExecuteRun(input, resume).finally(() => {
      if (this.runReleases.get(requestId) === promise) this.runReleases.delete(requestId);
      this.executingSessions.delete(sessionId);
    });
    this.runReleases.set(requestId, promise);
    return promise;
  }

  private async ExecuteRun(input: any, resume?: PausedAgentRun): Promise<any> {
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
    // 后台不递归调度；工作场景后台禁止编辑简历和档案，聊天后台仍为只读。
    const runScenario = unattended ? { ...scenario, toolNames: scenario.toolNames.filter((name) => !cronToolNames.has(name)
      && !(scenarioId === 'application' && ['CreateResume', 'UpdateResume', 'UpdateProfile'].includes(name))) } : scenario;
    let retainBrowserTask = false;
    const cleanupOutcomes: BrowserTaskCleanupOutcome[] = [];
    if (this.browserRunId) throw Object.assign(new Error('Another browser Agent run is already active.'), { code: 'AGENT_BUSY' });
    try {
    if (scenarioId === 'application') {
      // 先同步占用，再进入任何 await；否则两个并发 Send 都可能通过上面的检查，
      // 后者切换/关闭前者刚创建的 browserTaskId。
      this.browserRunId = requestId;
      this.currentSessionId = sessionId;
      try {
        await this.SyncBrowserEngine(true);
        if (this.browserSessionId && this.browserSessionId !== sessionId) {
          // 一次交互任务只绑定一个会话；切换会话时只关闭旧 task 页，不关闭共享 Bridge。
          const cleanup = await this.CloseBrowserTask();
          if (cleanup) cleanupOutcomes.push(cleanup);
          this.browserSessionId = null;
        }
        this.browserSessionId = sessionId;
        // 页面元素引用不得跨 Run 复用；用户可能在两次发送之间接管可见浏览器并改变 DOM。
        this.browserRuntime.ResetPageReferences();
      } catch (error) {
        if (this.browserRunId === requestId) this.browserRunId = null;
        throw error;
      }
    } else {
      const switchingBrowserSession = Boolean(this.browserSessionId && this.browserSessionId !== sessionId);
      if (switchingBrowserSession) this.browserRunId = requestId;
      try {
        if (switchingBrowserSession) {
          const cleanup = await this.CloseBrowserTask();
          if (cleanup) cleanupOutcomes.push(cleanup);
          this.browserSessionId = null;
        }
        this.currentSessionId = sessionId;
      } finally {
        if (switchingBrowserSession && this.browserRunId === requestId) this.browserRunId = null;
      }
    }
    const restoredAssistantState = await this.RestoreSessionAssistantState(sessionId);
    const provider = NormalizeProvider(input?.provider, restoredAssistantState.provider);
    const status = await this.modules.modelProvider.GetStatus(provider);
    if (!status.configured) throw new Error(`${provider} API Key is not configured.`);
    const hasRequestedModel = input?.model !== undefined;
    const model = hasRequestedModel
      ? this.modules.modelProvider.ResolveRequestModel(input.model, provider)
      : provider === restoredAssistantState.provider
        ? restoredAssistantState.model
        : this.modules.modelProvider.ResolveRequestModel(undefined, provider);
    if (this.controllers.has(requestId)) throw new Error('The request is already running.');
    const confirmationMode = input?.confirmationMode === undefined
      ? restoredAssistantState.confirmationMode
      : NormalizeConfirmationMode(input.confirmationMode);
    const reasoningEffort = input?.reasoningEffort === undefined
      ? restoredAssistantState.reasoningEffort
      : NormalizeReasoningEffort(input.reasoningEffort);
    const assistantStateChanged = provider !== restoredAssistantState.provider || model !== restoredAssistantState.model || confirmationMode !== restoredAssistantState.confirmationMode || reasoningEffort !== restoredAssistantState.reasoningEffort;
    this.sessionAssistantStates.set(sessionId, { provider, model, confirmationMode, reasoningEffort });
    const attachments = Array.isArray(input?.attachments) ? input.attachments.slice(0, 10).map((attachment: any) => ({
      name: String(attachment?.name ?? '').slice(0, 200), path: String(attachment?.path ?? '').slice(0, 1000),
    })).filter((attachment: any) => attachment.name && attachment.path) : [];
    const scheduledBrowserTaskGrant = unattended && input?.browserTaskGrant !== undefined
      ? BrowserTaskGrantSchema.parse(input.browserTaskGrant)
      : undefined;
    // 投递场景只允许 Grant resourceIds 中冻结的简历；默认场景不由浏览器 TaskGrant 收窄。
    const requestedResumeId = unattended && typeof input?.resumeId === 'string' && input.resumeId ? input.resumeId.slice(0, 200) : '';
    const authorizedResumeId = requestedResumeId && (scenarioId === 'default' || scheduledBrowserTaskGrant?.resourceIds.includes(`resume:${requestedResumeId}`))
      ? requestedResumeId
      : '';
    const projectId = typeof input?.projectId === 'string' ? input.projectId.slice(0, 200) : '';
    // 快照可能因 TTL 刷新并追加 Skill reset；必须先完成刷新，再读取本次请求历史。
    const snapshots = resume && this.sessionSnapshots.has(sessionId) ? this.sessionSnapshots.get(sessionId) : await this.LoadOrCreateSnapshots(sessionId, scenarioId);
    // 不悄悄替换用户冻结的前缀；旧场景快照必须显式重载后才能继续执行。
    if (snapshots.tool.scenarioPolicyVersion !== ScenarioPolicyVersion) {
      throw Object.assign(new Error('场景权限已更新为“聊天 / 工作”。请发送 /reload 重载当前会话，或新建会话后继续。'), { code: 'SCENARIO_RELOAD_REQUIRED' });
    }
    this.EnsureModuleSnapshotCompatible(snapshots.module);
    if (assistantStateChanged) await this.PersistSessionAssistantState(sessionId, { provider, model, confirmationMode, reasoningEffort });
    const projectRoot = await this.BindProjectEnvironment(sessionId, projectId);
    const allProfiles = (await this.business?.GetProfiles?.())?.items ?? [];
    const authorizedProfileIds = new Set((scheduledBrowserTaskGrant?.resourceIds ?? [])
      .filter((resourceId) => resourceId.startsWith('profile:'))
      .map((resourceId) => resourceId.slice('profile:'.length)));
    const profiles = unattended && scenarioId === 'application'
      ? allProfiles.filter((profile: any) => authorizedProfileIds.has(String(profile.id)))
      : allProfiles;
    const persistedBinding = this.sessionResumeBindings.get(sessionId);
    let boundResumeSnapshot = persistedBinding ? await this.resumeReadPort.ReadCurrent(persistedBinding.resumeId) : null;
    if (persistedBinding && (!boundResumeSnapshot || boundResumeSnapshot.revision !== persistedBinding.revision)) {
      this.sessionResumeBindings.delete(sessionId);
      boundResumeSnapshot = null;
    }
    let resumeEditing = boundResumeSnapshot ? this.resumePort.IsUserEditing(boundResumeSnapshot.id) : false;
    const runtimeContext = {
      resumeEditing,
      boundResume: boundResumeSnapshot ? { id: boundResumeSnapshot.id, name: boundResumeSnapshot.name, revision: boundResumeSnapshot.revision } : null,
      profiles,
      attachments,
      projectId,
    };
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
    const skillIndexMessages: AgentMessage[] = history.some((message: AgentMessage) => message.metadata?.kind === 'skill_index' && message.metadata.snapshotId === snapshots.skills.snapshotId)
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
    // 动态快照只服务本次 Run；历史中的旧格式快照必须先移除，避免过期档案继续影响模型判断。
    const messagesBeforeUser: AgentMessage[] = [
      ...(snapshot.message ? [snapshot.message] : []),
      ...skillIndexMessages,
    ];
    const usesVisionInput = SupportsVisionInput(provider, model);
    const resolveAttachment = (uri: string) => this.business?.ResolveAttachmentUri?.(uri) ?? Promise.resolve(null);
    const persistedHistory = history.filter((message: AgentMessage) => !IsRuntimeContextMessage(message));
    const requestHistory: AgentMessage[] = usesVisionInput
      ? await Promise.all(persistedHistory.map((message: AgentMessage) => HydrateVisionMessage(message, resolveAttachment)))
      : persistedHistory;
    const userMessage = usesVisionInput
      ? await CreateVisionUserMessage(userContent, attachments, resolveAttachment)
      : { role: 'user' as const, content: userContent };
    const controller = new AbortController();
    this.modules.observability.RecordLog('INFO', 'conversation.send', `session=${sessionId}`);
    if (!resume) this.modules.observability.StartTrace(requestId, sessionId, model);
    if (!resume && this.pendingQuestions.has(sessionId)) {
      const previousRequestId = [...this.requestSessions].reverse().find((entry) => entry[1] === sessionId)?.[0];
      if (previousRequestId) await this.SettleConversationInteraction(previousRequestId, sessionId, true, 'succeeded', '已收到用户回答');
    }
    this.pendingQuestions.delete(sessionId);
    const activeTools = this.HydrateToolSnapshot(snapshots.tool, scenarioId)
      .filter((tool: any) => runScenario.toolNames.includes(tool.definition.function.name));
    const activeToolNames = activeTools.map((tool: any) => tool.definition.function.name);
    const missingScenarioTools = runScenario.toolNames.filter((name) => !activeToolNames.includes(name));
    if (missingScenarioTools.length) {
      throw new Error(`Active tool registry does not match the ${scenario.id} scenario: missing=${missingScenarioTools.join(',') || 'none'}.`);
    }
    const { contextLimit, threshold } = this.modules.modelProvider.GetRuntimeLimits(provider);
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
        resumeLibrary: !unattended,
        ...(authorizedResumeId ? { resumeId: authorizedResumeId } : {}),
        attachmentPaths: attachments.map((attachment: any) => attachment.path),
      },
      provider: {
        moduleName: this.modules.modelProvider.name,
        moduleVersion: this.modules.modelProvider.version,
        provider,
        model,
        capabilities: [...this.modules.modelProvider.capabilities],
        contextLimit,
        compressionThreshold: threshold,
      },
    });
    // 函数型调度元数据不进入状态文件；可序列化副本保留完整授权清单、Prompt、数据范围与 Provider 选择供审计/恢复。
    if (!resume) this.runSnapshots.set(requestId, JSON.parse(JSON.stringify(runSnapshot)));
    while (this.runSnapshots.size > 100) {
      const oldestRunId = this.runSnapshots.keys().next().value as string | undefined;
      if (oldestRunId === undefined) break;
      this.runSnapshots.delete(oldestRunId);
    }
    this.SaveState();
    const contextContent = this.modules.contextBuilder.SerializeSessionContext(snapshots.session);
    const sessionTasks = this.tasks.get(sessionId) ?? new Map();
    this.tasks.set(sessionId, sessionTasks);
    const scopedResumeRead = {
      List: async () => {
        const resumes = await this.resumeReadPort.List();
        if (!unattended) return resumes;
        return authorizedResumeId ? resumes.filter((resume) => resume.id === authorizedResumeId) : [];
      },
      ReadCurrent: async (requestedResumeId: string) => {
        if (unattended && requestedResumeId !== authorizedResumeId) return null;
        return this.resumeReadPort.ReadCurrent(requestedResumeId);
      },
    };
    let toolContext: any;
    const BindResume = async (resume: any | null) => {
      boundResumeSnapshot = resume;
      resumeEditing = resume ? this.resumePort.IsUserEditing(resume.id) : false;
      if (resume) {
        this.sessionResumeBindings.set(sessionId, { resumeId: resume.id, ...(resume.revision !== undefined ? { revision: resume.revision } : {}), boundAt: Date.now() });
      } else {
        this.sessionResumeBindings.delete(sessionId);
      }
      if (toolContext) {
        toolContext.boundResume = resume;
        toolContext.resumeEditing = resumeEditing;
      }
      this.SaveState();
    };
    toolContext = {
      sessionId,
      requestId,
      confirmationMode,
      supportsVisionInput: usesVisionInput,
      resumeEditing,
      projectRoot,
      attachments,
      profileSnapshot: profiles,
      boundResume: boundResumeSnapshot,
      bindResume: BindResume,
      ports: {
        file: this.fileReader,
        resumeRead: scopedResumeRead,
        resumeWrite: this.resumeWritePort,
        profileWrite: {
          Save: async ({ profiles: nextProfiles }: any) => {
            const saved = await this.business?.SaveProfiles?.(nextProfiles, false);
            if (!saved || !Number.isSafeInteger(saved.count)) throw new Error('Profile persistence is unavailable.');
            return { count: saved.count };
          },
        },
        browser: scenarioId === 'application' ? this.browserRuntime : undefined,
        resumeExport: scenarioId === 'application' ? { Export: (input: { resume: ResumeSnapshot; format: 'pdf' | 'png'; sessionId: string; signal?: AbortSignal }) => this.ExportBoundResumeFile(input.resume, input.format, input.sessionId, input.signal) } : undefined,
        jobLibrary: this.jobLibraryPort ? {
          Read: (input: Parameters<JobLibraryPort['Read']>[0]) => this.jobLibraryPort!.Read(input),
          Collect: (input: Parameters<JobLibraryPort['Collect']>[0]) => {
            if (scenarioId !== 'application') throw Object.assign(new Error('Collection requires the application scenario.'), { code: 'TOOL_NOT_ALLOWED' });
            return this.jobLibraryPort!.Collect(input);
          },
        } : undefined,
        bossContact: scenarioId === 'application' ? this.bossContactPort ?? undefined : undefined,
        skill: {
          Load: async (skillInput: { skillId: string; resource?: string }) => this.skillRegistry.Load(snapshots.skills, scenarioId, skillInput),
        },
        ...(!unattended ? { cronTask: {
          PrepareCreate: async (cronInput: Record<string, unknown>) => this.PrepareCronTask(cronInput, {
            requestId,
            ...(toolContext.boundResume?.id ? { resumeId: toolContext.boundResume.id } : {}),
            profileIds: profiles.map((profile: any) => String(profile.id)).filter(Boolean),
          }),
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
        ...({ applicationTracking: {
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
          SaveJob: async (trackingInput: Record<string, unknown>) => this.business.SaveTrackedJob(trackingInput),
          Update: async (trackingInput: Record<string, unknown>) => this.business.UpdateApplicationTracking(trackingInput),
        } }),
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
      ...(scheduledBrowserTaskGrant ? { browserTaskGrant: scheduledBrowserTaskGrant } : {}),
    };
    const runtimeControl = { sessionId, confirmationMode, toolContext };
    this.runtimeControls.set(requestId, runtimeControl);
    this.controllers.set(requestId, controller);
    this.requestSessions.set(requestId, sessionId);
    // Renderer 与 Cron Runner 都先创建 reply 占位；后台任务同样保留有序过程和产物。
    const recorder = resume ? await this.RestoreConversationRecorder(requestId, sessionId) : typeof this.business?.SaveConversationPresentation === 'function'
      ? new ConversationRecorder(requestId, sessionId,
        (id, presentation) => this.business.SaveConversationPresentation(id, presentation),
        (event) => this.EmitPresentation(event))
      : undefined;
    if (recorder) this.conversationRecorders.set(requestId, recorder);
    try {
      let modelRequestCompleted = false;
      const result = await RunAgentLoop({
        requestId, sessionId, provider: runSnapshot.provider.provider, model: runSnapshot.provider.model, reasoningEffort,
        systemContext: contextContent, requestHistory, userContent, userMessage,
        messagesBeforeUser: resume ? [] : messagesBeforeUser, messagesAfterUser: resume ? [] : messagesAfterUser,
        ...(resume?.result ? { resume: { checkpoint: resume.checkpoint, result: resume.result } } : {}),
        onResumed: () => this.pausedRuns.delete(requestId),
        onCheckpoint: (checkpoint) => {
          const pending = JSON.parse(checkpoint.pendingResult.content) as { confirmationId?: string };
          const interactionId = pending.confirmationId ?? checkpoint.pendingCall.id;
          const event = this.GetPendingConversationEvents(sessionId).find((event) => (event.confirmationId ?? event.browserAction?.confirmationId) === interactionId || (event.type === 'question_requested' && event.requestId === requestId));
          this.pausedRuns.set(requestId, {
            input: { requestId, sessionId, content: userContent, provider, model, reasoningEffort, confirmationMode: runtimeControl.confirmationMode, attachments, scenarioId, ...(projectId ? { projectId } : {}) },
            checkpoint, interactionId, kind: checkpoint.pendingResult.disposition === 'wait_user_input' ? 'answer' : 'approval', status: 'waiting',
            ...(event ? { event: { ...event, confirmationId: interactionId } } : {}),
          });
        },
        histories: this.histories,
        // 每个已提交消息都建立状态落盘屏障；取消只中止未提交的后续结果，不能抹掉已接受输入。
        persistHistory: () => this.SaveState(),
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
          getBoundResumeName: () => toolContext.boundResume?.name ?? null,
        },
        contextLimit, thresholdPercent: threshold,
        createId: () => randomUUID(),
        scenario: runSnapshot.scenario,
        instructions: runSnapshot.instructions,
        onModelUsage: (usage) => { modelRequestCompleted = true; this.RecordSessionUsage(requestId, sessionId, usage, contextLimit, threshold); },
      });
      // circuit_open 是轮数/工具预算耗尽的 terminal failure。Kernel 会先发
      // error，但结果的旧 disposition 仍是 paused；不能把它误当成可续接的
      // waiting 状态，否则 BrowserTask 会跨 terminal 继续持有页面和锁。
      const resumableWait = result.outcome === 'waiting_user_input'
        || result.outcome === 'waiting_confirmation'
        || (result.outcome === 'paused' && result.reason !== 'iteration_limit' && result.reason !== 'tool_call_limit');
      retainBrowserTask = scenarioId === 'application' && resumableWait;
      if (result.outcome === 'cancelled') RestoreSkillState();
      this.compressionCount += result.compressionCount;
      const currentUsage = this.sessionUsage.get(sessionId);
      if (currentUsage?.source === 'actual') {
        currentUsage.compressionCount += result.compressionCount;
        currentUsage.contextLimit = contextLimit;
        currentUsage.compressionThreshold = threshold;
        currentUsage.updatedAt = Date.now();
        this.lastContextUsage = { inputTokens: currentUsage.inputTokens, contextLimit };
      } else if (!modelRequestCompleted && result.outcome !== 'cancelled') {
        this.sessionUsage.set(sessionId, {
          source: 'unavailable', inputTokens: 0, contextLimit, compressionCount: result.compressionCount, compressionThreshold: threshold,
          promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedInputTokens: 0, reportedRequestCount: 0, unreportedRequestCount: 1, updatedAt: Date.now(),
        });
      }
      this.SaveState();
      await recorder?.Flush();
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
      if (scenarioId === 'application' && !retainBrowserTask) {
        // waiting_* / paused 会把同一 browserTaskId 留给后续续轮；其他终态收回本次 task。
        const cleanup = await this.CloseBrowserTask();
        if (cleanup) cleanupOutcomes.push(cleanup);
        if (this.browserSessionId === sessionId) this.browserSessionId = null;
      }
      if (this.browserRunId === requestId) this.browserRunId = null;
      for (const [index, cleanup] of cleanupOutcomes.entries()) {
        try { this.RecordBrowserTaskCleanup(requestId, cleanup, index); } catch { /* run_released remains the authoritative bounded cleanup report. */ }
        try { this.modules.observability.AppendTraceEvent(requestId, 'browser_task_cleanup', cleanup, 0); } catch { /* telemetry cannot keep the Host lock held. */ }
        if (cleanup.status !== 'confirmed') {
          try {
            this.modules.observability.RecordLog('WARN', 'browser.task_cleanup',
              `status=${cleanup.status} task=${cleanup.browserTaskId ?? 'none'} code=${cleanup.code ?? 'none'} closedTabs=${cleanup.closedTabs} unknownTabs=${cleanup.unknownTabs ?? 'unknown'}`);
          } catch { /* run_released still exposes the outcome to the UI. */ }
        }
      }
      // waiting_* 只表示 Kernel 停止调度；必须在 Host 锁与运行资源清理后再允许 Renderer 发起续轮。
      try { await this.conversationRecorders.get(requestId)?.Flush(); }
      finally {
        this.Emit({ type: 'run_released', requestId, sessionId, ...(cleanupOutcomes.length ? { cleanupOutcomes } : {}) });
        const recorded = this.conversationRecorders.get(requestId);
        if (recorded && recorded.Status !== 'waiting' && recorded.Status !== 'paused') this.conversationRecorders.delete(requestId);
      }
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
