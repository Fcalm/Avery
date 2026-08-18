import type { ModelProviderModule } from '@offerget/agent-sdk';
import { AgentDefaultPorts } from './ports';
export { SummaryPrompt, SystemPrompt } from './prompts';
/** DeepSeek 官方 API 根地址；自定义 Provider 使用用户配置的 BaseUrl。 */
export declare const DefaultBaseUrl = "https://api.deepseek.com";
/** 默认模型 Provider 模块：配置、连通性、请求级模型解析、流式补全、摘要与规模估算；API Key 经宿主端口存取。 */
export declare function CreateProviderModule(ports: AgentDefaultPorts): ModelProviderModule;
