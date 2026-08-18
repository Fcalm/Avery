import {
  ErrorCode, type ErrorCodeValue, type ResultEnvelope, type DesktopAgentBridge, type WorkspaceBridge, type SettingsDto,
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

/** 统一平台客户端：页面与 feature api 层访问桌面 Bridge 的唯一入口，全部返回统一结果信封。 */
export const platformClient = {
  agent: {
    Configure: (config: Parameters<DesktopAgentBridge['Configure']>[0]) => CallBridge(() => RequireAgent().Configure(config)),
    TestConnection: (config: Parameters<DesktopAgentBridge['TestConnection']>[0]) => CallBridge(() => RequireAgent().TestConnection(config)),
    GetBalance: () => CallBridge(() => RequireAgent().GetBalance()),
    GetModels: () => CallBridge(() => RequireAgent().GetModels()),
    Send: (request: Parameters<DesktopAgentBridge['Send']>[0]) => CallBridge(() => RequireAgent().Send(request)),
    Cancel: (requestId: string) => CallBridge(() => RequireAgent().Cancel(requestId)),
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
    SaveSettings: (settings: Partial<SettingsDto>) => CallBridge(() => RequireWorkspace().SaveSettings(settings)),
    CreateConversation: (conversation: { id: string; title: string }) => CallBridge(() => RequireWorkspace().CreateConversation(conversation)),
    RenameConversation: (id: string, title: string, expectedRevision?: number) => CallBridge(() => RequireWorkspace().RenameConversation(id, title, expectedRevision)),
    DeleteConversation: (id: string) => CallBridge(() => RequireWorkspace().DeleteConversation(id)),
    AppendConversationMessages: (conversationId: string, messages: Parameters<WorkspaceBridge['AppendConversationMessages']>[1]) => CallBridge(() => RequireWorkspace().AppendConversationMessages(conversationId, messages)),
    CompleteConversationMessage: (conversationId: string, messageId: string, content: string, thinkingContent?: string) => CallBridge(() => RequireWorkspace().CompleteConversationMessage(conversationId, messageId, content, thinkingContent)),
    RemoveConversationMessage: (conversationId: string, messageId: string) => CallBridge(() => RequireWorkspace().RemoveConversationMessage(conversationId, messageId)),
    UpsertResume: (resume: Parameters<WorkspaceBridge['UpsertResume']>[0], expectedRevision?: number) => CallBridge(() => RequireWorkspace().UpsertResume(resume, expectedRevision)),
    RenameResume: (id: string, name: string, expectedRevision?: number) => CallBridge(() => RequireWorkspace().RenameResume(id, name, expectedRevision)),
    DeleteResume: (id: string) => CallBridge(() => RequireWorkspace().DeleteResume(id)),
    UpsertJob: (job: Parameters<WorkspaceBridge['UpsertJob']>[0], expectedRevision?: number) => CallBridge(() => RequireWorkspace().UpsertJob(job, expectedRevision)),
    SetJobFavorite: (id: string, favorite: boolean, expectedRevision?: number) => CallBridge(() => RequireWorkspace().SetJobFavorite(id, favorite, expectedRevision)),
    DeleteJob: (id: string) => CallBridge(() => RequireWorkspace().DeleteJob(id)),
    UpsertApplication: (application: Parameters<WorkspaceBridge['UpsertApplication']>[0], expectedRevision?: number) => CallBridge(() => RequireWorkspace().UpsertApplication(application, expectedRevision)),
    MoveApplicationStatus: (id: string, status: string, expectedRevision?: number) => CallBridge(() => RequireWorkspace().MoveApplicationStatus(id, status, expectedRevision)),
    DeleteApplication: (id: string) => CallBridge(() => RequireWorkspace().DeleteApplication(id)),
    GetProfiles: () => CallBridge(() => RequireWorkspace().GetProfiles()),
    SaveProfiles: (items: Parameters<WorkspaceBridge['SaveProfiles']>[0], force?: boolean) => CallBridge(() => RequireWorkspace().SaveProfiles(items, force)),
    ReloadProfiles: () => CallBridge(() => RequireWorkspace().ReloadProfiles()),
    ImportAttachment: (file: File, mimeType: string) => CallBridge(() => RequireWorkspace().ImportAttachment(file, mimeType)),
    CreateBackup: () => CallBridge(() => RequireWorkspace().CreateBackup()),
    GetResumeRevisions: (resumeId: string) => CallBridge(() => RequireWorkspace().GetResumeRevisions(resumeId)),
    SetResumeRevisionPinned: (revisionId: string, pinned: boolean) => CallBridge(() => RequireWorkspace().SetResumeRevisionPinned(revisionId, pinned)),
    ExportResume: (resume: { name: string; summary: string; content: string }, format: 'pdf' | 'docx' | 'png') => CallBridge(() => RequireWorkspace().ExportResume(resume, format)),
    Migrate: () => CallBridge(() => RequireWorkspace().Migrate()),
  },
};

/** 判断当前页面是否由带安全桥接的桌面客户端承载。 */
export function IsDesktopClientAvailable() {
  return Boolean(window.offergetAgent);
}
