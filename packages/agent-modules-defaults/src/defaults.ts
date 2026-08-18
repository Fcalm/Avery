import type { AgentModules } from '@offerget/agent-sdk';
import { CreateProviderModule } from './provider';
import { CreateContextBuilderModule } from './context';
import { CreateCompactionModule } from './compaction';
import { CreateToolsModule } from './tools';
import { CreateInteractionModule } from './interaction';
import { CreateObservabilityModule } from './observability';
import { AgentDefaultPorts } from './ports';

/** 默认模块包名与契约版本：解析器据此校验。 */
export const DefaultsPackageName = '@offerget/agent-modules-defaults';
export const DefaultsVersion = '0.1.0';
export const DefaultsSdkVersion = '0.1.0';

/** 构造官方默认六槽聚合；端口（密钥/文件/简历/观测存储）全部由宿主注入，模块不持有任何 Node 业务能力。 */
export function CreateDefaultModules(ports: AgentDefaultPorts): AgentModules {
  return {
    modelProvider: CreateProviderModule(ports),
    contextBuilder: CreateContextBuilderModule(ports),
    compaction: CreateCompactionModule(),
    tools: CreateToolsModule(ports),
    interaction: CreateInteractionModule(),
    observability: CreateObservabilityModule(ports),
  };
}
