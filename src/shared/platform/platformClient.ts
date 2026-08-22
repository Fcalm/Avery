import {
  ErrorCode, type ErrorCodeValue, type ResultEnvelope, type DesktopAgentBridge, type WorkspaceBridge, type SettingsDto, type WriteCommandOptions,
} from '@offerget/contracts';

/** 统一业务错误：携带稳定错误码与可选诊断明细，页面只消费 code，不再解析异常字符串。 */
export class AppError extends Error {
  code: ErrorCodeValue;
  details?: unknown;

  constructor(code: ErrorCodeValue, message: string, details?: unknown) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.details = details;
  }
}

/** 从同步抛出的异常中提取稳定错误码；后端业务错误已走结果信封，此处仅兜底携带结构 code 的异常。 */
function ExtractErrorCode(error: unknown): ErrorCodeValue {
  const code = error instanceof Error ? (error as { code?: unknown }).code : null;
  if (typeof code === 'string' && (Object.values(ErrorCode) as string[]).includes(code)) return code as ErrorCodeValue;
  return ErrorCode.INTERNAL_ERROR;
}

/** 统一桥接调用：后端已返回统一结果信封，这里只兜底同步抛出的异常，其余原样透传。 */
async function CallBridge<T>(call: () => Promise<T>): Promise<ResultEnvelope<T>> {
  try {
    const result = await call();
    if (result && typeof result === 'object' && 'ok' in result) return result as unknown as ResultEnvelope<T>;
    return { ok: true, data: result as T };
  } catch (error) {
    return { ok: false, error: { code: ExtractErrorCode(error), message: error instanceof Error ? error.message : '请求失败', retryable: false } };
  }
}

/** 从成功信封中取出数据；失败信封抛 AppError（携带 details 供恢复页识别后端状态），供 Mutation 统一处理错误码。接受已解包或未解包的信封。 */
export async function Unwrap<T>(envelope: ResultEnvelope<T> | Promise<ResultEnvelope<T>>): Promise<T> {
  const resolved = await envelope;
  if (!resolved.ok) throw new AppError(resolved.error.code, resolved.error.message, resolved.error.details);
  return resolved.data;
}

/** 只读访问 Agent Bridge；未在桌面客户端时抛统一业务错误。 */
function RequireAgent(): DesktopAgentBridge {
  if (!window.offergetAgent) throw new AppError(ErrorCode.INTERNAL_ERROR, '请使用桌面客户端启动 OfferGet。');
  return window.offergetAgent;
}

/** 只读访问 Workspace Bridge；未在桌面客户端时抛统一业务错误。 */
function RequireWorkspace(): WorkspaceBridge {
  if (!window.offergetWorkspace) throw new AppError(ErrorCode.INTERNAL_ERROR, '请使用桌面客户端启动 OfferGet。');
  return window.offergetWorkspace;
}

/**
 * 未经 Mutation 协调的单次写调用仍必须携带键，防止生产链路退回“无幂等”模式。
 * 自动重试路径由 useWorkspaceMutation 传入同一键；此兜底只适用于一次性调用。
 */
function ResolveWriteOptions(options?: WriteCommandOptions): WriteCommandOptions {
  return options?.idempotencyKey ? options : { idempotencyKey: crypto.randomUUID() };
}

/** 统一平台客户端：页面与 feature api 层访问桌面 Bridge 的唯一入口，全部返回统一结果信封。 */
export const platformClient = {
  agent: {
    Configure: (config: Parameters<DesktopAgentBridge['Configure']>[0]) => CallBridge(() => RequireAgent().Configure(config)),
    TestConnection: (config: Parameters<DesktopAgentBridge['TestConnection']>[0]) => CallBridge(() => RequireAgent().TestConnection(config)),
    GetBalance: () => CallBridge(() => RequireAgent().GetBalance()),
    GetModels: () => CallBridge(() => RequireAgent().GetModels()),
    Send: (request: Parameters<DesktopAgentBridge['Send']>[0]) => CallBridge(() => RequireAgent().Send(request)),
    Cancel: (requestId: string) => CallBridge(() => RequireAgent().Cancel(requestId)),
    UpdateConfirmationMode: (requestId: string, confirmationMode: Parameters<DesktopAgentBridge['UpdateConfirmationMode']>[1]) => CallBridge(() => RequireAgent().UpdateConfirmationMode(requestId, confirmationMode)),
    ConfirmResumeEdit: (confirmationId: string, accepted: boolean) => CallBridge(() => RequireAgent().ConfirmResumeEdit(confirmationId, accepted)),
    AcquireResumeEditLock: (resumeId: string) => CallBridge(() => RequireAgent().AcquireResumeEditLock(resumeId)),
    ReleaseResumeEditLock: (resumeId: string) => CallBridge(() => RequireAgent().ReleaseResumeEditLock(resumeId)),
    GetStatus: () => CallBridge(() => RequireAgent().GetStatus()),
    GetObservability: () => CallBridge(() => RequireAgent().GetObservability()),
    GetTraceEvents: (requestId: string) => CallBridge(() => RequireAgent().GetTraceEvents(requestId)),
    DeleteTraces: (sessionIds: string[]) => CallBridge(() => RequireAgent().DeleteTraces(sessionIds)),
    SetTraceRetention: (value: number) => CallBridge(() => RequireAgent().SetTraceRetention(value)),
    ClearObservability: () => CallBridge(() => RequireAgent().ClearObservability()),
    ReloadSession: (sessionId: string) => CallBridge(() => RequireAgent().ReloadSession(sessionId)),
    SelectProjectDirectory: () => CallBridge(() => RequireAgent().SelectProjectDirectory()),
    GetSessionAssistantState: (sessionId: string) => CallBridge(() => RequireAgent().GetSessionAssistantState(sessionId)),
    BindProjectEnvironment: (sessionId: string, projectId: string) => CallBridge(() => RequireAgent().BindProjectEnvironment(sessionId, projectId)),
    GetModuleConfiguration: () => CallBridge(() => RequireAgent().GetModuleConfiguration()),
    SelectModuleDirectory: () => CallBridge(() => RequireAgent().SelectModuleDirectory()),
    ResetModules: () => CallBridge(() => RequireAgent().ResetModules()),
    OnStream: (listener: Parameters<DesktopAgentBridge['OnStream']>[0]) => RequireAgent().OnStream(listener),
  },
  workspace: {
    GetStatus: () => CallBridge(() => RequireWorkspace().GetStatus()),
    GetViewModel: () => CallBridge(() => RequireWorkspace().GetViewModel()),
    GetSettings: () => CallBridge(() => RequireWorkspace().GetSettings()),
    SaveSettings: (settings: Partial<SettingsDto>, options?: WriteCommandOptions) => CallBridge(() => RequireWorkspace().SaveSettings(settings, ResolveWriteOptions(options))),
    CreateConversation: (conversation: { id: string; title: string }, options?: WriteCommandOptions) => CallBridge(() => RequireWorkspace().CreateConversation(conversation, ResolveWriteOptions(options))),
    RenameConversation: (id: string, title: string, expectedRevision?: number, options?: WriteCommandOptions) => CallBridge(() => RequireWorkspace().RenameConversation(id, title, expectedRevision, ResolveWriteOptions(options))),
    DeleteConversation: (id: string, options?: WriteCommandOptions) => CallBridge(() => RequireWorkspace().DeleteConversation(id, ResolveWriteOptions(options))),
    AppendConversationMessages: (conversationId: string, messages: Parameters<WorkspaceBridge['AppendConversationMessages']>[1], options?: WriteCommandOptions) => CallBridge(() => RequireWorkspace().AppendConversationMessages(conversationId, messages, ResolveWriteOptions(options))),
    CompleteConversationMessage: (conversationId: string, messageId: string, content: string, thinkingContent?: string, options?: WriteCommandOptions) => CallBridge(() => RequireWorkspace().CompleteConversationMessage(conversationId, messageId, content, thinkingContent, ResolveWriteOptions(options))),
    RemoveConversationMessage: (conversationId: string, messageId: string, options?: WriteCommandOptions) => CallBridge(() => RequireWorkspace().RemoveConversationMessage(conversationId, messageId, ResolveWriteOptions(options))),
    UpsertResume: (resume: Parameters<WorkspaceBridge['UpsertResume']>[0], expectedRevision?: number, options?: WriteCommandOptions) => CallBridge(() => RequireWorkspace().UpsertResume(resume, expectedRevision, ResolveWriteOptions(options))),
    RenameResume: (id: string, name: string, expectedRevision?: number, options?: WriteCommandOptions) => CallBridge(() => RequireWorkspace().RenameResume(id, name, expectedRevision, ResolveWriteOptions(options))),
    DeleteResume: (id: string, options?: WriteCommandOptions) => CallBridge(() => RequireWorkspace().DeleteResume(id, ResolveWriteOptions(options))),
    UpsertJob: (job: Parameters<WorkspaceBridge['UpsertJob']>[0], expectedRevision?: number, options?: WriteCommandOptions) => CallBridge(() => RequireWorkspace().UpsertJob(job, expectedRevision, ResolveWriteOptions(options))),
    SetJobFavorite: (id: string, favorite: boolean, expectedRevision?: number, options?: WriteCommandOptions) => CallBridge(() => RequireWorkspace().SetJobFavorite(id, favorite, expectedRevision, ResolveWriteOptions(options))),
    DeleteJob: (id: string, options?: WriteCommandOptions) => CallBridge(() => RequireWorkspace().DeleteJob(id, ResolveWriteOptions(options))),
    UpsertApplication: (application: Parameters<WorkspaceBridge['UpsertApplication']>[0], expectedRevision?: number, options?: WriteCommandOptions) => CallBridge(() => RequireWorkspace().UpsertApplication(application, expectedRevision, ResolveWriteOptions(options))),
    MoveApplicationStatus: (id: string, status: string, expectedRevision?: number, options?: WriteCommandOptions) => CallBridge(() => RequireWorkspace().MoveApplicationStatus(id, status, expectedRevision, ResolveWriteOptions(options))),
    DeleteApplication: (id: string, options?: WriteCommandOptions) => CallBridge(() => RequireWorkspace().DeleteApplication(id, ResolveWriteOptions(options))),
    GetProfiles: () => CallBridge(() => RequireWorkspace().GetProfiles()),
    SaveProfiles: (items: Parameters<WorkspaceBridge['SaveProfiles']>[0], force?: boolean, options?: WriteCommandOptions) => CallBridge(() => RequireWorkspace().SaveProfiles(items, force, ResolveWriteOptions(options))),
    ReloadProfiles: () => CallBridge(() => RequireWorkspace().ReloadProfiles()),
    ImportAttachment: (file: File, mimeType: string, options?: WriteCommandOptions) => CallBridge(() => RequireWorkspace().ImportAttachment(file, mimeType, ResolveWriteOptions(options))),
    CleanupAttachments: (options?: WriteCommandOptions) => CallBridge(() => RequireWorkspace().CleanupAttachments(ResolveWriteOptions(options))),
    GetRecoveryStatus: () => CallBridge(() => RequireWorkspace().GetRecoveryStatus()),
    RecoverOperations: (options?: WriteCommandOptions) => CallBridge(() => RequireWorkspace().RecoverOperations(ResolveWriteOptions(options))),
    GetDatabaseRecoveryStatus: () => CallBridge(() => RequireWorkspace().GetDatabaseRecoveryStatus()),
    RestoreLatestBackup: (options?: WriteCommandOptions) => CallBridge(() => RequireWorkspace().RestoreLatestBackup(ResolveWriteOptions(options))),
    RestoreBackup: (backupId: string, options?: WriteCommandOptions) => CallBridge(() => RequireWorkspace().RestoreBackup(backupId, ResolveWriteOptions(options))),
    ExportRecoveryDiagnostic: (options?: WriteCommandOptions) => CallBridge(() => RequireWorkspace().ExportRecoveryDiagnostic(ResolveWriteOptions(options))),
    CreateBackup: (options?: WriteCommandOptions) => CallBridge(() => RequireWorkspace().CreateBackup(ResolveWriteOptions(options))),
    GetResumeRevisions: (resumeId: string) => CallBridge(() => RequireWorkspace().GetResumeRevisions(resumeId)),
    SetResumeRevisionPinned: (revisionId: string, pinned: boolean, options?: WriteCommandOptions) => CallBridge(() => RequireWorkspace().SetResumeRevisionPinned(revisionId, pinned, ResolveWriteOptions(options))),
    ExportResume: (resume: { name: string; summary: string; content: string }, format: 'pdf' | 'docx' | 'png') => CallBridge(() => RequireWorkspace().ExportResume(resume, format)),
    Migrate: () => CallBridge(() => RequireWorkspace().Migrate()),
  },
};

/**
 * 编译期契约门禁：新增 Bridge 方法时，Renderer 平台客户端必须同步提供封装。
 * 这里仅校验方法名；参数与返回值由每个调用点的 WorkspaceBridge/DesktopAgentBridge 类型继续校验。
 */
const bridgeClientCompleteness: {
  agent: Record<keyof DesktopAgentBridge, unknown>;
  workspace: Record<keyof WorkspaceBridge, unknown>;
} = platformClient;
void bridgeClientCompleteness;

/** 判断当前页面是否由带安全桥接的桌面客户端承载。 */
export function IsDesktopClientAvailable() {
  return Boolean(window.offergetAgent);
}
