import type { AgentModules } from '@offerget/agent-sdk';
import { AgentDefaultPorts } from './ports';
/** 默认模块包名与契约版本：解析器据此校验。 */
export declare const DefaultsPackageName = "@offerget/agent-modules-defaults";
export declare const DefaultsVersion = "0.1.0";
export declare const DefaultsSdkVersion = "0.1.0";
/** 构造官方默认六槽聚合；端口（密钥/文件/简历/观测存储）全部由宿主注入，模块不持有任何 Node 业务能力。 */
export declare function CreateDefaultModules(ports: AgentDefaultPorts): AgentModules;
