import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  ApplicationUpsertSchema,
  ChatMessagesSchema,
  ConversationCreateSchema,
  CreateResultFailure,
  CreateResultSuccess,
  JobUpsertSchema,
  NormalizeError,
  ProfileItemsSchema,
  ResumeUpsertSchema,
  SettingsSubmitSchema,
  type ErrorCodeValue,
} from '@offerget/contracts';

/** 单条命令 payload 上限；合法业务负载（如批量会话消息）远小于此，超过视为调用方缺陷。 */
export const MaxCommandPayloadBytes = 10 * 1024 * 1024;

/** 只读命令通道集合：工作空间迁移期间仍放行，保证 UI 能读到当前数据。 */
export const ReadOnlyChannels = new Set<string>([
  'workspace:status', 'workspace:get-view-model', 'workspace:get-settings',
  'workspace:get-profiles', 'workspace:get-resume-revisions',
  'workspace:recovery-status',
  'workspace:database-recovery-status',
  'agent:status', 'agent:observability', 'agent:trace-events', 'agent:test-connection', 'agent:get-balance', 'agent:get-models', 'agent:get-session-assistant-state',
]);

/**
 * 校验信封级 requestId：只读显式参数，永不读取业务 payload（防止 payload 内 requestId 被误认或污染业务数据）。
 * 缺失时由 Router 生成；超长或非字符串按调用方缺陷拒绝，不静默替换。
 */
export function ExtractRequestId(requestId: unknown): string {
  if (requestId === undefined || requestId === null) return `req-${randomUUID()}`;
  if (typeof requestId === 'string' && requestId.length > 0 && requestId.length <= 200) return requestId;
  throw Object.assign(new Error('requestId is invalid.'), { code: 'VALIDATION_ERROR' });
}

interface MethodRoute {
  service: string;
  method: string;
}

/** 通道 → 命名服务与方法的静态路由表；preload 方法签名与通道名不变。 */
export const MethodRoutes: Record<string, MethodRoute> = {
  'agent:configure': { service: 'agent', method: 'Configure' },
  'agent:test-connection': { service: 'agent', method: 'TestConnection' },
  'agent:get-balance': { service: 'agent', method: 'GetBalance' },
  'agent:get-models': { service: 'agent', method: 'GetModels' },
  'agent:send': { service: 'agent', method: 'Send' },
  'agent:cancel': { service: 'agent', method: 'Cancel' },
  'agent:update-confirmation-mode': { service: 'agent', method: 'UpdateConfirmationMode' },
  'agent:confirm-resume-edit': { service: 'agent', method: 'ConfirmResumeEdit' },
  'agent:acquire-resume-lock': { service: 'agent', method: 'AcquireResumeEditLock' },
  'agent:release-resume-lock': { service: 'agent', method: 'ReleaseResumeEditLock' },
  'agent:status': { service: 'agent', method: 'GetStatus' },
  'agent:observability': { service: 'developer', method: 'GetObservability' },
  'agent:trace-events': { service: 'developer', method: 'GetTraceEvents' },
  'agent:delete-traces': { service: 'developer', method: 'DeleteTraces' },
  'agent:set-trace-retention': { service: 'developer', method: 'SetTraceRetention' },
  'agent:reload-session': { service: 'agent', method: 'ReloadSession' },
  'agent:get-session-assistant-state': { service: 'agent', method: 'GetSessionAssistantState' },
  'agent:bind-project-environment': { service: 'agent', method: 'BindProjectEnvironment' },
  'agent:clear-observability': { service: 'developer', method: 'ClearObservability' },
  'agent:select-project-directory': { service: 'desktop', method: 'SelectProjectDirectory' },
  'agent:module-configuration': { service: 'agent', method: 'GetModuleConfiguration' },
  'agent:select-module-directory': { service: 'agent', method: 'SelectModuleDirectory' },
  'agent:reset-modules': { service: 'agent', method: 'ResetModules' },
  'workspace:status': { service: 'workspace', method: 'GetStatus' },
  'workspace:get-view-model': { service: 'workspace', method: 'LoadViewModel' },
  'workspace:get-settings': { service: 'settings', method: 'GetStoredSettings' },
  'workspace:save-settings': { service: 'settings', method: 'SaveSettings' },
  'workspace:conversations-create': { service: 'conversations', method: 'CreateConversation' },
  'workspace:conversations-rename': { service: 'conversations', method: 'RenameConversation' },
  'workspace:conversations-delete': { service: 'conversations', method: 'DeleteConversation' },
  'workspace:conversations-append-messages': { service: 'conversations', method: 'AppendConversationMessages' },
  'workspace:conversations-complete-message': { service: 'conversations', method: 'CompleteConversationMessage' },
  'workspace:conversations-remove-message': { service: 'conversations', method: 'RemoveConversationMessage' },
  'workspace:resumes-upsert': { service: 'resumes', method: 'UpsertResume' },
  'workspace:resumes-rename': { service: 'resumes', method: 'RenameResume' },
  'workspace:resumes-delete': { service: 'resumes', method: 'DeleteResume' },
  'workspace:jobs-upsert': { service: 'jobs', method: 'UpsertJob' },
  'workspace:jobs-set-favorite': { service: 'jobs', method: 'SetJobFavorite' },
  'workspace:jobs-delete': { service: 'jobs', method: 'DeleteJob' },
  'workspace:applications-upsert': { service: 'applications', method: 'UpsertApplication' },
  'workspace:applications-move-status': { service: 'applications', method: 'MoveApplicationStatus' },
  'workspace:applications-delete': { service: 'applications', method: 'DeleteApplication' },
  'workspace:get-profiles': { service: 'profiles', method: 'GetProfiles' },
  'workspace:profiles-save': { service: 'profiles', method: 'SaveProfiles' },
  'workspace:profiles-reload': { service: 'profiles', method: 'ReloadProfiles' },
  'workspace:import-attachment': { service: 'workspace', method: 'ImportAttachment' },
  'workspace:cleanup-attachments': { service: 'workspace', method: 'CleanupAttachments' },
  'workspace:recovery-status': { service: 'workspace', method: 'GetWorkspaceRecoveryStatus' },
  'workspace:recover-operations': { service: 'workspace', method: 'RecoverWorkspaceOperations' },
  'workspace:database-recovery-status': { service: 'workspace', method: 'GetDatabaseRecoveryStatus' },
  'workspace:restore-latest-backup': { service: 'workspace', method: 'RestoreLatestBackup' },
  'workspace:restore-backup': { service: 'workspace', method: 'RestoreBackup' },
  'workspace:export-recovery-diagnostic': { service: 'workspace', method: 'ExportRecoveryDiagnostic' },
  'workspace:create-backup': { service: 'workspace', method: 'CreateBackup' },
  'workspace:get-resume-revisions': { service: 'resumes', method: 'GetResumeRevisions' },
  'workspace:set-resume-revision-pinned': { service: 'resumes', method: 'SetResumeRevisionPinned' },
  'workspace:export-resume': { service: 'desktop', method: 'ExportResume' },
};

/** 函数路由通道（编排型，由 CreateBackend 注入实现）。 */
export const FunctionRouteChannels = ['workspace:migrate'];

/** 事件发送通道：preload 用 ipcRenderer.on 订阅，不经 HandleCommand 分发。 */
export const EventChannels = ['agent:stream'];

/** 结构必需的实体 ID：长度受限，防止超长标识进入领域层。 */
const EntityId = z.string().min(1).max(200);

/** 可选实体修订号：写命令第二个位置参数的 envelope 级字段。 */
const Revision = z.number().int().nonnegative().optional();

/** 写通道负载的整数组形状校验表（阶段 6 A2 收口）：键为通道，值为对该通道 args 的整体 tuple 校验。 */
const WriteArgsSchemas: Record<string, z.ZodTuple> = {
  'workspace:save-settings': z.tuple([SettingsSubmitSchema]),
  'workspace:conversations-create': z.tuple([ConversationCreateSchema]),
  'workspace:conversations-rename': z.tuple([EntityId, z.string().max(200), Revision]),
  'workspace:conversations-delete': z.tuple([EntityId]),
  'workspace:conversations-append-messages': z.tuple([EntityId, ChatMessagesSchema]),
  'workspace:conversations-complete-message': z.tuple([EntityId, EntityId, z.string().max(200000), z.string().max(200000).optional()]),
  'workspace:conversations-remove-message': z.tuple([EntityId, EntityId]),
  'workspace:resumes-upsert': z.tuple([ResumeUpsertSchema, Revision]),
  'workspace:resumes-rename': z.tuple([EntityId, z.string().max(200), Revision]),
  'workspace:resumes-delete': z.tuple([EntityId]),
  'workspace:jobs-upsert': z.tuple([JobUpsertSchema, Revision]),
  'workspace:jobs-set-favorite': z.tuple([EntityId, z.boolean(), Revision]),
  'workspace:jobs-delete': z.tuple([EntityId]),
  'workspace:applications-upsert': z.tuple([ApplicationUpsertSchema, Revision]),
  'workspace:applications-move-status': z.tuple([EntityId, z.string().min(1).max(50), Revision]),
  'workspace:applications-delete': z.tuple([EntityId]),
  'workspace:profiles-save': z.tuple([ProfileItemsSchema, z.boolean().optional()]),
  'workspace:set-resume-revision-pinned': z.tuple([EntityId, z.boolean()]),
  'workspace:import-attachment': z.tuple([z.string().max(1000), z.string().max(100).optional()]),
  'workspace:cleanup-attachments': z.tuple([]),
  'workspace:recover-operations': z.tuple([]),
  'workspace:restore-latest-backup': z.tuple([]),
  'workspace:restore-backup': z.tuple([EntityId]),
  'workspace:export-recovery-diagnostic': z.tuple([]),
};

/** 可重放写命令通道：Gateway 仅为这些通道接受 WriteCommandEnvelope，避免读取命令协议漂移。 */
export const WriteCommandChannels = new Set<string>(Object.keys(WriteArgsSchemas));

export interface BackendContainer {
  [service: string]: any;
}

export type FunctionRoutes = Record<string, (...args: any[]) => Promise<unknown> | unknown>;

export interface CreateBackendOptions {
  container: BackendContainer;
  functionRoutes?: FunctionRoutes;
  idempotencyStore?: { Get(key: string, payloadHash: string): { hit: boolean; conflict: boolean; result?: unknown }; Put(key: string, payloadHash: string, result: unknown): void };
}

interface CommandLogEntry {
  requestId: string;
  channel: string;
  ok: boolean;
  at: number;
  agentRequestId?: string;
  idempotencyKey?: string;
}

/**
 * 组装后端命令分发器：container 提供命名服务，functionRoutes 覆盖编排型通道（如迁移热替换）。
 */
export function CreateBackend(options: CreateBackendOptions) {
  const container = options.container;
  const functionRoutes = options.functionRoutes ?? {};
  const idempotencyStore = options.idempotencyStore;

  function Resolve(channel: string): (...args: any[]) => unknown {
    const fn = functionRoutes[channel];
    if (fn) return fn;
    const route = MethodRoutes[channel];
    if (!route) throw new Error(`Unknown IPC channel: ${channel}.`);
    const service = container[route.service];
    if (!service || typeof service[route.method] !== 'function') throw new Error(`Channel ${channel} is not routable.`);
    return (...args: any[]) => service[route.method](...args);
  }

  const commandLog: CommandLogEntry[] = [];
  /** 同幂等键在进程内的串行队列：保证并发重试在首个请求完成前不会穿透幂等检查。 */
  const idempotencyLocks = new Map<string, Promise<void>>();
  /** 进程内幂等回放缓存：即使外部存储 Put 失败，当前进程内的同键重试仍可去重。 */
  const idempotencyMemory = new Map<string, { payloadHash: string; result: unknown }>();

  async function WithIdempotencyLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = idempotencyLocks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.then(() => current);
    idempotencyLocks.set(key, tail);
    await previous;
    try {
      return await fn();
    } finally {
      release();
      if (idempotencyLocks.get(key) === tail) {
        idempotencyLocks.delete(key);
      }
    }
  }

  return {
    async HandleCommand(channel: string, requestId: unknown, idempotencyKey: unknown, ...args: unknown[]): Promise<{ ok: boolean; data?: unknown; error?: { code: ErrorCodeValue; message: string; retryable: boolean; details?: unknown } }> {
      let resolvedRequestId: string;
      let invalidRequestId: unknown = null;
      try {
        resolvedRequestId = ExtractRequestId(requestId);
      } catch (error) {
        invalidRequestId = error;
        resolvedRequestId = typeof requestId === 'string' ? requestId.slice(0, 200) : 'req-missing';
      }

      let resolvedIdempotencyKey: string | undefined;
      let invalidIdempotencyKey: unknown = null;
      if (idempotencyKey !== undefined && idempotencyKey !== null) {
        if (typeof idempotencyKey === 'string' && idempotencyKey.length > 0 && idempotencyKey.length <= 200) {
          resolvedIdempotencyKey = idempotencyKey;
        } else {
          invalidIdempotencyKey = Object.assign(new Error('idempotencyKey is invalid.'), { code: 'VALIDATION_ERROR' });
        }
      }

      const startedAt = Date.now();
      const record = (ok: boolean): void => {
        const entry: CommandLogEntry = { requestId: resolvedRequestId, channel, ok, at: startedAt };
        if (resolvedIdempotencyKey) entry.idempotencyKey = resolvedIdempotencyKey;
        if (channel === 'agent:send' && args[0] && typeof args[0] === 'object' && typeof (args[0] as { requestId?: unknown }).requestId === 'string') {
          entry.agentRequestId = (args[0] as { requestId: string }).requestId;
        }
        commandLog.unshift(entry);
        if (commandLog.length > 500) commandLog.length = 500;
      };

      try {
        if (invalidRequestId) throw invalidRequestId;
        if (invalidIdempotencyKey) throw invalidIdempotencyKey;
        const serialized = JSON.stringify(args);
        if (serialized && serialized.length > MaxCommandPayloadBytes) {
          throw Object.assign(new Error('Command payload is too large.'), { code: 'VALIDATION_ERROR' });
        }

        const writeSchema = WriteArgsSchemas[channel];
        if (writeSchema) {
          const parsed = writeSchema.safeParse(args);
          if (!parsed.success) {
            throw Object.assign(new Error('Command payload does not match the expected shape.'), { code: 'VALIDATION_ERROR' });
          }
        }

        const replayable = Boolean(writeSchema) && channel !== 'agent:configure' && Boolean(idempotencyStore) && typeof resolvedIdempotencyKey === 'string';
        if (replayable && idempotencyStore && resolvedIdempotencyKey) {
          return await WithIdempotencyLock(resolvedIdempotencyKey, async () => {
            const payloadHash = createHash('sha256').update(`${channel}\n${serialized ?? ''}`).digest('hex');
            const memoryRecord = idempotencyMemory.get(resolvedIdempotencyKey);
            if (memoryRecord) {
              if (memoryRecord.payloadHash !== payloadHash) {
                throw Object.assign(new Error('The idempotency key was already used with a different payload.'), { code: 'REVISION_CONFLICT' });
              }
              record(true);
              return memoryRecord.result as { ok: boolean; data?: unknown; error?: { code: ErrorCodeValue; message: string; retryable: boolean; details?: unknown } };
            }

            const replay = idempotencyStore.Get(resolvedIdempotencyKey, payloadHash);
            if (replay.conflict) {
              throw Object.assign(new Error('The idempotency key was already used with a different payload.'), { code: 'REVISION_CONFLICT' });
            }
            if (replay.hit) {
              record(true);
              return replay.result as { ok: boolean; data?: unknown; error?: { code: ErrorCodeValue; message: string; retryable: boolean; details?: unknown } };
            }

            const result = await Resolve(channel)(...args);
            record(true);
            const envelope = CreateResultSuccess(result);
            idempotencyMemory.set(resolvedIdempotencyKey, { payloadHash, result: envelope });
            if (idempotencyMemory.size > 500) {
              const oldestKey = idempotencyMemory.keys().next().value as string | undefined;
              if (oldestKey) idempotencyMemory.delete(oldestKey);
            }
            try {
              await idempotencyStore.Put(resolvedIdempotencyKey, payloadHash, envelope);
            } catch {
              // 业务已成功；幂等记录落盘失败不应把成功响应改写成可重试失败。
              // 进程内缓存已先行写入，当前进程内同键重试仍可去重。
            }
            return envelope;
          });
        }

        const result = await Resolve(channel)(...args);
        record(true);
        return CreateResultSuccess(result);
      } catch (error) {
        record(false);
        const normalized = NormalizeError(error);
        const extra: { details?: unknown; retryable?: boolean } = {};
        if (normalized.details) extra.details = normalized.details;
        if (normalized.retryable) extra.retryable = true;
        return CreateResultFailure(normalized.code, normalized.message, extra);
      }
    },
    HandleChannels(): string[] {
      return [...Object.keys(MethodRoutes), ...Object.keys(functionRoutes)];
    },
    Channels(): string[] {
      return [...this.HandleChannels(), ...EventChannels];
    },
    GetCommandLog(): CommandLogEntry[] {
      return [...commandLog];
    },
  };
}
