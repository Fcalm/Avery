const { contextBridge, ipcRenderer, webUtils } = require('electron');

/**
 * 写命令只暴露稳定幂等键和业务参数，内部 requestId 由 Main/Backend 生成。
 * 同一用户意图的重试必须复用 options.idempotencyKey，preload 不得自行生成键。
 */
function InvokeWorkspaceWrite(channel, args, options) {
  return ipcRenderer.invoke(channel, { idempotencyKey: options?.idempotencyKey, payload: args });
}

contextBridge.exposeInMainWorld('offergetAgent', {
  Configure: (config) => ipcRenderer.invoke('agent:configure', config),
    TestConnection: (config) => ipcRenderer.invoke('agent:test-connection', config),
    GetBalance: () => ipcRenderer.invoke('agent:get-balance'),
    GetModels: () => ipcRenderer.invoke('agent:get-models'),
  Send: (request) => ipcRenderer.invoke('agent:send', request),
  Cancel: (requestId) => ipcRenderer.invoke('agent:cancel', requestId),
  ConfirmResumeEdit: (confirmationId, accepted) => ipcRenderer.invoke('agent:confirm-resume-edit', confirmationId, accepted),
  AcquireResumeEditLock: (resumeId) => ipcRenderer.invoke('agent:acquire-resume-lock', resumeId),
  ReleaseResumeEditLock: (resumeId) => ipcRenderer.invoke('agent:release-resume-lock', resumeId),
  GetStatus: () => ipcRenderer.invoke('agent:status'),
  GetObservability: () => ipcRenderer.invoke('agent:observability'),
  GetTraceEvents: (requestId) => ipcRenderer.invoke('agent:trace-events', requestId),
  DeleteTraces: (sessionIds) => ipcRenderer.invoke('agent:delete-traces', sessionIds),
  SetTraceRetention: (value) => ipcRenderer.invoke('agent:set-trace-retention', value),
  ClearObservability: () => ipcRenderer.invoke('agent:clear-observability'),
  ReloadSession: (sessionId) => ipcRenderer.invoke('agent:reload-session', sessionId),
  SelectProjectDirectory: () => ipcRenderer.invoke('agent:select-project-directory'),
  GetSessionAssistantState: (sessionId) => ipcRenderer.invoke('agent:get-session-assistant-state', sessionId),
  BindProjectEnvironment: (sessionId, projectId) => ipcRenderer.invoke('agent:bind-project-environment', sessionId, projectId),
  GetModuleConfiguration: () => ipcRenderer.invoke('agent:module-configuration'),
  SelectModuleDirectory: () => ipcRenderer.invoke('agent:select-module-directory'),
  ResetModules: () => ipcRenderer.invoke('agent:reset-modules'),
  OnStream: (listener) => {
    const handler = (_event, payload) => listener(payload);
    ipcRenderer.on('agent:stream', handler);
    return () => ipcRenderer.removeListener('agent:stream', handler);
  },
});

contextBridge.exposeInMainWorld('offergetWorkspace', {
  GetStatus: () => ipcRenderer.invoke('workspace:status'),
  GetViewModel: () => ipcRenderer.invoke('workspace:get-view-model'),
  GetSettings: () => ipcRenderer.invoke('workspace:get-settings'),
  SaveSettings: (settings, options) => InvokeWorkspaceWrite('workspace:save-settings', [settings], options),
  CreateConversation: (conversation, options) => InvokeWorkspaceWrite('workspace:conversations-create', [conversation], options),
  RenameConversation: (id, title, expectedRevision, options) => InvokeWorkspaceWrite('workspace:conversations-rename', [id, title, expectedRevision], options),
  DeleteConversation: (id, options) => InvokeWorkspaceWrite('workspace:conversations-delete', [id], options),
  AppendConversationMessages: (conversationId, messages, options) => InvokeWorkspaceWrite('workspace:conversations-append-messages', [conversationId, messages], options),
  CompleteConversationMessage: (conversationId, messageId, content, thinkingContent, options) => InvokeWorkspaceWrite('workspace:conversations-complete-message', [conversationId, messageId, content, thinkingContent], options),
  RemoveConversationMessage: (conversationId, messageId, options) => InvokeWorkspaceWrite('workspace:conversations-remove-message', [conversationId, messageId], options),
  UpsertResume: (resume, expectedRevision, options) => InvokeWorkspaceWrite('workspace:resumes-upsert', [resume, expectedRevision], options),
  RenameResume: (id, name, expectedRevision, options) => InvokeWorkspaceWrite('workspace:resumes-rename', [id, name, expectedRevision], options),
  DeleteResume: (id, options) => InvokeWorkspaceWrite('workspace:resumes-delete', [id], options),
  UpsertJob: (job, expectedRevision, options) => InvokeWorkspaceWrite('workspace:jobs-upsert', [job, expectedRevision], options),
  SetJobFavorite: (id, favorite, expectedRevision, options) => InvokeWorkspaceWrite('workspace:jobs-set-favorite', [id, favorite, expectedRevision], options),
  DeleteJob: (id, options) => InvokeWorkspaceWrite('workspace:jobs-delete', [id], options),
  UpsertApplication: (application, expectedRevision, options) => InvokeWorkspaceWrite('workspace:applications-upsert', [application, expectedRevision], options),
  MoveApplicationStatus: (id, status, expectedRevision, options) => InvokeWorkspaceWrite('workspace:applications-move-status', [id, status, expectedRevision], options),
  DeleteApplication: (id, options) => InvokeWorkspaceWrite('workspace:applications-delete', [id], options),
  GetProfiles: () => ipcRenderer.invoke('workspace:get-profiles'),
  SaveProfiles: (items, force, options) => InvokeWorkspaceWrite('workspace:profiles-save', [items, force], options),
  ReloadProfiles: () => ipcRenderer.invoke('workspace:profiles-reload'),
  ImportAttachment: (file, mimeType, options) => InvokeWorkspaceWrite('workspace:import-attachment', [webUtils.getPathForFile(file), mimeType], options),
  CleanupAttachments: (options) => InvokeWorkspaceWrite('workspace:cleanup-attachments', [], options),
  GetRecoveryStatus: () => ipcRenderer.invoke('workspace:recovery-status'),
  RecoverOperations: (options) => InvokeWorkspaceWrite('workspace:recover-operations', [], options),
  GetDatabaseRecoveryStatus: () => ipcRenderer.invoke('workspace:database-recovery-status'),
  RestoreLatestBackup: (options) => InvokeWorkspaceWrite('workspace:restore-latest-backup', [], options),
  RestoreBackup: (backupId, options) => InvokeWorkspaceWrite('workspace:restore-backup', [backupId], options),
  ExportRecoveryDiagnostic: (options) => InvokeWorkspaceWrite('workspace:export-recovery-diagnostic', [], options),
  CreateBackup: (options) => InvokeWorkspaceWrite('workspace:create-backup', [], options),
  GetResumeRevisions: (resumeId) => ipcRenderer.invoke('workspace:get-resume-revisions', resumeId),
  SetResumeRevisionPinned: (revisionId, pinned, options) => InvokeWorkspaceWrite('workspace:set-resume-revision-pinned', [revisionId, pinned], options),
  ExportResume: (resume, format) => ipcRenderer.invoke('workspace:export-resume', resume, format),
  Migrate: (destinationPath) => ipcRenderer.invoke('workspace:migrate', destinationPath),
});

contextBridge.exposeInMainWorld('offergetWindow', {
  Minimize: () => ipcRenderer.invoke('window:minimize'),
  ToggleMaximize: () => ipcRenderer.invoke('window:toggle-maximize'),
  Close: () => ipcRenderer.invoke('window:close'),
});
