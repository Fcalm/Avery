# Agent 开发 · 重建任务

> 归属：`docs/rebuild/PROGRESS-2026-08-20.md` 下一步计划的执行分解
> 分工日期：2026-08-20
> 角色边界：`packages/contracts`（agent 相关部分）、`agent-sdk`、`agent-core`、`agent-module-host`、`agent-modules-defaults` 五个包的设计、实现与测试；Agent 设计文档（`docs/Agent-design/`）维护；Provider Adapter 与 Usage 语义。**不负责** Backend 业务仓储/进程层（见后端任务 B-*）。
> 顶层约束：`AGENTS.md`、`docs/Agent-design/README.md` 的跨文档不变量（11 条，任何实现不得破坏）、`docs/ARCHITECTURE.md` 6.4 Agent 规则。

## 1. 任务总览与顺序

```text
A-01 agent 五包单测（最先，依赖 B-03 骨架）──→ A-03 实现差距修复（长任务，按 8 项顺序）
        │                                            │
        └── A-02 产品决策支持与设计收敛（等 PM 裁决）──┘
                                                      │
                                          A-04 里程碑 G agent 侧联调
```

- A-01 先行（针对现状契约，不依赖产品决策）；A-02 的岗位搜索范围裁决是 A-03 部分项的前置，先裁决再动场景/权限实现；A-04 依赖 B-04（运行环境）与 F-04（联调环境）。

## 2. 任务清单

### A-01【P1 · 已完成】agent 五包单元测试

- **背景**：全仓库 0 测试；agent 相关包源码齐全但行为无回归防线。
- **动作**：为五包补单测，重点覆盖 `docs/Agent-design/README.md` 的跨文档不变量与六槽核心路径：
  - `agent-core`：RunAgentLoop 生命周期（`completed`/`failed`/`cancelled` 互斥终态，`waiting_*`/`paused` 可恢复）、取消与停止（停止后 1 秒内进入可见停止态，迟到事件不污染其他会话）、并发屏障、压缩熔断、工具调度（未入白名单的工具即使模型请求也不执行）。
  - `agent-sdk`：六槽接口契约、窄工具端口签名、Usage 事件类型（未返回时 `unavailable`，禁止估算冒充）。
  - `agent-module-host`：模块解析、版本校验、会话模块快照（不可变场景快照：Prompt/工具白名单/数据范围一起冻结）。
  - `agent-modules-defaults`：默认 Provider（协议映射、流解析、usage 归一）、context-builder（token 预算）、compaction（保留 System Prompt/工具定义/关键事实/未完成任务/最近对话；不改变权限与 `【待确认】` 标签）、interaction、observability（脱敏）。
  - `contracts`（agent 相关）：事件判别联合、错误码稳定性、写入 Schema。
- **验收**：五包单测绿；README 第 6 节列出的现状差距每项至少有一条失败可复现用例或回归用例；`npm test` 纳入统一门禁。
- **依赖**：B-03（Vitest 骨架与 `npm test` 接线）就绪后立即开始。
- **建议窗口**：2–3 天。

**执行记录（2026-08-20）**：

- 新增 `tests/unit/agent/` 五包测试矩阵，由根 Vitest 配置统一收集；`npm test` 已纳入并通过。
- 五包覆盖：
  - `contracts`：Agent 事件类型、Usage `unavailable`、稳定错误码、写命令幂等键/revision Schema、简历写 Schema；
  - `agent-sdk`：六槽顺序与映射、窄端口类型、Run 状态/Disposition、完整 TurnGroup 保留；
  - `agent-core`：互斥终态、等待后停止模型循环、只读并行与写屏障、1 秒内取消、压缩熔断、场景白名单差距；
  - `agent-module-host`：六槽解析、版本/SDK 校验、覆盖失败不回退、快照复制与冻结差距；
  - `agent-modules-defaults`：工具白名单、Prompt 事实规则、Context 转义、token 压缩阈值、确认时重加锁、持久化 Ledger 回放、Provider Prompt/流/Usage、SSE 协议错误与 Observability。
- README 第 6 节八项差距均有回归或失败证据：统一等待、确认锁、并发调度、超时取消、SSE 畸形块、完整 TurnGroup、持久化幂等、Prompt 所有权。
- 6 条尚未修复的约束使用 Vitest `it.fails` 固定，门禁当前保持绿色；生产实现修复后这些用例会因“意外通过”变红，要求开发者将其改成普通回归测试：
  1. 场景白名单外的已注册工具仍可能进入工具模块；
  2. 取消完成后迟到 Provider 增量仍可能发出；
  3. 会话模块快照尚未把 Prompt、工具白名单和数据范围作为同一原子快照冻结；
  4. 工具自身超时未中止底层 `AbortSignal`；
  5. 默认 Observability 记录日志前未统一脱敏；
  6. “无需确认”模式尚未阻止含 `【待确认】` 的简历草稿直接写入。
- 验证结果：Agent 定向测试 `5 files / 28 passed / 6 expected fail`；根 `npm test` 为 `11 files / 36 passed / 6 expected fail`，Backend 集成测试 `8/8`；测试类型检查与根 `npm run build` 均通过。

### A-02【P1 · 已完成】产品决策支持与设计收敛

- **背景**：`docs/Agent-design/README.md` 的默认场景「自主岗位搜索」与 PRD「不自动扫描全网岗位、以用户 URL 为主」冲突，README 已标注「实现前必须更新 PRD，视为待上游确认」。
- **动作**：
  1. 向 PM 提交范围建议：区分「有界的按需岗位发现」（用户目标驱动、`SearchJobs`/`ReadUrl` 窄工具、Run 内临时数据）与「无界的持续全网爬取」（禁止），给出推荐边界与理由。
  2. PM 裁决后：同步修订 PRD（7.6 与 3.2 非目标）与 `docs/Agent-design/` 六篇文档，消除冲突；决策沉淀为 ADR。
  3. 同时按 README 第 8 节把已达成一致的决策（压缩阈值 70%、最近 5 个完整用户轮次、单 Run 子轮上限 12、Schema 方言、等待确认不持锁、首批 Provider DeepSeek+OpenAI、纠正重试上限）固化为 ADR 与实现约束。
- **验收**：PRD 与 Agent-design 无冲突；每项决策有 ADR（上下文/决策/替代方案/影响/回退）。
- **依赖**：PM 裁决（外部输入，本任务可先做第 3 项不依赖裁决的部分）。
- **建议窗口**：0.5–1 天 + 等待裁决。

**PM 裁决（2026-08-20）**：已完成，详见 `docs/rebuild/A-02-PM-DECISION-2026-08-20.md`。

- 0.2.0 不开放 `SearchJobs`/`ReadUrl`；岗位继续手动录入。
- 0.3.0 只允许用户提供 URL 后由受限 `ReadUrl` 提取，预览确认后入库；不开放 `SearchJobs`。
- 有界按需发现仅为未来候选，需另行更新路线图并通过网络安全门禁；无界持续全网爬取永久禁止。
- Agent 开发下一步只做 PRD、六篇 Agent-design 文档与 ADR 收敛；审查通过后再开始 A-03，不在 A-02 修改生产代码。

**PM 复审（2026-08-20）**：通过并关闭。PRD、路线图、六篇 Agent 设计文档和五份 ADR 已一致；允许进入 A-03。详见 `docs/rebuild/A-02-F-04-REVIEW-2026-08-20.md`。

### A-03【P2 · 代码复审通过，待提交拆分】Agent 实现差距修复（README 第 6 节清单）

- **背景**：README 第 6 节列出现状 8 项差距，均为风险项。统一等待、确认重加锁、并发屏障、SSE 失败与完整 TurnGroup 已有绿色回归，不重复改写。按下列顺序推进（每项先复现现有失败证据；缺少失败证据时先补测试）：
  1. 0.2.0 工具清单与执行白名单：只注册 12 个本地工具，禁用 `SearchJobs`/`ReadUrl`，执行入口按冻结快照拒绝未授权工具；
  2. 取消迟到事件：以 execution/run token 丢弃取消完成后的 Provider 增量；
  3. 原子 Run 快照：Prompt、工具白名单、数据范围、确认策略和 Provider 能力一次冻结并持久化；
  4. 工具超时取消：向底层传递 `AbortSignal`/deadline，写超时进入对账；
  5. Observability 脱敏：在统一入口过滤 Key、Authorization 与绝对路径；
  6. 待确认草稿：即使“无需确认”，含 `【待确认】` 的草稿也必须进入文本确认；
  7. 持久化 Tool Ledger：生产 Host 缺少持久化端口时拒绝写工具，不退化到进程内幂等；
  8. Prompt Manifest 接线：生产 Host 在 Run 创建期编译并冻结 Prompt，Provider 不保留业务 Prompt 回退路径。
- **验收**：每项有对应单测/集成测试与安全回归；不破坏 11 条跨文档不变量；README 第 6 节差距表逐项关闭并注明关闭提交。
- **依赖**：A-01（测试先立）、A-02（场景与权限裁决，涉及 1/2/3 项）、B-04（运行环境）。
- **建议窗口**：3–5 天（可与 A-04 的联调部分重叠）。

**执行记录（2026-08-20）**：8 项差距均已落地，且未启用 `SearchJobs`、联网 `ReadUrl` 或投递场景。A-01 的 6 条 `it.fails` 已全部转为普通回归测试，并补充写超时 `status_unknown`、缺失持久化 Ledger 拒绝写入、未启用网络工具直接调用拒绝等用例。验证结果：Vitest 45/45、Backend 8/8、`npm run build` 全量通过。当前处于代码复审阶段，复审通过前不进入 A-04。

**PM 代码复审（2026-08-21）**：请求修改。Provider 忽略 AbortSignal 并在取消后返回 completion 时，Kernel 仍可能记录 Usage、写历史并进入工具执行；工具入口对“进入时已取消”也未直接短路。须补迟到 completion/tool call 回归并关闭此竞态。提交 `007be26` 还混合了多项 A-03 安全边界与 Usage 对账，合并前须按逻辑拆分。详见 `docs/rebuild/A-03-G-CODE-REVIEW-2026-08-21.md`。

**PM 整改重审（2026-08-21）**：代码通过。Kernel completion 后取消门禁、工具入口已取消短路及迟到写工具 completion 回归均符合要求；Agent 定向测试 46/46、根 TypeScript 与 `git diff --check` 通过。剩余工作仅为合并前按八项安全边界与 Usage 逻辑拆分 `007be26`，拆分后无需再次进行功能代码审查。

### A-04【P2】里程碑 G · agent 侧真实 Usage 联调

- **动作**：0.2.0 以 DeepSeek Adapter 返回的 `usage` 为唯一权威；`prompt_tokens` 供 UI 展示完整上下文规模；未返回时标记 `unavailable` 并透传"未知"。OpenAI 为后续独立 Adapter，MiMo 仅为候选，均不作为 0.2.0 阻断项。与 B-05（入库/Trace 对账）、F-05（UI 展示）三方对账。
- **验收**：真实请求后 UI、数据库、Trace 的 usage 数值一致；未返回 usage 时任何界面不得显示为真实值（验收次数 0）。
- **依赖**：A-01、B-04；A-02 的 Provider 范围决策。
- **建议窗口**：1 天（联调部分）。

**执行记录（2026-08-21，Agent 侧实现完成，真实凭据验收待执行）**：

- SDK/Core 将每次已完成模型请求统一转换为 `ProviderUsageFact`；完整且自洽的 Provider 数值标记为 `provider`，缺失或无效值显式标记为 `unavailable`，不再用 `undefined` 表达跨模块语义。
- DeepSeek 流请求固定发送 `stream_options.include_usage=true`；Adapter 只接受非负安全整数且满足 `total_tokens = prompt_tokens + completion_tokens` 的唯一 Usage 块。Usage 可位于空 `choices` 附加块或无正文/思考/工具增量的纯终止 choice；重复块及 Usage 与真实增量混合仍按协议错误拒绝。数字字符串、`null` 和矛盾总数不得进入账本。
- AgentHost 使用同一 Usage 事实同时更新会话展示源、`agent-state.json` 和 Trace `provider_usage`；Mock 集成对账已验证三处均为 `11 / 7 / 18`。ObservabilityStore 同步收紧等式校验，`unavailable` 只允许零值。
- 新增真实 DeepSeek 门禁：仅当 `AVERY_DEEPSEEK_LIVE=1` 且提供 `DEEPSEEK_API_KEY` 时执行，普通 CI 不消耗额度。当前环境无 Key，因此该用例按设计跳过，不能据此宣称“真实请求三方对账”验收完成。
- 自动化验证：`npm test` 通过（Vitest 57 passed、1 个真实联调用例 skipped；Backend 8/8）。A-04 保持未关闭，待有效凭据执行真实门禁并由 F-05 复核 UI 后再完成里程碑 G。

## 3. 提交与协作约定

- 提交格式 `type(scope): 中文说明`；A-03 每项差距一个提交（如 `fix(agent-core): 统一等待经 RunDisposition 驱动`），每项提交必须带对应测试。
- 场景权限是硬边界：未进入白名单的工具即使模型请求也不得执行；确认只能批准已冻结且哈希匹配的提案。
- Provider 返回的 Usage 是用户展示与 Trace 的事实源；本地估算只用于压缩预判或明确标记的诊断值（ARCHITECTURE 6.4）。
- 与后端开发协作时，Agent 只能通过 Backend 拥有的窄端口执行；不新增 Shell、任意网络、任意路径读写等通用能力。
