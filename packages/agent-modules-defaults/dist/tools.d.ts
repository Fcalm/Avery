import type { ToolsModule } from '@offerget/agent-sdk';
import { AgentDefaultPorts } from './ports';
/** 工具模块：统一执行管道（Schema 校验/一次修复/幂等账本/超时/结构化错误码/统一 disposition）。 */
export declare function CreateToolsModule(ports: AgentDefaultPorts): ToolsModule;
