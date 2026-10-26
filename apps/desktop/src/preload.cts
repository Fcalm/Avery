import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { DesktopAgentBridge, DesktopEvaluationBridge, WorkspaceBridge, WriteCommandOptions, ResultEnvelope } from '@avery/contracts';

type Invoke = (channel: string, ...args: unknown[]) => Promise<unknown>;
const invoke: Invoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args);

/** 写命令仅转交调用方提供的稳定幂等键；传输 requestId 由 Main/Backend 生成。 */
function invokeWorkspaceWrite(channel: string, payload: unknown[], options?: WriteCommandOptions): Promise<unknown> {
  return invoke(channel, { idempotencyKey: options?.idempotencyKey, payload });
}

/** Agent 的高风险确认和身份清理同样使用写命令信封，避免 Renderer 绕过幂等协议。 */
function invokeAgentWrite(channel: string, payload: unknown[]): Promise<unknown> {
  return invoke(channel, { idempotencyKey: globalThis.crypto.randomUUID(), payload });
}

/** 测评写命令使用独立命名空间和稳定信封，不得混入 Agent Tool Bridge。 */
function invokeEvaluationWrite(channel: string, payload: unknown[]): Promise<unknown> {
  return invoke(channel, { idempotencyKey: globalThis.crypto.randomUUID(), payload });
}

const agentBridge: DesktopAgentBridge = {
  Configure: (config) => invoke('agent:configure', config) as ReturnType<DesktopAgentBridge['Configure']>,
  TestConnection: (config) => invoke('agent:test-connection', config) as ReturnType<DesktopAgentBridge['TestConnection']>,
  GetBalance: () => invoke('agent:get-balance') as ReturnType<DesktopAgentBridge['GetBalance']>,
  GetProviderUsage: () => invoke('agent:get-provider-usage') as ReturnType<DesktopAgentBridge['GetProviderUsage']>,
  GetModels: (provider) => invoke('agent:get-models', provider) as ReturnType<DesktopAgentBridge['GetModels']>,
  GetProviderCatalog: () => invoke('agent:get-provider-catalog') as ReturnType<DesktopAgentBridge['GetProviderCatalog']>,
  Send: (request) => invoke('agent:send', request) as ReturnType<DesktopAgentBridge['Send']>,
  RespondToInteraction: (response) => invokeAgentWrite('agent:respond-interaction', [response]) as ReturnType<DesktopAgentBridge['RespondToInteraction']>,
  Cancel: (requestId) => invoke('agent:cancel', requestId) as ReturnType<DesktopAgentBridge['Cancel']>,
  UpdateConfirmationMode: (requestId, confirmationMode) => invoke('agent:update-confirmation-mode', requestId, confirmationMode) as ReturnType<DesktopAgentBridge['UpdateConfirmationMode']>,
  UpdateReasoningEffort: (sessionId, reasoningEffort) => invoke('agent:update-reasoning-effort', sessionId, reasoningEffort) as ReturnType<DesktopAgentBridge['UpdateReasoningEffort']>,
  ConfirmResumeEdit: (id, accepted) => invoke('agent:confirm-resume-edit', id, accepted) as ReturnType<DesktopAgentBridge['ConfirmResumeEdit']>,
  ConfirmCronTask: (id, accepted) => invokeAgentWrite('agent:confirm-cron-task', [id, accepted]) as ReturnType<DesktopAgentBridge['ConfirmCronTask']>,
  ConfirmBrowserAction: (id, accepted, sessionId) => invokeAgentWrite('agent:confirm-browser-action', [id, accepted, sessionId]) as ReturnType<DesktopAgentBridge['ConfirmBrowserAction']>,
  GetBrowserRuntimeStatus: (probeConnection) => invoke('agent:browser-runtime-status', probeConnection) as ReturnType<DesktopAgentBridge['GetBrowserRuntimeStatus']>,
  GetCronBrowserAccess: () => invoke('agent:cron-browser-access') as ReturnType<DesktopAgentBridge['GetCronBrowserAccess']>,
  RevokeCronBrowserAccess: (input) => invokeAgentWrite('agent:cron-browser-revoke', [input]) as ReturnType<DesktopAgentBridge['RevokeCronBrowserAccess']>,
  AcquireResumeEditLock: (id) => invoke('agent:acquire-resume-lock', id) as ReturnType<DesktopAgentBridge['AcquireResumeEditLock']>,
  ReleaseResumeEditLock: (id) => invoke('agent:release-resume-lock', id) as ReturnType<DesktopAgentBridge['ReleaseResumeEditLock']>,
  GetStatus: () => invoke('agent:status') as ReturnType<DesktopAgentBridge['GetStatus']>,
  GetObservability: () => invoke('agent:observability') as ReturnType<DesktopAgentBridge['GetObservability']>,
  GetTraceEvents: (id) => invoke('agent:trace-events', id) as ReturnType<DesktopAgentBridge['GetTraceEvents']>,
  DeleteTraces: (ids) => invoke('agent:delete-traces', ids) as ReturnType<DesktopAgentBridge['DeleteTraces']>,
  SetTraceRetention: (value) => invoke('agent:set-trace-retention', value) as ReturnType<DesktopAgentBridge['SetTraceRetention']>,
  ClearObservability: () => invoke('agent:clear-observability') as ReturnType<DesktopAgentBridge['ClearObservability']>,
  ReloadSession: (id) => invoke('agent:reload-session', id) as ReturnType<DesktopAgentBridge['ReloadSession']>,
  GetCommandSkills: (input) => invoke('agent:command-skills', input) as ReturnType<DesktopAgentBridge['GetCommandSkills']>,
  SelectProjectDirectory: () => invoke('agent:select-project-directory') as ReturnType<DesktopAgentBridge['SelectProjectDirectory']>,
  GetSessionAssistantState: (id) => invoke('agent:get-session-assistant-state', id) as ReturnType<DesktopAgentBridge['GetSessionAssistantState']>,
  ReadConversationResource: (id, resource) => invoke('agent:read-conversation-resource', id, resource) as ReturnType<DesktopAgentBridge['ReadConversationResource']>,
  GetSessionScenes: () => invoke('agent:get-session-scenes') as ReturnType<DesktopAgentBridge['GetSessionScenes']>,
  BindProjectEnvironment: (sessionId, projectId) => invoke('agent:bind-project-environment', sessionId, projectId) as ReturnType<DesktopAgentBridge['BindProjectEnvironment']>,
  GetModuleConfiguration: () => invoke('agent:module-configuration') as ReturnType<DesktopAgentBridge['GetModuleConfiguration']>,
  SelectModuleDirectory: () => invoke('agent:select-module-directory') as ReturnType<DesktopAgentBridge['SelectModuleDirectory']>,
  ResetModules: () => invoke('agent:reset-modules') as ReturnType<DesktopAgentBridge['ResetModules']>,
  OnStream: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: unknown) => listener(payload as Parameters<typeof listener>[0]);
    ipcRenderer.on('agent:stream', handler);
    return () => ipcRenderer.removeListener('agent:stream', handler);
  },
};

const workspaceBridge: WorkspaceBridge = {
  GetStatus: () => invoke('workspace:status') as ReturnType<WorkspaceBridge['GetStatus']>,
  GetViewModel: () => invoke('workspace:get-view-model') as ReturnType<WorkspaceBridge['GetViewModel']>,
  GetSettings: () => invoke('workspace:get-settings') as ReturnType<WorkspaceBridge['GetSettings']>,
  SaveSettings: (value, options) => invokeWorkspaceWrite('workspace:save-settings', [value], options) as ReturnType<WorkspaceBridge['SaveSettings']>,
  CreateConversation: (value, options) => invokeWorkspaceWrite('workspace:conversations-create', [value], options) as ReturnType<WorkspaceBridge['CreateConversation']>,
  RenameConversation: (id, title, revision, options) => invokeWorkspaceWrite('workspace:conversations-rename', [id, title, revision], options) as ReturnType<WorkspaceBridge['RenameConversation']>,
  SetConversationPinned: (id, pinned, revision, options) => invokeWorkspaceWrite('workspace:conversations-set-pinned', [id, pinned, revision], options) as ReturnType<WorkspaceBridge['SetConversationPinned']>,
  SetConversationArchived: (id, archived, revision, options) => invokeWorkspaceWrite('workspace:conversations-set-archived', [id, archived, revision], options) as ReturnType<WorkspaceBridge['SetConversationArchived']>,
  DeleteConversation: (id, options) => invokeWorkspaceWrite('workspace:conversations-delete', [id], options) as ReturnType<WorkspaceBridge['DeleteConversation']>,
  AppendConversationMessages: (id, messages, options) => invokeWorkspaceWrite('workspace:conversations-append-messages', [id, messages], options) as ReturnType<WorkspaceBridge['AppendConversationMessages']>,
  CompleteConversationMessage: (id, messageId, content, thinking, options) => invokeWorkspaceWrite('workspace:conversations-complete-message', [id, messageId, content, thinking], options) as ReturnType<WorkspaceBridge['CompleteConversationMessage']>,
  RemoveConversationMessage: (id, messageId, options) => invokeWorkspaceWrite('workspace:conversations-remove-message', [id, messageId], options) as ReturnType<WorkspaceBridge['RemoveConversationMessage']>,
  UpsertResume: (value, revision, options) => invokeWorkspaceWrite('workspace:resumes-upsert', [value, revision], options) as ReturnType<WorkspaceBridge['UpsertResume']>,
  RenameResume: (id, name, revision, options) => invokeWorkspaceWrite('workspace:resumes-rename', [id, name, revision], options) as ReturnType<WorkspaceBridge['RenameResume']>,
  DeleteResume: (id, options) => invokeWorkspaceWrite('workspace:resumes-delete', [id], options) as ReturnType<WorkspaceBridge['DeleteResume']>,
  UpsertJob: (value, revision, options) => invokeWorkspaceWrite('workspace:jobs-upsert', [value, revision], options) as ReturnType<WorkspaceBridge['UpsertJob']>,
  QueryJobs: (query) => invoke('workspace:jobs-query', query) as ReturnType<WorkspaceBridge['QueryJobs']>,
  ListRecruitmentSources: () => invoke('workspace:job-collection-sources') as ReturnType<WorkspaceBridge['ListRecruitmentSources']>,
  SetRecruitmentSourceEnabled: (id, enabled, options) => invokeWorkspaceWrite('workspace:job-collection-source-enabled', [id, enabled], options) as ReturnType<WorkspaceBridge['SetRecruitmentSourceEnabled']>,
  StartJobCollection: (input, options) => invokeWorkspaceWrite('workspace:job-collection-start', [input], options) as ReturnType<WorkspaceBridge['StartJobCollection']>,
  GetJobCollectionTask: (id) => invoke('workspace:job-collection-task', id) as ReturnType<WorkspaceBridge['GetJobCollectionTask']>,
  CancelJobCollection: (id, options) => invokeWorkspaceWrite('workspace:job-collection-cancel', [id], options) as ReturnType<WorkspaceBridge['CancelJobCollection']>,
  SetJobFavorite: (id, favorite, revision, options) => invokeWorkspaceWrite('workspace:jobs-set-favorite', [id, favorite, revision], options) as ReturnType<WorkspaceBridge['SetJobFavorite']>,
  DeleteJob: (id, options) => invokeWorkspaceWrite('workspace:jobs-delete', [id], options) as ReturnType<WorkspaceBridge['DeleteJob']>,
  DeleteJobs: (ids, options) => invokeWorkspaceWrite('workspace:jobs-delete-many', [ids], options) as ReturnType<WorkspaceBridge['DeleteJobs']>,
  UpsertApplication: (value, revision, options) => invokeWorkspaceWrite('workspace:applications-upsert', [value, revision], options) as ReturnType<WorkspaceBridge['UpsertApplication']>,
  MoveApplicationStatus: (id, status, revision, options) => invokeWorkspaceWrite('workspace:applications-move-status', [id, status, revision], options) as ReturnType<WorkspaceBridge['MoveApplicationStatus']>,
  DeleteApplication: (id, options) => invokeWorkspaceWrite('workspace:applications-delete', [id], options) as ReturnType<WorkspaceBridge['DeleteApplication']>,
  GetProfiles: () => invoke('workspace:get-profiles') as ReturnType<WorkspaceBridge['GetProfiles']>,
  SaveProfiles: (items, force, options) => invokeWorkspaceWrite('workspace:profiles-save', [items, force], options) as ReturnType<WorkspaceBridge['SaveProfiles']>,
  ReloadProfiles: () => invoke('workspace:profiles-reload') as ReturnType<WorkspaceBridge['ReloadProfiles']>,
  ImportAttachment: (file, mime, options) => invokeWorkspaceWrite('workspace:import-attachment', [webUtils.getPathForFile(file), mime], options) as ReturnType<WorkspaceBridge['ImportAttachment']>,
  CleanupAttachments: (options) => invokeWorkspaceWrite('workspace:cleanup-attachments', [], options) as ReturnType<WorkspaceBridge['CleanupAttachments']>,
  GetRecoveryStatus: () => invoke('workspace:recovery-status') as ReturnType<WorkspaceBridge['GetRecoveryStatus']>,
  RecoverOperations: (options) => invokeWorkspaceWrite('workspace:recover-operations', [], options) as ReturnType<WorkspaceBridge['RecoverOperations']>,
  GetDatabaseRecoveryStatus: () => invoke('workspace:database-recovery-status') as ReturnType<WorkspaceBridge['GetDatabaseRecoveryStatus']>,
  RestoreLatestBackup: (options) => invokeWorkspaceWrite('workspace:restore-latest-backup', [], options) as ReturnType<WorkspaceBridge['RestoreLatestBackup']>,
  RestoreBackup: (id, options) => invokeWorkspaceWrite('workspace:restore-backup', [id], options) as ReturnType<WorkspaceBridge['RestoreBackup']>,
  ExportRecoveryDiagnostic: (options) => invokeWorkspaceWrite('workspace:export-recovery-diagnostic', [], options) as ReturnType<WorkspaceBridge['ExportRecoveryDiagnostic']>,
  CreateBackup: (options) => invokeWorkspaceWrite('workspace:create-backup', [], options) as ReturnType<WorkspaceBridge['CreateBackup']>,
  GetResumeRevisions: (id) => invoke('workspace:get-resume-revisions', id) as ReturnType<WorkspaceBridge['GetResumeRevisions']>,
  GetResumeRevision: (resumeId, revisionId) => invoke('workspace:get-resume-revision', resumeId, revisionId) as ReturnType<WorkspaceBridge['GetResumeRevision']>,
  RestoreResumeRevision: (resumeId, revisionId, revision, options) => invokeWorkspaceWrite('workspace:resume-revisions-restore', [resumeId, revisionId, revision], options) as ReturnType<WorkspaceBridge['RestoreResumeRevision']>,
  DeleteResumeRevision: (resumeId, revisionId, options) => invokeWorkspaceWrite('workspace:resume-revisions-delete', [resumeId, revisionId], options) as ReturnType<WorkspaceBridge['DeleteResumeRevision']>,
  ExportResume: (resume, format) => invoke('workspace:export-resume', resume, format) as ReturnType<WorkspaceBridge['ExportResume']>,
  Migrate: () => invoke('workspace:migrate') as ReturnType<WorkspaceBridge['Migrate']>,
};

const evaluationBridge: DesktopEvaluationBridge = {
  CreateProject: (input) => invokeEvaluationWrite('evaluation:project-create', [input]) as ReturnType<DesktopEvaluationBridge['CreateProject']>,
  UpdateProject: (id, input, revision) => invokeEvaluationWrite('evaluation:project-update', [id, input, revision]) as ReturnType<DesktopEvaluationBridge['UpdateProject']>,
  ReadProject: (id) => invoke('evaluation:project-read', id) as ReturnType<DesktopEvaluationBridge['ReadProject']>,
  ListProjects: () => invoke('evaluation:projects-list') as ReturnType<DesktopEvaluationBridge['ListProjects']>,
  DeleteProject: (id) => invokeEvaluationWrite('evaluation:project-delete', [id]) as ReturnType<DesktopEvaluationBridge['DeleteProject']>,
  ImportDataset: (id, jsonl, rubric, revision) => invokeEvaluationWrite('evaluation:dataset-import', [id, jsonl, rubric, revision]) as ReturnType<DesktopEvaluationBridge['ImportDataset']>,
  ListDatasetVersions: (id) => invoke('evaluation:dataset-versions-list', id) as ReturnType<DesktopEvaluationBridge['ListDatasetVersions']>,
  SelectDatasetVersion: (id, version, revision) => invokeEvaluationWrite('evaluation:dataset-version-select', [id, version, revision]) as ReturnType<DesktopEvaluationBridge['SelectDatasetVersion']>,
  DeleteDatasetVersion: (id, version, revision) => invokeEvaluationWrite('evaluation:dataset-version-delete', [id, version, revision]) as ReturnType<DesktopEvaluationBridge['DeleteDatasetVersion']>,
  ValidateProject: (id) => invoke('evaluation:project-validate', id) as ReturnType<DesktopEvaluationBridge['ValidateProject']>,
  PreviewProject: (id) => invoke('evaluation:project-preview', id) as ReturnType<DesktopEvaluationBridge['PreviewProject']>,
  StartRun: (id, candidateId) => invokeEvaluationWrite('evaluation:run-start', [id, candidateId]) as ReturnType<DesktopEvaluationBridge['StartRun']>,
  CancelRun: (id) => invokeEvaluationWrite('evaluation:run-cancel', [id]) as ReturnType<DesktopEvaluationBridge['CancelRun']>,
  ReadRun: (id) => invoke('evaluation:run-read', id) as ReturnType<DesktopEvaluationBridge['ReadRun']>,
  ListRuns: (projectId) => invoke('evaluation:runs-list', projectId) as ReturnType<DesktopEvaluationBridge['ListRuns']>,
  ReadCaseResult: (id) => invoke('evaluation:case-read', id) as ReturnType<DesktopEvaluationBridge['ReadCaseResult']>,
  CompareRuns: (left, right) => invoke('evaluation:runs-compare', left, right) as ReturnType<DesktopEvaluationBridge['CompareRuns']>,
  OnEvent: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: unknown) => listener(payload as Parameters<typeof listener>[0]);
    ipcRenderer.on('evaluation:event', handler);
    return () => ipcRenderer.removeListener('evaluation:event', handler);
  },
};

contextBridge.exposeInMainWorld('averyAgent', agentBridge);
contextBridge.exposeInMainWorld('averyWorkspace', workspaceBridge);
contextBridge.exposeInMainWorld('averyEvaluation', evaluationBridge);
contextBridge.exposeInMainWorld('averyWindow', {
  /** 仅查询/订阅宿主客户区尺寸，Renderer 不直接访问窗口或屏幕 API。 */
  GetFrameSize: () => invoke('window:get-frame-size') as Promise<{ width: number; height: number; unit: 'physical' | 'css' }>,
  OnFrameSizeChange: (listener: (size: { width: number; height: number; unit: 'physical' | 'css' }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, size: { width: number; height: number; unit: 'physical' | 'css' }) => listener(size);
    ipcRenderer.on('window:frame-size-change', handler);
    return () => ipcRenderer.removeListener('window:frame-size-change', handler);
  },
  Minimize: () => invoke('window:minimize'), ToggleMaximize: () => invoke('window:toggle-maximize'), IsMaximized: () => invoke('window:is-maximized') as Promise<boolean>, Close: () => invoke('window:close'),
  OnMaximizedChange: (listener: (maximized: boolean) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, maximized: unknown) => listener(maximized === true);
    ipcRenderer.on('window:maximized-change', handler);
    return () => ipcRenderer.removeListener('window:maximized-change', handler);
  },
  GetWorkspaceDirectory: () => invoke('app:get-workspace-directory') as Promise<string>,
  /** 固定服务商链接；主进程校验来源，不开放任意外部导航。 */
  OpenDeepSeekApiKeys: () => invoke('app:open-deepseek-api-keys') as Promise<ResultEnvelope<boolean>>,
  OpenProviderDashboard: (provider: string) => invoke('app:open-provider-dashboard', provider) as Promise<ResultEnvelope<boolean>>,
  ReadMimoAccountUsage: () => invoke('app:mimo-account-usage') as Promise<ResultEnvelope<import('@avery/contracts').ProviderAccountUsage>>,
  OpenMimoAccountLogin: () => invoke('app:mimo-account-login') as Promise<ResultEnvelope<{ authorized: boolean }>>,
  DisconnectMimoAccount: () => invoke('app:mimo-account-disconnect') as Promise<ResultEnvelope<boolean>>,
  /** 只写入纯文本；来源与长度由主进程校验，不向页面暴露 Electron clipboard。 */
  WriteClipboardText: (text: string) => invoke('app:write-clipboard-text', text) as Promise<ResultEnvelope<boolean>>,
  OpenWorkspaceDirectory: () => invoke('app:open-workspace-directory') as Promise<boolean>,
  SetLoginItemSettings: (openAtLogin: boolean) => invoke('app:set-login-item', openAtLogin) as Promise<boolean>,
});
