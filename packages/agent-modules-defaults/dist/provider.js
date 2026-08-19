"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DefaultBaseUrl = exports.SystemPrompt = exports.SummaryPrompt = void 0;
exports.CreateProviderModule = CreateProviderModule;
const helpers_1 = require("./helpers");
const prompts_1 = require("./prompts");
// 保留既有导出，供扩展模块和既有调用方兼容；实际定义集中在 prompts.ts。
var prompts_2 = require("./prompts");
Object.defineProperty(exports, "SummaryPrompt", { enumerable: true, get: function () { return prompts_2.SummaryPrompt; } });
Object.defineProperty(exports, "SystemPrompt", { enumerable: true, get: function () { return prompts_2.SystemPrompt; } });
/** DeepSeek 官方 API 根地址；自定义 Provider 使用用户配置的 BaseUrl。 */
exports.DefaultBaseUrl = 'https://api.deepseek.com';
const DefaultDeepSeekModels = ['deepseek-v4-flash', 'deepseek-v4-pro'];
/** 将已弃用的历史模型名迁移为当前默认模型，避免旧配置导致请求被服务端拒绝。 */
function NormalizeDeepSeekModel(model) {
    const value = typeof model === 'string' ? model.trim() : '';
    // chat / reasoner 已被官方弃用；其余以 deepseek- 开头的 ID 由 /models 实时校验后可安全使用。
    if (value === 'deepseek-chat' || value === 'deepseek-reasoner')
        return 'deepseek-v4-flash';
    return /^deepseek-[a-z0-9][a-z0-9._-]{0,199}$/i.test(value) ? value : 'deepseek-v4-flash';
}
/** 将 SSE 读取块拆为完整的数据行。 */
function CreateSseParser(onData) {
    let buffer = '';
    return (chunk) => {
        buffer += chunk;
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() || '';
        for (const line of lines) {
            if (!line.startsWith('data:'))
                continue;
            const value = line.slice(5).trim();
            if (value && value !== '[DONE]')
                onData(value);
        }
    };
}
/** 仅接受 Provider 明确返回的完整非负整数 usage；无效或缺失时不使用估算值替代。 */
function NormalizeModelUsage(value) {
    const usage = value && typeof value === 'object' ? value : null;
    const promptTokens = Number(usage?.prompt_tokens);
    const completionTokens = Number(usage?.completion_tokens);
    const totalTokens = Number(usage?.total_tokens);
    if (![promptTokens, completionTokens, totalTokens].every((item) => Number.isSafeInteger(item) && item >= 0))
        return undefined;
    if (totalTokens < promptTokens || totalTokens < completionTokens)
        return undefined;
    return { promptTokens, completionTokens, totalTokens };
}
/** 默认模型 Provider 模块：配置、连通性、请求级模型解析、流式补全、摘要与规模估算；API Key 经宿主端口存取。 */
function CreateProviderModule(ports) {
    let config = { provider: 'DeepSeek', baseUrl: exports.DefaultBaseUrl, model: 'deepseek-v4-flash', thinkingEnabled: true, contextLimit: 64000, compressionThreshold: 80, apiKey: '' };
    let configLoaded = false;
    const providerFetch = globalThis.fetch;
    /** 惰性加载宿主私有配置：首次任一业务入口需要配置时经端口读取，之后缓存于内存；无端口或未保存时保留默认值。 */
    async function EnsureConfig() {
        if (configLoaded)
            return;
        configLoaded = true;
        const stored = (await ports.getConfig()) ?? null;
        if (!stored)
            return;
        config = {
            provider: stored.provider || 'DeepSeek',
            baseUrl: stored.provider === 'DeepSeek' ? exports.DefaultBaseUrl : (stored.baseUrl || exports.DefaultBaseUrl),
            model: stored.provider === 'DeepSeek' ? NormalizeDeepSeekModel(stored.model) : (stored.model || 'deepseek-v4-flash'),
            thinkingEnabled: stored.thinkingEnabled !== false,
            contextLimit: stored.contextLimit || 64000,
            compressionThreshold: stored.compressionThreshold ?? 80,
            apiKey: typeof stored.apiKey === 'string' ? stored.apiKey : '',
        };
    }
    /** 解析用户配置的上下文长度，拒绝无意义长度并保留安全默认值。 */
    function ParseContextLimit(value) {
        const matched = String(value ?? '64K').trim().match(/^(\d+)\s*[kK]?$/);
        const limit = matched ? Number(matched[1]) * (/[kK]/.test(String(value)) ? 1000 : 1) : 64000;
        if (!Number.isInteger(limit) || limit < 8000 || limit > 2_000_000)
            return 64000;
        return limit;
    }
    /** 解析可配置的压缩阈值，范围固定为文档要求的 1–80%。 */
    function ParseCompressionThreshold(value) {
        const threshold = Number(value ?? 80);
        return Number.isInteger(threshold) && threshold >= 1 && threshold <= 80 ? threshold : 80;
    }
    return {
        packageName: '@offerget/agent-modules-defaults',
        name: 'offerget.agent-defaults',
        version: '0.1.0',
        sdkVersion: '0.1.0',
        slot: 'model-provider',
        capabilities: ['model'],
        /** 保存经校验的模型配置，并将 API Key 经端口移交宿主 safeStorage 加密落盘。 */
        async Configure(input) {
            await EnsureConfig();
            const cfg = (input ?? {});
            const provider = cfg.provider === '自定义' ? '自定义' : 'DeepSeek';
            const requestedModel = (0, helpers_1.RequireString)(cfg.model, 'model', 200);
            const apiKey = typeof cfg.apiKey === 'string' ? cfg.apiKey.trim() : '';
            const baseUrl = provider === 'DeepSeek' ? exports.DefaultBaseUrl : (0, helpers_1.RequireString)(cfg.baseUrl, 'baseUrl', 500).replace(/\/$/, '');
            if (apiKey && /\*/.test(apiKey))
                throw new Error('Please enter the complete API Key before saving.');
            const model = provider === 'DeepSeek' ? NormalizeDeepSeekModel(requestedModel) : requestedModel;
            if (provider === 'DeepSeek' && model !== requestedModel)
                throw new Error('请选择 DeepSeek 当前支持的模型。');
            const next = { provider, baseUrl, model, thinkingEnabled: Boolean(cfg.thinkingEnabled), apiKey: apiKey || config.apiKey };
            if (!next.apiKey)
                throw new Error('API Key is required.');
            const contextLimit = ParseContextLimit(cfg.contextLength);
            const compressionThreshold = ParseCompressionThreshold(cfg.compressionThreshold);
            await ports.saveConfig({ ...next, contextLimit, compressionThreshold });
            config = { ...next, contextLimit, compressionThreshold };
            return { configured: true, provider: next.provider, model: next.model };
        },
        /** 使用当前表单值测试兼容 OpenAI 的模型服务，不写入配置或暴露密钥。 */
        async TestConnection(input) {
            const cfg = (input ?? {});
            const provider = cfg.provider === '自定义' ? '自定义' : 'DeepSeek';
            const apiKey = (0, helpers_1.RequireString)(cfg.apiKey, 'apiKey', 500);
            if (/\*/.test(apiKey))
                throw new Error('Please enter the complete API Key before testing.');
            const baseUrl = provider === 'DeepSeek' ? exports.DefaultBaseUrl : (0, helpers_1.RequireString)(cfg.baseUrl, 'baseUrl', 500).replace(/\/$/, '');
            const response = await providerFetch(`${baseUrl}/models`, { method: 'GET', headers: { Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(15000) });
            if (!response.ok)
                throw new Error(`Connection test failed (${response.status}).`);
            return { connected: true, provider, baseUrl };
        },
        /** 只返回脱敏状态，供渲染层决定是否展示配置引导；首次读取前先加载已保存配置。 */
        async GetStatus() {
            await EnsureConfig();
            return { configured: Boolean(config.apiKey), provider: config.provider, model: config.model };
        },
        /** 校验单轮模型切换，DeepSeek 仅允许预设，自定义 Provider 固定使用已保存模型。 */
        ResolveRequestModel(requestedModel) {
            if (config.provider !== 'DeepSeek')
                return config.model;
            if (requestedModel === undefined)
                return config.model;
            const model = NormalizeDeepSeekModel(requestedModel);
            if (model !== requestedModel)
                throw new Error('The requested model is not available for DeepSeek.');
            return model;
        },
        /** 读取 DeepSeek 账户余额。密钥只在主进程私有配置中使用，返回值不含密钥。 */
        async GetBalance() {
            await EnsureConfig();
            if (!config.apiKey)
                throw new Error('请先保存 DeepSeek API Key。');
            if (config.provider !== 'DeepSeek')
                throw new Error('余额查询仅支持 DeepSeek。');
            const response = await providerFetch(`${exports.DefaultBaseUrl}/user/balance`, {
                method: 'GET', headers: { Authorization: `Bearer ${config.apiKey}` }, signal: AbortSignal.timeout(15000),
            });
            if (!response.ok)
                throw new Error(`余额查询失败（${response.status}）。`);
            const json = await response.json();
            const balances = Array.isArray(json.balance_infos) ? json.balance_infos
                .filter((item) => typeof item?.currency === 'string' && Number.isFinite(Number(item?.total_balance)))
                .map((item) => ({ currency: String(item.currency), totalBalance: String(item.total_balance) })) : [];
            if (json.is_available !== true || balances.length === 0)
                throw new Error('当前账户余额不可用。');
            return { available: true, balances };
        },
        /** 从 DeepSeek 官方 /models 同步当前凭据可用的模型；网络失败由调用层保留本地 V4 兜底。 */
        async GetModels() {
            await EnsureConfig();
            if (!config.apiKey)
                throw new Error('请先保存 DeepSeek API Key。');
            if (config.provider !== 'DeepSeek')
                throw new Error('模型同步仅支持 DeepSeek。');
            const response = await providerFetch(`${exports.DefaultBaseUrl}/models`, {
                method: 'GET', headers: { Authorization: `Bearer ${config.apiKey}` }, signal: AbortSignal.timeout(15000),
            });
            if (!response.ok)
                throw new Error(`模型列表获取失败（${response.status}）。`);
            const json = await response.json();
            const models = Array.isArray(json.data) ? json.data
                .map((item) => typeof item?.id === 'string' ? item.id.trim() : '')
                .filter((id) => id === NormalizeDeepSeekModel(id)) : [];
            const available = [...new Set(models)].sort((left, right) => left.localeCompare(right));
            return { models: available.length ? available : DefaultDeepSeekModels };
        },
        /** 调用兼容 OpenAI Chat Completions 的流式接口并转发思考与正文增量；畸形 SSE 直接失败，不静默忽略。 */
        async StreamCompletion(request) {
            await EnsureConfig();
            const systemContent = request.instructions?.compiled ?? prompts_1.SystemPrompt;
            const response = await providerFetch(`${config.baseUrl}/chat/completions`, {
                method: 'POST',
                signal: request.signal,
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` },
                body: JSON.stringify({ model: request.model, stream: true, ...(config.provider === 'DeepSeek' ? { stream_options: { include_usage: true } } : {}), messages: [{ role: 'system', content: systemContent }, ...request.history], tools: request.tools.map((tool) => tool.definition), tool_choice: 'auto' }),
            });
            if (!response.ok || !response.body)
                throw new Error(`Model request failed (${response.status}).`);
            const decoder = new TextDecoder();
            const toolCalls = [];
            let content = '';
            let reasoningContent = '';
            let usage;
            const parse = CreateSseParser((data) => {
                let payload;
                try {
                    payload = JSON.parse(data);
                }
                catch {
                    throw new Error('PROTOCOL_INVALID_SSE_JSON: Provider sent a malformed SSE data block.');
                }
                const record = payload && typeof payload === 'object' ? payload : null;
                if (!record)
                    throw new Error('PROTOCOL_INVALID_SSE_JSON: Provider SSE data is not an object.');
                const reportedUsage = NormalizeModelUsage(record?.usage);
                if (reportedUsage)
                    usage = reportedUsage;
                const choices = Array.isArray(record?.choices) ? record.choices : null;
                if (record?.choices !== undefined && !Array.isArray(record?.choices))
                    throw new Error('PROTOCOL_INVALID_SSE_SHAPE: Provider delta shape is invalid.');
                const choice = choices?.[0] && typeof choices[0] === 'object' ? choices[0].delta : undefined;
                const reasoning = typeof choice?.reasoning_content === 'string' ? choice.reasoning_content : '';
                const deltaContent = typeof choice?.content === 'string' ? choice.content : '';
                for (const deltaCall of Array.isArray(choice?.tool_calls) ? choice.tool_calls : []) {
                    const deltaRecord = deltaCall && typeof deltaCall === 'object' ? deltaCall : null;
                    if (!deltaRecord)
                        throw new Error('PROTOCOL_INVALID_SSE_SHAPE: Tool call delta is not an object.');
                    const index = Number(deltaRecord.index ?? 0);
                    if (!Number.isSafeInteger(index) || index < 0 || index > 127)
                        throw new Error('PROTOCOL_INVALID_SSE_SHAPE: Tool call index is invalid.');
                    const call = toolCalls[index] ?? { id: '', type: 'function', function: { name: '', arguments: '' } };
                    const fn = deltaRecord.function && typeof deltaRecord.function === 'object' ? deltaRecord.function : null;
                    call.id += typeof deltaRecord.id === 'string' ? deltaRecord.id : '';
                    call.function.name += typeof fn?.name === 'string' ? fn.name : '';
                    call.function.arguments += typeof fn?.arguments === 'string' ? fn.arguments : '';
                    toolCalls[index] = call;
                }
                if (reasoning)
                    request.onDelta({ reasoning, content: '' });
                if (deltaContent)
                    request.onDelta({ reasoning: '', content: deltaContent });
                reasoningContent += reasoning;
                content += deltaContent;
            });
            const reader = response.body.getReader();
            while (true) {
                const { done, value } = await reader.read();
                if (done)
                    break;
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
        async CreateSummary(model, messages) {
            await EnsureConfig();
            const response = await providerFetch(`${config.baseUrl}/chat/completions`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` },
                body: JSON.stringify({ model, stream: false, messages: [{ role: 'system', content: prompts_1.SummaryPrompt }, ...messages] }),
            });
            if (!response.ok)
                throw new Error(`Summary request failed (${response.status}).`);
            const json = (await response.json());
            const content = json?.choices?.[0]?.message?.content;
            const usage = NormalizeModelUsage(json?.usage);
            return { content: (0, helpers_1.RequireString)(content, 'summary', 16000), ...(usage ? { usage } : {}) };
        },
        /** 估算 Provider 请求输入规模；仅用于触发阈值与界面提示，不用于计费。 */
        EstimateTokens(value) { return Math.ceil(JSON.stringify(value).length / 4); },
        /** 返回上下文长度上限与压缩阈值百分比。 */
        GetRuntimeLimits() { return { contextLimit: config.contextLimit, threshold: config.compressionThreshold }; },
        /** 返回当前 BaseUrl，供连通性等只读展示（不含密钥）。 */
        BaseUrl() { return config.baseUrl; },
        /** 返回模块拥有的场景系统提示。 */
        SystemPrompt() { return prompts_1.SystemPrompt; },
    };
}
