import type { KernelRunInput, KernelRunResult } from '@offerget/agent-sdk';
/** 从 Trace 正文中移除常见密钥、Bearer 凭据与超长内容；纯函数，供内核事件脱敏。 */
export declare function ScrubTraceContent(value: unknown): string;
/** 纯 Agent 内核：Send 的 while 状态机。宿主负责配置、快照、持久化与事件出口；Kernel 不持有 config/凭据/业务态。 */
export declare function RunAgentLoop(input: KernelRunInput): Promise<KernelRunResult>;
