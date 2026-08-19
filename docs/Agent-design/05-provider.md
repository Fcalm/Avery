# Provider：DeepSeek 与 OpenAI 协议适配

## 1. 目标边界

Provider 层负责：

- 凭据引用、Endpoint、模型与能力发现。
- 将内部消息、Prompt 和工具 Schema 映射到供应商协议。
- 解析流式事件、工具调用、结束原因、错误和 Usage。
- 处理供应商允许的超时、限流和有界重试。
- 保存协议版本与响应元数据，支持对账和回放测试。

Provider 层不负责：

- 选择业务场景或工具白名单。
- 持有 System Prompt 正文的业务所有权。
- 决定是否允许工具执行或写入。
- 把 Provider 原始错误直接显示给 Renderer。
- 估算 Usage 后伪装成供应商真实值。

## 2. 内部规范化协议

```ts
interface ModelRequest {
  requestId: string;
  model: string;
  instructions: CompiledInstructions;
  messages: CanonicalMessage[];
  tools: CanonicalToolDefinition[];
  toolChoice: 'auto' | 'none' | { toolId: string };
  maxOutputTokens: number;
  reasoning?: { enabled: boolean; effort?: string };
  responseFormat?: CanonicalResponseFormat;
  providerContinuation?: ProviderContinuation;
}

type ModelStreamEvent =
  | { type: 'response_started'; providerRequestId?: string }
  | { type: 'output_text_delta'; text: string }
  | { type: 'reasoning_summary_delta'; text: string }
  | { type: 'tool_call_started'; index: number; id: string; name: string }
  | { type: 'tool_arguments_delta'; index: number; text: string }
  | { type: 'tool_call_completed'; index: number }
  | { type: 'usage'; usage: NormalizedUsage; raw: unknown }
  | { type: 'response_completed'; finishReason: CanonicalFinishReason }
  | { type: 'error'; error: ProviderError };
```

Loop 只消费这些事件，不解析 SSE/JSONL，也不判断 DeepSeek 的 `choices[0].delta` 或 OpenAI Responses 的具体事件结构。

## 3. Adapter 接口

```ts
interface ProviderAdapter {
  id: string;
  protocolVersion: string;
  configure(config: ProviderConfigRef): Promise<void>;
  discoverModels(signal: AbortSignal): Promise<ModelDescriptor[]>;
  resolveCapabilities(model: string): Promise<ModelCapabilities>;
  countTokens?(request: ModelRequest): Promise<number>;
  stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelStreamEvent>;
  summarize(request: SummaryRequest, signal: AbortSignal): Promise<SummaryResponse>;
  normalizeError(error: unknown): ProviderError;
  healthCheck(signal: AbortSignal): Promise<ProviderHealth>;
}
```

能力按模型快照记录，不能只按供应商名称硬编码：

```ts
interface ModelCapabilities {
  contextLimit?: number;
  maxOutputTokens?: number;
  toolCalling: 'none' | 'single' | 'parallel';
  strictToolSchema: boolean;
  streaming: boolean;
  usageInStream: boolean;
  systemInstructions: 'none' | 'single' | 'layered';
  reasoning: 'none' | 'opaque' | 'summary' | 'provider_specific';
  vision: boolean;
  tokenCounting: boolean;
}
```

模型列表接口返回“存在”不代表支持当前 Agent 场景。运行前 Harness 必须检查所需能力，例如工具调用、上下文长度和流式 Usage。

## 4. 供应商范围

### 4.1 首批正式支持

| Adapter | 协议 | 首期定位 | 关键差异 |
| --- | --- | --- | --- |
| DeepSeek | 官方 Chat Completions API | V1 默认 | 多轮历史由客户端维护；thinking + tool calls 可能要求回传 Provider-specific reasoning state |
| OpenAI | 官方 Responses API | V1 支持 | 使用 Responses 事件、response item 和 function call/output 语义，不能按 Chat Completions 解析 |

“正式支持”意味着必须同时具备：

- 产品配置入口和凭据存储。
- 模型发现或受控模型清单。
- 流式文本、工具调用、Usage、取消和错误映射。
- Prompt、工具 Schema 和 Provider Continuation 的契约测试。
- Mock/fixture、真实联调开关和发布回归门禁。

DeepSeek 与 OpenAI 必须使用独立 Adapter。不能因为 DeepSeek 采用 OpenAI 风格的部分结构，就让二者共享一套未经区分的流解析和消息映射。

首批不支持自定义 OpenAI-compatible Endpoint，不提供自定义 Base URL、任意 Header 或第三方兼容服务配置。

### 4.2 MiMo 候选扩展

MiMo 只作为候选 Provider，不属于首批支持范围：

```ts
{
  id: 'mimo',
  status: 'candidate',
  userConfigEnabled: false
}
```

在完成官方 API 稳定性、工具调用、流式 Usage、上下文长度、推理状态和错误语义验证前：

- 不在用户设置中展示 MiMo。
- 不把 MiMo 模型加入正式模型列表。
- 不承诺 Prompt、工具或 Continuation 与现有 Adapter 兼容。
- 不通过“OpenAI-compatible”名义直接复用 DeepSeek/OpenAI Adapter。

如果后续验证通过，应新增独立 MiMo Adapter、fixture 和能力快照，并通过与 DeepSeek/OpenAI 相同的发布门禁。

## 5. 消息与工具映射

Canonical Transcript 保留语义对象，不永久保存某家 Provider 的请求 JSON。每个 Adapter 负责：

- 指令角色映射。
- assistant tool call 与 tool result 的配对。
- 同批并行调用的索引和 ID 聚合。
- 空 content、停止原因和拒绝内容的规范化。
- Provider 所需但不应展示的 continuity state。

工具参数流只在收到完成事件后交给 Tools 校验。若连接结束时参数 JSON 未闭合，返回 `PROTOCOL_INCOMPLETE_TOOL_CALL`，不能尝试执行可解析的前半段。

## 6. 推理内容

- 内核不假设所有 Provider 都返回思维链。
- 用户可见的仅是 Provider 明确设计为可展示的 reasoning summary；原始隐藏推理不进入 UI 或普通 Trace。
- Provider 为继续工具链而要求回传的推理字段，作为 `ProviderContinuation` 原样受控保存，仅用于同一 Provider/模型/Run。
- Continuation 不参与跨 Provider 迁移、通用摘要或业务事实提取。
- 切换 Provider 时若无法安全转换 continuation，应在完整用户轮次边界切换，不在未完成工具链中切换。

## 7. Usage

```ts
interface NormalizedUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cachedInputTokens?: number;
  reasoningTokens?: number;
  source: 'provider';
  complete: boolean;
}
```

规则：

- 保留脱敏后的原始 Usage JSON供开发 Trace，同时生成规范字段。
- 不同 Provider 不存在的字段保持 `undefined`，不填 0。
- 校验整数、非负和明显矛盾值；异常 Usage 记协议告警，不用于 UI 百分比。
- 流中多次出现 Usage 时按 Adapter 规则选择最终累计值，不能简单相加。
- 本地 token 估算放在 Context `TokenMeasurement`，不写入 `NormalizedUsage`。

## 8. 流解析

- SSE parser 必须处理跨 chunk 行、事件名、多行 data、终止事件和 UTF-8 边界。
- 未知事件记录版本化告警；是否可忽略由 Adapter 白名单决定。
- 已知事件 JSON 畸形、工具参数缺片、finish reason 缺失不得静默吞掉。
- Adapter 输出事件序号，Harness 检查单调性和工具调用生命周期完整性。
- 背压通过 AsyncIterable 传播；UI 慢不能导致无界内存缓冲。

## 9. 错误与重试

```ts
interface ProviderError {
  code: string;
  category: 'auth' | 'rate_limit' | 'timeout' | 'network' | 'invalid_request'
    | 'content_policy' | 'protocol' | 'server' | 'cancelled';
  retryability: 'none' | 'safe_before_output' | 'user_action';
  httpStatus?: number;
  providerRequestId?: string;
  safeMessage: string;
}
```

- 鉴权、参数、内容策略和能力不匹配不自动重试。
- 429/部分 5xx/网络错误只在尚未向 UI 发出正文、尚未执行工具时有界退避，遵守 `Retry-After`。
- 已有部分输出时失败，不自动发第二个请求并拼接。
- 摘要请求和只读模型请求可以独立配置重试上限，默认 1 次。
- 取消优先于重试；所有 fetch/SDK 调用必须接收同一个 AbortSignal。
- 重试记录 attempt、延迟、原因和 Provider request ID。

## 10. 配置与安全

- API Key 只以 Credential Reference 出现在 Provider 配置，实际值由 Desktop 安全存储端口按请求读取。
- Renderer、业务数据库、导出、Prompt、工具结果和 Trace 不保存 Key。
- DeepSeek 和 OpenAI 使用产品内置的官方 Endpoint，不接受用户自定义 Base URL、Authorization 模板或额外 Header。
- 联调 Mock Endpoint 只允许测试构建通过显式环境配置启用，不进入正式设置或持久化配置。
- Provider 请求默认拒绝跨域重定向，避免凭据被带到非预期 Endpoint。
- 文本与视觉 Provider 分开配置、授权和凭据引用，不默认共享 Key。

## 11. Provider 快照与切换

每个 Run 冻结：

- Provider/Adapter ID 与协议版本。
- Base URL 的脱敏标识。
- 模型 ID 与能力快照。
- thinking、max output、tool schema 方言。
- Prompt 编译策略版本。

会话可以在完整 Run 边界切换模型；运行中或未完成工具链中不切换。模型下线时，新 Run 提示用户选择替代模型，不静默映射到另一个模型后继续高风险写入。

## 12. 契约与回归测试

每个 Adapter 至少有：

- 请求 golden fixture：指令、多轮消息、单/多工具、工具结果、空正文。
- 流分片 fuzz：每个字节边界切块、多个 data 行、未知事件、畸形 JSON、提前 EOF。
- Usage fixture：完整、缺失、重复、缓存 token、矛盾值。
- 错误映射：401、403、429、400、5xx、timeout、cancel。
- 工具链回放：call ID、顺序、参数增量和 continuation 完整。
- 能力探测：不支持工具或 system 时在请求前拒绝。

外部联调测试使用显式环境开关，不在普通 CI 使用真实 Key。CI 以录制后脱敏的协议 fixture 和 mock server 为主。

## 13. 参考协议

设计时应以供应商官方文档为准，并在实现 Adapter 时固定校验日期与协议版本：

- [OpenAI Function calling](https://developers.openai.com/api/docs/guides/function-calling)
- [OpenAI Streaming responses](https://developers.openai.com/api/docs/guides/streaming-responses)
- [DeepSeek Tool Calls](https://api-docs.deepseek.com/guides/tool_calls)
- [DeepSeek Thinking Mode](https://api-docs.deepseek.com/guides/thinking_mode/)

## 14. 总结

Provider Adapter 是协议反腐层。它把 DeepSeek 和 OpenAI 的角色、流事件、工具调用、推理状态和 Usage 转成内部契约，但不拥有业务 Prompt、权限和 Loop 策略。首批只正式支持 DeepSeek 与 OpenAI；MiMo 保持候选状态，完成独立协议验证后再决定是否扩展。
