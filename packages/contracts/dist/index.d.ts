/** OfferGet 跨进程契约包：错误码、信封、DTO 与 Bridge 类型的唯一来源。 */
export { ErrorCode } from './error-codes';
export type { ErrorCodeValue } from './error-codes';
export { ErrorInfoSchema, RequestEnvelopeSchema, ResultEnvelopeSchema, CreateResultSuccess, CreateResultFailure } from './envelope';
export type { FailureResult, RequestEnvelope, ResultEnvelope, SuccessResult } from './envelope';
export { ExtractDetails, NormalizeError } from './error-normalizer';
export type { NormalizedError } from './error-normalizer';
export { ApplicationUpsertSchema, ChatMessageInputSchema, ChatMessagesSchema, ConversationCreateSchema, JobUpsertSchema, ProfileItemSchema, ProfileItemsSchema, ResumeUpsertSchema, SettingsSubmitSchema, } from './write-schemas';
export type { ApplicationDto, AttachmentDto, ChatMessageDto, ChatMessageInput, ConversationDto, JobDto, ProfileItemDto, ResumeDto, ResumeRevisionDto, SettingsDto, WorkspaceStatusDto, WorkspaceViewModel, } from './dto';
export { ApplicationStatusValues, ChannelValues, EmploymentTypeValues, JobScoreValues, ProfileCategoryValues, } from './enums';
export type { ApplicationStatus, Channel, EmploymentType, JobScore, ProfileCategory, } from './enums';
export { BridgeNamespaces } from './bridge';
export type { BridgeNamespaceName } from './bridge';
export type { AgentConfiguration, AgentModuleConfiguration, AgentObservability, AgentSendRequest, AgentSessionAssistantState, AgentStreamEvent, AgentTraceEvent, DesktopAgentBridge, WorkspaceBridge, } from './bridge';
