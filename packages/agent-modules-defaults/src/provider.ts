import type { AgentMessage, ModelCompletion, ModelDelta, ModelProviderModule, ModelUsage, ReasoningEffort, RegisteredAgentTool } from '@avery/agent-sdk';
import { AgentDefaultPorts, ProviderConfig } from './ports';
import { RequireString } from './helpers';
import { SummaryPrompt } from './prompts';

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
const MaximumConfigurableContextLimit = 2_000_000;
/** DeepSeek /models 不返回上下文元数据，已知官方模型能力必须由 Provider 维护。 */
const DeepSeekModelContextLimits: Readonly<Record<string, number>> = {
  'deepseek-v4-flash': 1_000_000,
  'deepseek-v4-pro': 1_000_000,
  'deepseek-v4-flash-vision-exp': 1_000_000,
};
const ZaiModelContextLimits: Readonly<Record<string, number>> = { [GlmFlashModel]: 1_000_000 };

export type ContextLimitMode = 'default' | 'custom';

/** DeepSeek V4 与 GLM-5.3-Flash 的官方映射：前端保留五档语义，Provider 只发送服务端实际支持的三档。 */
export function ResolveDeepSeekReasoningEffort(value: ReasoningEffort): 'low' | 'high' | 'max' {
  if (value === 'low') return 'low';
  if (value === 'max') return 'max';
  return 'high';
}

type SupportedProvider = 'DeepSeek' | 'Z.AI' | '自定义';

function NormalizeProvider(value: unknown): SupportedProvider {
  if (value === 'Z.AI') return 'Z.AI';
  if (value === '自定义') return '自定义';
  return 'DeepSeek';
}

function ResolveOfficialBaseUrl(provider: SupportedProvider, customBaseUrl?: unknown): string {
  if (provider === 'DeepSeek') return DefaultBaseUrl;
  if (provider === 'Z.AI') return DefaultZaiBaseUrl;
  return RequireString(customBaseUrl, 'baseUrl', 500).replace(/\/$/, '');
}

function ResolveProviderModel(provider: SupportedProvider, value: unknown): string {
  if (provider === 'Z.AI') return GlmFlashModel;
  if (provider === 'DeepSeek') return NormalizeDeepSeekModel(value);
  return RequireString(value, 'model', 200);
}

function ResolveModelMaximum(provider: SupportedProvider, model: string): number | undefined {
  if (provider === 'DeepSeek') return DeepSeekModelContextLimits[model];
  if (provider === 'Z.AI') return ZaiModelContextLimits[model];
  return undefined;
}

/** 统一解析自动/自定义限制；自动值永不超过模型上限，自定义值超过已知上限时显式拒绝。 */
export function ResolveContextLimit(input: { mode: ContextLimitMode; value?: unknown; modelMaximum?: number }): number {
  if (input.mode === 'default') return Math.min(DefaultContextLimit, input.modelMaximum ?? DefaultContextLimit);
  const raw = String(input.value ?? '').trim();
  const matched = raw.match(/^(\d+)\s*([kK])?$/);
  const limit = matched ? Number(matched[1]) * (matched[2] ? 1000 : 1) : Number.NaN;
  if (!Number.isSafeInteger(limit) || limit < 8_000 || limit > MaximumConfigurableContextLimit) {
    throw new Error('上下文限制需为 8K–2000K，可填写 256K 或 256000。');
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

/** 仅接受 Provider 明确返回的完整非负整数 usage；无效或缺失时不使用估算值替代。 */
function NormalizeModelUsage(value: unknown): ModelUsage | undefined {
  const usage = value && typeof value === 'object' ? value as Record<string, unknown> : null;
  const promptTokens = usage?.prompt_tokens;
  const completionTokens = usage?.completion_tokens;
  const totalTokens = usage?.total_tokens;
  if (typeof promptTokens !== 'number' || !Number.isSafeInteger(promptTokens) || promptTokens < 0) return undefined;
  if (typeof completionTokens !== 'number' || !Number.isSafeInteger(completionTokens) || completionTokens < 0) return undefined;
  if (typeof totalTokens !== 'number' || !Number.isSafeInteger(totalTokens) || totalTokens < 0) return undefined;
  if (totalTokens !== promptTokens + completionTokens) return undefined;
  return { promptTokens, completionTokens, totalTokens };
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

/** Base64 字节数不是视觉 token 数；按官方单图最高 384 token 估算，避免图片误触发文本压缩。 */
function EstimateProviderTokens(value: unknown): number {
  let inlineImageCount = 0;
  const serialized = JSON.stringify(value, (_key, item) => {
    if (typeof item === 'string' && /^data:image\/(?:jpeg|png|gif|webp);base64,/i.test(item)) {
      inlineImageCount += 1;
      return '[inline-image]';
    }
    return item;
  }) ?? '';
  return Math.ceil(serialized.length / 4) + inlineImageCount * 384;
}

/** 默认模型 Provider 模块：配置、连通性、请求级模型解析、流式补全、摘要与规模估算；API Key 经宿主端口存取。 */
export function CreateProviderModule(ports: AgentDefaultPorts): ModelProviderModule {
  let config: ProviderConfig = { provider: 'DeepSeek', baseUrl: DefaultBaseUrl, model: 'deepseek-v4-flash', thinkingEnabled: true, contextLimit: DefaultContextLimit, contextLimitMode: 'default', compressionThreshold: 80, apiKey: '' };
  let configLoaded = false;
  const providerFetch = globalThis.fetch;

  /** 惰性加载宿主私有配置：首次任一业务入口需要配置时经端口读取，之后缓存于内存；无端口或未保存时保留默认值。 */
  async function EnsureConfig() {
    if (configLoaded) return;
    configLoaded = true;
    const stored = (await ports.getConfig()) ?? null;
    if (!stored) return;
    const provider = NormalizeProvider(stored.provider);
    const model = ResolveProviderModel(provider, stored.model || 'deepseek-v4-flash');
    // DeepSeek 旧版 64K 是历史默认值而非用户选择；自定义 Provider 的旧值则由用户明确填写，必须保留。
    const contextLimitMode: ContextLimitMode = stored.contextLimitMode === 'custom' || stored.contextLimitMode === 'default'
      ? stored.contextLimitMode : provider === '自定义' ? 'custom' : 'default';
    const modelMaximum = ResolveModelMaximum(provider, model);
    let contextLimit: number;
    try {
      contextLimit = ResolveContextLimit({ mode: contextLimitMode, value: stored.contextLimit, modelMaximum });
    } catch {
      contextLimit = ResolveContextLimit({ mode: 'default', modelMaximum });
    }
    config = {
      provider,
      baseUrl: provider === '自定义' ? (stored.baseUrl || DefaultBaseUrl) : ResolveOfficialBaseUrl(provider),
      model,
      thinkingEnabled: provider === 'Z.AI' ? true : stored.thinkingEnabled !== false,
      contextLimit,
      contextLimitMode,
      compressionThreshold: stored.compressionThreshold ?? 80,
      apiKey: typeof stored.apiKey === 'string' ? stored.apiKey : '',
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
    sdkVersion: '0.1.0',
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
      const next = {
        provider,
        baseUrl,
        model,
        thinkingEnabled: provider === 'Z.AI' ? true : Boolean(cfg.thinkingEnabled),
        // 同一供应商修改非密钥设置可复用已保存凭据；跨供应商必须由用户重新提供，避免误发旧 Key。
        apiKey: apiKey || (provider === config.provider ? config.apiKey : ''),
      };
      if (!next.apiKey) throw new Error('API Key is required.');
      const contextLimitMode: ContextLimitMode = cfg.contextLimitMode === 'custom' ? 'custom' : 'default';
      const contextLimit = ResolveContextLimit({
        mode: contextLimitMode,
        value: cfg.contextLength,
        modelMaximum: ResolveModelMaximum(provider, model),
      });
      const compressionThreshold = ParseCompressionThreshold(cfg.compressionThreshold);
      await ports.saveConfig({ ...next, contextLimit, contextLimitMode, compressionThreshold });
      config = { ...next, contextLimit, contextLimitMode, compressionThreshold };
      return { configured: true, provider: next.provider, model: next.model };
    },
    /** 使用当前表单值测试兼容 OpenAI 的模型服务，不写入配置或暴露密钥。 */
    async TestConnection(input: unknown) {
      const cfg = (input ?? {}) as Record<string, unknown>;
      const provider = NormalizeProvider(cfg.provider);
      const apiKey = RequireString(cfg.apiKey, 'apiKey', 500);
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
    async GetStatus() {
      await EnsureConfig();
      return {
        configured: Boolean(config.apiKey),
        provider: config.provider,
        model: config.model,
        baseUrl: config.baseUrl,
        contextLimit: config.contextLimit,
        contextLimitMode: config.contextLimitMode ?? 'default',
        compressionThreshold: config.compressionThreshold,
      };
    },
    /** 校验单轮模型切换，DeepSeek 仅允许预设，自定义 Provider 固定使用已保存模型。 */
    ResolveRequestModel(requestedModel) {
      if (config.provider === 'Z.AI') {
        if (requestedModel !== undefined && requestedModel !== GlmFlashModel) throw new Error('The requested model is not available for Z.AI.');
        return GlmFlashModel;
      }
      if (config.provider !== 'DeepSeek') return config.model;
      if (requestedModel === undefined) return config.model;
      const model = NormalizeDeepSeekModel(requestedModel);
      if (model !== requestedModel) throw new Error('The requested model is not available for DeepSeek.');
      return model;
    },
    /** 读取 DeepSeek 账户余额。密钥只在主进程私有配置中使用，返回值不含密钥。 */
    async GetBalance() {
      await EnsureConfig();
      if (!config.apiKey) throw new Error('请先保存 DeepSeek API Key。');
      if (config.provider !== 'DeepSeek') throw new Error('余额查询仅支持 DeepSeek。');
      const response = await providerFetch(`${DefaultBaseUrl}/user/balance`, {
        method: 'GET', headers: { Authorization: `Bearer ${config.apiKey}` }, signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) throw new Error(`余额查询失败（${response.status}）。`);
      const json = await response.json() as { is_available?: unknown; balance_infos?: Array<{ currency?: unknown; total_balance?: unknown }> };
      const balances = Array.isArray(json.balance_infos) ? json.balance_infos
        .filter((item) => typeof item?.currency === 'string' && Number.isFinite(Number(item?.total_balance)))
        .map((item) => ({ currency: String(item.currency), totalBalance: String(item.total_balance) })) : [];
      if (json.is_available !== true || balances.length === 0) throw new Error('当前账户余额不可用。');
      return { available: true, balances };
    },
    /** 从 DeepSeek 官方 /models 同步当前凭据可用的模型；网络失败由调用层保留本地 V4 兜底。 */
    async GetModels() {
      await EnsureConfig();
      if (config.provider === 'Z.AI') return { models: [GlmFlashModel] };
      if (!config.apiKey) throw new Error('请先保存 DeepSeek API Key。');
      if (config.provider !== 'DeepSeek') throw new Error('模型同步仅支持 DeepSeek。');
      const response = await providerFetch(`${DefaultBaseUrl}/models`, {
        method: 'GET', headers: { Authorization: `Bearer ${config.apiKey}` }, signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) throw new Error(`模型列表获取失败（${response.status}）。`);
      const json = await response.json() as { data?: Array<{ id?: unknown }> };
      const models = Array.isArray(json.data) ? json.data
        .map((item) => typeof item?.id === 'string' ? item.id.trim() : '')
        .filter((id) => id === NormalizeDeepSeekModel(id)) : [];
      const available = [...new Set(models)].sort((left, right) => left.localeCompare(right));
      return { models: available.length ? available : DefaultDeepSeekModels };
    },
    /** 调用兼容 OpenAI Chat Completions 的流式接口并转发思考与正文增量；畸形 SSE 直接失败，不静默忽略。 */
    async StreamCompletion(request) {
      await EnsureConfig();
      const systemContent = RequireString(request.instructions?.compiled, 'compiled instructions', 200000);
      const providerMessages = [{ role: 'system', content: systemContent }, ...request.history.map(ToProviderMessage)];
      const thinking = config.provider === 'Z.AI'
        ? { thinking: { type: 'enabled', clear_thinking: false }, reasoning_effort: ResolveDeepSeekReasoningEffort(request.reasoningEffort), temperature: 1, top_p: 0.95, tool_stream: true }
        : config.provider === 'DeepSeek'
          ? config.thinkingEnabled
            ? { thinking: { type: 'enabled' }, reasoning_effort: ResolveDeepSeekReasoningEffort(request.reasoningEffort) }
            : { thinking: { type: 'disabled' } }
          : {};
      const body = SerializeCompletionBody({ model: request.model, stream: true, ...thinking, ...(config.provider === 'DeepSeek' ? { stream_options: { include_usage: true } } : {}), messages: providerMessages, tools: request.tools.map((tool) => tool.definition), tool_choice: 'auto' }, config.provider === 'DeepSeek');
      request.onRequest?.({ kind: 'completion', model: request.model, messages: providerMessages, toolCount: request.tools.length });
      const response = await providerFetch(`${config.baseUrl}/chat/completions`, {
        method: 'POST',
        signal: request.signal,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` },
        body,
      });
      if (!response.ok || !response.body) throw new Error(`Model request failed (${response.status}).`);
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
          if (config.provider === 'DeepSeek' && usageChunkSeen) {
            throw new Error('PROTOCOL_DUPLICATE_USAGE: DeepSeek sent more than one non-null usage chunk.');
          }
          if (config.provider === 'DeepSeek' && !IsDeepSeekUsageChunk(choices)) {
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
    async CreateSummary(model, messages, onRequest) {
      await EnsureConfig();
      const providerMessages = [{ role: 'system', content: SummaryPrompt }, ...messages.map(ToProviderMessage)];
      const providerOptions = config.provider === 'Z.AI'
        ? { thinking: { type: 'enabled', clear_thinking: false }, reasoning_effort: 'high', temperature: 1, top_p: 0.95 }
        : {};
      const body = JSON.stringify({ model, stream: false, messages: providerMessages, ...providerOptions });
      onRequest?.({ kind: 'summary', model, messages: providerMessages, toolCount: 0 });
      const response = await providerFetch(`${config.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` },
        body,
      });
      if (!response.ok) throw new Error(`Summary request failed (${response.status}).`);
      const json = (await response.json()) as { choices?: Array<{ message?: { content?: unknown } }>; usage?: unknown };
      const content = json?.choices?.[0]?.message?.content;
      const usage = NormalizeModelUsage(json?.usage);
      return { content: RequireString(content, 'summary', 16000), ...(usage ? { usage } : {}) };
    },
    /** 估算 Provider 请求输入规模；仅用于触发阈值与界面提示，不用于计费。 */
    EstimateTokens(value) { return EstimateProviderTokens(value); },
    /** 返回上下文长度上限与压缩阈值百分比。 */
    GetRuntimeLimits() { return { contextLimit: config.contextLimit, threshold: config.compressionThreshold }; },
    /** 返回当前 BaseUrl，供连通性等只读展示（不含密钥）。 */
    BaseUrl() { return config.baseUrl; },
  };
}
