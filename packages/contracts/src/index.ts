/** Avery 跨进程契约包：错误码、信封、DTO 与 Bridge 类型的唯一来源。 */
export type { ConversationActivity, ConversationPart, ConversationPresentation, ConversationResource, ConversationRunStatus, ConversationToolStatus } from '@avery/agent-sdk';
export { ErrorCode } from './error-codes';
export type { ErrorCodeValue } from './error-codes';
export { ErrorInfoSchema, RequestEnvelopeSchema, ResultEnvelopeSchema, WriteCommandEnvelopeSchema, CreateResultSuccess, CreateResultFailure } from './envelope';
export type { FailureResult, RequestEnvelope, ResultEnvelope, SuccessResult, WriteCommandEnvelope, WriteCommandOptions } from './envelope';
export { CreateWriteIntentKeyStore } from './write-intent';
export { ExtractDetails, NormalizeError } from './error-normalizer';
export type { NormalizedError } from './error-normalizer';
export { CreateResumeDocumentMarkup } from './resume-template';
export type { ResumeDocumentInput } from './resume-template';
export { JobQuerySchema, ParseJobQuery } from './job-query';
export type { JobQueryInput, JobQuery, JobLibraryView, JobQueryResult } from './job-query';
export { JobCollectionInputSchema, JobCollectionLimits } from './job-collection';
export type { JobCollectionInput, JobCollectionRequest, JobCollectionTask, JobCollectionState, JobCollectionSourceResult, RecruitmentSource, CollectedJob, JobImportResult } from './job-collection';
export {
  ApplicationUpsertSchema, ChatMessageInputSchema, ChatMessagesSchema, ConversationCreateSchema,
  JobUpsertSchema, ProfileItemSchema, ProfileItemsSchema, ResumeUpsertSchema, SettingsSubmitSchema,
} from './write-schemas';
export type {
  ApplicationDto, AttachmentDto, ChatMessageDto, ChatMessageInput, ConversationDto, ConversationResourceView, JobDto,
  ProfileItemDto, ResumeDto, ResumeRevisionDocumentDto, ResumeRevisionDto, SettingsDto, WorkspaceStatusDto, WorkspaceViewModel,
} from './dto';
export {
  ApplicationStatusValues, ChannelValues, JobSeekingTypeValues, JobScoreValues, ProfileCategoryValues,
} from './enums';
export {
  CronTaskScenarioSchema, CronTaskStateSchema, CronRunStateSchema, CronDayOfWeekSchema, BrowserTaskGrantPurposeSchema,
  CronScheduleSchema, CreateCronTaskSchema, UpdateCronTaskSchema, ReadCronTaskSchema, DeleteCronTaskSchema, BrowserTaskGrantSchema,
} from './cron-task';
export type { CronSchedule, CreateCronTaskInput, UpdateCronTaskInput, CronTaskState, CronRunState, BrowserTaskGrantPurpose, BrowserTaskGrant, CronTaskDto, CronRunDto } from './cron-task';
export type {
  ApplicationStatus, Channel, JobSeekingType, JobScore, ProfileCategory,
} from './enums';
export { BridgeNamespaces } from './bridge';
export type { BridgeNamespaceName } from './bridge';
export type {
  AgentBrowserRuntimeStatus, AgentConfiguration, AgentModuleConfiguration, AgentObservability, AgentSendRequest, AgentSessionAssistantState, AgentStreamEvent, AgentTraceEvent, BrowserActionState, ConfirmationMode, CronBrowserAccessStatus, ReasoningEffort,
  DesktopAgentBridge, WorkspaceBridge,
} from './bridge';
export type {
  DesktopEvaluationBridge, EvalBrowserAssertion, EvalBrowserAssertionResult, EvalBrowserAssertionType, EvalCaseRun, EvalCaseRunDetail, EvalCaseRunStatus, EvalCaseScore, EvalComparison, EvalDatasetCase, EvalDatasetImportResult,
  EvalEvent, EvalExpectedResult, EvalDatasetVersion, EvalProject, EvalProjectConfig, EvalProjectInput, EvalPromptCandidate, EvalPromptPreview,
  EvalRequirementResult, EvalRunnerType, EvalRun, EvalRunDetail, EvalRunStatus, EvalRunSummary, EvalTraceNode, EvalTraceNodeType, EvalUserSimulatorStrategy,
} from './evaluation';
export { AgentInteractionResponseSchema } from './agent-interaction';
export type { AgentInteractionResponse } from './agent-interaction';
