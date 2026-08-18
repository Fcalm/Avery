import type { ContextBuilderModule } from '@offerget/agent-sdk';
import { AgentDefaultPorts } from './ports';
/** 上下文构建模块：读取业务只读快照并序列化为会话上下文；不读取工作空间或项目规则文件。 */
export declare function CreateContextBuilderModule(ports: AgentDefaultPorts): ContextBuilderModule;
