/** agent-sdk：Agent 模块化 SDK——六槽接口、窄 Port、Manifest、Tool 契约与 Kernel 接口的唯一来源；零运行时依赖。 */
export { SlotOrder } from './manifest';
export type { ModuleManifest, SlotName } from './manifest';
export { SlotToModuleKey } from './modules';
export type { AgentModules, CompactionModule, ContextBuilderModule, InteractionModule, ModelProviderModule, ObservabilityModule, SessionContextSnapshot, SessionContextSource, ToolsModule } from './modules';
export type { AgentStreamEvent } from './events';
export type { KernelRunFunction, KernelRunInput, KernelRunResult } from './kernel';
export { DropOldestTurnGroups, IsUserTurn, KeepRecentTurnGroups, SplitTurnGroups } from './turn-group';
export type {
  BrowserActionProposal, BrowserAutomationPort, BrowserToolName, FileReadPort, JobSearchPort, ProfileWritePort, RegisteredAgentTool, ResumeReadPort, ResumeWritePort,
  SkillReadPort, ToolContext, ToolLedgerPort, ToolPorts, UrlReadPort,
} from './tools';
export type {
  AgentMessage, AgentRole, AttachmentDescriptor, CompiledInstructions, ConfirmationMode, ReasoningEffort, LogEntry, ModelCapabilities,
  ModelCompletion, ModelDelta, ModelStreamEvent, ModelSummary, ModelUsage, NormalizedUsage, PendingConfirmation,
  FrozenSkill, LoadedSkillState, PendingInteraction, PendingQuestionInteraction, ProfileSnapshotItem, PromptFragment, PromptManifest,
  ProviderError, ProviderUsageFact, ResumeSnapshot, RunDisposition, RunState, RuntimeContext, ScenarioSnapshot, StructuredRunError,
  SkillManifest, SkillSnapshot, TaskItem, ToolCallFragment, ToolDisposition, ToolExecutionResult, ToolLedgerEntry, ToolReceipt, TraceEntry,
  TraceEventEntry, TurnGroup,
} from './types';
