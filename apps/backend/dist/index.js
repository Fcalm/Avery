"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const node_crypto_1 = require("node:crypto");
const node_path_1 = require("node:path");
const idempotency_store_1 = require("./idempotency-store");
/** Backend Utility Process 组合根：以 require 保持异常处理器早于领域加载的时序。 */
const PostMessage = (message) => process.parentPort.postMessage(message);
// 子进程 stderr 不回流主进程控制台，统一经 parentPort 上报未捕获异常以便诊断；注册须早于后续 require。
process.on('uncaughtException', (error) => {
    try {
        PostMessage({ kind: 'backend-error', code: 'UNCAUGHT', message: String(error?.stack || error) });
    }
    catch { /* 上报失败时保持默认退出。 */ }
});
process.on('unhandledRejection', (reason) => {
    try {
        PostMessage({ kind: 'backend-error', code: 'UNHANDLED', message: String(reason?.stack || reason) });
    }
    catch { /* 上报失败时保持默认行为。 */ }
});
// 必须在依赖 pdf-parse 的模块 require 之前注入，否则其 bundle 顶层引用 DOMMatrix 会抛 ReferenceError。
const { InstallBrowserPolyfills } = require('./electron/backend/pdf-polyfills.js');
InstallBrowserPolyfills();
// 进程编排层：TS 模块（同包 require 保持调用时序，不强求类型）。
const { CreateWorkerHost } = require('./worker-host');
const { CreateBackend, ReadOnlyChannels } = require('./router');
// 领域层同属本包 TS 构建产物；require 仅用于维持启动加载顺序。
const { CreateDesktopCapabilityClient } = require('./electron/backend/desktop-capability-client.js');
const { CreateCredentialClient } = require('./electron/backend/credential-client.js');
const { AgentRunService } = require('./electron/backend/services/agent-run-service.js');
const { DeveloperService } = require('./electron/backend/services/developer-service.js');
const { AgentHost } = require('./electron/backend/agent-host.js');
const { ResumeLockStore } = require('./electron/backend/resume-lock-store.js');
/** 组装业务/可观测性 DB Worker、Agent 运行时与 Router，经 parentPort 服务 Main 命令；桌面能力与凭据经反向 RPC 交由 Main 适配器执行。 */
async function Bootstrap() {
    const parentPort = process.parentPort;
    const hello = await new Promise((resolve) => parentPort.once('message', (event) => resolve(event?.data ?? event)));
    const app = hello?.app ?? {};
    const userDataPath = String(app.userDataPath ?? '');
    const defaultWorkspacePath = String(app.defaultWorkspacePath ?? '');
    let currentWorkspacePath = String(app.workspacePath || defaultWorkspacePath);
    const smoke = Boolean(app.smoke);
    const desktop = CreateDesktopCapabilityClient(PostMessage);
    const credentialPort = CreateCredentialClient(desktop);
    const host = CreateWorkerHost({ workspacePath: currentWorkspacePath, userDataPath, smoke });
    await host.Ready();
    // 上次进程崩溃遗留的 running Trace 标记为 interrupted，恢复观测一致性后再对外提供服务。
    await host.observability.RecoverInterruptedTraces();
    // 项目环境映射：渲染层只持有 projectId 掩码，真实目录路径只存在 Backend 内存。
    const projectEnvironments = new Map();
    // 简历互斥锁：用户与 Agent 共用；Agent 持有期间拒绝用户经工作空间写路径的保存。
    const resumeLockStore = new ResumeLockStore();
    const agent = new AgentHost({
        userDataPath,
        workspacePath: currentWorkspacePath,
        Emit: (event) => PostMessage({ kind: 'event', channel: 'agent:stream', payload: event }),
        business: host.business,
        observability: host.observability,
        credentialPort,
        resolveProjectEnvironment: (projectId) => projectEnvironments.get(projectId) || null,
        resumeLockStore,
    });
    const agentRunService = new AgentRunService({ agentHost: agent, selectModuleDirectory: () => desktop.Call('SelectModuleDirectory') });
    const developerService = new DeveloperService({ agentHost: agent });
    let migrating = false;
    /** 工作空间迁移编排：Agent 空闲校验、弹目录选择、复制校验并切换业务 Worker；迁移全程门禁写命令，原目录保留为安全副本。 */
    async function MigrateWorkspace() {
        if (agent.IsBusy())
            throw new Error('Cannot migrate the workspace while the Agent is running.');
        migrating = true;
        try {
            const destinationPath = await desktop.Call('SelectWorkspaceDirectory');
            if (!destinationPath)
                return { ...(await host.business.GetStatus()), migration: { succeeded: false, cancelled: true } };
            const result = await host.business.CopyWorkspaceTo(destinationPath);
            await host.business.SwitchWorkspace(destinationPath);
            currentWorkspacePath = destinationPath;
            agent.SetWorkspacePath(destinationPath);
            return { ...(await host.business.GetStatus()), migration: { succeeded: true, retainedSource: true, integrity: result.integrity } };
        }
        finally {
            migrating = false;
        }
    }
    // 业务写路径守卫：用户经工作空间保存/重命名/删除简历时，若 Agent 持有该简历互斥锁则拒绝（Agent 的保存走简历端口，不受此守卫）。
    // 删除也要拦：Agent 编辑期间用户删除会把墓碑复活（Upsert 置 deleted_at=NULL）。
    const guardedMethods = new Set(['UpsertResume', 'RenameResume', 'DeleteResume']);
    const guardedBusiness = new Proxy(host.business, {
        get(target, property) {
            if (typeof property === 'string' && guardedMethods.has(property)) {
                return async (...args) => {
                    const resumeId = args[0]?.id ?? args[0];
                    const lock = resumeLockStore.GetLock(resumeId);
                    if (lock && lock.owner === 'agent')
                        throw Object.assign(new Error('Agent is currently editing this resume.'), { code: 'RESOURCE_LOCKED' });
                    return target[property](...args);
                };
            }
            // 业务 StoreClient 属性均为字符串方法名；symbol 访问（如 Symbol.iterator）透传。
            return target[property];
        },
    });
    // 领域独立服务注入：Router 不再面向整份 business 门面，按会话/简历/岗位/投递/档案/设置/工作空间分别注入窄门面（A3）。
    const Facade = (methods) => {
        const service = {};
        for (const method of methods)
            service[method] = (...args) => guardedBusiness[method](...args);
        return service;
    };
    const conversations = Facade(['CreateConversation', 'RenameConversation', 'DeleteConversation', 'AppendConversationMessages', 'CompleteConversationMessage', 'RemoveConversationMessage']);
    const resumes = Facade(['UpsertResume', 'RenameResume', 'DeleteResume', 'GetResumeRevisions', 'SetResumeRevisionPinned']);
    const jobs = Facade(['UpsertJob', 'SetJobFavorite', 'DeleteJob']);
    const applications = Facade(['UpsertApplication', 'MoveApplicationStatus', 'DeleteApplication']);
    const profiles = Facade(['GetProfiles', 'SaveProfiles', 'ReloadProfiles']);
    const settings = Facade(['GetStoredSettings', 'SaveSettings']);
    const workspace = Facade(['GetStatus', 'LoadViewModel', 'ImportAttachment', 'CleanupAttachments', 'GetWorkspaceRecoveryStatus', 'RecoverWorkspaceOperations', 'GetDatabaseRecoveryStatus', 'RestoreLatestBackup', 'RestoreBackup', 'ExportRecoveryDiagnostic', 'CreateBackup']);
    const backend = CreateBackend({
        container: {
            agent: agentRunService,
            developer: developerService,
            conversations,
            resumes,
            jobs,
            applications,
            profiles,
            settings,
            workspace,
            desktop: {
                SelectProjectDirectory: async () => {
                    const result = await desktop.Call('SelectProjectDirectory');
                    if (!result)
                        return null;
                    const projectId = `proj-${(0, node_crypto_1.randomUUID)()}`;
                    projectEnvironments.set(projectId, { path: result.path, name: result.name });
                    return { projectId, name: result.name };
                },
                ExportResume: (resume, format) => desktop.Call('ExportResume', [{ workspacePath: currentWorkspacePath, resume, format }]),
            },
        },
        functionRoutes: { 'workspace:migrate': MigrateWorkspace },
        idempotencyStore: new idempotency_store_1.IdempotencyStore((0, node_path_1.join)(userDataPath, 'idempotency-replay.json')),
    });
    PostMessage({ kind: 'ready', pid: process.pid });
    // 就绪后空闲执行小批量清理；失败项由服务保留墓碑，下次启动或手动清理继续重试。
    setTimeout(() => { void guardedBusiness.CleanupAttachments().catch(() => undefined); }, 5000);
    // utilityProcess 子进程侧消息为 MessageEvent 包装（{ data, ports }），需解包后再按 kind 分发。
    process.parentPort.on('message', async (event) => {
        const raw = event;
        const message = raw?.data ?? raw;
        const typed = message;
        if (!typed || typeof typed.kind !== 'string')
            return;
        if (typed.kind === 'desktop-result') {
            desktop.OnMessage(message);
            return;
        }
        if (typed.kind === 'command') {
            try {
                // 迁移期间拒绝非只读写命令，防止迁移窗口写入旧库造成迁移后丢写。
                const recoveryStatus = await host.business.GetWorkspaceRecoveryStatus();
                const recoveryCommands = new Set(['workspace:recover-operations', 'workspace:restore-latest-backup', 'workspace:restore-backup', 'workspace:export-recovery-diagnostic']);
                const recoveryBlocksWrite = recoveryStatus.blocked && !recoveryCommands.has(typed.channel) && !ReadOnlyChannels.has(typed.channel);
                if ((migrating && typed.channel !== 'workspace:migrate' && !ReadOnlyChannels.has(typed.channel)) || recoveryBlocksWrite) {
                    PostMessage({ kind: 'result', requestId: typed.requestId, result: { ok: false, error: { code: 'WORKSPACE_BUSY', message: '工作空间正在迁移，请稍后重试。', retryable: true } } });
                    return;
                }
                const args = Array.isArray(typed.payload) ? typed.payload : [typed.payload];
                // requestId 是信封级显式参数，绝不注入业务 payload；业务对象保持原样透传。
                const result = await backend.HandleCommand(typed.channel, typed.requestId, ...args);
                PostMessage({ kind: 'result', requestId: typed.requestId, result });
            }
            catch (error) {
                PostMessage({ kind: 'result', requestId: typed.requestId, result: { ok: false, error: { code: 'INTERNAL_ERROR', message: error?.message || 'Backend command failed.', retryable: true } } });
            }
            return;
        }
        if (typed.kind === 'ping') {
            PostMessage({ kind: 'pong', seq: typed.seq });
            return;
        }
        if (typed.kind === 'shutdown') {
            await agent.Close();
            host.Close();
            setTimeout(() => process.exit(0), 50);
        }
    });
}
Bootstrap().catch((error) => {
    console.error('Backend bootstrap failed:', error);
    PostMessage({ kind: 'backend-error', code: 'INTERNAL_ERROR', message: error?.message || 'Backend bootstrap failed.' });
    setTimeout(() => process.exit(1), 100);
});
