"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
// @ts-nocheck
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { RunAgentLoop, ScrubTraceContent } = require('@offerget/agent-core');
const { ResolveModules } = require('@offerget/agent-module-host');
const { CreateDefaultModules } = require('@offerget/agent-modules-defaults');
const { AgentFileReader } = require('./agent-file-reader.js');
const { AgentResumePort } = require('./agent-resume-port.js');
const { ResumeLockStore } = require('./resume-lock-store.js');
/** 用户编辑锁的稳定 ownerId；前端经 bridge 加解锁都以此为准。 */
const UserLockOwnerId = 'user-main';
function NormalizeProjectBinding(value) {
    if (typeof value === 'string' && value)
        return { rootPath: value, projectId: null, name: path.basename(value) };
    if (!value || typeof value !== 'object')
        return null;
    const rootPath = typeof value.rootPath === 'string' ? value.rootPath : typeof value.path === 'string' ? value.path : '';
    if (!rootPath)
        return null;
    return {
        rootPath,
        projectId: typeof value.projectId === 'string' ? value.projectId : null,
        name: typeof value.name === 'string' && value.name ? value.name.slice(0, 200) : path.basename(rootPath),
    };
}
/** 读取持久化 usage 时只保留已校验的会话事实；旧估算数据绝不标记为真实。 */
function NormalizeSessionUsage(value) {
    if (!value || typeof value !== 'object')
        return null;
    const number = (field) => Number.isSafeInteger(value[field]) && value[field] >= 0 ? value[field] : 0;
    const source = ['actual', 'unavailable', 'legacy_estimate'].includes(value.source) ? value.source : 'legacy_estimate';
    return {
        source,
        inputTokens: number('inputTokens'), contextLimit: number('contextLimit'), compressionCount: number('compressionCount'), compressionThreshold: number('compressionThreshold'),
        promptTokens: number('promptTokens'), completionTokens: number('completionTokens'), totalTokens: number('totalTokens'), reportedRequestCount: number('reportedRequestCount'), unreportedRequestCount: number('unreportedRequestCount'), updatedAt: number('updatedAt'),
    };
}
/** 校验字符串字段，避免 IPC 输入直接进入请求层。 */
function RequireString(value, field, maxLength = 20000) {
    if (typeof value !== 'string' || !value.trim() || value.length > maxLength)
        throw new Error(`${field} is invalid.`);
    return value.trim();
}
/** 逐事件 token 仅用于开发者 Trace 的量级观察，不替代 Provider 最终账单。 */
function EstimateTraceTokens(value) {
    const text = String(value ?? '');
    if (!text)
        return 0;
    let units = 0;
    for (const character of text)
        units += /[\u3400-\u9fff\uf900-\ufaff]/.test(character) ? 1 : 0.25;
    return Math.max(1, Math.ceil(units));
}
/**
 * Agent 宿主组合根：替代 agent-runtime.cjs。
 * 持有配置凭据、会话/任务/项目环境内存态与快照持久化；Send 委托 agent-core RunAgentLoop，
 * 六槽默认实现由 defaults 包提供、经 module-host ResolveModules 校验装配。
 */
class AgentHost {
    constructor({ userDataPath, workspacePath, Emit, business, observability, credentialPort, resolveProjectEnvironment, resumeLockStore }) {
        this.statePath = path.join(userDataPath, 'agent-state.json');
        this.moduleConfigPath = path.join(userDataPath, 'agent-modules.json');
        this.Emit = Emit;
        this.business = business;
        this.observabilityPort = observability;
        this.credentialPort = credentialPort;
        this.resolveProjectEnvironment = resolveProjectEnvironment ?? (() => null);
        this.controllers = new Map();
        this.histories = new Map();
        this.tasks = new Map();
        this.pendingQuestions = new Map();
        this.pendingEdits = new Map();
        this.projectEnvironments = new Map();
        this.sessionSnapshots = new Map();
        this.sessionReloadNotices = new Map();
        this.sessionUsage = new Map();
        this.lastContextUsage = { inputTokens: 0, contextLimit: 64000 };
        this.compressionCount = 0;
        this.fileReader = new AgentFileReader((uri) => this.business?.ResolveAttachmentUri?.(uri) ?? Promise.resolve(null), {
            ocrRuntimeRoot: path.join(userDataPath, 'ocr-runtime'),
            ocrCacheRoot: workspacePath ? path.join(workspacePath, 'derived', 'ocr') : null,
        });
        // 简历端口：用户与 Agent 共用同一后端锁与乐观锁校验；宿主传入 lockStore 以在工作空间写路径共享锁判断。
        this.resumePort = new AgentResumePort({ lockStore: resumeLockStore ?? new ResumeLockStore(), business });
        this.resumeReadPort = this.resumePort;
        this.resumeWritePort = this.resumePort;
        this.moduleError = null;
        this.moduleConfiguration = { enabled: false, trusted: false, status: 'default', directoryName: null, modules: [] };
        this.modules = this.BuildModules();
        this.LoadState();
    }
    SetWorkspacePath(workspacePath) {
        this.fileReader.SetOcrCacheRoot(workspacePath ? path.join(workspacePath, 'derived', 'ocr') : null);
    }
    async Close() {
        await this.fileReader.Close();
    }
    /** 构造官方默认六槽；端口全部由宿主持有。 */
    CreateDefaults() {
        const defaults = CreateDefaultModules({
            getConfig: async () => (await this.credentialPort?.Load?.()) ?? null,
            saveConfig: async (config) => { await this.credentialPort?.Save?.(config); },
            getStoredSettings: async () => (await this.business?.GetStoredSettings?.()) ?? {},
            file: this.fileReader,
            resumeRead: this.resumeReadPort,
            resumeWrite: this.resumeWritePort,
            observabilityStore: this.observabilityPort,
        });
        return defaults;
    }
    /** 从受信任目录读取 offerget-modules.json，并把入口约束在该目录真实路径内。 */
    LoadModuleOverrides(directoryPath, defaults) {
        const base = fs.realpathSync(directoryPath);
        const manifestPath = path.join(base, 'offerget-modules.json');
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        if (!manifest || typeof manifest !== 'object' || !manifest.modules || typeof manifest.modules !== 'object')
            throw new Error('offerget-modules.json modules is missing.');
        const overrides = {};
        for (const [slot, descriptor] of Object.entries(manifest.modules)) {
            if (!['model-provider', 'context-builder', 'compaction', 'tools', 'interaction', 'observability'].includes(slot))
                throw new Error(`Unknown module slot: ${slot}.`);
            if (!descriptor || typeof descriptor !== 'object' || typeof descriptor.entry !== 'string')
                throw new Error(`Module ${slot} entry is invalid.`);
            const entry = fs.realpathSync(path.resolve(base, descriptor.entry));
            if (!(entry === base || entry.startsWith(`${base}${path.sep}`)))
                throw new Error(`Module ${slot} entry escapes the trusted directory.`);
            if (!['.cjs', '.js'].includes(path.extname(entry).toLowerCase()))
                throw new Error(`Module ${slot} entry must be .cjs or .js.`);
            const moduleKey = { 'model-provider': 'modelProvider', 'context-builder': 'contextBuilder', compaction: 'compaction', tools: 'tools', interaction: 'interaction', observability: 'observability' }[slot];
            const defaultModule = defaults[moduleKey];
            overrides[slot] = {
                packageName: String(descriptor.packageName || `local.${slot}`),
                name: String(descriptor.name || `local.${slot}`),
                version: String(descriptor.version || '0.1.0'),
                sdkVersion: String(descriptor.sdkVersion || '0.1.0'),
                create: () => {
                    delete require.cache[entry];
                    const loaded = require(entry);
                    const factory = loaded?.create ?? loaded?.default?.create ?? loaded?.default ?? loaded;
                    if (typeof factory !== 'function')
                        throw new Error(`Module ${slot} must export a create function.`);
                    const candidate = factory({ defaultModule });
                    const allowed = new Set(defaultModule.capabilities ?? []);
                    for (const capability of candidate?.capabilities ?? [])
                        if (!allowed.has(capability))
                            throw new Error(`Module ${slot} requests unauthorized capability ${capability}.`);
                    return candidate;
                },
            };
        }
        return overrides;
    }
    /** 装配默认或用户覆盖六槽；失败配置保持阻断状态，不静默回退执行 Agent。 */
    BuildModules() {
        const defaults = this.CreateDefaults();
        let stored = null;
        try {
            stored = JSON.parse(fs.readFileSync(this.moduleConfigPath, 'utf8'));
        }
        catch {
            stored = null;
        }
        if (!stored?.enabled) {
            const resolved = ResolveModules({ sessionId: 'host', sessionRevision: 0, defaults, createId: () => crypto.randomUUID() });
            this.moduleSnapshot = resolved.snapshot;
            this.moduleError = null;
            this.moduleConfiguration = { enabled: false, trusted: false, status: 'default', directoryName: null, modules: resolved.snapshot.modules };
            return resolved.modules;
        }
        try {
            if (stored.trusted !== true || typeof stored.directoryPath !== 'string')
                throw new Error('User module directory is not trusted.');
            const overrides = this.LoadModuleOverrides(stored.directoryPath, defaults);
            const resolved = ResolveModules({ sessionId: 'host', sessionRevision: 0, defaults, overrides, createId: () => crypto.randomUUID() });
            this.moduleSnapshot = resolved.snapshot;
            this.moduleError = null;
            this.moduleConfiguration = { enabled: true, trusted: true, status: 'active', directoryName: path.basename(stored.directoryPath), modules: resolved.snapshot.modules };
            return resolved.modules;
        }
        catch (error) {
            const fallback = ResolveModules({ sessionId: 'blocked', sessionRevision: 0, defaults, createId: () => crypto.randomUUID() });
            this.moduleSnapshot = fallback.snapshot;
            this.moduleError = error instanceof Error ? error.message : String(error);
            this.moduleConfiguration = { enabled: true, trusted: true, status: 'blocked', directoryName: path.basename(String(stored.directoryPath || '')), error: this.moduleError, modules: [] };
            return fallback.modules;
        }
    }
    EnsureModulesReady() {
        if (this.moduleError)
            throw Object.assign(new Error(`User module configuration is blocked: ${this.moduleError}`), { code: 'VALIDATION_ERROR' });
    }
    GetModuleConfiguration() { return { ...this.moduleConfiguration }; }
    /** 用户在原生目录选择器中明确选择并信任目录后启用；无效配置被持久化为 blocked，供 UI 显式恢复默认。 */
    ConfigureUserModules(directoryPath) {
        if (this.IsBusy())
            throw Object.assign(new Error('Stop the current Agent run before changing modules.'), { code: 'AGENT_BUSY' });
        const base = fs.realpathSync(directoryPath);
        fs.writeFileSync(this.moduleConfigPath, JSON.stringify({ enabled: true, trusted: true, directoryPath: base }, null, 2), { encoding: 'utf8', mode: 0o600 });
        this.modules = this.BuildModules();
        return this.GetModuleConfiguration();
    }
    ResetUserModules() {
        if (this.IsBusy())
            throw Object.assign(new Error('Stop the current Agent run before resetting modules.'), { code: 'AGENT_BUSY' });
        try {
            fs.unlinkSync(this.moduleConfigPath);
        }
        catch (error) {
            if (error?.code !== 'ENOENT')
                throw error;
        }
        this.modules = this.BuildModules();
        return this.GetModuleConfiguration();
    }
    /** 返回是否有未结束的 Agent 请求；工作空间迁移期间必须保持空闲。 */
    IsBusy() { return this.controllers.size > 0; }
    /** 读取不含密钥的会话与任务状态；损坏文件只会回退为空状态。 */
    LoadState() {
        try {
            const state = JSON.parse(fs.readFileSync(this.statePath, 'utf8'));
            this.histories = new Map(Array.isArray(state.histories) ? state.histories : []);
            this.tasks = new Map((Array.isArray(state.tasks) ? state.tasks : []).map(([sessionId, tasks]) => [sessionId, new Map(Array.isArray(tasks) ? tasks : [])]));
            this.projectEnvironments = new Map((Array.isArray(state.projectEnvironments) ? state.projectEnvironments : [])
                .map(([sessionId, value]) => [sessionId, NormalizeProjectBinding(value)])
                .filter(([sessionId, value]) => typeof sessionId === 'string' && value));
            this.sessionUsage = new Map((Array.isArray(state.sessionUsage) ? state.sessionUsage : [])
                .map(([sessionId, value]) => [sessionId, NormalizeSessionUsage(value)])
                .filter(([sessionId, value]) => typeof sessionId === 'string' && value));
        }
        catch { /* First launch or corrupted state starts with empty runtime data. */ }
    }
    /** 原子写入不含 API Key 的受保护运行状态。 */
    SaveState() {
        const payload = {
            histories: [...this.histories.entries()],
            tasks: [...this.tasks.entries()].map(([sessionId, tasks]) => [sessionId, [...tasks.entries()]]),
            projectEnvironments: [...this.projectEnvironments.entries()],
            sessionUsage: [...this.sessionUsage.entries()],
        };
        const temporaryPath = `${this.statePath}.tmp`;
        fs.mkdirSync(path.dirname(this.statePath), { recursive: true });
        fs.writeFileSync(temporaryPath, JSON.stringify(payload), 'utf8');
        fs.renameSync(temporaryPath, this.statePath);
    }
    /** 保存经校验的模型配置，API Key 经端口移交主进程 safeStorage 加密落盘。 */
    Configure(input) { this.EnsureModulesReady(); return this.modules.modelProvider.Configure(input); }
    /** 使用表单临时配置测试连通性，不写入配置。 */
    TestConnection(config) { this.EnsureModulesReady(); return this.modules.modelProvider.TestConnection(config); }
    /** 查询已加密保存的 DeepSeek Key 对应余额；不会向渲染层暴露凭据。 */
    GetBalance() { this.EnsureModulesReady(); return this.modules.modelProvider.GetBalance(); }
    /** 查询当前凭据可访问的 DeepSeek 模型；不会向渲染层暴露凭据。 */
    GetModels() { this.EnsureModulesReady(); return this.modules.modelProvider.GetModels(); }
    /** 返回脱敏的配置状态。 */
    GetStatus() { return this.modules.modelProvider.GetStatus(); }
    /** 中止指定在途请求。 */
    Cancel(requestId) {
        const controller = this.controllers.get(requestId);
        if (!controller)
            return { cancelled: false };
        controller.abort();
        return { cancelled: true };
    }
    /** 应用或丢弃待确认的简历补丁：接受时经简历写端口落库并释放 Agent 锁。 */
    ConfirmResumeEdit(confirmationId, accepted) {
        return this.modules.interaction.ConfirmResumeEdit(confirmationId, accepted, { pendingEdits: this.pendingEdits, ports: { resumeWrite: this.resumeWritePort }, emit: (event) => this.Emit(event) });
    }
    /** 用户开始编辑简历前获取互斥锁；Agent 占用时返回未获取及原因。 */
    async AcquireResumeEditLock(resumeId) {
        const normalizedId = typeof resumeId === 'string' ? resumeId : '';
        if (!normalizedId || normalizedId.length > 200)
            throw new Error('Resume id is invalid.');
        const result = await this.resumePort.AcquireLock({ resumeId: normalizedId, owner: 'user', ownerId: UserLockOwnerId });
        if (!result.acquired) {
            // 用户路径只有 Agent 或同用户可能占用（同用户重复获取会刷新租约返回成功），被占用必是 Agent 持锁。
            const lock = this.resumePort.lockStore.GetLock(normalizedId);
            return { acquired: false, reason: lock?.owner === 'agent' ? 'Agent 正在编辑这份简历，请稍后再试' : '简历正被其他操作占用' };
        }
        return { acquired: true };
    }
    /** 用户保存或取消编辑后释放简历锁。 */
    async ReleaseResumeEditLock(resumeId) {
        const normalizedId = typeof resumeId === 'string' ? resumeId : '';
        if (!normalizedId || normalizedId.length > 200)
            throw new Error('Resume id is invalid.');
        await this.resumePort.ReleaseLock(normalizedId, UserLockOwnerId);
        return { released: true };
    }
    /** 绑定单会话单项目目录；会话一旦绑定，后续请求不得切换到其它目录；项目只经 projectId 掩码解析真实路径。 */
    async BindProjectEnvironment(sessionId, projectId) {
        const existing = this.projectEnvironments.get(sessionId) ?? null;
        if (!projectId)
            return existing?.rootPath ?? null;
        const requested = (await this.resolveProjectEnvironment(projectId)) ?? null;
        const requestedBinding = NormalizeProjectBinding(requested);
        if (requestedBinding && !requestedBinding.projectId)
            requestedBinding.projectId = projectId;
        if (existing && requestedBinding && existing.rootPath !== requestedBinding.rootPath)
            throw new Error('A project environment is already bound to this session. Create a new conversation to switch projects.');
        const project = existing && requestedBinding && existing.rootPath === requestedBinding.rootPath ? { ...existing, ...requestedBinding } : existing ?? requestedBinding;
        if (project) {
            const stat = fs.statSync(project.rootPath);
            if (!stat.isDirectory())
                throw new Error('The selected project environment is unavailable.');
            this.projectEnvironments.set(sessionId, project);
            this.SaveState();
        }
        return project?.rootPath ?? null;
    }
    /** 返回会话专属 usage 和脱敏项目标签；默认值绝不回退到其它会话。 */
    GetSessionAssistantState(sessionId) {
        const normalizedSessionId = RequireString(sessionId, 'sessionId', 200);
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
        };
    }
    /** 将每次已完成模型请求的 usage 合并到单会话账本；缺失值仅记未上报，绝不估算。 */
    RecordSessionUsage(sessionId, usage, contextLimit, threshold) {
        const previous = this.sessionUsage.get(sessionId);
        const base = previous?.source === 'actual' ? previous : { promptTokens: 0, completionTokens: 0, totalTokens: 0, reportedRequestCount: 0, unreportedRequestCount: 0, compressionCount: 0 };
        if (!usage || ![usage.promptTokens, usage.completionTokens, usage.totalTokens].every((value) => Number.isSafeInteger(value) && value >= 0) || usage.totalTokens < usage.promptTokens || usage.totalTokens < usage.completionTokens) {
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
    BuildToolSnapshot(sessionId, sessionRevision) {
        const builtInTools = this.modules.tools.GetToolDefinitions();
        const orderedToolNames = builtInTools.map((tool) => tool.definition.function.name);
        return { snapshotId: crypto.randomUUID(), sessionId, sessionRevision, builtInTools, mcpTools: [], orderedToolNames, toolsetHash: crypto.createHash('sha256').update(JSON.stringify(orderedToolNames)).digest('hex') };
    }
    BuildModuleSnapshot(sessionId, sessionRevision) {
        return { ...this.moduleSnapshot, snapshotId: crypto.randomUUID(), sessionId, sessionRevision };
    }
    /** 创建两份快照并原子写入会话表；供首次发送与原子重载使用。 */
    async CreateAndPersistSnapshots(sessionId, sessionRevision) {
        const session = await this.modules.contextBuilder.BuildSessionContextSnapshot(sessionId, sessionRevision);
        const module = this.BuildModuleSnapshot(sessionId, sessionRevision);
        const tool = this.BuildToolSnapshot(sessionId, sessionRevision);
        const entry = { session, module, tool };
        this.sessionSnapshots.set(sessionId, entry);
        await this.business?.SetConversationSnapshots?.(sessionId, { sessionSnapshotJson: JSON.stringify(session), toolSnapshotJson: JSON.stringify({ module, tool }) });
        return entry;
    }
    /** 读取或惰性创建会话快照：内存缓存优先，其次会话表，最后新建并持久化。 */
    async LoadOrCreateSnapshots(sessionId) {
        const cached = this.sessionSnapshots.get(sessionId);
        if (cached)
            return cached;
        const stored = await this.business?.GetConversationSnapshots?.(sessionId);
        let session = null;
        let module = null;
        let tool = null;
        if (stored?.sessionSnapshotJson) {
            try {
                session = JSON.parse(stored.sessionSnapshotJson);
            }
            catch {
                session = null;
            }
        }
        if (stored?.toolSnapshotJson) {
            try {
                const combined = JSON.parse(stored.toolSnapshotJson);
                module = combined?.module ?? null;
                tool = combined?.tool ?? combined;
            }
            catch {
                tool = null;
            }
        }
        if (session && tool) {
            const entry = { session, module: module ?? this.BuildModuleSnapshot(sessionId, session.sessionRevision ?? 1), tool };
            this.sessionSnapshots.set(sessionId, entry);
            return entry;
        }
        const nextRevision = Math.max(1, (session?.sessionRevision ?? 0) + 1);
        return this.CreateAndPersistSnapshots(sessionId, nextRevision);
    }
    /** 空闲时原子重载会话上下文与 Tool 快照；任一步失败保留旧快照。 */
    async ReloadSession(sessionId) {
        if (typeof sessionId !== 'string' || sessionId.length === 0 || sessionId.length > 200)
            throw new Error('Session id is invalid.');
        if (this.IsBusy())
            return { reloaded: false, reason: 'busy' };
        const current = this.sessionSnapshots.get(sessionId) ?? await this.LoadOrCreateSnapshots(sessionId);
        const nextRevision = (current.session?.sessionRevision ?? 0) + 1;
        try {
            const session = await this.modules.contextBuilder.BuildSessionContextSnapshot(sessionId, nextRevision);
            const module = this.BuildModuleSnapshot(sessionId, nextRevision);
            const tool = this.BuildToolSnapshot(sessionId, nextRevision);
            this.sessionSnapshots.set(sessionId, { session, module, tool });
            await this.business?.SetConversationSnapshots?.(sessionId, { sessionSnapshotJson: JSON.stringify(session), toolSnapshotJson: JSON.stringify({ module, tool }) });
            this.sessionReloadNotices.set(sessionId, current.session?.snapshotId ?? 'unknown');
            return { reloaded: true, sessionRevision: session.sessionRevision };
        }
        catch (error) {
            return { reloaded: false, reason: error instanceof Error ? error.message : 'reload failed' };
        }
    }
    /** 在显式状态机内执行一次受限的流式对话回合：编排完成后委托 Kernel 运行循环。 */
    async Send(input) {
        this.EnsureModulesReady();
        const requestId = RequireString(input?.requestId, 'requestId', 200);
        const sessionId = RequireString(input?.sessionId, 'sessionId', 200);
        const userContent = RequireString(input?.content, 'content');
        const status = await this.modules.modelProvider.GetStatus();
        if (!status.configured)
            throw new Error('API Key is not configured.');
        const model = this.modules.modelProvider.ResolveRequestModel(input?.model);
        if (this.controllers.has(requestId))
            throw new Error('The request is already running.');
        // 请求级显式窄字段：确认模式、附件、项目 ID 与简历 ID；业务只读快照由后端按 ID 读取。
        const confirmationMode = input?.confirmationMode === '无需确认' ? '无需确认' : '需要确认';
        const attachments = Array.isArray(input?.attachments) ? input.attachments.slice(0, 10).map((attachment) => ({
            name: String(attachment?.name ?? '').slice(0, 200), path: String(attachment?.path ?? '').slice(0, 1000),
        })).filter((attachment) => attachment.name && attachment.path) : [];
        const resumeId = typeof input?.resumeId === 'string' && input.resumeId ? input.resumeId.slice(0, 200) : '';
        const projectId = typeof input?.projectId === 'string' ? input.projectId.slice(0, 200) : '';
        const projectRoot = await this.BindProjectEnvironment(sessionId, projectId);
        const profiles = (await this.business?.GetProfiles?.())?.items ?? [];
        // 简历只读快照经简历端口读取（含 revision），供工具乐观锁与整份保存使用。
        const resumeSnapshot = resumeId ? (await this.resumeReadPort.ReadCurrent(resumeId)) ?? null : null;
        const resumeEditing = resumeId ? this.resumePort.IsUserEditing(resumeId) : false;
        const runtimeContext = { confirmationMode, resumeEditing, resume: resumeSnapshot, profiles, attachments, projectId };
        const controller = new AbortController();
        this.controllers.set(requestId, controller);
        this.modules.observability.RecordLog('INFO', 'conversation.send', `session=${sessionId}`);
        this.modules.observability.StartTrace(requestId, sessionId, model);
        const history = this.histories.get(sessionId) || [];
        const snapshot = this.modules.contextBuilder.CreateDynamicSnapshot(sessionId, runtimeContext);
        const requestHistory = snapshot.changed ? [...history, snapshot.message] : history;
        this.pendingQuestions.delete(sessionId);
        const snapshots = await this.LoadOrCreateSnapshots(sessionId);
        let contextContent = this.modules.contextBuilder.SerializeSessionContext(snapshots.session);
        const reloadNotice = this.sessionReloadNotices.get(sessionId);
        if (reloadNotice) {
            contextContent += `<system-reminder type="snapshot-replaced" replaces-snapshot-id="${reloadNotice}" snapshot-id="${snapshots.session.snapshotId}" session-revision="${snapshots.session.sessionRevision}">Session context and tool snapshots were atomically reloaded.</system-reminder>`;
            this.sessionReloadNotices.delete(sessionId);
        }
        const systemPrompt = ScrubTraceContent(contextContent);
        const userMessage = ScrubTraceContent(userContent);
        this.modules.observability.AppendTraceEvent(requestId, 'system_prompt', { content: systemPrompt }, EstimateTraceTokens(systemPrompt));
        this.modules.observability.AppendTraceEvent(requestId, 'user_message', { content: userMessage }, EstimateTraceTokens(userMessage));
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
            ports: { file: this.fileReader, resumeRead: this.resumeReadPort, resumeWrite: this.resumeWritePort },
            tasks: sessionTasks,
            pendingEdits: this.pendingEdits,
            pendingQuestions: this.pendingQuestions,
            emit: (event) => this.Emit(event),
            persistSessionState: () => this.SaveState(),
        };
        try {
            const { contextLimit, threshold } = this.modules.modelProvider.GetRuntimeLimits();
            let modelRequestCompleted = false;
            const result = await RunAgentLoop({
                requestId, sessionId, model,
                systemContext: contextContent, requestHistory, userContent,
                histories: this.histories,
                toolArray: this.modules.tools.GetToolDefinitions(),
                modules: this.modules, toolContext,
                emit: (event) => this.Emit(event),
                signal: controller.signal, maxTurns: 8,
                contextLimit, thresholdPercent: threshold,
                createId: () => crypto.randomUUID(),
                onModelUsage: (usage) => { modelRequestCompleted = true; this.RecordSessionUsage(sessionId, usage, contextLimit, threshold); },
            });
            this.compressionCount += result.compressionCount;
            const currentUsage = this.sessionUsage.get(sessionId);
            if (currentUsage?.source === 'actual') {
                currentUsage.compressionCount += result.compressionCount;
                currentUsage.contextLimit = contextLimit;
                currentUsage.compressionThreshold = threshold;
                currentUsage.updatedAt = Date.now();
                this.lastContextUsage = { inputTokens: currentUsage.inputTokens, contextLimit };
            }
            else if (!modelRequestCompleted) {
                // 取消、网络失败或非兼容 Provider 未返回 usage 时必须明确标记未知，不能倒退为本地估算。
                this.sessionUsage.set(sessionId, {
                    source: 'unavailable', inputTokens: 0, contextLimit, compressionCount: result.compressionCount, compressionThreshold: threshold,
                    promptTokens: 0, completionTokens: 0, totalTokens: 0, reportedRequestCount: 0, unreportedRequestCount: 1, updatedAt: Date.now(),
                });
            }
            this.SaveState();
            return { accepted: true, ...(result.outcome === 'cancelled' ? { cancelled: true } : {}) };
        }
        catch (error) {
            throw error;
        }
        finally {
            this.controllers.delete(requestId);
        }
    }
    /** 聚合运行时内存态与可观测性库数据，供开发者界面展示脱敏日志与 Trace。 */
    async GetObservability() {
        const status = await this.modules.modelProvider.GetStatus();
        const { contextLimit, threshold } = this.modules.modelProvider.GetRuntimeLimits();
        const contextUsage = { ...(this.lastContextUsage ?? { inputTokens: 0, contextLimit }), compressionCount: this.compressionCount, compressionThreshold: threshold };
        const logs = await this.modules.observability.GetLogs();
        const traces = await this.modules.observability.GetTraces();
        return { configured: status.configured, model: status.model, historySessions: this.histories.size, taskCount: [...this.tasks.values()].reduce((count, tasks) => count + tasks.size, 0), contextUsage, logs: logs ?? [...this.modules.observability.SnapshotLocalLogs()].reverse(), traces: traces ?? [] };
    }
    /** 按请求标识读取开发者主动展开的 Trace 事件。 */
    GetTraceEvents(requestId) { return this.modules.observability.GetTraceEvents(requestId); }
    /** 按会话删除对应的 Trace 索引及其事件，不影响日志或业务会话。 */
    DeleteTraces(sessionIds) { return this.modules.observability.DeleteTraces(sessionIds); }
    /** 更新开发者可见的 Trace 留存量，不接收任何敏感配置。 */
    SetTraceRetention(value) { return this.modules.observability.SetTraceRetention(value); }
    /** 清空开发者模式可见的日志与 Trace，不影响会话、任务和 API 配置。 */
    ClearObservability() { return this.modules.observability.ClearObservability(); }
}
module.exports = { AgentHost, ScrubTraceContent };
