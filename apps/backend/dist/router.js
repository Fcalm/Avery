"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.WriteCommandChannels = exports.EventChannels = exports.FunctionRouteChannels = exports.MethodRoutes = exports.ReadOnlyChannels = exports.MaxCommandPayloadBytes = void 0;
exports.ExtractRequestId = ExtractRequestId;
exports.CreateBackend = CreateBackend;
const node_crypto_1 = require("node:crypto");
const zod_1 = require("zod");
const contracts_1 = require("@offerget/contracts");
/** 单条命令 payload 上限；合法业务负载（如批量会话消息）远小于此，超过视为调用方缺陷。 */
exports.MaxCommandPayloadBytes = 10 * 1024 * 1024;
/** 只读命令通道集合：工作空间迁移期间仍放行，保证 UI 能读到当前数据。 */
exports.ReadOnlyChannels = new Set([
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
function ExtractRequestId(requestId) {
    if (requestId === undefined || requestId === null)
        return `req-${(0, node_crypto_1.randomUUID)()}`;
    if (typeof requestId === 'string' && requestId.length > 0 && requestId.length <= 200)
        return requestId;
    throw Object.assign(new Error('requestId is invalid.'), { code: 'VALIDATION_ERROR' });
}
/** 通道 → 命名服务与方法的静态路由表；preload 方法签名与通道名不变。 */
exports.MethodRoutes = {
    'agent:configure': { service: 'agent', method: 'Configure' },
    'agent:test-connection': { service: 'agent', method: 'TestConnection' },
    'agent:get-balance': { service: 'agent', method: 'GetBalance' },
    'agent:get-models': { service: 'agent', method: 'GetModels' },
    'agent:send': { service: 'agent', method: 'Send' },
    'agent:cancel': { service: 'agent', method: 'Cancel' },
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
exports.FunctionRouteChannels = ['workspace:migrate'];
/** 事件发送通道：preload 用 ipcRenderer.on 订阅，不经 HandleCommand 分发。 */
exports.EventChannels = ['agent:stream'];
/** 结构必需的实体 ID：长度受限，防止超长标识进入领域层。 */
const EntityId = zod_1.z.string().min(1).max(200);
/** 可选实体修订号：写命令第二个位置参数的 envelope 级字段。 */
const Revision = zod_1.z.number().int().nonnegative().optional();
/** 写通道负载的整数组形状校验表（阶段 6 A2 收口）：键为通道，值为对该通道 args 的整体 tuple 校验。 */
const WriteArgsSchemas = {
    'workspace:save-settings': zod_1.z.tuple([contracts_1.SettingsSubmitSchema]),
    'workspace:conversations-create': zod_1.z.tuple([contracts_1.ConversationCreateSchema]),
    'workspace:conversations-rename': zod_1.z.tuple([EntityId, zod_1.z.string().max(200), Revision]),
    'workspace:conversations-delete': zod_1.z.tuple([EntityId]),
    'workspace:conversations-append-messages': zod_1.z.tuple([EntityId, contracts_1.ChatMessagesSchema]),
    'workspace:conversations-complete-message': zod_1.z.tuple([EntityId, EntityId, zod_1.z.string().max(200000), zod_1.z.string().max(200000).optional()]),
    'workspace:conversations-remove-message': zod_1.z.tuple([EntityId, EntityId]),
    'workspace:resumes-upsert': zod_1.z.tuple([contracts_1.ResumeUpsertSchema, Revision]),
    'workspace:resumes-rename': zod_1.z.tuple([EntityId, zod_1.z.string().max(200), Revision]),
    'workspace:resumes-delete': zod_1.z.tuple([EntityId]),
    'workspace:jobs-upsert': zod_1.z.tuple([contracts_1.JobUpsertSchema, Revision]),
    'workspace:jobs-set-favorite': zod_1.z.tuple([EntityId, zod_1.z.boolean(), Revision]),
    'workspace:jobs-delete': zod_1.z.tuple([EntityId]),
    'workspace:applications-upsert': zod_1.z.tuple([contracts_1.ApplicationUpsertSchema, Revision]),
    'workspace:applications-move-status': zod_1.z.tuple([EntityId, zod_1.z.string().min(1).max(50), Revision]),
    'workspace:applications-delete': zod_1.z.tuple([EntityId]),
    'workspace:profiles-save': zod_1.z.tuple([contracts_1.ProfileItemsSchema, zod_1.z.boolean().optional()]),
    'workspace:set-resume-revision-pinned': zod_1.z.tuple([EntityId, zod_1.z.boolean()]),
    'workspace:import-attachment': zod_1.z.tuple([zod_1.z.string().max(1000), zod_1.z.string().max(100).optional()]),
    'workspace:cleanup-attachments': zod_1.z.tuple([]),
    'workspace:recover-operations': zod_1.z.tuple([]),
    'workspace:restore-latest-backup': zod_1.z.tuple([]),
    'workspace:restore-backup': zod_1.z.tuple([EntityId]),
    'workspace:export-recovery-diagnostic': zod_1.z.tuple([]),
};
/** 可重放写命令通道：Gateway 仅为这些通道接受 WriteCommandEnvelope，避免读取命令协议漂移。 */
exports.WriteCommandChannels = new Set(Object.keys(WriteArgsSchemas));
/**
 * 组装后端命令分发器：container 提供命名服务，functionRoutes 覆盖编排型通道（如迁移热替换）。
 */
function CreateBackend(options) {
    const container = options.container;
    const functionRoutes = options.functionRoutes ?? {};
    const idempotencyStore = options.idempotencyStore;
    function Resolve(channel) {
        const fn = functionRoutes[channel];
        if (fn)
            return fn;
        const route = exports.MethodRoutes[channel];
        if (!route)
            throw new Error(`Unknown IPC channel: ${channel}.`);
        const service = container[route.service];
        if (!service || typeof service[route.method] !== 'function')
            throw new Error(`Channel ${channel} is not routable.`);
        return (...args) => service[route.method](...args);
    }
    const commandLog = [];
    /** 同幂等键在进程内的串行队列：保证并发重试在首个请求完成前不会穿透幂等检查。 */
    const idempotencyLocks = new Map();
    /** 进程内幂等回放缓存：即使外部存储 Put 失败，当前进程内的同键重试仍可去重。 */
    const idempotencyMemory = new Map();
    async function WithIdempotencyLock(key, fn) {
        const previous = idempotencyLocks.get(key) ?? Promise.resolve();
        let release;
        const current = new Promise((resolve) => { release = resolve; });
        const tail = previous.then(() => current);
        idempotencyLocks.set(key, tail);
        await previous;
        try {
            return await fn();
        }
        finally {
            release();
            if (idempotencyLocks.get(key) === tail) {
                idempotencyLocks.delete(key);
            }
        }
    }
    return {
        async HandleCommand(channel, requestId, idempotencyKey, ...args) {
            let resolvedRequestId;
            let invalidRequestId = null;
            try {
                resolvedRequestId = ExtractRequestId(requestId);
            }
            catch (error) {
                invalidRequestId = error;
                resolvedRequestId = typeof requestId === 'string' ? requestId.slice(0, 200) : 'req-missing';
            }
            let resolvedIdempotencyKey;
            let invalidIdempotencyKey = null;
            if (idempotencyKey !== undefined && idempotencyKey !== null) {
                if (typeof idempotencyKey === 'string' && idempotencyKey.length > 0 && idempotencyKey.length <= 200) {
                    resolvedIdempotencyKey = idempotencyKey;
                }
                else {
                    invalidIdempotencyKey = Object.assign(new Error('idempotencyKey is invalid.'), { code: 'VALIDATION_ERROR' });
                }
            }
            const startedAt = Date.now();
            const record = (ok) => {
                const entry = { requestId: resolvedRequestId, channel, ok, at: startedAt };
                if (resolvedIdempotencyKey)
                    entry.idempotencyKey = resolvedIdempotencyKey;
                if (channel === 'agent:send' && args[0] && typeof args[0] === 'object' && typeof args[0].requestId === 'string') {
                    entry.agentRequestId = args[0].requestId;
                }
                commandLog.unshift(entry);
                if (commandLog.length > 500)
                    commandLog.length = 500;
            };
            try {
                if (invalidRequestId)
                    throw invalidRequestId;
                if (invalidIdempotencyKey)
                    throw invalidIdempotencyKey;
                const serialized = JSON.stringify(args);
                if (serialized && serialized.length > exports.MaxCommandPayloadBytes) {
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
                        const payloadHash = (0, node_crypto_1.createHash)('sha256').update(`${channel}\n${serialized ?? ''}`).digest('hex');
                        const memoryRecord = idempotencyMemory.get(resolvedIdempotencyKey);
                        if (memoryRecord) {
                            if (memoryRecord.payloadHash !== payloadHash) {
                                throw Object.assign(new Error('The idempotency key was already used with a different payload.'), { code: 'REVISION_CONFLICT' });
                            }
                            record(true);
                            return memoryRecord.result;
                        }
                        const replay = idempotencyStore.Get(resolvedIdempotencyKey, payloadHash);
                        if (replay.conflict) {
                            throw Object.assign(new Error('The idempotency key was already used with a different payload.'), { code: 'REVISION_CONFLICT' });
                        }
                        if (replay.hit) {
                            record(true);
                            return replay.result;
                        }
                        const result = await Resolve(channel)(...args);
                        record(true);
                        const envelope = (0, contracts_1.CreateResultSuccess)(result);
                        idempotencyMemory.set(resolvedIdempotencyKey, { payloadHash, result: envelope });
                        if (idempotencyMemory.size > 500) {
                            const oldestKey = idempotencyMemory.keys().next().value;
                            if (oldestKey)
                                idempotencyMemory.delete(oldestKey);
                        }
                        try {
                            await idempotencyStore.Put(resolvedIdempotencyKey, payloadHash, envelope);
                        }
                        catch {
                            // 业务已成功；幂等记录落盘失败不应把成功响应改写成可重试失败。
                            // 进程内缓存已先行写入，当前进程内同键重试仍可去重。
                        }
                        return envelope;
                    });
                }
                const result = await Resolve(channel)(...args);
                record(true);
                return (0, contracts_1.CreateResultSuccess)(result);
            }
            catch (error) {
                record(false);
                const normalized = (0, contracts_1.NormalizeError)(error);
                const extra = {};
                if (normalized.details)
                    extra.details = normalized.details;
                if (normalized.retryable)
                    extra.retryable = true;
                return (0, contracts_1.CreateResultFailure)(normalized.code, normalized.message, extra);
            }
        },
        HandleChannels() {
            return [...Object.keys(exports.MethodRoutes), ...Object.keys(functionRoutes)];
        },
        Channels() {
            return [...this.HandleChannels(), ...exports.EventChannels];
        },
        GetCommandLog() {
            return [...commandLog];
        },
    };
}
