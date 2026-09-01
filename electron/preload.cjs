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
    GetModels: () => invoke('agent:get-models'),
    Send: (request) => invoke('agent:send', request),
    Cancel: (requestId) => invoke('agent:cancel', requestId),
    UpdateConfirmationMode: (requestId, confirmationMode) => invoke('agent:update-confirmation-mode', requestId, confirmationMode),
    UpdateReasoningEffort: (sessionId, reasoningEffort) => invoke('agent:update-reasoning-effort', sessionId, reasoningEffort),
    ConfirmResumeEdit: (id, accepted) => invoke('agent:confirm-resume-edit', id, accepted),
    ConfirmCronTask: (id, accepted) => invokeAgentWrite('agent:confirm-cron-task', [id, accepted]),
    ConfirmBrowserAction: (id, accepted) => invokeAgentWrite('agent:confirm-browser-action', [id, accepted]),
    GetBrowserRuntimeStatus: () => invoke('agent:browser-runtime-status'),
    ClearBrowserProfile: () => invokeAgentWrite('agent:browser-clear-profile', []),
    AcquireResumeEditLock: (id) => invoke('agent:acquire-resume-lock', id),
    ReleaseResumeEditLock: (id) => invoke('agent:release-resume-lock', id),
    GetStatus: () => invoke('agent:status'),
    GetObservability: () => invoke('agent:observability'),
    GetTraceEvents: (id) => invoke('agent:trace-events', id),
    DeleteTraces: (ids) => invoke('agent:delete-traces', ids),
    SetTraceRetention: (value) => invoke('agent:set-trace-retention', value),
    ClearObservability: () => invoke('agent:clear-observability'),
    ReloadSession: (id) => invoke('agent:reload-session', id),
    SelectProjectDirectory: () => invoke('agent:select-project-directory'),
    GetSessionAssistantState: (id) => invoke('agent:get-session-assistant-state', id),
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
    DeleteConversation: (id, options) => invokeWorkspaceWrite('workspace:conversations-delete', [id], options),
    AppendConversationMessages: (id, messages, options) => invokeWorkspaceWrite('workspace:conversations-append-messages', [id, messages], options),
    CompleteConversationMessage: (id, messageId, content, thinking, options) => invokeWorkspaceWrite('workspace:conversations-complete-message', [id, messageId, content, thinking], options),
    RemoveConversationMessage: (id, messageId, options) => invokeWorkspaceWrite('workspace:conversations-remove-message', [id, messageId], options),
    UpsertResume: (value, revision, options) => invokeWorkspaceWrite('workspace:resumes-upsert', [value, revision], options),
    RenameResume: (id, name, revision, options) => invokeWorkspaceWrite('workspace:resumes-rename', [id, name, revision], options),
    DeleteResume: (id, options) => invokeWorkspaceWrite('workspace:resumes-delete', [id], options),
    UpsertJob: (value, revision, options) => invokeWorkspaceWrite('workspace:jobs-upsert', [value, revision], options),
    SetJobFavorite: (id, favorite, revision, options) => invokeWorkspaceWrite('workspace:jobs-set-favorite', [id, favorite, revision], options),
    DeleteJob: (id, options) => invokeWorkspaceWrite('workspace:jobs-delete', [id], options),
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
    SetResumeRevisionPinned: (id, pinned, options) => invokeWorkspaceWrite('workspace:set-resume-revision-pinned', [id, pinned], options),
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
    ValidateProject: (id) => invoke('evaluation:project-validate', id),
    PreviewProject: (id) => invoke('evaluation:project-preview', id),
    StartRun: (id) => invokeEvaluationWrite('evaluation:run-start', [id]),
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
electron_1.contextBridge.exposeInMainWorld('offergetAgent', agentBridge);
electron_1.contextBridge.exposeInMainWorld('offergetWorkspace', workspaceBridge);
electron_1.contextBridge.exposeInMainWorld('offergetEvaluation', evaluationBridge);
electron_1.contextBridge.exposeInMainWorld('offergetWindow', {
    Minimize: () => invoke('window:minimize'), ToggleMaximize: () => invoke('window:toggle-maximize'), Close: () => invoke('window:close'),
});
