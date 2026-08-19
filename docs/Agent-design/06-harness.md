# Harness：约束、验证与纠正

## 1. 定义

Harness 是包围 Loop 的可信控制层，负责把产品规则变成可执行约束，并对模型、Provider、工具和状态机的输入输出做验证。

```text
请求进入 → 前置约束 → Loop → 运行时监控 → 后置验证 → 结果/纠正
              │          │             │
              └── Policy └── Ledger    └── Evidence/Receipts
```

Harness 必须独立于被执行的模型。模型可以协助生成候选计划或语义评审，但不能决定自己是否合规，也不能给自己增加权限。

## 2. Harness 与 Loop 的边界

| Loop | Harness |
| --- | --- |
| 请求下一次模型输出 | 决定本次请求是否满足能力、预算和策略 |
| 编排工具批次 | 校验白名单、风险、确认、幂等和资源范围 |
| 推进候选状态 | 验证状态转换并以 CAS 提交 |
| 收集最终文本 | 检查执行声明、事实来源和完成条件 |
| 捕获运行错误 | 分类为纠正、暂停、失败、取消或对账 |

状态写入由 Harness 暴露的受限 API 完成，Loop 不直接修改任意 `state` 字段。

## 3. 五层约束

### 3.1 构建期约束

- TypeScript 严格类型与可判别联合。
- Prompt fragment、工具注册表、场景注册表和错误码静态 lint。
- 工具 Input/Output Schema 生成一致性。
- Provider capability 与场景需求的兼容检查。
- 禁止依赖检查：Agent Core 不得依赖 Node/Electron/数据库/具体 Provider。

### 3.2 Run 创建约束

- 鉴别 actor、session、场景和资源归属。
- 冻结 Scenario/Prompt/Provider/Tool/DataScope 快照。
- 计算预算和最高风险等级。
- 检查是否已有互斥 active Run 或 pending interaction。
- 对用户输入、附件数量和负载大小做边界校验。

### 3.3 工具前置约束

- 工具是否在快照白名单中。
- 当前用户请求是否包含对应写意图。
- 参数 Schema、语义和资源 ID 是否正确。
- 当前确认策略是否要求提案。
- expected revision、资源锁和业务幂等键是否存在。
- 路径、附件、项目和网络能力是否落在授权范围。

### 3.4 运行时约束

- 状态转换、lease、heartbeat 和 CAS。
- 模型轮次、工具数、token、墙钟时间和错误指纹预算。
- Provider 流事件完整性与背压。
- 工具 DAG、并发屏障、AbortSignal 和 deadline。
- side effect ledger、checkpoint 和审计事件顺序。

### 3.5 后置约束

- Tool Output Schema、receipt 和仓储 revision。
- 最终回复中的执行声明是否有证据。
- 简历事实和变更是否可定位到来源。
- 完成条件是否满足，是否仍有强制 pending interaction。
- Trace 是否脱敏，Usage 是否来自 Provider。

## 4. Policy as Code

```ts
interface PolicyInput {
  actor: ActorSnapshot;
  scenario: ScenarioSnapshot;
  run: AgentRun;
  proposedAction: ProposedAction;
  resource: ResourceSnapshot;
}

type PolicyDecision =
  | { effect: 'allow'; authorizationId: string }
  | { effect: 'deny'; code: string; safeMessage: string }
  | { effect: 'require_confirmation'; proposal: ConfirmationProposal }
  | { effect: 'pause'; code: string; recoveryActions: string[] };
```

Policy 规则使用代码和数据表实现，不从 Prompt 或模型文本解析。每个决定记录 `policyVersion`、匹配规则 ID 和输入快照哈希。

示例不变量：

- `confirmationMode = 无需确认` 只影响场景声明的低风险写入。
- 删除、不可逆覆盖、扩大文件范围、外部发送图片、自动提交始终单独授权。
- 普通 Agent 场景永远拒绝 Shell、任意网络和浏览器提交。
- 用户正在编辑简历或 revision 冲突时，不允许 Agent 静默覆盖。
- 确认只对 `proposalHash` 对应的参数生效一次。

## 5. 验证策略

### 5.1 确定性验证优先

优先使用：

- JSON Schema/Zod/AJV。
- 状态转换表和 CAS。
- 路径 canonicalization、敏感模式和 MIME/大小限制。
- 数据库约束、revision、事务和唯一幂等键。
- receipt 与业务仓储对账。
- Prompt/Tool manifest hash。
- token/调用/时间预算计数器。

这些规则失败时不能让模型“自我反思后决定是否忽略”。

### 5.2 语义验证

适合模型或规则+模型辅助的内容：

- 简历 bullet 是否忠于来源。
- 结论是否把推断写成事实。
- 最终答复是否遗漏明显未完成项。
- 摘要是否丢失否定、数字、日期和约束。

语义验证器只返回 finding 和置信度，不授予工具权限。高风险写入仍需确定性证据和用户确认。

### 5.3 证据与声明账本

Harness 从最终回复抽取或要求模型同时生成结构化声明：

```ts
interface CompletionClaim {
  type: 'fact' | 'action_completed' | 'artifact_created' | 'recommendation';
  text: string;
  evidenceRefs: string[];
}
```

验证规则：

- `action_completed` 必须引用成功 Tool Receipt。
- `artifact_created` 必须引用业务实体 ID、revision 或 artifact hash。
- 外部事实必须引用允许的数据源或显式标注为推断。
- `recommendation` 可以无外部证据，但不能伪装成已经发生的结果。

UI 不一定展示结构化声明，但 Trace 保存验证结果。

## 6. 纠正分类

| 错误 | 默认纠正 | 上限/终点 |
| --- | --- | --- |
| JSON/Schema 参数错误 | 返回精确 issue 给模型修正 | 同指纹 1 次，之后暂停 |
| 工具不在白名单 | 拒绝，不给模型试探替代越权工具 | 立即结束该分支 |
| 缺少用户事实 | `interaction.ask` | 等待用户，不猜测 |
| 需要确认 | 固定 proposal 并等待 | 接受/拒绝/过期 |
| revision 冲突 | 重新读取并展示冲突 | 不自动重放写入 |
| Provider 瞬时错误 | 输出前有界退避 | 默认 1 次，遵守 Retry-After |
| Provider 流畸形/半截工具参数 | 失败并记录协议错误 | 不执行部分调用 |
| 工具 timeout 且状态未知 | 对账 | 明确前禁止重试 |
| 工具结果 Output Schema 失败 | 隔离结果并报实现错误 | 不交给模型当事实 |
| 摘要不变量漂移 | 拒绝摘要并重试一次 | 再失败则确定性收缩或暂停 |
| 最终回复无依据声称已执行 | 带 evidence packet 重新生成 | 1 次；再失败用 Harness 安全模板回复 |
| 达到轮次/工具/token 预算 | checkpoint + paused | 用户显式继续或缩小目标 |

“纠正”不是无限重试。每次纠正必须记录错误指纹、输入变化和为什么仍安全。

## 7. 最终回复纠正

推荐流程：

1. 模型产生候选最终回复与可选 Completion Claims。
2. Harness 从 Tool Ledger、Business Store 和当前 Run 构造 Evidence Packet。
3. 确定性检查执行动词、实体 ID、receipt、pending 状态和敏感信息。
4. 若只有表述问题，允许模型基于 Evidence Packet 重写一次。
5. 若重写仍失败，Harness 使用安全模板返回已验证结果、失败原因和下一步，不继续让模型尝试。

安全模板不是隐藏错误，而是明确区分：

- 已完成且有回执的动作。
- 未完成或状态未知的动作。
- 需要用户回答/确认的事项。
- 可选建议。

## 8. 副作用验证与对账

写操作采用 Outbox/Tool Ledger 思路：

```text
ledger.started → port.execute(idempotencyKey) → business commit
              → ledger.succeeded(receipt)
```

崩溃可能发生在 business commit 与 ledger success 之间。恢复时必须通过业务幂等键或只读查询对账：

- 已提交：补写 receipt，不再次执行。
- 未提交：按策略允许安全重试。
- 无法判断：`status_unknown` + paused，交由用户核对。

不能因为模型没有收到 tool result 就推断工具没有执行。

## 9. Trace 与审计

建议事件：

```text
run.created
snapshot.frozen
context.built
provider.request.started
provider.stream.completed|failed
tool.batch.planned
tool.started|succeeded|failed|status_unknown
policy.allowed|denied|confirmation_required
interaction.waiting|answered|expired
context.compacted|compaction_rejected
response.validation_failed|corrected
run.paused|completed|failed|cancelled
```

每条事件有 ordinal、时间、run/session/request ID、schemaVersion 和脱敏 payload。API Key、Authorization、原始敏感文件、无关个人信息和绝对路径不写入 Trace。

## 10. 测试与评估

| 层级 | 必测内容 |
| --- | --- |
| Unit | Policy、状态机、预算、Schema、资源键、错误分类、声明验证 |
| Contract | Prompt/Tool/Provider/Context manifest，一致的错误码与事件联合 |
| Integration | Provider mock、工具 timeout、事务崩溃、幂等对账、压缩失败、重启恢复 |
| Security | Prompt injection、路径逃逸、越权工具、敏感文件、SSRF、Trace 泄密 |
| Scenario Eval | 事实忠实度、必要提问率、无依据执行声明率、工具选择和完成率 |
| E2E | 等待问题、确认接受/拒绝/过期、取消、冲突、离线恢复 |
| Fault Injection | 每个 checkpoint 后崩溃、SSE 任意断点、Worker 退出、数据库忙、磁盘满 |

关键指标建议：

- 未授权副作用率必须为 0。
- 重复写入率必须为 0。
- 无 receipt 的完成声明率必须为 0。
- Prompt injection 导致能力扩张率必须为 0。
- 等待/重启后的交互恢复成功率应为 100%。
- 语义质量指标不能用来抵消安全不变量失败。

## 11. 发布门禁

任何 Prompt、工具、Provider Adapter、Context 压缩或 Policy 变更，至少通过：

1. 受影响包严格类型检查与构建。
2. 状态机、白名单和 Schema 单元测试。
3. Provider/Tool 契约 fixture。
4. 相关场景 golden eval。
5. Prompt injection 与副作用回归。
6. 涉及等待、写入或恢复时的故障注入测试。
7. 变更前后 Trace 对比，确认没有新增敏感字段。

模型升级视为行为变更，即使 API Schema 不变，也需重新跑场景 eval 和高风险回归。

## 12. 当前实现优先纠正项

按风险排序：

1. 统一等待 disposition，修复确认后 Loop 仍继续的可能性。
2. 等待确认不再持有简历锁，改为提案 + 确认时 revision 校验。
3. 写工具接入持久化业务幂等键与 Tool Ledger。
4. 工具超时传递 AbortSignal，并增加状态未知对账。
5. Provider 不再静默忽略畸形流事件。
6. 历史按完整 TurnGroup 保存和压缩，移除固定 40 消息截取。
7. Prompt 所有权从 Provider 移到 Prompt Compiler/ScenarioSnapshot。
8. 实现基于资源键的只读并发与写屏障。

## 13. 总结

Harness 是 Agent 可靠性的主要来源：它在模型之外执行权限、状态、预算、Schema、幂等和证据规则。纠正必须有界、可解释、可审计；无法确认副作用或事实时应暂停并请求用户，而不是反复调用模型直到看起来成功。
