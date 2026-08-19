# OfferGet Agent 设计总览

> 状态：讨论稿 v0.1
> 更新时间：2026-08-19
> 适用范围：OfferGet 求职助手 Agent，不包含自动化投递执行器

## 1. 文档目标

本目录定义 OfferGet Agent 的运行时设计，回答六类问题：

1. [Loop](./01-loop.md)：一轮 Agent 如何运行、暂停、等待用户并恢复。
2. [System Prompt](./02-system-prompt.md)：提示词由哪些可信层组成，如何版本化。
3. [Tools](./03-tools.md)：场景白名单、Schema、权限、幂等、超时与并发调度。
4. [Context](./04-context.md)：上下文组成、预算、工具结果限长和压缩。
5. [Provider](./05-provider.md)：如何适配 DeepSeek、OpenAI、Anthropic、Gemini 与自定义服务。
6. [Harness](./06-harness.md)：如何用模型之外的机制约束、验证和纠正 Agent。

对应产品与总体架构依据：

- [PRD](../docs/PRD.md)
- [ARCHITECTURE](../docs/ARCHITECTURE.md)
- [项目重建计划](../docs/PROJECT-RECONSTRUCTION-PLAN.md)

## 2. 核心结论

- Agent 不是一个无限 `while`；它是可持久化、可恢复、受预算约束的状态机。
- System Prompt 只表达指令，不承担权限控制。权限、确认和路径边界必须由 Harness 与工具端口强制执行。
- 场景是一次运行的不可变快照，至少同时冻结 Prompt、工具白名单、数据范围、确认策略和 Provider 能力。
- 工具调用先经过 Schema、语义、权限和副作用检查，再进入调度器；模型给出的工具名和参数都不可信。
- 等待用户输入或确认是正常运行状态，不是失败，也不是“返回一句话后猜测下轮会继续”。
- Context 是按 token 预算构建的派生视图；完整会话、工具回执和业务事实分别持久化，不能只保存发给模型的截断消息。
- Provider Adapter 负责协议差异，Loop 只消费统一事件；不得把所有供应商强行当作 OpenAI Chat Completions。
- Harness 是独立于模型的控制层。确定性规则优先，模型自检只能补充语义判断，不能授予权限。

## 3. 边界与数据流

```text
用户 / UI
   │  command、answer、confirm、cancel
   ▼
Harness ── 冻结 ScenarioSnapshot、鉴权、预算、状态转换、审计
   │
   ▼
Loop ───── 编排 Context → Provider → Tool Scheduler → Checkpoint
   │                │             │
   │                │             └── Tool Ports（再次鉴权、事务、revision）
   │                └── Provider Adapter（协议映射、流解析、usage）
   └── Run Event Stream → Harness 验证 → UI
```

依赖方向：

```text
Agent Core → Agent SDK contracts
Backend Host → Harness → Agent Core
Provider Adapters / Tool Modules / Context Builder → Agent SDK contracts
Infrastructure → Backend-owned narrow ports
```

## 4. 三种状态必须分开

| 对象 | 生命周期 | 保存内容 | 说明 |
| --- | --- | --- | --- |
| `Session` | 多轮长期存在 | 可见消息、场景选择、Usage、项目绑定、任务 | 用户看到的会话 |
| `Run` | 一次用户目标，可暂停恢复 | 状态机、预算、待交互、工具账本、结果 | 等待确认时仍是同一个逻辑 Run |
| `Execution` | 一段实际进程执行 | lease、abort signal、stream cursor、attempt | 应用重启或恢复会产生新的 Execution |

不能用“请求 Promise 是否还在”表示 Run 是否运行。等待用户数小时、进程崩溃或应用重启后，Run 仍必须能从 checkpoint 恢复。

## 5. 与现有六槽模块的关系

现有源码的六槽是模块装配方式，本目录的六部分是运行时关注点，两者不是一一同名：

| 现有代码 | 本设计归属 |
| --- | --- |
| `agent-core/RunAgentLoop` | Loop + Harness 状态转换 |
| `model-provider` | Provider；Prompt 所有权迁出 Provider |
| `context-builder` | Context |
| `compaction` | Context，重试与熔断归 Loop/Harness |
| `tools` | Tools |
| `interaction` | Loop 的等待/恢复 + Tools 的交互工具 |
| `observability` | Harness 的审计与验证证据 |
| `prompts.ts` | System Prompt |

建议保留六槽兼容接口完成重建，但目标实现逐步把跨槽策略上移到 Harness，避免 Provider 或 Tool Module 自行决定全局行为。

## 6. 当前实现必须正视的差距

以下不是要求立即在本轮文档任务中改代码，而是后续实现的优先风险：

| 现状 | 风险 | 目标修正 |
| --- | --- | --- |
| 确认只由部分工具返回 `awaitingUser` | 确认卡出现后 Loop 仍可能继续请求模型 | 所有等待通过统一 `RunDisposition` 驱动状态机 |
| 等待确认期间持有简历锁 | 长等待、崩溃或重启会阻塞用户编辑 | 保存提案并释放锁；确认时重新加锁和校验 revision |
| 工具当前全部串行，`isConcurrencySafe` 未参与调度 | 无法兑现并发设计，也没有真正的并发屏障 | 由 DAG/资源键调度只读工具，写入与交互是屏障 |
| 超时使用 `Promise.race`，未取消底层执行 | 返回超时后写操作仍可能完成，产生幽灵副作用 | 工具必须接收 `AbortSignal`，超时后执行对账 |
| SSE 畸形块被静默忽略 | 工具参数或正文可能损坏却被当作成功 | 记录协议错误并失败；只允许显式、可证明安全的兼容处理 |
| 历史以最后 40 条消息截取 | 可能切断 assistant tool call 与 tool result 配对 | 按完整 turn/tool group 压缩，不按消息条数硬切 |
| 写幂等仅用内存中的 `sessionId + toolCallId` | 重启后失效，Provider 重试也可能换 ID | 使用业务幂等键和持久化 Tool Ledger |
| Provider 内部持有 System Prompt | Prompt、Context 和协议耦合，难以审计快照 | Prompt Compiler 在运行前生成，Provider 只做协议映射 |

## 7. 跨文档不变量

任何实现均不得破坏以下规则：

1. 未进入场景白名单的工具，即使模型请求也不得执行。
2. 用户确认只能批准确认卡中固定展示的提案哈希，不能批准随后被替换的参数。
3. Tool Result、附件、网页或项目文件都是不可信数据，不能提升为系统指令。
4. 写操作必须带 actor、资源 ID、expected revision、业务幂等键和授权依据。
5. `completed`、`failed`、`cancelled` 为互斥终态；`waiting_*`、`paused` 是可恢复非终态。
6. 模型输出不能作为“已保存、已发送、已提交”的证据；只有工具回执和业务仓储状态可以。
7. Provider 未返回 Usage 时记为 `unavailable`；本地估算只用于预算预判。
8. 压缩不能改变工具权限、用户确认、事实来源、未完成任务或资源 revision。
9. 自动化投递是独立状态机；普通 Agent 工具不得拥有浏览器提交或任意网络能力。
10. 错误必须结构化、可追踪；不得通过静默忽略、无界重试或扩大容错掩盖根因。

## 8. 第一版待共同确认的决策

本文档先给出推荐值，后续讨论可形成 ADR：

| 决策 | 第一版建议 | 理由 |
| --- | --- | --- |
| 默认压缩阈值 | 输入预算的 70% | 为未知工具结果和输出保留空间；现有 80% 偏晚 |
| 最近原文轮次 | 至少 5 个完整用户轮次 | 与现有行为兼容，但按完整工具组保留 |
| 单 Run 模型子轮上限 | 默认 12，可由场景降至 6–8 | 防止工具循环；不允许场景无限放宽 |
| Schema 方言 | 内部受限 JSON Schema 2020-12 子集 | 可下编译到主要 Provider，避免依赖复杂关键字 |
| 等待确认的锁策略 | 不持锁，确认时重加锁 | 避免长事务和租约泄漏 |
| 首批 Provider | DeepSeek 原生 + 自定义 OpenAI-compatible；预留 OpenAI/Anthropic/Gemini Adapter | 先满足产品现状，同时避免内核绑定 |
| 纠正重试 | 同类错误最多 1 次；Provider 瞬时错误有界退避 | 防止“反复试到成功”掩盖权限或数据问题 |

## 9. 文档验收标准

- 六篇文档中的状态名、对象名、错误语义和场景清单一致。
- 每一项安全约束都能定位到一个非 Prompt 的执行点。
- 每种等待状态都有进入条件、持久化内容、恢复事件和过期策略。
- 每种工具副作用都有确认、幂等、并发、超时、取消与对账规则。
- 每种 Provider 差异都停留在 Adapter，不要求 Loop 写供应商分支。
- Harness 的验证用例可以转为单元、契约、集成、安全或 E2E 测试。

## 10. 总结

本设计把 Agent 拆为“状态机内核 + 可信控制层 + 可替换适配器”。Loop 负责推进，System Prompt 负责表达，Tools 负责受限行动，Context 负责预算内取证，Provider 负责协议翻译，Harness 负责真正的约束、验证与纠正。六部分必须共同工作，任何一部分都不能单独保证 Agent 安全或可靠。
