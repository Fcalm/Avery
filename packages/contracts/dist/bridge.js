"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.BridgeNamespaces = void 0;
/** Bridge 方法清单：preload 暴露的方法名唯一来源，供一致性冒烟校验与契约生成使用。 */
exports.BridgeNamespaces = {
    agent: [
        'Configure', 'TestConnection', 'GetBalance', 'GetModels', 'Send', 'Cancel', 'ConfirmResumeEdit',
        'AcquireResumeEditLock', 'ReleaseResumeEditLock', 'GetStatus',
        'GetObservability', 'GetTraceEvents', 'DeleteTraces', 'SetTraceRetention', 'ClearObservability',
        'ReloadSession', 'SelectProjectDirectory', 'GetSessionAssistantState', 'BindProjectEnvironment',
        'GetModuleConfiguration', 'SelectModuleDirectory', 'ResetModules', 'OnStream',
    ],
    workspace: [
        'GetStatus', 'GetViewModel', 'GetSettings', 'SaveSettings',
        'CreateConversation', 'RenameConversation', 'DeleteConversation', 'AppendConversationMessages',
        'CompleteConversationMessage', 'RemoveConversationMessage', 'UpsertResume', 'RenameResume',
        'DeleteResume', 'UpsertJob', 'SetJobFavorite', 'DeleteJob', 'UpsertApplication',
        'MoveApplicationStatus', 'DeleteApplication', 'GetProfiles', 'SaveProfiles', 'ReloadProfiles',
        'ImportAttachment', 'CleanupAttachments', 'GetRecoveryStatus', 'RecoverOperations', 'GetDatabaseRecoveryStatus',
        'RestoreLatestBackup', 'RestoreBackup', 'ExportRecoveryDiagnostic', 'CreateBackup', 'GetResumeRevisions', 'SetResumeRevisionPinned',
        'ExportResume', 'Migrate',
    ],
};
