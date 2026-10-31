/** 模型身份包含服务端点；同名模型在不同服务上的能力不得互相继承。 */
export interface ModelConfigurationIdentity {
  provider: 'DeepSeek' | 'Z.AI' | 'MIMO' | '自定义';
  model: string;
  baseUrl?: string;
}

/** 目录提供推荐值，用户只保存显式覆盖；此声明不等同于真实 API 已验证。 */
export interface ModelCapabilityValues {
  contextWindow: number;
  maxOutput: number;
  inputImage: boolean;
  inputPdf: boolean;
  thinking: boolean;
  toolCall: boolean;
}

export type ModelCapabilityOverrides = Partial<ModelCapabilityValues>;

/** UI、附件、截图工具与 Provider 共用的脱敏生效配置；不含密钥和请求内容。 */
export interface ResolvedModelConfiguration extends ModelConfigurationIdentity {
  baseUrl: string;
  values: ModelCapabilityValues;
  inherited: ModelCapabilityValues;
  overrides: ModelCapabilityOverrides;
  source: 'directory' | 'unknown';
  revision: number;
  directoryUpdatedAt?: string;
  /** 目录匹配仅是能力声明；目前没有执行付费能力探测请求。 */
  verified: false;
}

export interface ModelDirectoryEntry {
  baseUrl: string;
  model: string;
  values: ModelCapabilityValues;
}

/** 只规范化已知 API 根路径，不做模型名包含匹配，也不把第三方域名猜成官方服务。 */
export function NormalizeModelEndpoint(value: string): string {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('模型接口地址必须是不含凭据、查询或片段的 HTTP(S) 地址。');
  const pathname = url.pathname.replace(/\/+$/, '');
  const knownV1Alias = ['api.deepseek.com', 'api.xiaomimimo.com', 'openrouter.ai', 'api.openai.com'].includes(url.hostname);
  return `${url.origin}${knownV1Alias ? pathname.replace(/\/v1$/, '') : pathname}`;
}

export const OfficialModelEndpoints = {
  DeepSeek: 'https://api.deepseek.com',
  'Z.AI': 'https://open.bigmodel.cn/api/paas/v4',
  MIMO: 'https://api.xiaomimimo.com/v1',
} as const;

/** 未匹配目录时保留可用的文字工具工作流，视觉能力必须由目录或显式覆盖开启。 */
export const UnknownModelCapabilities: Readonly<ModelCapabilityValues> = Object.freeze({
  contextWindow: 256_000, maxOutput: 8192, inputImage: false, inputPdf: false, thinking: true, toolCall: true,
});
import { BundledModelDirectory } from './model-capabilities-snapshot';

/** 查询只使用端点和完整模型 ID；用户选择的 Provider 仍参与个人覆盖的身份隔离。 */
export function FindModelDirectoryEntry(entries: readonly ModelDirectoryEntry[], baseUrl: string, model: string): ModelDirectoryEntry | undefined {
  const endpoint = NormalizeModelEndpoint(baseUrl);
  return entries.find((entry) => entry.model === model && NormalizeModelEndpoint(entry.baseUrl) === endpoint);
}

export function ResolveBundledModelCapabilities(provider: unknown, model: unknown, baseUrl?: string): ModelCapabilityValues | undefined {
  if (typeof model !== 'string') return undefined;
  const endpoint = baseUrl ?? OfficialModelEndpoints[provider as keyof typeof OfficialModelEndpoints];
  return endpoint ? FindModelDirectoryEntry(BundledModelDirectory, endpoint, model)?.values : undefined;
}
