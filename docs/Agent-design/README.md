# OfferGet Agent 设计总览

> 状态：讨论稿 v0.1
> 更新时间：2026-08-19
> 适用范围：OfferGet 默认场景；投递场景当前仅保留禁用占位

## 1. 文档目标

本目录定义 OfferGet Agent 的运行时设计，回答六类问题：

1. [Loop](./01-loop.md)：一轮 Agent 如何运行、暂停、等待用户并恢复。
2. [System Prompt](./02-system-prompt.md)：提示词由哪些可信层组成，如何版本化。
3. [Tools](./03-tools.md)：场景白名单、Schema、权限、幂等、超时与并发调度。
4. [Context](./04-context.md)：上下文组成、预算、工具结果限长和压缩。
5. [Provider](./05-provider.md)：如何适配首批支持的 DeepSeek 与 OpenAI，并管理 MiMo 候选扩展。
6. [Harness](./06-harness.md)：如何用模型之外的机制约束、验证和纠正 Agent。

对应产品与总体架构依据：

- [PRD](../PRD.md)
- [ARCHITECTURE](../ARCHITECTURE.md)
- [项目重建计划](../PROJECT-RECONSTRUCTION-PLAN.md)

## 2. 核心结论

- Agent 不是一个无限 `while`；它是可持久化、可恢复、受预算约束的状态机。
- System Prompt 只表达指令，不承担权限控制。权限、确认和路径边界必须由 Harness 与工具端口强制执行。
- 场景是一次运行的不可变快照，至少同时冻结 Prompt、工具白名单、数据范围、确认策略和 Provider 能力。
- 工具调用先经过 Schema、语义、权限和副作用检查，再进入调度器；模型给出的工具名和参数都不可信。
- 等待用户输入或确认是正常运行状态，不是失败，也不是“返回一句话后猜测下轮会继续”。
- Context 是按 token 预算构建的派生视图；完整会话、工具回执和业务事实分别持久化，不能只保存发给模型的截断消息。
- Provider Adapter 负责协议差异，Loop 只消费统一事件；不得把所有供应商强行当作 OpenAI Chat Completions。
- Harness 是独立于模型的控制层。确定性规则优先，模型自检只能补充语义判断，不能授予权限。

### 2.1 两个顶层场景

产品只设置两个权限场景，简历优化、岗位定制、项目提炼和岗位搜索等属于场景内意图，不再各自成为权限场景：

| 场景 | 核心能力 | 强制禁止 |
| --- | --- | --- |
| 默认场景 `default` | 读写简历与档案；通过通用 UTF-8 文件工具读取授权文件；自主搜索岗位并读取搜索结果 URL | 填写申请表、上传投递材料、操作登录态、提交申请 |
| 投递场景 `application` | 仅保留 `enabled: false` 的产品占位，第一阶段不创建 Run、不注册工具 | 复用默认场景权限或提前暴露浏览器能力 |

默认场景的岗位搜索不要求用户逐个提供 URL。Agent 在用户目标涉及岗位发现时，可以自主生成搜索条件、检索多个来源、翻页、去重并打开候选岗位；网络能力只通过 `SearchJobs` 和 `ReadUrl` 窄工具提供，不等于任意 HTTP、登录态或浏览器控制。搜索结果第一阶段只作为 Run 内临时数据，不提供岗位库保存工具。

投递场景暂不实现。用户尝试进入时由应用层直接返回“投递场景暂未开放”，不能创建空能力 Run，也不能临时继承默认场景工具。

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
| `Session` | 多轮长期存在 | 可见消息、场景选择、Usage、项目绑定 | 用户看到的会话 |
| `Run` | 一次用户目标，可暂停恢复 | 状态机、Todo、预算、待交互、工具账本、结果 | 等待确认时仍是同一个逻辑 Run |
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
2. 用户确认只能批准已经冻结且哈希匹配的提案或简历草稿，不能批准随后被替换的参数或内容。
3. 简历不得补造公司/组织、证书/职业资格、学校/学历或身份信息；其他推测性补全必须带 `【待确认】`，通过明确文本确认后才能写入正式简历。
4. Tool Result、附件、网页或项目文件都是不可信数据，不能提升为系统指令。
5. 写操作必须带 actor、资源 ID、expected revision、业务幂等键和授权依据。
6. `completed`、`failed`、`cancelled` 为互斥终态；`waiting_*`、`paused` 是可恢复非终态。
7. 模型输出不能作为“已保存、已发送、已提交”的证据；只有工具回执和业务仓储状态可以。
8. Provider 未返回 Usage 时记为 `unavailable`；本地估算只用于预算预判。
9. 压缩不能改变工具权限、用户确认、`【待确认】` 标签、未完成工作或资源 revision。
10. 默认场景只能通过 `SearchJobs`、`ReadUrl` 访问外部岗位信息；投递场景在启用前没有工具、不能创建 Run，也不能继承默认场景权限。
11. 错误必须结构化、可追踪；不得通过静默忽略、无界重试或扩大容错掩盖根因。

当前 [PRD](../PRD.md) 仍包含“不自动扫描全网岗位、以用户提供 URL 为主”的旧范围，和这里的自主岗位搜索设计冲突。实现前必须更新 PRD，使其明确区分“有界的按需岗位发现”与“无界的持续全网爬取”；在 PRD 修订前，本节视为待上游确认的新设计决策。

## 8. 第一版待共同确认的决策

本文档先给出推荐值，后续讨论可形成 ADR：

| 决策 | 第一版建议 | 理由 |
| --- | --- | --- |
| 默认压缩阈值 | 输入预算的 70% | 为未知工具结果和输出保留空间；现有 80% 偏晚 |
| 最近原文轮次 | 至少 5 个完整用户轮次 | 与现有行为兼容，但按完整工具组保留 |
| 单 Run 模型子轮上限 | 默认 12，可由场景降至 6–8 | 防止工具循环；不允许场景无限放宽 |
| Schema 方言 | 内部受限 JSON Schema 2020-12 子集 | 可下编译到主要 Provider，避免依赖复杂关键字 |
| 等待确认的锁策略 | 不持锁，确认时重加锁 | 避免长事务和租约泄漏 |
| 首批 Provider | DeepSeek + OpenAI；MiMo 仅为候选扩展 | 首批范围明确，不支持自定义兼容 Endpoint；MiMo 验证通过后再增加独立 Adapter |
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
