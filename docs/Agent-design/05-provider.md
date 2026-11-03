# Provider：版本化供应商适配与发布门禁

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

### 3.1 上下文限制解析

- 后端 `ModelConfigurationService` 统一解析目录推荐值与个人覆盖；Kernel、压缩器、Usage、设置页和 Provider 消费同一生效上下文窗口。
- 目录按实际 API 根地址和完整模型 ID 匹配；官方服务使用固定官方端点，自定义服务不因模型同名而继承其他端点的能力。仅已知官方服务规范化 `/v1` 别名。
- 自动模式使用目录声明的窗口，产品当前最高采用 1M；未匹配目录时使用 256K，并明确标记为未知来源。目录声明不代表真实 API 已验证。
- 手工编辑窗口保持 128000–1000000 的界面范围；目录自动给出的更小窗口可直接保留。历史有效小窗口作为个人覆盖迁移，不被默认值覆盖。
- Run 创建时冻结生效能力；在途请求及其恢复继续使用原快照，目录或个人配置更新只影响后续新 Run。

### 3.2 模型能力配置

- `GetModelConfiguration` 返回目录推荐值、生效值、个人覆盖和单模型 revision；`SaveModelConfiguration` 严格校验字段并按 revision 原子保存。模型能力配置不包含 API Key。
- 设置页编辑模型 ID 时自动解析能力；图片、PDF 声明、上下文、最大输出和思考配置均保存到后端。恢复自动匹配清除个人覆盖，重新继承当前目录。
- 图片附件与 `BrowserScreenshot` 使用 Run 内同一图片能力；Provider 在发请求前检查图片和工具能力，并使用生效输出上限。当前 GLM 接入仍固定开启思考，不接受关闭覆盖。
- PDF 目录标记作为模型能力声明保存；现有 PDF 仍通过文档解析读取，本次不新增原生 PDF 透传。目录匹配不自动执行付费能力探测。
- 个人覆盖保存在 userData 下的 `model-configurations.json`；公开目录缓存使用独立的 `model-directory-cache.json`，不进入业务工作空间。个人配置损坏时保留原文并报错，不静默清空。
- 随应用携带公开事实快照，启动和新 Run 不等待网络。目录后台刷新间隔为一天，也支持设置页显式更新；失败沿用已有缓存和内置快照，不改写个人覆盖。
- 公开目录来源为 [Models.dev](https://github.com/anomalyco/models.dev)，备用数据源为 [OpenCode 的 Models.dev 快照](https://github.com/anomalyco/opencode/blob/dev/packages/core/src/models-dev/snapshot.txt)。目录请求只发往固定公开地址，不携带供应商凭据。
- 旧前端缓存仅迁移正向图片/PDF 标记和非默认数值；默认 `false` 不作为显式关闭覆盖。已有后端个人覆盖优先。

## 4. 供应商范围

### 4.1 0.2.0 正式支持

| Adapter | 协议 | 0.2.0 定位 | 关键差异 |
| --- | --- | --- | --- |
| DeepSeek | 官方 Chat Completions API | 唯一正式发布门禁 | 多轮历史由客户端维护；thinking + tool calls 可能要求回传 Provider-specific reasoning state |
| Z.AI GLM | 官方 Chat Completions API | `glm-5.3-flash` 正式模型 | 原生多模态；强制思考；保留历史 reasoning；支持流式工具调用 |

DeepSeek 与 Z.AI Adapter 都必须通过下列正式支持门禁；DeepSeek 继续作为既有回归基线：

- 产品配置入口和凭据存储。
- 模型发现或受控模型清单。
- 流式文本、工具调用、Usage、取消和错误映射。
- Prompt、工具 Schema 和 Provider Continuation 的契约测试。
- Mock/fixture、真实联调开关和发布回归门禁。

DeepSeek Chat Completions 的思考参数由 Adapter 统一生成：全局思考模式关闭时发送 `thinking.type=disabled`；开启时发送 `thinking.type=enabled`，并把会话级 `reasoningEffort` 映射为 `reasoning_effort`。前端保留 `low/medium/high/xhigh/max` 五档，官方实际映射为 `low/high/high/high/max`。该选择随会话助手状态持久化，普通 Run 只读取启动时值，不在同一 Run 中途改变。

Agent 请求始终携带工具定义，因此历史 assistant 消息的 `reasoning_content` 必须完整回传；Provider Adapter 不得因上一轮没有工具调用而删除该字段。

### 4.2 Z.AI GLM-5.3-Flash

- 用户在 API 配置中选择 `GLM` 并填写自己的智谱中国区 API Key；Key 经宿主 `safeStorage` 加密，不进入 Renderer 持久化数据。
- 中国区标准端点固定为 `https://open.bigmodel.cn/api/paas/v4`，模型固定为 `glm-5.3-flash`。Provider 加载旧配置时忽略曾使用的国际站地址并自动切换到中国区端点；需要其他区域或 Coding Plan 专用端点时使用“自定义”配置。
- 连接测试调用一次最小非流式 Chat Completion，不依赖官方文档未声明的 `/models` 接口。
- 正式请求发送 `thinking.type=enabled`、`thinking.clear_thinking=false`、`tool_stream=true`、`temperature=1`、`top_p=0.95`；会话五档思考强度映射为官方 `low/high/high/high/max`。
- 图片使用 `messages[].content[]` 的 `image_url` 块，支持 URL 或受控附件转换得到的 Base64 Data URL；物理路径和 Base64 不写入会话历史。
- 流式 Usage 的缓存命中原生字段为 `prompt_tokens_details.cached_tokens`，Adapter 归一化为 `cachedInputTokens` 供会话账本、Trace 与 UI 的缓存命中展示共用。
- 切换供应商时禁止复用原供应商的已保存 Key，必须由用户重新输入并通过连接测试。

### 4.3 OpenAI 后续独立 Adapter

OpenAI 使用官方 Responses API，属于后续扩展，不是 0.2.0 发布阻断项：

```ts
{
  id: 'openai',
  protocol: 'responses',
  status: 'planned',
  userConfigEnabled: false
}
```

启用前必须补齐 Responses 事件、response item、function call/output、Usage、取消、错误映射和真实联调门禁。OpenAI 与 DeepSeek 必须使用独立 Adapter；不能因为 DeepSeek 采用 OpenAI 风格的部分结构，就共享未经区分的流解析和消息映射。

0.2.0 及后续正式范围都不因 OpenAI 计划而自动支持自定义 OpenAI-compatible Endpoint，不提供自定义 Base URL、任意 Header 或第三方兼容服务配置。

### 4.4 MiMo 候选扩展

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

如果后续验证通过，应新增独立 MiMo Adapter、fixture 和能力快照，并通过当时正式 Adapter 相同的发布门禁。

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

DeepSeek 0.2.0 Adapter 进一步固定以下协议：

- 流请求必须发送 `stream_options.include_usage=true`。
- `[DONE]` 前只允许一个非空 Usage 块。优先接受官方约定的空 `choices` 附加块；兼容 DeepSeek 实际返回的纯终止 choice（存在非空 `finish_reason`，但 delta 不含正文、思考或工具调用）。普通增量中的 `usage: null` 不计为 Usage 块。
- `prompt_tokens`、`completion_tokens`、`total_tokens` 必须是非负安全整数，并满足 `total_tokens = prompt_tokens + completion_tokens`；不接受数字字符串或 `null` 转换。
- 缓存命中输入 token 按 Provider 的字段位置读取：DeepSeek 用 `prompt_cache_hit_tokens`，Z.AI GLM 用 `prompt_tokens_details.cached_tokens`；两者统一归一化为 `cachedInputTokens`，同时出现且取值不一致时整块 Usage 按矛盾值拒绝。
- 对话输入框与轨迹仪表盘的缓存命中率统一为当前会话 `ΣcachedInputTokens ÷ ΣtotalTokens`，其中 `totalTokens = promptTokens + completionTokens`；轨迹事件列表的最近记录数量不限制该累计口径。
- 缺失或无效 Usage 转成显式 `unavailable` 事实；重复非空块，或 Usage 与真实正文、思考、工具调用增量同块，属于协议错误，不采用“最后一个覆盖”。
- SDK/Core 对宿主只输出 `ProviderUsageFact`，因此会话账本、Trace 和 UI 数据源消费同一份 `provider` / `unavailable` 事实。

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
- 408、429、5xx 和网络中断仅重试当前模型步骤，最多三次尝试；默认指数退避 1 秒、2 秒，`Retry-After` 最多等待 10 秒。
- 重试前撤回当前步骤的未完成正文与思考增量，保留此前已完成步骤、工具回执和资源；不重放已执行工具。
- 流式格式异常或断流重试后仍失败时，最后一次使用非流式完整答复；完整校验全部工具参数后才交给调度器。
- 已输出的失败片段先撤回，不能把两次尝试的内容拼接成完整回复。
- 摘要请求复用同一退避和取消机制。重试耗尽后不把整个 Run 标记为可自动重放。
- 取消优先于重试；所有 fetch/SDK 调用必须接收同一个 AbortSignal。
- 重试记录 attempt、延迟、原因和 Provider request ID。
- 连接等待上限为 60 秒，流式读取空闲上限为 90 秒，非流式完整响应等待上限为 180 秒；持续输出不因整轮固定时间被切断。
- 收到完成标记即结束读取并释放连接；空回复、流内错误、半截工具调用、输出长度截断不得伪装成成功。

## 10. 配置与安全

- API Key 只以 Credential Reference 出现在 Provider 配置，实际值由 Desktop 安全存储端口按请求读取。
- Renderer、业务数据库、导出、Prompt、工具结果和 Trace 不保存 Key。
- DeepSeek 和 OpenAI 使用产品内置的官方 Endpoint，不接受用户自定义 Base URL、Authorization 模板或额外 Header。
- 联调 Mock Endpoint 只允许测试构建通过显式环境配置启用，不进入正式设置或持久化配置。
- Provider 请求默认拒绝跨域重定向，避免凭据被带到非预期 Endpoint。
- 文本与视觉 Provider 分开配置、授权和凭据引用，不默认共享 Key。

## 11. Provider 快照与切换

用户可以同时配置多个 Provider。Desktop Credential Store 使用版本化注册表分别保存每个 Provider 的加密 API Key、端点、默认模型和上下文参数；旧版单 Provider 文件在首次读取时映射到注册表，下一次保存时迁移为 v2，不删除原凭据。Renderer 只能读取脱敏的 Provider/模型目录，不能取得明文或密文 Key。

对话输入框的选择由 `{ provider, model }` 组成，并随会话助手状态持久化。Host 创建 Run 时必须把 Provider 和模型一起冻结；Kernel 的补全和压缩摘要均显式携带该 Provider，Adapter 按请求查找对应配置。禁止通过改变全局“当前 Provider”来实现对话切换，否则不同会话并发运行时可能把请求发往错误端点或串用凭据。切换只允许发生在新的 Run 边界，正在执行的工具链不受输入框后续选择影响。

每个 Run 冻结：

- Provider/Adapter ID 与协议版本。
- Base URL 的脱敏标识。
- 模型 ID 与能力快照。
- thinking 开关、会话级 reasoning effort、max output、tool schema 方言。
- Prompt 编译策略版本。

会话可以在完整 Run 边界切换模型；运行中或未完成工具链中不切换。模型下线时，新 Run 提示用户选择替代模型，不静默映射到另一个模型后继续高风险写入。

## 12. 契约与回归测试

每个已启用 Adapter 至少有：

- 请求 golden fixture：指令、多轮消息、单/多工具、工具结果、空正文。
- 流分片 fuzz：每个字节边界切块、多个 data 行、未知事件、畸形 JSON、提前 EOF。
- Usage fixture：完整、缺失、重复、缓存 token、矛盾值。
- 错误映射：401、403、429、400、5xx、timeout、cancel。
- 工具链回放：call ID、顺序、参数增量和 continuation 完整。
- 能力探测：不支持工具或 system 时在请求前拒绝。

外部联调测试使用显式环境开关，不在普通 CI 使用真实 Key。CI 以录制后脱敏的协议 fixture 和 mock server 为主。

DeepSeek 真实 Usage 门禁命令（PowerShell）如下；模型可通过 `AVERY_DEEPSEEK_MODEL` 覆盖：

```powershell
$env:AVERY_DEEPSEEK_LIVE = '1'
$env:DEEPSEEK_API_KEY = '<真实密钥>'
npm run test:vitest -- tests/integration/agent/deepseek-usage.integration.test.ts
```

未设置显式开关时用例必须显示为 skipped；设置开关但缺少 Key 时必须失败，不能将跳过误报为真实联调通过。

OpenAI 和 MiMo 在 `status` 不是 `active` 时可以保留设计 fixture，但不能进入用户设置、模型列表、ProviderSnapshot 或普通 CI 的“正式支持”矩阵。

## 13. 参考协议

设计时应以供应商官方文档为准，并在实现 Adapter 时固定校验日期与协议版本：

- [OpenAI Function calling](https://developers.openai.com/api/docs/guides/function-calling)
- [OpenAI Streaming responses](https://developers.openai.com/api/docs/guides/streaming-responses)
- [DeepSeek Tool Calls](https://api-docs.deepseek.com/guides/tool_calls)
- [DeepSeek Thinking Mode](https://api-docs.deepseek.com/guides/thinking_mode/)
- [DeepSeek Create Chat Completion（含流式 Usage）](https://api-docs.deepseek.com/api/create-chat-completion/)

## 14. 总结

Provider Adapter 是协议反腐层。它把各供应商的角色、流事件、工具调用、推理状态和 Usage 转成内部契约，但不拥有业务 Prompt、权限和 Loop 策略。0.2.0 只以 DeepSeek 为正式发布门禁；OpenAI 必须以后续独立 Responses Adapter 接入，MiMo 保持候选状态，二者都不能通过“兼容协议”绕过验证后提前展示。
