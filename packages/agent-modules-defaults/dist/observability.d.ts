import type { ObservabilityModule } from '@offerget/agent-sdk';
import { AgentDefaultPorts } from './ports';
/** 可观测性模块：本地日志缓冲 + 后端 Trace 存储端口；存储缺失或失败时以本地缓冲兜底，读失败返回空。 */
export declare function CreateObservabilityModule(ports: AgentDefaultPorts): ObservabilityModule;
