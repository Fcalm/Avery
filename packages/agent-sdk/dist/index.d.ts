/** agent-sdk：Agent 模块化 SDK——六槽接口、窄 Port、Manifest、Tool 契约与 Kernel 接口的唯一来源；零运行时依赖。 */
export { SlotOrder } from './manifest';
export type { ModuleManifest, SlotName } from './manifest';
export { SlotToModuleKey } from './modules';
export type { AgentModules, CompactionModule, ContextBuilderModule, InteractionModule, ModelProviderModule, ObservabilityModule, SessionContextSnapshot, SessionContextSource, ToolsModule } from './modules';
export type { AgentStreamEvent } from './events';
export type { KernelRunFunction, KernelRunInput, KernelRunResult } from './kernel';
export type { FileReadPort, RegisteredAgentTool, ResumeReadPort, ResumeWritePort, ToolContext, ToolPorts } from './tools';
export type { AgentMessage, AgentRole, AttachmentDescriptor, LogEntry, ModelCompletion, ModelDelta, ModelSummary, ModelUsage, ProfileSnapshotItem, ResumeSnapshot, RuntimeContext, TaskItem, ToolCallFragment, ToolExecutionResult, TraceEntry, TraceEventEntry, } from './types';
