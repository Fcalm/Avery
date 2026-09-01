/** OfferGet 跨进程契约包：错误码、信封、DTO 与 Bridge 类型的唯一来源。 */
export { ErrorCode } from './error-codes';
export type { ErrorCodeValue } from './error-codes';
export { ErrorInfoSchema, RequestEnvelopeSchema, ResultEnvelopeSchema, WriteCommandEnvelopeSchema, CreateResultSuccess, CreateResultFailure } from './envelope';
export type { FailureResult, RequestEnvelope, ResultEnvelope, SuccessResult, WriteCommandEnvelope, WriteCommandOptions } from './envelope';
export { CreateWriteIntentKeyStore } from './write-intent';
export { ExtractDetails, NormalizeError } from './error-normalizer';
export type { NormalizedError } from './error-normalizer';
export { CreateResumeDocumentMarkup } from './resume-template';
export type { ResumeDocumentInput } from './resume-template';
export {
  ApplicationUpsertSchema, ChatMessageInputSchema, ChatMessagesSchema, ConversationCreateSchema,
  JobUpsertSchema, ProfileItemSchema, ProfileItemsSchema, ResumeUpsertSchema, SettingsSubmitSchema,
} from './write-schemas';
export type {
  ApplicationDto, AttachmentDto, ChatMessageDto, ChatMessageInput, ConversationDto, JobDto,
  ProfileItemDto, ResumeDto, ResumeRevisionDto, SettingsDto, WorkspaceStatusDto, WorkspaceViewModel,
} from './dto';
export {
  ApplicationStatusValues, ChannelValues, EmploymentTypeValues, JobScoreValues, ProfileCategoryValues,
} from './enums';
export {
  CronTaskScenarioSchema, CronTaskStateSchema, CronRunStateSchema, CronDayOfWeekSchema,
  CronScheduleSchema, CreateCronTaskSchema, UpdateCronTaskSchema, ReadCronTaskSchema, DeleteCronTaskSchema,
} from './cron-task';
export type { CronSchedule, CreateCronTaskInput, UpdateCronTaskInput, CronTaskState, CronRunState, CronTaskDto, CronRunDto } from './cron-task';
export type {
  ApplicationStatus, Channel, EmploymentType, JobScore, ProfileCategory,
} from './enums';
export { BridgeNamespaces } from './bridge';
export type { BridgeNamespaceName } from './bridge';
export type {
  AgentBrowserRuntimeStatus, AgentConfiguration, AgentModuleConfiguration, AgentObservability, AgentSendRequest, AgentSessionAssistantState, AgentStreamEvent, AgentTraceEvent, BrowserActionState, ConfirmationMode, ReasoningEffort,
  DesktopAgentBridge, WorkspaceBridge,
} from './bridge';
export type {
  DesktopEvaluationBridge, EvalBrowserAssertion, EvalBrowserAssertionResult, EvalBrowserAssertionType, EvalCaseRun, EvalCaseRunDetail, EvalCaseRunStatus, EvalCaseScore, EvalComparison, EvalDatasetCase, EvalDatasetImportResult,
  EvalEvent, EvalExpectedResult, EvalProject, EvalProjectConfig, EvalProjectInput, EvalPromptCandidate, EvalPromptPreview,
  EvalRequirementResult, EvalRunnerType, EvalRun, EvalRunDetail, EvalRunStatus, EvalRunSummary, EvalTraceNode, EvalTraceNodeType, EvalUserSimulatorStrategy,
} from './evaluation';
