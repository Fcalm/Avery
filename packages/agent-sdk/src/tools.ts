import type { AgentStreamEvent } from './events';
import type { AttachmentDescriptor, ProfileSnapshotItem, ResumeSnapshot, TaskItem, ToolExecutionResult, ToolLedgerEntry, ToolReceipt } from './types';

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

/** ReadUrl 端口：只允许 http/https，宿主负责 SSRF、来源与预算限制。 */
export interface UrlReadPort {
  Read(input: { url: string; signal?: AbortSignal; deadline?: number }): Promise<{
    content: string;
    truncated: boolean;
    finalUrl: string;
    fetchedAt: string;
  }>;
}

/** 文件读取端口：由宿主注入（agent-file-reader）；路径校验与资源边界由宿主持有，模块不可绕过。 */
export interface FileReadPort {
  ReadAuthorizedFile(filePath: string, sourceName?: string, execution?: { signal?: AbortSignal; deadline?: number }): Promise<{
    content: string;
    truncated: boolean;
    warnings?: string[];
    pages?: number;
    needsOcr?: boolean;
    ocr?: {
      engine: string;
      version: string;
      languages: string[];
      confidence: number;
      lowConfidence: boolean;
      cacheHit: boolean;
      source: { page: number; regions: Array<Record<string, unknown>> };
    };
  }>;
  ReadTextFile(filePath: string): { content: string; truncated: boolean };
  /** 枚举项目内常规文件：path 为可读取的绝对路径，name 为相对项目的 POSIX 路径（供展示与匹配）。 */
  ListProjectFiles(projectPath: string, limit?: number): Array<{ path: string; name: string }>;
  ResolveProjectPath(projectRoot: string | null, requestedPath: string): string;
  /** 将 attachment:// 虚拟 URI 解析为宿主私有物理路径；展示名取自 ToolContext.attachments。 */
  ResolveAttachmentUri(uri: string): Promise<string | null>;
  CreateGlobMatcher(pattern: string): RegExp;
}

/** 简历只读端口：宿主按 resumeId 提供当前只读快照（含 revision）。 */
export interface ResumeReadPort {
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
  resumeWrite: ResumeWritePort;
  profileWrite?: ProfileWritePort;
  jobSearch?: JobSearchPort;
  urlRead?: UrlReadPort;
}

/** 宿主逐会话构造的工具执行上下文：承载只读快照、交互态、持久化回调与事件出口。 */
export interface ToolContext {
  sessionId: string;
  requestId: string;
  confirmationMode: '需要确认' | '无需确认';
  resumeEditing: boolean;
  projectRoot: string | null;
  attachments: AttachmentDescriptor[];
  profileSnapshot: ProfileSnapshotItem[];
  resumeSnapshot: ResumeSnapshot | null;
  resumeId?: string;
  ports: ToolPorts;
  /** 会话内任务表：宿主持有的 Map 引用，工具直接增删。 */
  tasks: Map<string, TaskItem>;
  /** 待确认简历补丁：宿主持有的 Map 引用。 */
  pendingEdits: Map<string, unknown>;
  /** 澄清提问状态：宿主持有的 Map 引用。 */
  pendingQuestions: Map<string, unknown>;
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
}
