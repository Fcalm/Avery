# OfferGet Agent 设计总览

> 状态：v0.2 已通过 PM 复审；Runtime Reminder 与 Session 前缀快照已进入实现
> 更新时间：2026-08-27
> 适用范围：OfferGet 0.2.0 默认场景；0.3.0 网络能力边界与未来候选仅作版本化设计

## 1. 文档目标

本目录定义 OfferGet Agent 的运行时设计，回答六类问题：

1. [Loop](./01-loop.md)：一轮 Agent 如何运行、暂停、等待用户并恢复。
2. [System Prompt](./02-system-prompt.md)：提示词由哪些可信层组成，如何版本化。
3. [Tools](./03-tools.md)：场景白名单、Schema、权限、幂等、超时与并发调度。
4. [Context](./04-context.md)：上下文组成、预算、工具结果限长和压缩。
5. [Provider](./05-provider.md)：0.2.0 如何稳定支持 DeepSeek，并为 OpenAI 独立 Adapter 与 MiMo 候选扩展保留边界。
6. [Harness](./06-harness.md)：如何用模型之外的机制约束、验证和纠正 Agent。

专项开发规划：

- [Browser Tools 开发规划与进度](./07-browser-tools-development-plan.md)：`agent-browser` CLI、登录持久化、工具契约、安全边界、Harness、取消恢复、测试与发布进度。
- [Electron CDP 兼容性验证](./08-electron-cdp-compatibility-validation.md)：记录主进程 `WebContentsView` 的兼容性与越权风险，以及隔离 Electron 伴随进程的方案决定。
- [投递场景 Agent E2E 开发规划](./09-application-agent-e2e-development-plan.md)：本地多岗位测试站、真实表单控件、ScriptedProvider、AgentHost 完整链路与发布门禁。
- [投递 Agent 发布验证](./10-application-release-validation.md)：打包桌面/浏览器证据边界、DeepSeek 10 次评估运行器和真实招聘站人工安全门禁。
- [拟真浏览器 Agent 测评分支需求](./11-realistic-browser-evaluation-branch.md)：记录后续复杂 DOM、动态组件、安全干扰、可复现用例和测评指标需求；当前不开发。
- [Agent 测评系统开发规划](./12-agent-evaluation-system-development-plan.md)：定义开发者模式下的应用内测评控制台、Prompt/Browser Runner、多候选快照、评分、存储、页面和分阶段验收。

对应产品与总体架构依据：

- [PRD](../PRD.md)
- [ARCHITECTURE](../ARCHITECTURE.md)
- [项目重建计划](../PROJECT-RECONSTRUCTION-PLAN.md)
- [A-02 产品裁决](../rebuild/A-02-PM-DECISION-2026-08-20.md)
- [Agent ADR 索引](../architecture/decisions/README.md)

## 2. 核心结论

- Agent 不是一个无限 `while`；它是可持久化、可恢复、受预算约束的状态机。
- System Prompt 只表达指令，不承担权限控制。权限、确认和路径边界必须由 Harness 与工具端口强制执行。
- Session 首次使用时冻结稳定 Prompt/Context/Tool 前缀；每个 Run 引用该前缀并冻结数据范围、Provider/模型与预算。
- 工具调用先经过 Schema、语义、权限和副作用检查，再进入调度器；模型给出的工具名和参数都不可信。
- 等待用户输入或确认是正常运行状态，不是失败，也不是“返回一句话后猜测下轮会继续”。
- Context 是按 token 预算构建的派生视图；完整会话、工具回执和业务事实分别持久化，不能只保存发给模型的截断消息。
- Provider Adapter 负责协议差异，Loop 只消费统一事件；不得把所有供应商强行当作 OpenAI Chat Completions。
- Harness 是独立于模型的控制层。确定性规则优先，模型自检只能补充语义判断，不能授予权限。
- 一次点击发送创建一个 Run，不创建新 Session；场景切换才创建新 Session。
- 默认场景最多 30 个模型轮次，投递场景 100；Runtime Reminder 以 user 角色 append-only 注入。
- Session 前缀只在首次创建、满 24 小时后的下一次 Run 或 `/reload` 时重建，不设置独立 `ContextCacheEpoch`。

### 2.1 两个顶层场景

产品只设置两个顶层权限场景，简历优化、岗位定制和项目提炼等属于场景内意图，不再各自成为权限场景。网络岗位能力按版本单独启用，不能因 Prompt 或用户意图自动扩权：

| 版本/场景 | 核心能力 | 网络边界 |
| --- | --- | --- |
| 0.2.0 默认场景 `default` | 读写简历与档案；通过通用 UTF-8 文件工具读取授权文件；维护 Run Todo；结构化提问 | 不注册 `SearchJobs`、`ReadUrl`，不访问岗位 URL，不拥有任意 HTTP 或浏览器能力 |
| 0.3.0 默认场景候选 | 继承 0.2.0；用户显式提供 URL 时可调用受限 `ReadUrl` 生成预览 | `SearchJobs` 仍禁用；确认入库必须经过独立窄写入边界 |
| 投递场景 `application` | 读取简历/档案/授权文件，使用 12 个受控原子浏览器工具自主搜索、阅读 JD 和投递 | 不得写简历/档案，不开放 `SearchJobs`、原始 CLI、任意脚本或未经确认的高风险外部动作 |

默认场景坚持本地材料闭环，不开放岗位联网发现或 URL 提取。投递场景允许 Agent 通过受控浏览器自主搜索岗位、读取公开 JD，并在用户授权范围内填写和投递；它不能把页面内容当成指令、不能携带未授权文件或绕过最终外部动作确认。

`SearchJobs` 仅是未承诺版本的候选设计。启用前必须另行更新 PRD 和路线图，并通过来源白名单、SSRF、预算、取消、超时、脱敏、审计和站点条款专项验收。无界翻页、后台监控、周期搜索和持续全网爬取永久禁止。

投递场景已进入开发态：新会话可冻结独立的 Prompt、100 轮预算和 21 个工具白名单，并通过隔离浏览器执行原子动作；确定性本地 AgentHost E2E 与打包浏览器冒烟已通过，但 DeepSeek 10 次基线和真实站点发布门禁尚未通过，因此不能标记为正式开放。场景切换仍须新建会话，不能临时继承默认场景权限。

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
| `Run` | 一次点击发送创建，可暂停恢复 | 状态机、Todo、轮数、待交互、工具账本、结果 | 等待确认时仍是同一个逻辑 Run |
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

## 6. A-03 实现差距关闭记录

A-01 已为五包建立测试基线。统一等待、确认时重加锁、只读并发与写屏障、畸形 SSE 失败、完整 TurnGroup 和模块级 Ledger/Prompt 接口已经有绿色回归；A-03 不应无依据重写这些实现。

A-01 曾记录 6 条 `it.fails` 失败证据，并由只读集成审计发现 2 条宿主接线缺口。A-03 已逐项关闭下表 8 项差距；当前 Agent 测试不再保留预期失败用例：

| 当前缺口 | 风险 | A-03 目标 |
| --- | --- | --- |
| 0.2.0 生产场景/工具清单仍含网络草案，且执行入口未再次核对冻结白名单 | 发布范围越界；模型还可直接请求已注册但未授权的工具 | 0.2.0 只注册 12 个本地工具；`SearchJobs`/`ReadUrl` 标为禁用草案；Harness 按冻结快照拒绝未授权工具 |
| Run 取消完成后 Provider 迟到增量仍可能发出 | 已停止请求污染 UI、Trace 或其他会话 | 以 execution/run token 丢弃迟到事件，取消后 1 秒内保持唯一可见终态 |
| Prompt、工具白名单和数据范围未作为同一原子 Run 快照被宿主实际消费 | 重载或重启后产生混合版本请求 | 一次冻结并持久化 Scenario/Prompt/Tool/DataScope/Provider，Loop 只读取该快照 |
| 工具自身超时未中止底层操作 | 返回 timeout 后仍产生幽灵副作用 | 为单工具派生 AbortSignal/deadline；写入超时进入对账 |
| 默认 Observability 写入日志前未统一脱敏 | Key、Authorization 或绝对路径进入日志 | 在观测入口集中脱敏，并保留回归 fixture |
| “无需确认”模式尚未阻止含 `【待确认】` 的草稿直接写入 | 未确认推测内容进入正式简历 | Harness 强制保存待确认草稿并进入等待，文本确认后才能写入 |
| Tool Ledger 接口已存在，但生产 Host 尚未保证持久化端口和 Run 上下文全链路注入 | 重启后业务幂等退化为内存缓存 | 宿主强制注入持久化 Ledger；缺失时拒绝写工具而非降级执行 |
| Provider 已接受编译指令，但生产 Host 尚未把 Prompt Manifest 与工具策略哈希一起传入 | Provider 仍可能回退到内部 Prompt | Run 创建期编译并冻结 Prompt，Provider 不再拥有业务 Prompt 回退路径 |

**关闭证据（2026-08-20）**：0.2.0 活动工具已收窄为 12 个本地工具；Core 与工具模块双层校验冻结白名单；Provider/Tool 迟到事件被丢弃；Host 消费原子 Run 快照并注入持久化 Tool Ledger；单工具超时派生取消信号且写超时进入 `status_unknown`；Provider 强制接收编译 Prompt；Observability 入口统一脱敏；含 `【待确认】` 的草稿强制进入文本等待。根测试为 Vitest 45/45、Backend 8/8，全量构建通过。

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
10. 0.2.0 默认场景没有任何岗位网络工具；0.3.0 只允许用户明确 URL 对应的受限 `ReadUrl`；`SearchJobs` 在另行裁决前保持禁用，投递场景启用前不能创建 Run 或继承默认场景权限。
11. 错误必须结构化、可追踪；不得通过静默忽略、无界重试或扩大容错掩盖根因。

本节执行 [A-02 产品裁决](../rebuild/A-02-PM-DECISION-2026-08-20.md)。PRD 与路线图的版本措辞若尚未同步，以“0.2.0 无网络、0.3.0 仅用户 URL、未来发现未承诺、无界爬取永久禁止”为设计边界；不得据此提前实现网络能力。

## 8. 已裁决的第一版决策

以下值已由 PM 于 2026-08-20 裁决，并分别固化到 [Agent ADR](../architecture/decisions/README.md)：

| 决策 | 已裁决值 | ADR |
| --- | --- | --- |
| 岗位网络范围 | 0.2.0 无网络；0.3.0 仅用户明确 URL；未来发现未承诺 | [ADR-AGENT-001](../architecture/decisions/ADR-AGENT-001-versioned-job-network-scope.md) |
| 场景快照 | Session 冻结稳定 Prompt/Context/Tool 前缀；Run 冻结动态数据范围与 Provider 选择 | [ADR-AGENT-002](../architecture/decisions/ADR-AGENT-002-immutable-run-snapshot.md) |
| 默认压缩阈值 | 输入预算的 70%，场景只可降低 | [ADR-AGENT-003](../architecture/decisions/ADR-AGENT-003-context-budget-and-compaction.md) |
| 最近原文轮次 | 至少 5 个完整用户轮次及完整工具组 | [ADR-AGENT-003](../architecture/decisions/ADR-AGENT-003-context-budget-and-compaction.md) |
| 单 Run 模型子轮 | 默认场景 30；投递场景 100；最后一轮禁止新工具调用 | [ADR-AGENT-003](../architecture/decisions/ADR-AGENT-003-context-budget-and-compaction.md) |
| Schema 与确认 | 受限 JSON Schema 2020-12；等待不持锁，确认时重加锁校验 revision | [ADR-AGENT-004](../architecture/decisions/ADR-AGENT-004-tool-safety-and-correction.md) |
| 纠正重试 | 同错误指纹最多 1 次；Provider 瞬时错误仅输出前有界退避 | [ADR-AGENT-004](../architecture/decisions/ADR-AGENT-004-tool-safety-and-correction.md) |
| Provider | 0.2.0 DeepSeek；OpenAI 为后续独立 Adapter；MiMo 仅候选 | [ADR-AGENT-005](../architecture/decisions/ADR-AGENT-005-provider-rollout.md) |

## 9. 文档验收标准

- 六篇文档中的状态名、对象名、错误语义和场景清单一致。
- 每一项安全约束都能定位到一个非 Prompt 的执行点。
- 每种等待状态都有进入条件、持久化内容、恢复事件和过期策略。
- 每种工具副作用都有确认、幂等、并发、超时、取消与对账规则。
- 每种 Provider 差异都停留在 Adapter，不要求 Loop 写供应商分支。
- Harness 的验证用例可以转为单元、契约、集成、安全或 E2E 测试。

## 10. 总结

本设计把 Agent 拆为“状态机内核 + 可信控制层 + 可替换适配器”。Loop 负责推进，System Prompt 负责表达，Tools 负责受限行动，Context 负责预算内取证，Provider 负责协议翻译，Harness 负责真正的约束、验证与纠正。六部分必须共同工作，任何一部分都不能单独保证 Agent 安全或可靠。
