import type { ToolsModule } from '@offerget/agent-sdk';
import { AgentDefaultPorts } from './ports';
/** 工具模块：统一执行管道（Schema 校验/一次修复/幂等/超时/结构化错误码）；文件与路径边界由宿主注入窄端口约束。 */
export declare function CreateToolsModule(ports: AgentDefaultPorts): ToolsModule;
