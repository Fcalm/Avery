import { AgentSdkContractVersion, NormalizeModelEndpoint, ResolveBundledModelCapabilities } from '@avery/agent-sdk';
import type { AgentMessage, ModelCompletion, ModelDelta, ModelProviderModule, ModelUsage, ReasoningEffort, RegisteredAgentTool } from '@avery/agent-sdk';
import { AgentDefaultPorts, ProviderConfig } from './ports';
import { RequireString } from './helpers';
import { SummaryPrompt } from './prompts';
import { QueryProviderAccountUsage } from './provider-usage';

// 保留既有导出，供扩展模块和既有调用方兼容；实际定义集中在 prompts.ts。
export { SummaryPrompt } from './prompts';

/** 官方 API 根地址；自定义 Provider 使用用户配置的 BaseUrl。 */
export const DefaultBaseUrl = 'https://api.deepseek.com';
/** 智谱中国区开放平台端点；国内控制台签发的 API Key 不能发送到国际站。 */
export const DefaultZaiBaseUrl = 'https://open.bigmodel.cn/api/paas/v4';
export const GlmFlashModel = 'glm-5.3-flash';
const DefaultDeepSeekModels = ['deepseek-v4-flash', 'deepseek-v4-pro', 'deepseek-v4-flash-vision-exp'];
const DeepSeekMaximumRequestBytes = 48 * 1024 * 1024;
export const DefaultContextLimit = 256_000;

/** 仅提取供应商结构化错误消息，保留状态码并脱敏凭据；不把请求体或 HTML 错页显示给用户。 */
async function ProviderRequestError(response: Response, label: string, apiKey: string): Promise<Error> {
  let detail = '';
  try {
    const body = await response.json() as { error?: { message?: unknown }; message?: unknown };
    const message = body?.error?.message ?? body?.message;
    if (typeof message === 'string') {
      detail = (apiKey ? message.replaceAll(apiKey, '[REDACTED]') : message)
        .replace(/Bearer\s+[^\s,;"']+/gi, 'Bearer [REDACTED]')
        .replace(/\bsk-[A-Za-z0-9_-]+\b/g, '[REDACTED_API_KEY]')
        .replace(/[\r\n]+/g, ' ').slice(0, 600);
    }
  } catch { /* 无结构化消息时保留状态码，不转发原始响应正文。 */ }
  return new Error(`${label} (${response.status}).${detail ? ` ${detail}` : ''}`);
}
/** 自定义上下文限制的允许区间：与模型配置弹窗一致，用户新填写的值必须落在区间内。 */
const MinimumConfigurableContextLimit = 128_000;
const MaximumConfigurableContextLimit = 1_000_000;
/** MiMo 官方 API 根地址（OpenAI 兼容）；对话补全请求发往 {baseUrl}/chat/completions。 */
export const DefaultMimoBaseUrl = 'https://api.xiaomimimo.com/v1';
export const DefaultMimoModel = 'mimo-v2.6-flash';
/** MiMo 官方对话模型固定列表：既是模型列表同步失败时的兜底，也是新装默认值；v2.5 系列已公告退役计划，不作为初值。 */
const DefaultMimoModels = ['mimo-v2.6-flash', 'mimo-v2.6-pro', 'mimo-v2.6-pro-ultraspeed'];

export type ContextLimitMode = 'default' | 'custom';

/** DeepSeek V4 与 GLM-5.3-Flash 的官方映射：前端保留五档语义，Provider 只发送服务端实际支持的三档。 */
export function ResolveDeepSeekReasoningEffort(value: ReasoningEffort): 'low' | 'high' | 'max' {
  if (value === 'low') return 'low';
  if (value === 'max') return 'max';
  return 'high';
}

type SupportedProvider = 'DeepSeek' | 'Z.AI' | 'MIMO' | '自定义';

function NormalizeProvider(value: unknown): SupportedProvider {
  if (value === 'Z.AI') return 'Z.AI';
  if (value === 'MIMO') return 'MIMO';
  if (value === '自定义') return '自定义';
  return 'DeepSeek';
}

function ResolveOfficialBaseUrl(provider: SupportedProvider, customBaseUrl?: unknown): string {
  if (provider === 'DeepSeek') return DefaultBaseUrl;
  if (provider === 'Z.AI') return DefaultZaiBaseUrl;
  if (provider === 'MIMO') return DefaultMimoBaseUrl;
  return RequireString(customBaseUrl, 'baseUrl', 500).replace(/\/$/, '');
}

function ResolveProviderModel(provider: SupportedProvider, value: unknown): string {
  if (provider === 'Z.AI') return GlmFlashModel;
  if (provider === 'DeepSeek') return NormalizeDeepSeekModel(value);
  if (provider === 'MIMO') return NormalizeMimoModel(value);
  return RequireString(value, 'model', 200);
}

function ResolveModelMaximum(provider: SupportedProvider, model: string): number | undefined {
  return ResolveBundledModelCapabilities(provider, model)?.contextWindow;
}

/**
 * 统一解析自动/自定义限制；自动值永不超过模型上限，自定义值超过已知上限时显式拒绝。
 * 数值可带 K/M 后缀：界面按 256K、1M 这样的可读形式下发。
 * allowStoredValue 用于读取已保存配置：旧版本允许的区间更宽，历史值即使落在新区间之外也保留，
 * 否则用户一进入会话就会被默认值悄悄替换；新填写的值仍按区间校验。
 */
export function ResolveContextLimit(input: { mode: ContextLimitMode; value?: unknown; modelMaximum?: number; allowStoredValue?: boolean }): number {
  if (input.mode === 'default') return Math.min(DefaultContextLimit, input.modelMaximum ?? DefaultContextLimit);
  const raw = String(input.value ?? '').trim();
  const matched = raw.match(/^(\d+)\s*([kKmM])?$/);
  const unit = matched?.[2]?.toLowerCase() ?? '';
  const limit = matched ? Number(matched[1]) * (unit === 'k' ? 1_000 : unit === 'm' ? 1_000_000 : 1) : Number.NaN;
  // 已知模型或显式模型覆盖允许更小的窗口；未知模型的新手工输入继续遵守既有界面区间。
  const minimumLimit = Math.min(MinimumConfigurableContextLimit, input.modelMaximum ?? MinimumConfigurableContextLimit);
  const outOfRange = limit < minimumLimit || limit > MaximumConfigurableContextLimit;
  if (!Number.isSafeInteger(limit) || (outOfRange && input.allowStoredValue !== true)) {
    throw new Error('上下文限制需为 128000–1000000，可填写 128000、128K 或 1M。');
  }
  if (input.modelMaximum !== undefined && limit > input.modelMaximum) {
    throw new Error(`自定义上下文限制不能超过当前模型的 ${input.modelMaximum.toLocaleString()} token 上限。`);
  }
  return limit;
}

/** 将已弃用的历史模型名迁移为当前默认模型，避免旧配置导致请求被服务端拒绝。 */
function NormalizeDeepSeekModel(model: unknown) {
  const value = typeof model === 'string' ? model.trim() : '';
  // chat / reasoner 已被官方弃用；其余以 deepseek- 开头的 ID 由 /models 实时校验后可安全使用。
  if (value === 'deepseek-chat' || value === 'deepseek-reasoner') return 'deepseek-v4-flash';
  return /^deepseek-[a-z0-9][a-z0-9._-]{0,199}$/i.test(value) ? value : 'deepseek-v4-flash';
}

/**
 * MiMo 对话补全只接受 mimo-v 前缀的官方 chat 模型 ID；
 * MiMo 同时提供 ASR / TTS 系语音模型，这些 ID 不能当对话模型保存或使用（无论来自手工添加还是其它来源）。
 */
function NormalizeMimoModel(model: unknown) {
  const value = typeof model === 'string' ? model.trim() : '';
  const isChatModel = /^mimo-v\d[a-z0-9._-]*$/i.test(value) && !/(?:^|-)(?:asr|tts)(?:-|$)/i.test(value);
  return isChatModel ? value : DefaultMimoModel;
}

/** 将 SSE 读取块拆为完整的数据行。 */
function CreateSseParser(onData: (value: string) => void) {
  let buffer = '';
  return (chunk: string) => {
    buffer += chunk;
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || '';
    for (const line of lines) {
      if (!line.startsWith('data:')) continue;
      const value = line.slice(5).trim();
      if (value && value !== '[DONE]') onData(value);
    }
  };
}

/**
 * 缓存命中输入 token 的字段位置随 Provider 不同：DeepSeek 用顶层 prompt_cache_hit_tokens，
 * GLM、MiMo 等 OpenAI 风格响应放在 prompt_tokens_details.cached_tokens（MiMo 该对象还含
 * image/audio/video_tokens 等明细，与命中数无关）。两者是同一事实的两种写法，
 * 同时出现时必须一致，否则整块 Usage 按矛盾值拒绝（沿用本合同对 usage 的唯一性要求）。
 * 返回 undefined 表示两个字段都未提供；返回 null 表示字段存在但值非法或互相矛盾。
 */
function ReadCachedInputTokens(usage: Record<string, unknown> | null): number | undefined | null {
  const details = usage?.prompt_tokens_details;
  const cachedDetails = details && typeof details === 'object' ? details as Record<string, unknown> : undefined;
  if (details !== undefined && details !== null && !cachedDetails) return null;
  const values = [usage?.prompt_cache_hit_tokens, cachedDetails?.cached_tokens].filter((value) => value !== undefined);
  if (values.length === 0) return undefined;
  const [first, ...rest] = values;
  if (typeof first !== 'number' || !Number.isSafeInteger(first) || first < 0) return null;
  if (rest.some((value) => value !== first)) return null;
  return first;
}

/** 仅接受 Provider 明确返回的完整非负整数 usage；无效或缺失时不使用估算值替代。 */
function NormalizeModelUsage(value: unknown): ModelUsage | undefined {
  const usage = value && typeof value === 'object' ? value as Record<string, unknown> : null;
  const promptTokens = usage?.prompt_tokens;
  const completionTokens = usage?.completion_tokens;
  const totalTokens = usage?.total_tokens;
  const cachedInputTokens = ReadCachedInputTokens(usage);
  if (typeof promptTokens !== 'number' || !Number.isSafeInteger(promptTokens) || promptTokens < 0) return undefined;
  if (typeof completionTokens !== 'number' || !Number.isSafeInteger(completionTokens) || completionTokens < 0) return undefined;
  if (typeof totalTokens !== 'number' || !Number.isSafeInteger(totalTokens) || totalTokens < 0) return undefined;
  if (totalTokens !== promptTokens + completionTokens) return undefined;
  if (cachedInputTokens === null || (cachedInputTokens !== undefined && cachedInputTokens > promptTokens)) return undefined;
  return { promptTokens, completionTokens, totalTokens, cachedInputTokens: cachedInputTokens ?? 0 };
}

/**
 * DeepSeek 的 Usage 既可能出现在官方约定的空 choices 附加块，也可能附着在纯终止 choice 上。
 * 纯终止 choice 只能携带 finish_reason 和空 delta；正文、思考或工具增量与 Usage 同块仍按协议错误拒绝。
 */
function IsDeepSeekUsageChunk(choices: Array<Record<string, unknown>> | null): boolean {
  if (!choices) return false;
  if (choices.length === 0) return true;
  return choices.every((choice) => {
    if (typeof choice.finish_reason !== 'string' || !choice.finish_reason) return false;
    if (choice.delta === undefined || choice.delta === null) return true;
    if (typeof choice.delta !== 'object') return false;
    const delta = choice.delta as Record<string, unknown>;
    const hasContent = delta.content !== undefined && delta.content !== null && delta.content !== '';
    const hasReasoning = delta.reasoning_content !== undefined && delta.reasoning_content !== null && delta.reasoning_content !== '';
    const hasToolCalls = delta.tool_calls !== undefined && (!Array.isArray(delta.tool_calls) || delta.tool_calls.length > 0);
    return !hasContent && !hasReasoning && !hasToolCalls;
  });
}

/** 只发送 Provider 协议字段；runtime 元数据只在本地用于隐藏展示和压缩分组。 */
function ToProviderMessage(message: AgentMessage): Omit<AgentMessage, 'content' | 'providerContent' | 'imageAttachments'> & { content: AgentMessage['content'] | NonNullable<AgentMessage['providerContent']> } {
  return {
    role: message.role,
    content: message.providerContent ?? message.content,
    ...(message.tool_calls ? { tool_calls: message.tool_calls } : {}),
    ...(message.tool_call_id ? { tool_call_id: message.tool_call_id } : {}),
    ...(message.reasoning_content ? { reasoning_content: message.reasoning_content } : {}),
  };
}

/** DeepSeek 对内联图片与其他字段共同执行 48 MiB 请求体限制；在发网前给出稳定错误。 */
function SerializeCompletionBody(value: unknown, enforceDeepSeekLimit: boolean): string {
  const body = JSON.stringify(value);
  if (enforceDeepSeekLimit && new TextEncoder().encode(body).byteLength > DeepSeekMaximumRequestBytes) {
    throw new Error('DeepSeek vision request exceeds the 48 MiB request body limit. Reduce the number or size of images.');
  }
  return body;
}

/** 本地预算采用偏保守的中英文密度，不冒充真实 tokenizer；图片正文不按 Base64 文本计数。 */
function EstimateProviderTokens(value: unknown): number {
  let inlineImageCount = 0;
  const serialized = JSON.stringify(value, (_key, item) => {
    if (typeof item === 'string' && /^data:image\/(?:jpeg|png|gif|webp);base64,/i.test(item)) {
      inlineImageCount += 1;
      return '[inline-image]';
    }
    return item;
  }) ?? '';
  let units = 0;
  for (const character of serialized) units += /[\u3400-\u9fff\uf900-\ufaff]/.test(character) ? 1 : 0.25;
  return Math.ceil(units) + inlineImageCount * 384;
}

/** 默认模型 Provider 模块：配置、连通性、请求级模型解析、流式补全、摘要与规模估算；API Key 经宿主端口存取。 */
export function CreateProviderModule(ports: AgentDefaultPorts): ModelProviderModule {
  const defaultConfig: ProviderConfig = { provider: 'DeepSeek', baseUrl: DefaultBaseUrl, model: 'deepseek-v4-flash', thinkingEnabled: true, contextLimit: DefaultContextLimit, contextLimitMode: 'default', compressionThreshold: 80, apiKey: '' };
  let config: ProviderConfig = defaultConfig;
  const configs = new Map<SupportedProvider, ProviderConfig>([['DeepSeek', defaultConfig]]);
  let configLoadPromise: Promise<void> | null = null;
  const providerFetch = globalThis.fetch;

  /** 惰性加载宿主私有配置；并发入口共享同一个 Promise，不能在凭据尚未读完时误用默认配置。 */
  async function EnsureConfig() {
    if (!configLoadPromise) {
      configLoadPromise = (async () => {
        const stored = (await ports.getConfig()) ?? null;
        if (!stored) return;
        const storedConfigs = stored.providerConfigs && typeof stored.providerConfigs === 'object'
          ? Object.values(stored.providerConfigs)
          : [stored];
        for (const storedConfig of storedConfigs) {
          if (!storedConfig || typeof storedConfig !== 'object') continue;
          const provider = NormalizeProvider(storedConfig.provider);
          const model = ResolveProviderModel(provider, storedConfig.model || 'deepseek-v4-flash');
          // DeepSeek 旧版 64K 是历史默认值而非用户选择；自定义 Provider 的旧值则由用户明确填写，必须保留。
          const contextLimitMode: ContextLimitMode = storedConfig.contextLimitMode === 'custom' || storedConfig.contextLimitMode === 'default'
            ? storedConfig.contextLimitMode : provider === '自定义' ? 'custom' : 'default';
          const modelMaximum = ResolveModelMaximum(provider, model);
          let contextLimit: number;
          try {
            // 已保存的值按 allowStoredValue 读取：旧版本配置的区间可能更宽，不能被默认值顶掉。
            contextLimit = ResolveContextLimit({ mode: contextLimitMode, value: storedConfig.contextLimit, modelMaximum, allowStoredValue: true });
          } catch {
            contextLimit = ResolveContextLimit({ mode: 'default', modelMaximum });
          }
          configs.set(provider, {
            provider,
            baseUrl: provider === '自定义' ? (storedConfig.baseUrl || DefaultBaseUrl) : ResolveOfficialBaseUrl(provider),
            model,
            thinkingEnabled: provider === 'Z.AI' ? true : storedConfig.thinkingEnabled !== false,
            contextLimit,
            contextLimitMode,
            compressionThreshold: storedConfig.compressionThreshold ?? 80,
            apiKey: typeof storedConfig.apiKey === 'string' ? storedConfig.apiKey : '',
          });
        }
        config = configs.get(NormalizeProvider(stored.provider)) ?? configs.get('DeepSeek') ?? defaultConfig;
      })().catch((error) => {
        // 临时存储错误允许后续入口重试，不能把失败状态永久缓存到模块生命周期。
        configLoadPromise = null;
        throw error;
      });
    }
    await configLoadPromise;
  }

  function ConfigFor(providerValue?: unknown): ProviderConfig {
    const provider = providerValue === undefined ? NormalizeProvider(config.provider) : NormalizeProvider(providerValue);
    return configs.get(provider) ?? {
      ...defaultConfig,
      provider,
      baseUrl: ResolveOfficialBaseUrl(provider, provider === '自定义' ? DefaultBaseUrl : undefined),
      model: ResolveProviderModel(provider, provider === 'Z.AI' ? GlmFlashModel : provider === 'DeepSeek' ? 'deepseek-v4-flash' : provider === 'MIMO' ? DefaultMimoModel : 'custom-model'),
      apiKey: '',
    };
  }

  /** 解析可配置的压缩阈值，范围固定为文档要求的 1–80%。 */
  function ParseCompressionThreshold(value: unknown): number {
    const threshold = Number(value ?? 80);
    return Number.isInteger(threshold) && threshold >= 1 && threshold <= 80 ? threshold : 80;
  }

  return {
    packageName: '@avery/agent-modules-defaults',
    name: 'avery.agent-defaults',
    version: '0.1.0',
    sdkVersion: AgentSdkContractVersion,
    slot: 'model-provider',
    capabilities: ['model'],
    /** 保存经校验的模型配置，并将 API Key 经端口移交宿主 safeStorage 加密落盘。 */
    async Configure(input: unknown) {
      await EnsureConfig();
      const cfg = (input ?? {}) as Record<string, unknown>;
      const provider = NormalizeProvider(cfg.provider);
      const requestedModel = provider === 'Z.AI' ? GlmFlashModel : RequireString(cfg.model, 'model', 200);
      const apiKey = typeof cfg.apiKey === 'string' ? cfg.apiKey.trim() : '';
      const baseUrl = ResolveOfficialBaseUrl(provider, cfg.baseUrl);
      if (apiKey && /\*/.test(apiKey)) throw new Error('Please enter the complete API Key before saving.');
      const model = ResolveProviderModel(provider, requestedModel);
      if (provider === 'DeepSeek' && model !== requestedModel) throw new Error('请选择 DeepSeek 当前支持的模型。');
      if (provider === 'MIMO' && model !== requestedModel) throw new Error('请选择 MiMo 当前支持的对话模型。');
      const existing = configs.get(provider);
      const next = {
        provider,
        baseUrl,
        model,
        thinkingEnabled: provider === 'Z.AI' ? true : Boolean(cfg.thinkingEnabled),
        // 每个供应商独立复用自己的已保存凭据，绝不把其它 Provider 的 Key 发送到当前端点。
        apiKey: apiKey || existing?.apiKey || '',
      };
      if (!next.apiKey) throw new Error('API Key is required.');
      const contextLimitMode: ContextLimitMode = cfg.contextLimitMode === 'custom' ? 'custom' : 'default';
      const contextLimit = ResolveContextLimit({
        mode: contextLimitMode,
        value: cfg.contextLength,
        modelMaximum: ports.resolveModelConfiguration?.(provider, model, baseUrl).values.contextWindow ?? ResolveModelMaximum(provider, model),
      });
      const compressionThreshold = ParseCompressionThreshold(cfg.compressionThreshold);
      await ports.saveConfig({ ...next, contextLimit, contextLimitMode, compressionThreshold });
      config = { ...next, contextLimit, contextLimitMode, compressionThreshold };
      configs.set(provider, config);
      return { configured: true, provider: next.provider, model: next.model };
    },
    /** 使用当前表单值测试兼容 OpenAI 的模型服务，不写入配置或暴露密钥。 */
    async TestConnection(input: unknown) {
      await EnsureConfig();
      const cfg = (input ?? {}) as Record<string, unknown>;
      const provider = NormalizeProvider(cfg.provider);
      const enteredApiKey = typeof cfg.apiKey === 'string' ? cfg.apiKey.trim() : '';
      const apiKey = enteredApiKey || configs.get(provider)?.apiKey || '';
      if (!apiKey) throw new Error('API Key is required.');
      if (/\*/.test(apiKey)) throw new Error('Please enter the complete API Key before testing.');
      const baseUrl = ResolveOfficialBaseUrl(provider, cfg.baseUrl);
      const requestedModel = provider === 'Z.AI' ? GlmFlashModel : RequireString(cfg.model, 'model', 200);
      const model = ResolveProviderModel(provider, requestedModel);
      ResolveContextLimit({
        mode: cfg.contextLimitMode === 'custom' ? 'custom' : 'default',
        value: cfg.contextLength,
        modelMaximum: ResolveModelMaximum(provider, model),
      });
      if (provider === 'Z.AI') {
        const response = await providerFetch(`${baseUrl}/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
          signal: AbortSignal.timeout(30000),
          body: JSON.stringify({ model, messages: [{ role: 'user', content: 'Reply OK.' }], stream: false, max_tokens: 1, thinking: { type: 'enabled' } }),
        });
        if (!response.ok) throw new Error(`Connection test failed (${response.status}).`);
        return { connected: true, provider, baseUrl };
      }
      const response = await providerFetch(`${baseUrl}/models`, { method: 'GET', headers: { Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(15000) });
      if (!response.ok) throw new Error(`Connection test failed (${response.status}).`);
      return { connected: true, provider, baseUrl };
    },
    /** 只返回脱敏状态，供渲染层决定是否展示配置引导；首次读取前先加载已保存配置。 */
    async GetStatus(providerValue?: string) {
      await EnsureConfig();
      const selected = ConfigFor(providerValue);
      return {
        configured: Boolean(selected.apiKey),
        provider: selected.provider,
        model: selected.model,
        baseUrl: selected.baseUrl,
        contextLimit: selected.contextLimit,
        contextLimitMode: selected.contextLimitMode ?? 'default',
        compressionThreshold: selected.compressionThreshold,
      };
    },
    /** 校验单轮模型切换，DeepSeek/MiMo 仅允许官方对话模型，自定义 Provider 固定使用已保存模型。 */
    ResolveRequestModel(requestedModel, providerValue) {
      const selected = ConfigFor(providerValue);
      if (selected.provider === 'Z.AI') {
        if (requestedModel !== undefined && requestedModel !== GlmFlashModel) throw new Error('The requested model is not available for Z.AI.');
        return GlmFlashModel;
      }
      if (selected.provider === 'MIMO') {
        if (requestedModel === undefined) return selected.model;
        const model = NormalizeMimoModel(requestedModel);
        if (model !== requestedModel) throw new Error('The requested model is not available for MIMO.');
        return model;
      }
      if (selected.provider !== 'DeepSeek') return selected.model;
      if (requestedModel === undefined) return selected.model;
      const model = NormalizeDeepSeekModel(requestedModel);
      if (model !== requestedModel) throw new Error('The requested model is not available for DeepSeek.');
      return model;
    },
    /** 多供应商独立查询，未配置的供应商不发请求；查询不依赖当前选中的对话模型。 */
    async GetProviderUsage() {
      await EnsureConfig();
      const providers = await Promise.all([...configs.values()].filter((selected) => selected.apiKey).map((selected) => QueryProviderAccountUsage(selected.provider, selected.apiKey, providerFetch)));
      return { providers, checkedAt: new Date().toISOString() };
    },
    /** 读取 DeepSeek 账户余额。密钥只在主进程私有配置中使用，返回值不含密钥。 */
    async GetBalance() {
      await EnsureConfig();
      const selected = ConfigFor('DeepSeek');
      if (!selected.apiKey) throw new Error('请先保存 DeepSeek API Key。');
      const response = await providerFetch(`${DefaultBaseUrl}/user/balance`, {
        method: 'GET', headers: { Authorization: `Bearer ${selected.apiKey}` }, signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) throw new Error(`余额查询失败（${response.status}）。`);
      const json = await response.json() as { is_available?: unknown; balance_infos?: Array<{ currency?: unknown; total_balance?: unknown }> };
      const balances = Array.isArray(json.balance_infos) ? json.balance_infos
        .filter((item) => typeof item?.currency === 'string' && Number.isFinite(Number(item?.total_balance)))
        .map((item) => ({ currency: String(item.currency), totalBalance: String(item.total_balance) })) : [];
      if (json.is_available !== true || balances.length === 0) throw new Error('当前账户余额不可用。');
      return { available: true, balances };
    },
    /**
     * 读取当前凭据可访问的模型列表。DeepSeek 与 MiMo 走官方 GET /models 同步（MiMo 端点为 /v1/models）；
     * MiMo 返回里含 ASR/TTS 系非对话模型，只保留对话 ID，取不到有效项时回落官方固定列表。
     * 返回值带 provider 回执：调用方据此确认结果确实来自请求的供应商。
     * 显式传入的 Provider 必须精确匹配，绝不静默回退到 DeepSeek——
     * 回退会把其它供应商的模型列表交出去，被调用方合并进错误的供应商（曾导致 MiMo 列表混入 DeepSeek 模型）。
     */
    async GetModels(providerValue?: string) {
      await EnsureConfig();
      if (providerValue !== undefined && providerValue !== 'DeepSeek' && providerValue !== 'Z.AI' && providerValue !== 'MIMO' && providerValue !== '自定义') {
        throw new Error(`Unsupported provider: ${String(providerValue)}.`);
      }
      const selected = ConfigFor(providerValue);
      if (selected.provider === 'Z.AI') return { provider: selected.provider, models: [GlmFlashModel] };
      if (selected.provider === 'MIMO') {
        if (!selected.apiKey) throw new Error('请先保存 MiMo API Key。');
        const response = await providerFetch(`${DefaultMimoBaseUrl}/models`, {
          method: 'GET', headers: { Authorization: `Bearer ${selected.apiKey}` }, signal: AbortSignal.timeout(15000),
        });
        if (!response.ok) throw new Error(`模型列表获取失败（${response.status}）。`);
        const json = await response.json() as { data?: Array<{ id?: unknown }> };
        // /models 同时返回 ASR/TTS 系语音模型，只保留对话补全可用的 ID；全部非法时回落官方固定列表。
        const models = Array.isArray(json.data) ? json.data
          .map((item) => typeof item?.id === 'string' ? item.id.trim() : '')
          .filter((id) => id && id === NormalizeMimoModel(id)) : [];
        const available = [...new Set(models)].sort((left, right) => left.localeCompare(right));
        return { provider: selected.provider, models: available.length ? available : DefaultMimoModels };
      }
      if (selected.provider === '自定义') return { provider: selected.provider, models: [selected.model] };
      if (!selected.apiKey) throw new Error('请先保存 DeepSeek API Key。');
      const response = await providerFetch(`${DefaultBaseUrl}/models`, {
        method: 'GET', headers: { Authorization: `Bearer ${selected.apiKey}` }, signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) throw new Error(`模型列表获取失败（${response.status}）。`);
      const json = await response.json() as { data?: Array<{ id?: unknown }> };
      const models = Array.isArray(json.data) ? json.data
        .map((item) => typeof item?.id === 'string' ? item.id.trim() : '')
        .filter((id) => id === NormalizeDeepSeekModel(id)) : [];
      const available = [...new Set(models)].sort((left, right) => left.localeCompare(right));
      return { provider: selected.provider, models: available.length ? available : DefaultDeepSeekModels };
    },
    async GetProviderCatalog() {
      await EnsureConfig();
      const providers = await Promise.all((['DeepSeek', 'Z.AI', 'MIMO', '自定义'] as SupportedProvider[]).map(async (provider) => {
        const selected = ConfigFor(provider);
        const metadata = { baseUrl: selected.baseUrl, contextLimit: selected.contextLimit, contextLimitMode: selected.contextLimitMode ?? 'default' as const, compressionThreshold: selected.compressionThreshold, thinkingEnabled: selected.thinkingEnabled };
        if (!selected.apiKey) return { provider, configured: false, model: selected.model, models: [], ...metadata };
        let models: string[];
        try { models = (await this.GetModels(provider)).models; }
        catch { models = provider === 'DeepSeek' ? DefaultDeepSeekModels : provider === 'MIMO' ? DefaultMimoModels : [selected.model]; }
        return { provider, configured: true, model: selected.model, models, ...metadata };
      }));
      return { providers };
    },
    /** 调用兼容 OpenAI Chat Completions 的流式接口并转发思考与正文增量；畸形 SSE 直接失败，不静默忽略。 */
    async StreamCompletion(request) {
      await EnsureConfig();
      const configured = ConfigFor(request.provider);
      const modelConfiguration = request.modelConfiguration ?? ports.resolveModelConfiguration?.(request.provider, request.model, configured.baseUrl);
      if (modelConfiguration && (modelConfiguration.model !== request.model || modelConfiguration.provider !== request.provider
        || NormalizeModelEndpoint(modelConfiguration.baseUrl) !== NormalizeModelEndpoint(configured.baseUrl))) throw new Error('本轮模型接口配置已改变，请开始新一轮任务。');
      const selected = { ...configured, thinkingEnabled: modelConfiguration?.values.thinking ?? configured.thinkingEnabled };
      if (modelConfiguration?.values.inputImage === false && request.history.some((message) => message.providerContent?.some((block) => block.type === 'image_url'))) throw new Error('当前生效模型配置不支持图片输入。');
      if (modelConfiguration?.values.toolCall === false && request.tools.length) throw new Error('当前生效模型配置不支持工具调用。');
      let maxTokens = request.maxTokens === undefined ? modelConfiguration?.values.maxOutput : Math.min(request.maxTokens, modelConfiguration?.values.maxOutput ?? request.maxTokens);
      const requestModel = ResolveProviderModel(NormalizeProvider(selected.provider), request.model);
      if (requestModel !== request.model) throw new Error(`The requested model is not available for ${selected.provider}.`);
      const systemContent = RequireString(request.instructions?.compiled, 'compiled instructions', 200000);
      const providerMessages = [{ role: 'system', content: systemContent }, ...request.history.map(ToProviderMessage)];
      // 配置给出输出硬上限；单次调用还须给真实输入和协议留空间，不能把最大输出与输入直接相加撑爆窗口。
      if (modelConfiguration && maxTokens) {
        const available = Math.floor(modelConfiguration.values.contextWindow - EstimateProviderTokens({ messages: providerMessages, tools: request.tools }) - Math.min(1024, modelConfiguration.values.contextWindow * 0.1));
        if (available <= 0) throw new Error('模型输入已超过当前生效上下文预算。');
        maxTokens = Math.min(maxTokens, available);
      }
      const thinking = selected.provider === 'Z.AI'
        ? { thinking: { type: 'enabled', clear_thinking: false }, reasoning_effort: ResolveDeepSeekReasoningEffort(request.reasoningEffort), temperature: 1, top_p: 0.95, tool_stream: true }
        : selected.provider === 'DeepSeek'
          ? selected.thinkingEnabled
            ? { thinking: { type: 'enabled' }, reasoning_effort: ResolveDeepSeekReasoningEffort(request.reasoningEffort) }
            : { thinking: { type: 'disabled' } }
          // MiMo 仅接受 thinking.type 开关；官方文档未提供 reasoning_effort，思考模式下温度参数也会被服务端强制默认值。
          : selected.provider === 'MIMO'
            ? { thinking: { type: selected.thinkingEnabled ? 'enabled' : 'disabled' } }
            : {};
      const body = SerializeCompletionBody({
        model: requestModel, stream: true, ...thinking,
        ...(selected.provider === 'DeepSeek' ? { stream_options: { include_usage: true } } : {}),
        // 严格 JSON 输出：DeepSeek、智谱与 MiMo 官方文档均支持 response_format json_object，三条通道发送 API 参数；
        // 自定义通道的端点能力未知，仅保留提示词侧的 JSON 样例约束，避免不支持的端点报 400。
        ...((selected.provider === 'DeepSeek' || selected.provider === 'Z.AI' || selected.provider === 'MIMO') && request.responseFormat ? { response_format: request.responseFormat } : {}),
        // 输出上限字段名随 Provider 不同：MiMo 官方参数是 max_completion_tokens（含推理 token），其余通道用 max_tokens。
        ...(maxTokens ? (selected.provider === 'MIMO' ? { max_completion_tokens: maxTokens } : { max_tokens: maxTokens }) : {}),
        messages: providerMessages, tools: request.tools.map((tool) => tool.definition), tool_choice: 'auto',
      }, selected.provider === 'DeepSeek');
      request.onRequest?.({ kind: 'completion', model: requestModel, messages: providerMessages, toolCount: request.tools.length });
      const response = await providerFetch(`${selected.baseUrl}/chat/completions`, {
        method: 'POST',
        signal: request.signal,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${selected.apiKey}` },
        body,
      });
      if (!response.ok) throw await ProviderRequestError(response, 'Model request failed', selected.apiKey);
      if (!response.body) throw new Error(`Model request failed (${response.status}).`);
      const decoder = new TextDecoder();
      const toolCalls: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }> = [];
      let content = '';
      let reasoningContent = '';
      let usage: ModelUsage | undefined;
      let usageChunkSeen = false;
      const parse = CreateSseParser((data) => {
        let payload: unknown;
        try {
          payload = JSON.parse(data);
        } catch {
          throw new Error('PROTOCOL_INVALID_SSE_JSON: Provider sent a malformed SSE data block.');
        }
        const record = payload && typeof payload === 'object' ? payload as Record<string, unknown> : null;
        if (!record) throw new Error('PROTOCOL_INVALID_SSE_JSON: Provider SSE data is not an object.');
        const choices = Array.isArray(record.choices) ? record.choices as Array<Record<string, unknown>> : null;
        if (record.choices !== undefined && !Array.isArray(record.choices)) throw new Error('PROTOCOL_INVALID_SSE_SHAPE: Provider delta shape is invalid.');
        if (record.usage !== undefined && record.usage !== null) {
          if (selected.provider === 'DeepSeek' && usageChunkSeen) {
            throw new Error('PROTOCOL_DUPLICATE_USAGE: DeepSeek sent more than one non-null usage chunk.');
          }
          if (selected.provider === 'DeepSeek' && !IsDeepSeekUsageChunk(choices)) {
            throw new Error('PROTOCOL_INVALID_USAGE_CHUNK: DeepSeek usage must be in an empty choices chunk or a terminal-only choice.');
          }
          usageChunkSeen = true;
          const reportedUsage = NormalizeModelUsage(record.usage);
          if (reportedUsage) usage = reportedUsage;
        }
        const choice = choices?.[0] && typeof choices[0] === 'object' ? choices[0].delta as Record<string, unknown> | undefined : undefined;
        const reasoning = typeof choice?.reasoning_content === 'string' ? choice.reasoning_content : '';
        const deltaContent = typeof choice?.content === 'string' ? choice.content : '';
        for (const deltaCall of Array.isArray(choice?.tool_calls) ? choice.tool_calls : []) {
          const deltaRecord = deltaCall && typeof deltaCall === 'object' ? deltaCall as Record<string, unknown> : null;
          if (!deltaRecord) throw new Error('PROTOCOL_INVALID_SSE_SHAPE: Tool call delta is not an object.');
          const index = Number(deltaRecord.index ?? 0);
          if (!Number.isSafeInteger(index) || index < 0 || index > 127) throw new Error('PROTOCOL_INVALID_SSE_SHAPE: Tool call index is invalid.');
          const call = toolCalls[index] ?? { id: '', type: 'function', function: { name: '', arguments: '' } };
          const fn = deltaRecord.function && typeof deltaRecord.function === 'object' ? deltaRecord.function as Record<string, unknown> : null;
          call.id += typeof deltaRecord.id === 'string' ? deltaRecord.id : '';
          call.function.name += typeof fn?.name === 'string' ? fn.name : '';
          if (typeof fn?.arguments === 'string') call.function.arguments += fn.arguments;
          else if (fn?.arguments && typeof fn.arguments === 'object' && !call.function.arguments) call.function.arguments = JSON.stringify(fn.arguments);
          toolCalls[index] = call;
        }
        if (reasoning) request.onDelta({ reasoning, content: '' });
        if (deltaContent) request.onDelta({ reasoning: '', content: deltaContent });
        reasoningContent += reasoning;
        content += deltaContent;
      });
      const reader = response.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        parse(decoder.decode(value, { stream: true }));
      }
      const completedCalls = toolCalls.filter((call) => call.id && call.function.name);
      const incomplete = toolCalls.find((call) => call.id || call.function.name || call.function.arguments);
      if (incomplete && !completedCalls.some((call) => call.id === incomplete.id)) {
        throw new Error('PROTOCOL_INCOMPLETE_TOOL_CALL: Provider finished without completing a tool call.');
      }
      return { content, reasoningContent, toolCalls: completedCalls, ...(usage ? { usage } : {}) };
    },
    /** 通过不带工具的非流式模型调用生成可替换历史的应用摘要。 */
    async CreateSummary(provider, model, messages, onRequest, options = {}) {
      await EnsureConfig();
      const configured = ConfigFor(provider);
      const modelConfiguration = options.modelConfiguration ?? ports.resolveModelConfiguration?.(provider, model, configured.baseUrl);
      if (modelConfiguration && (modelConfiguration.model !== model || modelConfiguration.provider !== provider
        || NormalizeModelEndpoint(modelConfiguration.baseUrl) !== NormalizeModelEndpoint(configured.baseUrl))) throw new Error('本轮模型接口配置已改变，请开始新一轮任务。');
      const selected = { ...configured, thinkingEnabled: modelConfiguration?.values.thinking ?? configured.thinkingEnabled,
        contextLimit: modelConfiguration?.values.contextWindow ?? configured.contextLimit };
      let maxOutput = Math.min(8192, modelConfiguration?.values.maxOutput ?? 8192);
      const requestModel = ResolveProviderModel(NormalizeProvider(selected.provider), model);
      if (requestModel !== model) throw new Error(`The requested model is not available for ${selected.provider}.`);
      // 历史仅作带来源的数据，不重放旧工具协议或隐藏推理；原始 compact 命令不属于该历史。
      const providerMessages = [{ role: 'system', content: SummaryPrompt }, { role: 'user', content: JSON.stringify({
        compressionInstructions: options.compressionInstructions ?? '围绕当前目标、未完成事项和后续工作保留重点，简化重复过程。',
        protectedState: options.protectedState,
        history: messages.map((message) => ({ role: message.role, content: message.content, toolCalls: message.tool_calls, toolCallId: message.tool_call_id, source: message.metadata?.kind })),
        recentContext: options.recentContext?.map((message) => ({ role: message.role, content: message.content })),
      }) }];
      const providerOptions = selected.provider === 'Z.AI'
        ? { thinking: { type: 'enabled', clear_thinking: false }, reasoning_effort: ResolveDeepSeekReasoningEffort(options.reasoningEffort ?? 'medium'), temperature: 1, top_p: 0.95 }
        : selected.provider === 'DeepSeek'
          ? selected.thinkingEnabled
            ? { thinking: { type: 'enabled' }, reasoning_effort: ResolveDeepSeekReasoningEffort(options.reasoningEffort ?? 'medium') }
            : { thinking: { type: 'disabled' } }
          : selected.provider === 'MIMO' ? { thinking: { type: selected.thinkingEnabled ? 'enabled' : 'disabled' } } : {};
      if (modelConfiguration) maxOutput = Math.min(maxOutput, Math.max(1, Math.floor(selected.contextLimit - EstimateProviderTokens(providerMessages) - Math.min(1024, selected.contextLimit * 0.1))));
      const body = SerializeCompletionBody({ model: requestModel, stream: false, messages: providerMessages, ...providerOptions,
        ...(selected.provider === 'MIMO' ? { max_completion_tokens: maxOutput } : { max_tokens: maxOutput }),
      }, selected.provider === 'DeepSeek');
      if (EstimateProviderTokens(providerMessages) >= selected.contextLimit - Math.min(8192, selected.contextLimit * 0.1)) throw new Error('Summary input exceeds the model budget.');
      onRequest?.({ kind: 'summary', model: requestModel, messages: providerMessages, toolCount: 0 });
      const response = await providerFetch(`${selected.baseUrl}/chat/completions`, {
        method: 'POST',
        signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(120000)]) : AbortSignal.timeout(120000),
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${selected.apiKey}` },
        body,
      });
      if (!response.ok) throw await ProviderRequestError(response, 'Summary request failed', selected.apiKey);
      const json = (await response.json()) as { choices?: Array<{ message?: { content?: unknown }; finish_reason?: string }>; usage?: unknown };
      if (json.choices?.[0]?.finish_reason === 'length') throw new Error('Summary output was truncated.');
      const content = json?.choices?.[0]?.message?.content;
      const usage = NormalizeModelUsage(json?.usage);
      return { content: RequireString(content, 'summary', 16000), ...(usage ? { usage } : {}) };
    },
    /** 估算 Provider 请求输入规模；仅用于触发阈值与界面提示，不用于计费。 */
    EstimateTokens(value) { return EstimateProviderTokens(value); },
    /** 返回上下文长度上限与压缩阈值百分比。 */
    GetRuntimeLimits(providerValue, model) {
      const selected = ConfigFor(providerValue);
      const resolved = ports.resolveModelConfiguration?.(selected.provider, model ?? selected.model, selected.baseUrl);
      return { contextLimit: resolved?.values.contextWindow ?? selected.contextLimit, threshold: selected.compressionThreshold };
    },
    /** 返回当前 BaseUrl，供连通性等只读展示（不含密钥）。 */
    BaseUrl(providerValue) { return ConfigFor(providerValue).baseUrl; },
  };
}
