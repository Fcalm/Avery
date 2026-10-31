import type { AgentStreamEvent } from './events';
import type { AgentMessage, AttachmentDescriptor, ConfirmationMode, ProfileSnapshotItem, ResumeSnapshot, TaskItem, ToolExecutionResult, ToolLedgerEntry, ToolReceipt } from './types';

/** 已注册工具：定义 + 超时 + 并发安全标记 + 设计文档要求的副作用/风险/确认/幂等/资源键/限额/场景白名单；并发屏障由 Kernel 调度。 */
export interface RegisteredAgentTool {
  definition: { type: 'function'; function: { name: string; description: string; parameters: Record<string, unknown> } };
  timeoutMs: number;
  isConcurrencySafe: boolean;
  /** 副作用等级；`none` 才可能并行。 */
  sideEffect?: 'none' | 'local_write' | 'external_action';
  /** 风险等级；确认策略与最终授权由 Harness/Policy 决定。 */
  risk?: 'low' | 'medium' | 'high';
  /** 确认策略：never 不要求确认；scenario_policy 由场景策略决定；always 始终要求提案。 */
  confirmation?: 'never' | 'scenario_policy' | 'always';
  /** 幂等要求；required 的写工具必须使用业务幂等键。 */
  idempotency?: 'not_needed' | 'required';
  /** 调度器内部资源键；返回资源标识用于只读并行与写屏障。 */
  resourceKeys?: (input: Record<string, unknown>) => string[];
  /** 工具限额；缺省时由调用方使用 timeoutMs 与通用默认值。 */
  limits?: {
    timeoutMs?: number;
    maxInputBytes?: number;
    maxOutputBytes?: number;
    maxRecords?: number;
  };
  /** 允许使用该工具的场景 ID 白名单；缺省表示仅默认场景。 */
  allowedScenarios?: string[];
  /** Harness 在工具执行入口统一校验的会话资源；禁止各工具自行复制授权判断。 */
  requiredResources?: Array<'bound_resume' | 'personal_browser'>;
}

/** 业务幂等键与工具账本端口：写工具在执行前落 started，完成后落 succeeded/failed/status_unknown。 */
export interface ToolLedgerPort {
  Start(entry: Omit<ToolLedgerEntry, 'status' | 'receipt' | 'errorCode' | 'finishedAt'>): Promise<void> | void;
  Finish(ledgerId: string, status: ToolLedgerEntry['status'], extra?: { receipt?: ToolReceipt; errorCode?: string; finishedAt?: number }): Promise<void> | void;
  FindByIdempotencyKey(idempotencyKey: string): Promise<ToolLedgerEntry | undefined> | ToolLedgerEntry | undefined;
}

/** Profile 写端口：宿主未提供时 UpdateProfile 安全拒绝，不扩大权限。 */
export interface ProfileWritePort {
  Save(input: { profiles: ProfileSnapshotItem[]; baseRevision?: number; actor: string; idempotencyKey?: string }): Promise<{ count: number; revision?: number }>;
}

/** 岗位搜索端口：MVP 阶段宿主未注入时工具安全拒绝，不允许任意网络能力。 */
export interface JobSearchPort {
  Search(input: { query: string; page?: number; signal?: AbortSignal; deadline?: number }): Promise<{
    items: Array<{ id: string; title: string; company?: string; url?: string; summary?: string; source?: string }>;
    hasMore: boolean;
    cursor?: string;
  }>;
}

export interface JobCollectionQuery {
  keyword: string;
  city: string;
}

export interface JobCollectionFilters {
  jobTypes?: Array<'intern' | 'campus_recruitment' | 'social_recruitment'>;
  experience?: string[];
  education?: string[];
  salaryMinMonthlyK?: number;
  companySizes?: string[];
  industries?: string[];
  excludeKeywords?: string[];
}

export interface JobCollectionCandidate {
  candidateId: string;
  platform: 'boss_zhipin' | 'beisen' | 'moka' | 'hotjob';
  sourceJobId: string;
  title: string;
  company: string;
  city: string;
  salary: string;
  experience: string;
  education: string;
  jobType?: 'intern' | 'campus_recruitment' | 'social_recruitment';
  jd: string;
  url: string;
  alreadySaved: boolean;
  contactStatus: string;
}

/** @deprecated 仅供旧采集实现及历史回归兼容；生产AgentHost不再注入，新工具使用JobLibraryPort。 */
export interface JobCollectionPort {
  Collect(input: {
    sessionId: string;
    platforms: Array<'boss_zhipin' | 'beisen' | 'moka' | 'hotjob'>;
    queries: JobCollectionQuery[];
    /** ATS 来源由企业公开招聘 URL 指定，事实同步与筛选后的会话候选分离。 */
    sources?: Array<{ url: string; company: string; maxPages?: 5 | 10 | 20 }>;
    filters?: JobCollectionFilters;
    sort: 'relevance' | 'newest';
    maxResults: number;
    signal?: AbortSignal;
    deadline?: number;
  }): Promise<{
    status: 'completed' | 'completed_with_shortage';
    collectionId: string;
    candidates: JobCollectionCandidate[];
    counts: { collected: number; duplicates: number; filtered: number };
    truncated: boolean;
    warnings: string[];
    /** ATS 条件匹配统计；语义理解及是否保存仍交给 Agent。 */
    matching?: { processed: number; reused: number; failed: number };
    sourceRuns?: Array<{ sourceId: string; ats?: 'beisen' | 'moka' | 'hotjob'; health: string; snapshotStatus: string; transport: string; jobCount: number; nextPage?: number; errors: Array<{ code: string; message: string }> }>;
  }>;
  SaveCandidate(input: {
    sessionId: string;
    collectionId: string;
    candidateId: string;
    matchScore?: number;
  }): Promise<{ jobId: string; jobRevision: number }>;
}

/** Agent列表数量和正文长度集中配置；Host投影与工具Schema共用同一上限。 */
export const JobLibraryReadLimits = { defaultCount: 20, maxCount: 100, summaryJdChars: 300, detailJdChars: 20000 } as const;

/** 持久化岗位库端口；采集与页面共用任务和入库语义，不返回会话临时候选。 */
export interface JobLibraryPort {
  Collect(input: {
    request: {
      channel: 'boss_zhipin' | 'company_website'; keyword?: string; targetCount?: number;
      jobSeekingTypes?: Array<'intern' | 'campus_recruitment' | 'social_recruitment'>;
      educations?: Array<'college' | 'bachelor' | 'master' | 'doctor'>; city?: string; sourceIds?: string[];
    };
    idempotencyKey: string; signal?: AbortSignal; deadline?: number; reconcileOnly?: boolean;
  }): Promise<{
    taskId: string; status: 'completed' | 'completed_with_shortage' | 'failed' | 'cancelled' | 'timed_out' | 'interrupted';
    requestedCount: number; collected: number; inserted: number; existing: number; failedWrites: number;
    scanned: number; skippedDeleted: number; warnings: string[];
    sourceCount?: number; warningCount?: number; truncated?: boolean;
    sources: Array<{ sourceId: string; company: string; status: string; received: number; error?: string }>;
  }>;
  Read(input: {
    jobId?: string; channel?: 'boss_zhipin' | 'company_website' | 'other'; keyword?: string;
    maxResults?: number; cursor?: string; cities?: string[];
    jobSeekingTypes?: Array<'intern' | 'campus_recruitment' | 'social_recruitment'>;
    educations?: Array<'college' | 'bachelor' | 'master' | 'doctor'>;
    view?: 'all' | 'favorites' | 'pending' | 'applied'; sort?: 'created' | 'score';
  }): Promise<Record<string, unknown>>;
}

export interface BossContactPort {
  Prepare(input: {
    sessionId: string;
    items: Array<{ jobId: string; message: { mode: 'first_quick_phrase' } | { mode: 'custom'; text: string } }>;
    imageAssetId?: string;
    authorizedAssetIds: string[];
    resume: { id: string; name?: string; revision?: number };
    unattended?: boolean;
  }): Promise<BrowserActionProposal>;
  Execute(input: { proposal: BrowserActionProposal; signal?: AbortSignal; deadline?: number }): Promise<{ data: unknown; status: 'succeeded' | 'status_unknown' }>;
  Cancel(proposal: BrowserActionProposal): Promise<void> | void;
}

/** ReadUrl 端口：只允许 http/https，宿主负责 SSRF、来源与预算限制。 */
export interface UrlReadPort {
  Read(input: { url: string; signal?: AbortSignal; deadline?: number }): Promise<{
    content: string;
    truncated: boolean;
    finalUrl: string;
    fetchedAt: string;
  }>;
}

/** Skill 快照读取端口：只接受注册表 ID 与清单内资源路径，禁止模型传入文件系统路径。 */
export interface SkillReadPort {
  Load(input: { skillId: string; resource?: string }): Promise<{
    skillId: string;
    skillVersion: string;
    resource?: string;
    message: AgentMessage;
  }>;
}

/** CronTask 端口：创建先冻结提案；完全信任可直接提交，其余档位等待用户确认。 */
export interface CronTaskPort {
  PrepareCreate(input: Record<string, unknown>): Promise<{ confirmationId: string; summary: string; scenarioId: 'default' | 'application' }>;
  /** 仅供完全信任的交互 Run 提交宿主已冻结的提案；不得接受模型重建的任务或授权。 */
  CommitCreate(confirmationId: string, signal?: AbortSignal): Promise<{ created: boolean; task?: { id: string } }>;
  Read(input: { cronTaskId?: string; includeRuns?: boolean }): Promise<unknown>;
  Update(input: Record<string, unknown>): Promise<unknown>;
  Delete(cronTaskId: string): Promise<unknown>;
}

/** 岗位与投递跟踪端口：岗位可独立保存；投递会将受宿主读取的简历快照冻结为凭证。 */
export interface ApplicationTrackingPort {
  Read(input?: { company?: string; title?: string; url?: string }): Promise<{ jobs: unknown[]; applications: unknown[]; truncated?: boolean }>;
  SaveJob(input: Record<string, unknown>): Promise<unknown>;
  Update(input: Record<string, unknown> & { resumeEvidence: ResumeSnapshot }): Promise<unknown>;
}

/** 浏览器窄端口只接受原子动作；BrowserRunScript 在工具层编排，不进入提案或驱动白名单。 */
export type BrowserToolName =
  | 'BrowserNavigate'
  | 'BrowserSnapshot'
  | 'BrowserScreenshot'
  | 'BrowserReadPage'
  | 'BrowserInspectForm'
  | 'BrowserClick'
  | 'BrowserFill'
  | 'BrowserFillForm'
  | 'BrowserValidateForm'
  | 'BrowserSelect'
  | 'BrowserSetChecked'
  | 'BrowserPressKey'
  | 'BrowserUploadFile'
  | 'BrowserWait'
  | 'BrowserSwitchTab'
  | 'BrowserGoBack';

/** Cron Runner 从持久任务记录注入的浏览器授权快照；模型和 Renderer 不能自行构造。 */
export interface BrowserTaskGrantSnapshot {
  mode: 'personal_browser_extension';
  purpose: 'job_search' | 'job_application' | 'boss_contact';
  allowNavigation: boolean;
  allowFormFill: boolean;
  allowFileUpload: boolean;
  allowExternalSend: boolean;
  resourceIds: string[];
  grantedAt: string;
  revokedAt?: string;
}

export type BrowserEngine = 'chrome' | 'edge' | 'ego';

/** 浏览器动作提案由宿主根据当前页面引用生成；模型不能自行构造哈希或内部路径。 */
export interface BrowserActionProposal {
  /** 生产 Host 绑定使用的稳定提案标识；不得以 proposalHash 替代。 */
  proposalId: string;
  proposalHash: string;
  toolName: BrowserToolName;
  canonicalArguments: Record<string, unknown>;
  summary: string;
  risk: 'low' | 'medium' | 'high';
  /** 默认强制确认；完全信任模式下上传和按键由工具执行策略豁免，仍须校验资源与任务授权。 */
  forceConfirmation: boolean;
  pageRevision: number;
  url?: string;
  resourceIds: string[];
}

/** 浏览器窄端口：准备阶段只校验并分类，执行阶段只接受冻结提案，底层驱动不向模型暴露。 */
export interface BrowserAutomationPort {
  Prepare(input: { toolName: BrowserToolName; arguments: Record<string, unknown> }): Promise<BrowserActionProposal>;
  Execute(input: { proposal: BrowserActionProposal; signal?: AbortSignal; deadline?: number }): Promise<{ data: unknown; status: 'succeeded' | 'status_unknown' }>;
  /** probeConnection 仅由用户显式检测触发；普通状态读取不得启动浏览器。 */
  GetStatus(probeConnection?: boolean): Promise<{ available: boolean; running: boolean; pageRevision: number; currentUrl?: string }>;
  /** 当前扩展 Runtime 的任务身份；待确认动作须绑定此值，不能在会话切换后复用新任务页。 */
  GetBrowserTaskId?(): string | undefined;
  /** 新 Run 或用户接管后废弃全部元素引用，强制先重新 Snapshot。 */
  ResetPageReferences(): void;
  Close(): Promise<void>;
  /** Cron Runner 设置可信任务上下文；任务级持久授权与浏览器在线状态分别校验。 */
  SetUnattended?(value: boolean, context?: { cronTaskId?: string; browserTaskGrant?: BrowserTaskGrantSnapshot }): Promise<void> | void;
  /** 设置下一次浏览器动作使用的 Chrome/Edge/ego lite；切换时淘汰旧任务页引用。 */
  SetEngine?(value: BrowserEngine): Promise<void> | void;
  /** 下一次创建任务时冻结关闭策略；关闭自动关闭后仍须撤销控制权，不能保留旧任务授权。 */
  SetCloseTaskTabs?(value: boolean): Promise<void> | void;
  /** 仅供受信任 Host 适配器运行固定页面提取表达式；不存在对应模型工具，也不得传入模型生成的脚本。 */
  EvaluateTrustedPage?(input: { site: 'boss_zhipin'; expression: string; signal?: AbortSignal; deadline?: number }): Promise<unknown>;
}

/** 文件读取端口：由宿主注入（agent-file-reader）；路径校验与资源边界由宿主持有，模块不可绕过。 */
export interface FileReadPort {
  ReadAuthorizedFile(filePath: string, sourceName?: string, execution?: { signal?: AbortSignal; deadline?: number }): Promise<{
    content: string;
    truncated: boolean;
    warnings?: string[];
    pages?: number;
  }>;
  ReadTextFile(filePath: string): { content: string; truncated: boolean };
  /** 枚举项目内常规文件：path 为可读取的绝对路径，name 为相对项目的 POSIX 路径（供展示与匹配）。 */
  ListProjectFiles(projectPath: string, limit?: number): Array<{ path: string; name: string }>;
  ResolveProjectPath(projectRoot: string | null, requestedPath: string): string;
  /** 将 attachment:// 虚拟 URI 解析为宿主私有 Markdown 快照路径；图片保留原文件供模型视觉输入使用。 */
  ResolveAttachmentUri(uri: string): Promise<string | null>;
  CreateGlobMatcher(pattern: string): RegExp;
}

/** 简历索引项不含正文；模型先读取索引，再按 ID 渐进加载并绑定正文。 */
export interface ResumeIndexItem {
  id: string;
  name: string;
  updatedAt: string;
  revision?: number;
  targetRoles?: string[];
}

/** 简历只读端口：宿主提供无正文索引，并按授权的 resumeId 返回当前只读快照。 */
export interface ResumeReadPort {
  List(): Promise<ResumeIndexItem[]>;
  ReadCurrent(resumeId: string): Promise<ResumeSnapshot | null>;
}

/** 简历互斥锁信息；owner 区分用户与 Agent。 */
export interface ResumeEditLock {
  resumeId: string;
  owner: 'user' | 'agent';
  ownerId: string;
  baseRevision?: number;
  acquiredAt: number;
  leaseExpiresAt: number;
}

/** 简历写端口：后端落库 + 互斥锁 + 乐观锁；用户与 Agent 共用同一锁。 */
export interface ResumeWritePort {
  /** 尝试获取简历互斥锁；被其他 owner 占用时返回未获取及错误码。 */
  AcquireLock(input: { resumeId: string; owner: 'user' | 'agent'; ownerId: string; baseRevision?: number }): Promise<{ acquired: true; lock: ResumeEditLock } | { acquired: false; code: 'RESUME_LOCKED_BY_USER' | 'RESOURCE_LOCKED' }>;
  /** 释放指定 owner 持有的简历锁。 */
  ReleaseLock(resumeId: string, ownerId: string): Promise<void>;
  /** 保存简历并校验乐观锁版本；冲突时返回 RESUME_REVISION_CONFLICT 失败。 */
  Save(input: { resume: ResumeSnapshot; baseRevision?: number }): Promise<{ id: string; revision: number }>;
}

/** Agent 权限上限内的窄端口集合：默认只含文件/简历；岗位与 Profile 端口由宿主按场景注入，缺省安全拒绝。 */
export interface ToolPorts {
  file: FileReadPort;
  resumeRead: ResumeReadPort;
  /** 已绑定简历的 PDF/PNG 导出由 Host 完成；返回文件资源 ID，不暴露物理路径。 */
  resumeExport?: {
    Export(input: { resume: ResumeSnapshot; format: 'pdf' | 'png'; sessionId: string; signal?: AbortSignal }): Promise<{ fileId: string; fileName: string; mimeType: 'application/pdf' | 'image/png'; resumeId: string; resumeRevision: number; sizeBytes: number; sha256: string }>;
  };
  resumeWrite: ResumeWritePort;
  profileWrite?: ProfileWritePort;
  jobSearch?: JobSearchPort;
  /** @deprecated 旧模块类型兼容；生产宿主只提供jobLibrary。 */
  jobCollection?: JobCollectionPort;
  jobLibrary?: JobLibraryPort;
  bossContact?: BossContactPort;
  urlRead?: UrlReadPort;
  browser?: BrowserAutomationPort;
  skill?: SkillReadPort;
  cronTask?: CronTaskPort;
  applicationTracking?: ApplicationTrackingPort;
}

/** 宿主逐会话构造的工具执行上下文：承载只读快照、交互态、持久化回调与事件出口。 */
export interface ToolContext {
  sessionId: string;
  requestId: string;
  confirmationMode: ConfirmationMode;
  resumeEditing: boolean;
  projectRoot: string | null;
  attachments: AttachmentDescriptor[];
  profileSnapshot: ProfileSnapshotItem[];
  /** 仅由成功的 ReadResume({resumeId}) 建立；正文不由用户消息或 runtime-context 注入。 */
  boundResume: ResumeSnapshot | null;
  /** 宿主持久化或清除会话级绑定；工具不得直接伪造 resumeId。 */
  bindResume: (resume: ResumeSnapshot | null) => Promise<void> | void;
  ports: ToolPorts;
  /** 会话内任务表：宿主持有的 Map 引用，工具直接增删。 */
  tasks: Map<string, TaskItem>;
  /** 待确认简历补丁：宿主持有的 Map 引用。 */
  pendingEdits: Map<string, unknown>;
  /** 澄清提问状态：宿主持有的 Map 引用。 */
  pendingQuestions: Map<string, unknown>;
  /** 待确认浏览器动作；仅宿主可以执行其中冻结的提案。 */
  pendingBrowserActions?: Map<string, unknown>;
  emit: (event: AgentStreamEvent) => void;
  /** 工具改动会话状态后回调宿主持久化（如任务保存）。 */
  persistSessionState: () => void;
  /** 当前 Run 标识；Todo 等 Run 级实体优先使用该标识作用域。 */
  runId?: string;
  /** 当前 Execution 的取消信号；所有可取消异步调用必须接收。 */
  signal?: AbortSignal;
  /** 绝对截止时间（epoch ms）；超时与取消共用。 */
  deadline?: number;
  /** 写工具账本端口；宿主未注入时模块使用内存兜底，重启后不能保证跨进程幂等。 */
  ledger?: ToolLedgerPort;
  /** 当前 Run 的场景快照 ID；用于工具白名单校验与审计。 */
  scenarioSnapshotId?: string;
  /** 当前 Run 的冻结场景 ID；工具模块在执行入口再次校验。 */
  scenarioId?: string;
  /** Kernel 注入本轮冻结的工具白名单；脚本内的每一步也必须通过此边界。 */
  allowedToolNames?: ReadonlySet<string>;
  /** 脚本内快照依赖绑定到真实的外层 tool result，不能引用未进入 Transcript 的子动作 ID。 */
  browserSnapshotResultId?: string;
  /** Kernel 扣减本轮工具预算；嵌套脚本不能绕过场景显式设置的动作总数上限。 */
  consumeBrowserScriptStep?: () => boolean;
  /** 会话已提交到 Transcript 的 Skill；Kernel 在 followup 消息追加后更新。 */
  loadedSkills?: Map<string, string>;
  /** 当前 Run 已加载的 Skill 资源，用于幂等；值为 `skillId:resourcePath`。 */
  loadedSkillResources?: Set<string>;
  /** 同一工具批次内已经生成但尚未追加的 Skill/资源键，避免重复正文。 */
  pendingSkillLoads?: Set<string>;
  /** 无人值守 Cron Run 已在创建时获得周期级授权；只由宿主内部入口设置。 */
  unattended?: boolean;
  /** 无人值守浏览器权限的持久快照；普通交互 Run 不设置。 */
  browserTaskGrant?: BrowserTaskGrantSnapshot;
  /** 当前 Provider/模型是否接受 image_url；截图工具据此在调用 CLI 前拒绝不兼容模型。 */
  supportsVisionInput?: boolean;
  /** Kernel 根据实际模型上下文检查工具回执；基线丢失时浏览器快照必须回退全量。 */
  hasToolResultInContext?: (toolCallId: string) => boolean;
  /** 压缩后必须重新观察才能执行依赖页面引用的动作，不视摘要中的旧引用为实时结构。 */
  requiresBrowserSnapshot?: boolean;
}
