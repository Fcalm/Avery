"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const electron_1 = require("electron");
const invoke = (channel, ...args) => electron_1.ipcRenderer.invoke(channel, ...args);
/** 写命令仅转交调用方提供的稳定幂等键；传输 requestId 由 Main/Backend 生成。 */
function invokeWorkspaceWrite(channel, payload, options) {
    return invoke(channel, { idempotencyKey: options?.idempotencyKey, payload });
}
/** Agent 的高风险确认和身份清理同样使用写命令信封，避免 Renderer 绕过幂等协议。 */
function invokeAgentWrite(channel, payload) {
    return invoke(channel, { idempotencyKey: globalThis.crypto.randomUUID(), payload });
}
/** 测评写命令使用独立命名空间和稳定信封，不得混入 Agent Tool Bridge。 */
function invokeEvaluationWrite(channel, payload) {
    return invoke(channel, { idempotencyKey: globalThis.crypto.randomUUID(), payload });
}
const agentBridge = {
    Configure: (config) => invoke('agent:configure', config),
    TestConnection: (config) => invoke('agent:test-connection', config),
    GetBalance: () => invoke('agent:get-balance'),
    GetProviderUsage: () => invoke('agent:get-provider-usage'),
    GetModels: (provider) => invoke('agent:get-models', provider),
    GetProviderCatalog: () => invoke('agent:get-provider-catalog'),
    GetModelConfiguration: (input) => invoke('agent:get-model-configuration', input),
    SaveModelConfiguration: (input) => invoke('agent:save-model-configuration', input),
    Send: (request) => invoke('agent:send', request),
    RespondToInteraction: (response) => invokeAgentWrite('agent:respond-interaction', [response]),
    Cancel: (requestId) => invoke('agent:cancel', requestId),
    UpdateConfirmationMode: (requestId, confirmationMode) => invoke('agent:update-confirmation-mode', requestId, confirmationMode),
    UpdateReasoningEffort: (sessionId, reasoningEffort) => invoke('agent:update-reasoning-effort', sessionId, reasoningEffort),
    ConfirmResumeEdit: (id, accepted) => invoke('agent:confirm-resume-edit', id, accepted),
    ConfirmCronTask: (id, accepted) => invokeAgentWrite('agent:confirm-cron-task', [id, accepted]),
    ConfirmBrowserAction: (id, accepted, sessionId) => invokeAgentWrite('agent:confirm-browser-action', [id, accepted, sessionId]),
    GetBrowserRuntimeStatus: (probeConnection) => invoke('agent:browser-runtime-status', probeConnection),
    GetCronBrowserAccess: () => invoke('agent:cron-browser-access'),
    RevokeCronBrowserAccess: (input) => invokeAgentWrite('agent:cron-browser-revoke', [input]),
    AcquireResumeEditLock: (id) => invoke('agent:acquire-resume-lock', id),
    ReleaseResumeEditLock: (id) => invoke('agent:release-resume-lock', id),
    GetStatus: () => invoke('agent:status'),
    GetObservability: () => invoke('agent:observability'),
    GetTraceEvents: (id) => invoke('agent:trace-events', id),
    DeleteTraces: (ids) => invoke('agent:delete-traces', ids),
    SetTraceRetention: (value) => invoke('agent:set-trace-retention', value),
    ClearObservability: () => invoke('agent:clear-observability'),
    ReloadSession: (id) => invoke('agent:reload-session', id),
    CompactSession: (input) => invoke('agent:compact-session', input),
    GetCommandSkills: (input) => invoke('agent:command-skills', input),
    SelectProjectDirectory: () => invoke('agent:select-project-directory'),
    GetSessionAssistantState: (id) => invoke('agent:get-session-assistant-state', id),
    ReadConversationResource: (id, resource) => invoke('agent:read-conversation-resource', id, resource),
    GetSessionScenes: () => invoke('agent:get-session-scenes'),
    BindProjectEnvironment: (sessionId, projectId) => invoke('agent:bind-project-environment', sessionId, projectId),
    GetModuleConfiguration: () => invoke('agent:module-configuration'),
    SelectModuleDirectory: () => invoke('agent:select-module-directory'),
    ResetModules: () => invoke('agent:reset-modules'),
    OnStream: (listener) => {
        const handler = (_event, payload) => listener(payload);
        electron_1.ipcRenderer.on('agent:stream', handler);
        return () => electron_1.ipcRenderer.removeListener('agent:stream', handler);
    },
};
const workspaceBridge = {
    GetStatus: () => invoke('workspace:status'),
    GetViewModel: () => invoke('workspace:get-view-model'),
    GetSettings: () => invoke('workspace:get-settings'),
    SaveSettings: (value, options) => invokeWorkspaceWrite('workspace:save-settings', [value], options),
    CreateConversation: (value, options) => invokeWorkspaceWrite('workspace:conversations-create', [value], options),
    RenameConversation: (id, title, revision, options) => invokeWorkspaceWrite('workspace:conversations-rename', [id, title, revision], options),
    SetConversationPinned: (id, pinned, revision, options) => invokeWorkspaceWrite('workspace:conversations-set-pinned', [id, pinned, revision], options),
    SetConversationArchived: (id, archived, revision, options) => invokeWorkspaceWrite('workspace:conversations-set-archived', [id, archived, revision], options),
    DeleteConversation: (id, options) => invokeWorkspaceWrite('workspace:conversations-delete', [id], options),
    AppendConversationMessages: (id, messages, options) => invokeWorkspaceWrite('workspace:conversations-append-messages', [id, messages], options),
    CompleteConversationMessage: (id, messageId, content, thinking, options) => invokeWorkspaceWrite('workspace:conversations-complete-message', [id, messageId, content, thinking], options),
    RemoveConversationMessage: (id, messageId, options) => invokeWorkspaceWrite('workspace:conversations-remove-message', [id, messageId], options),
    UpsertResume: (value, revision, options) => invokeWorkspaceWrite('workspace:resumes-upsert', [value, revision], options),
    RenameResume: (id, name, revision, options) => invokeWorkspaceWrite('workspace:resumes-rename', [id, name, revision], options),
    DeleteResume: (id, options) => invokeWorkspaceWrite('workspace:resumes-delete', [id], options),
    UpsertJob: (value, revision, options) => invokeWorkspaceWrite('workspace:jobs-upsert', [value, revision], options),
    QueryJobs: (query) => invoke('workspace:jobs-query', query),
    ListRecruitmentSources: () => invoke('workspace:job-collection-sources'),
    SetRecruitmentSourceEnabled: (id, enabled, options) => invokeWorkspaceWrite('workspace:job-collection-source-enabled', [id, enabled], options),
    StartJobCollection: (input, options) => invokeWorkspaceWrite('workspace:job-collection-start', [input], options),
    GetJobCollectionTask: (id) => invoke('workspace:job-collection-task', id),
    CancelJobCollection: (id, options) => invokeWorkspaceWrite('workspace:job-collection-cancel', [id], options),
    SetJobFavorite: (id, favorite, revision, options) => invokeWorkspaceWrite('workspace:jobs-set-favorite', [id, favorite, revision], options),
    DeleteJob: (id, options) => invokeWorkspaceWrite('workspace:jobs-delete', [id], options),
    DeleteJobs: (ids, options) => invokeWorkspaceWrite('workspace:jobs-delete-many', [ids], options),
    UpsertApplication: (value, revision, options) => invokeWorkspaceWrite('workspace:applications-upsert', [value, revision], options),
    MoveApplicationStatus: (id, status, revision, options) => invokeWorkspaceWrite('workspace:applications-move-status', [id, status, revision], options),
    DeleteApplication: (id, options) => invokeWorkspaceWrite('workspace:applications-delete', [id], options),
    GetProfiles: () => invoke('workspace:get-profiles'),
    SaveProfiles: (items, force, options) => invokeWorkspaceWrite('workspace:profiles-save', [items, force], options),
    ReloadProfiles: () => invoke('workspace:profiles-reload'),
    ImportAttachment: (file, mime, options) => invokeWorkspaceWrite('workspace:import-attachment', [electron_1.webUtils.getPathForFile(file), mime], options),
    CleanupAttachments: (options) => invokeWorkspaceWrite('workspace:cleanup-attachments', [], options),
    GetRecoveryStatus: () => invoke('workspace:recovery-status'),
    RecoverOperations: (options) => invokeWorkspaceWrite('workspace:recover-operations', [], options),
    GetDatabaseRecoveryStatus: () => invoke('workspace:database-recovery-status'),
    RestoreLatestBackup: (options) => invokeWorkspaceWrite('workspace:restore-latest-backup', [], options),
    RestoreBackup: (id, options) => invokeWorkspaceWrite('workspace:restore-backup', [id], options),
    ExportRecoveryDiagnostic: (options) => invokeWorkspaceWrite('workspace:export-recovery-diagnostic', [], options),
    CreateBackup: (options) => invokeWorkspaceWrite('workspace:create-backup', [], options),
    GetResumeRevisions: (id) => invoke('workspace:get-resume-revisions', id),
    GetResumeRevision: (resumeId, revisionId) => invoke('workspace:get-resume-revision', resumeId, revisionId),
    RestoreResumeRevision: (resumeId, revisionId, revision, options) => invokeWorkspaceWrite('workspace:resume-revisions-restore', [resumeId, revisionId, revision], options),
    DeleteResumeRevision: (resumeId, revisionId, options) => invokeWorkspaceWrite('workspace:resume-revisions-delete', [resumeId, revisionId], options),
    ExportResume: (resume, format) => invoke('workspace:export-resume', resume, format),
    Migrate: () => invoke('workspace:migrate'),
};
const evaluationBridge = {
    CreateProject: (input) => invokeEvaluationWrite('evaluation:project-create', [input]),
    UpdateProject: (id, input, revision) => invokeEvaluationWrite('evaluation:project-update', [id, input, revision]),
    ReadProject: (id) => invoke('evaluation:project-read', id),
    ListProjects: () => invoke('evaluation:projects-list'),
    DeleteProject: (id) => invokeEvaluationWrite('evaluation:project-delete', [id]),
    ImportDataset: (id, jsonl, rubric, revision) => invokeEvaluationWrite('evaluation:dataset-import', [id, jsonl, rubric, revision]),
    ListDatasetVersions: (id) => invoke('evaluation:dataset-versions-list', id),
    SelectDatasetVersion: (id, version, revision) => invokeEvaluationWrite('evaluation:dataset-version-select', [id, version, revision]),
    DeleteDatasetVersion: (id, version, revision) => invokeEvaluationWrite('evaluation:dataset-version-delete', [id, version, revision]),
    ValidateProject: (id) => invoke('evaluation:project-validate', id),
    PreviewProject: (id) => invoke('evaluation:project-preview', id),
    StartRun: (id, candidateId) => invokeEvaluationWrite('evaluation:run-start', [id, candidateId]),
    CancelRun: (id) => invokeEvaluationWrite('evaluation:run-cancel', [id]),
    ReadRun: (id) => invoke('evaluation:run-read', id),
    ListRuns: (projectId) => invoke('evaluation:runs-list', projectId),
    ReadCaseResult: (id) => invoke('evaluation:case-read', id),
    CompareRuns: (left, right) => invoke('evaluation:runs-compare', left, right),
    OnEvent: (listener) => {
        const handler = (_event, payload) => listener(payload);
        electron_1.ipcRenderer.on('evaluation:event', handler);
        return () => electron_1.ipcRenderer.removeListener('evaluation:event', handler);
    },
};
electron_1.contextBridge.exposeInMainWorld('averyAgent', agentBridge);
electron_1.contextBridge.exposeInMainWorld('averyWorkspace', workspaceBridge);
electron_1.contextBridge.exposeInMainWorld('averyEvaluation', evaluationBridge);
const updateBridge = {
    GetState: () => invoke('app-update:read'),
    Check: () => invoke('app-update:check'),
    Download: () => invoke('app-update:download'),
    Install: () => invoke('app-update:install'),
    OnStateChange: listener => {
        const handler = (_event, state) => listener(state);
        electron_1.ipcRenderer.on('app-update:state', handler);
        return () => electron_1.ipcRenderer.removeListener('app-update:state', handler);
    },
};
electron_1.contextBridge.exposeInMainWorld('averyUpdates', updateBridge);
electron_1.contextBridge.exposeInMainWorld('averyWindow', {
    /** 仅查询/订阅宿主客户区尺寸，Renderer 不直接访问窗口或屏幕 API。 */
    GetFrameSize: () => invoke('window:get-frame-size'),
    OnFrameSizeChange: (listener) => {
        const handler = (_event, size) => listener(size);
        electron_1.ipcRenderer.on('window:frame-size-change', handler);
        return () => electron_1.ipcRenderer.removeListener('window:frame-size-change', handler);
    },
    Minimize: () => invoke('window:minimize'), ToggleMaximize: () => invoke('window:toggle-maximize'), IsMaximized: () => invoke('window:is-maximized'), Close: () => invoke('window:close'),
    OnMaximizedChange: (listener) => {
        const handler = (_event, maximized) => listener(maximized === true);
        electron_1.ipcRenderer.on('window:maximized-change', handler);
        return () => electron_1.ipcRenderer.removeListener('window:maximized-change', handler);
    },
    GetWorkspaceDirectory: () => invoke('app:get-workspace-directory'),
    /** 固定服务商链接；主进程校验来源，不开放任意外部导航。 */
    OpenDeepSeekApiKeys: () => invoke('app:open-deepseek-api-keys'),
    OpenProviderDashboard: (provider) => invoke('app:open-provider-dashboard', provider),
    /** 只传浏览器枚举；安装页、扩展目录及启动方式由 Main 决定。 */
    OpenBrowserExtensionSetup: (engine) => invoke('app:open-browser-extension-setup', engine),
    ReadMimoAccountUsage: () => invoke('app:mimo-account-usage'),
    OpenMimoAccountLogin: () => invoke('app:mimo-account-login'),
    DisconnectMimoAccount: () => invoke('app:mimo-account-disconnect'),
    /** 只写入纯文本；来源与长度由主进程校验，不向页面暴露 Electron clipboard。 */
    WriteClipboardText: (text) => invoke('app:write-clipboard-text', text),
    OpenWorkspaceDirectory: () => invoke('app:open-workspace-directory'),
    SetLoginItemSettings: (openAtLogin) => invoke('app:set-login-item', openAtLogin),
});
