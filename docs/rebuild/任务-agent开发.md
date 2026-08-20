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

### A-01【P1 · 最先】agent 五包单元测试

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

### A-02【P1】产品决策支持与设计收敛

- **背景**：`docs/Agent-design/README.md` 的默认场景「自主岗位搜索」与 PRD「不自动扫描全网岗位、以用户 URL 为主」冲突，README 已标注「实现前必须更新 PRD，视为待上游确认」。
- **动作**：
  1. 向 PM 提交范围建议：区分「有界的按需岗位发现」（用户目标驱动、`SearchJobs`/`ReadUrl` 窄工具、Run 内临时数据）与「无界的持续全网爬取」（禁止），给出推荐边界与理由。
  2. PM 裁决后：同步修订 PRD（7.6 与 3.2 非目标）与 `docs/Agent-design/` 六篇文档，消除冲突；决策沉淀为 ADR。
  3. 同时按 README 第 8 节把已达成一致的决策（压缩阈值 70%、最近 5 个完整用户轮次、单 Run 子轮上限 12、Schema 方言、等待确认不持锁、首批 Provider DeepSeek+OpenAI、纠正重试上限）固化为 ADR 与实现约束。
- **验收**：PRD 与 Agent-design 无冲突；每项决策有 ADR（上下文/决策/替代方案/影响/回退）。
- **依赖**：PM 裁决（外部输入，本任务可先做第 3 项不依赖裁决的部分）。
- **建议窗口**：0.5–1 天 + 等待裁决。

### A-03【P2 · 长任务】Agent 实现差距修复（README 第 6 节清单）

- **背景**：README 第 6 节列出现状 8 项差距，均为风险项。按下列顺序推进（每项必须先在 A-01 中有测试前置）：
  1. 统一等待：所有等待（用户回答/写入确认）由 `RunDisposition` 驱动状态机，等待确认时不得继续请求模型；
  2. 锁策略：等待确认期间保存提案并释放锁；确认时重新加锁并校验 revision（不得在长等待/崩溃时阻塞用户编辑）；
  3. 并发调度：`isConcurrencySafe` 参与调度，DAG/资源键调度只读工具，写入与交互为屏障；
  4. 超时对账：工具接收 `AbortSignal`，超时后执行对账，消灭"返回超时后写操作仍完成"的幽灵副作用；
  5. 流解析：SSE 畸形块显式记录协议错误并失败，禁止静默忽略；
  6. 压缩边界：按完整 turn/tool group 压缩，不按消息条数硬切（当前 40 条截断会切断 tool call/result 配对）；
  7. 持久化幂等：写幂等用业务幂等键 + 持久化 Tool Ledger（当前内存 `sessionId + toolCallId` 重启即失效）；
  8. Prompt 归属：Prompt Compiler 在运行前生成 System Prompt，Provider 只做协议映射（当前 Provider 内部持有 Prompt，审计困难）。
- **验收**：每项有对应单测/集成测试与安全回归；不破坏 11 条跨文档不变量；README 第 6 节差距表逐项关闭并注明关闭提交。
- **依赖**：A-01（测试先立）、A-02（场景与权限裁决，涉及 1/2/3 项）、B-04（运行环境）。
- **建议窗口**：3–5 天（可与 A-04 的联调部分重叠）。

### A-04【P2】里程碑 G · agent 侧真实 Usage 联调

- **动作**：Provider Adapter 以 API 返回的 `usage` 为唯一权威（DeepSeek + OpenAI）；`prompt_tokens` 供 UI 展示完整上下文规模；未返回时标记 `unavailable` 并透传"未知"；MiMo 候选评估（验证通过才增加独立 Adapter，不得强行统一为 OpenAI 协议）。与 B-05（入库/Trace 对账）、F-05（UI 展示）三方对账。
- **验收**：真实请求后 UI、数据库、Trace 的 usage 数值一致；未返回 usage 时任何界面不得显示为真实值（验收次数 0）。
- **依赖**：A-01、B-04；A-02 的 Provider 范围决策。
- **建议窗口**：1 天（联调部分）。

## 3. 提交与协作约定

- 提交格式 `type(scope): 中文说明`；A-03 每项差距一个提交（如 `fix(agent-core): 统一等待经 RunDisposition 驱动`），每项提交必须带对应测试。
- 场景权限是硬边界：未进入白名单的工具即使模型请求也不得执行；确认只能批准已冻结且哈希匹配的提案。
- Provider 返回的 Usage 是用户展示与 Trace 的事实源；本地估算只用于压缩预判或明确标记的诊断值（ARCHITECTURE 6.4）。
- 与后端开发协作时，Agent 只能通过 Backend 拥有的窄端口执行；不新增 Shell、任意网络、任意路径读写等通用能力。
