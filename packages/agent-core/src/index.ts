/** agent-core：纯 Agent 内核——RunAgentLoop 状态机；无 Node/Electron 依赖，业务态全部经参数与上下文注入。 */
export { RunAgentLoop, ScrubTraceContent } from './kernel';
export type { KernelRunFunction, KernelRunInput, KernelRunResult } from '@offerget/agent-sdk';
