# ADR-AGENT-005：Provider 独立适配与发布顺序

> 状态：已接受
>
> 决策日期：2026-08-20
>
> 实现授权：无；0.2.0 不因本文新增 Provider 代码

## 上下文

DeepSeek 使用官方 Chat Completions 风格协议，OpenAI 的目标协议是 Responses API，两者的事件、工具调用、推理状态和 Usage 语义并不等价。用“OpenAI-compatible”抽象强行复用会把差异泄漏到 Loop，并导致错误的流解析或 Usage。当前版本目标是恢复稳定基线，不应让新增供应商阻塞 0.2.0。

## 决策

1. 0.2.0 只以现有 DeepSeek Adapter 的稳定性作为正式发布门禁，使用官方 Endpoint。
2. OpenAI 是后续独立 Adapter，目标为官方 Responses API；未完成请求/流/工具/Usage/错误 fixture 和真实联调前，`status = planned`、不在设置中启用，也不阻塞 0.2.0。
3. MiMo 只作为候选评估，验证通过后新增独立 Adapter；不能借“OpenAI-compatible”直接复用 DeepSeek 或 OpenAI Adapter。
4. 不支持自定义 Base URL、任意 Header 或第三方 OpenAI-compatible Endpoint。测试 Mock 只在显式测试构建中启用。
5. Provider 只做协议映射。业务 Prompt 由 Run 创建期编译并通过 Prompt Manifest 传入；Usage 缺失保持 `unavailable`，不以估算补零。

## 替代方案

- **0.2.0 同时正式支持 DeepSeek 与 OpenAI**：增加发布阻断面，不符合恢复基线目标，否决。
- **统一 OpenAI-compatible Adapter**：隐藏关键协议差异，否决。
- **永远只支持 DeepSeek**：简单但限制后续扩展，不采用。
- **开放自定义 Endpoint/Header**：扩大凭据和 SSRF 风险，当前范围否决。

## 影响

正面影响：

- 0.2.0 发布门禁清晰，避免未完成 Adapter 造成假支持。
- Loop 只消费规范事件，不增加供应商分支。
- OpenAI/MiMo 可以按各自官方协议独立测试和回退。

负面影响：

- 0.2.0 用户只能使用 DeepSeek。
- 独立 Adapter 会有部分重复映射代码和 fixture 成本。
- 旧“自定义兼容服务”配置需要迁移或明确拒绝。

## 迁移

1. 将 Provider Registry 增加 `active/planned/candidate` 状态，0.2.0 只返回 DeepSeek。
2. 删除生产设置中的自定义 Endpoint/Header 入口；保留测试专用 Mock 注入。
3. 后续 OpenAI Adapter 使用独立包或模块、协议 fixture 和能力快照。
4. MiMo 评估结果单独记录，未通过不得进入正式模型列表。

## 回退

若 DeepSeek Adapter 出现发布阻断，产品进入明确的 Provider 不可用状态，不静默切换到计划中 Adapter。后续 OpenAI/MiMo 上线后若发生协议回归，可按 Provider Registry 禁用对应 Adapter；既有 Run 使用冻结快照进入 `paused`，用户在完整 Run 边界选择仍受支持的 Provider。
