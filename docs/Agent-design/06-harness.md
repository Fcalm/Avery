# Harness：约束、验证与纠正

## 1. 定义

Harness 是包围 Loop 的可信控制层，负责把产品规则变成可执行约束，并对模型、Provider、工具和状态机的输入输出做验证。

```text
请求进入 → 前置约束 → Loop → 运行时监控 → 后置验证 → 结果/纠正
              │          │             │
              └── Policy └── Ledger    └── Checks/Receipts
```

Harness 必须独立于被执行的模型。模型可以协助生成候选计划或语义评审，但不能决定自己是否合规，也不能给自己增加权限。

## 2. Harness 与 Loop 的边界

| Loop | Harness |
| --- | --- |
| 请求下一次模型输出 | 决定本次请求是否满足能力、预算和策略 |
| 编排工具批次 | 校验白名单、风险、确认、幂等和资源范围 |
| 推进候选状态 | 验证状态转换并以 CAS 提交 |
| 收集最终文本 | 检查执行状态、待确认标签和完成条件 |
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
- 最终回复中的执行声明是否与 Run 状态和 Tool Receipt 一致。
- 新增公司、证书、学校/学历或身份信息是否触发纠正。
- 推测性补全是否在所属条目末尾保留 `【待确认】`。
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

确认权限只有三档：

- `always_confirm`：所有会产生外部修改的工具均等待确认。
- `allow_low_risk`：只有注册表标记为 low risk 的操作可免确认；medium/high 仍等待。
- `fully_trusted`：在现有场景白名单和资源授权内免除普通确认。UI 必须先展示警告并让用户显式确认切换。

示例不变量：

- 三档权限只改变“是否等待确认”，不增加工具、路径、数据范围、账号或网络权限。
- 删除、不可逆覆盖、扩大文件范围、外部发送图片、自动提交始终单独授权。
- 0.2.0 默认场景永远拒绝 `SearchJobs`、`ReadUrl`、Shell、任意网络和浏览器投递；全局草案注册表中存在名称或 Schema 也不构成授权。
- 0.3.0 只有版本化场景快照明确启用、URL 来自当前用户消息且网络策略通过时才允许 `ReadUrl`；`SearchJobs` 继续拒绝。
- 未来 `SearchJobs` 必须经过新的产品裁决与网络安全门禁；后台、周期、无界发现永久拒绝。
- 投递场景使用独立冻结白名单：可以创建 Run，但不能复用默认场景的简历/档案写权限；浏览器外部动作仍受 proposal、确认与 receipt 约束。
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

### 5.2 简历内容的轻量验证

简历目标是在用户已有经历边界内进行有竞争力的包装，不做逐句事实审计，也不要求每句话携带 evidence reference。

运行时只区分两类新增内容：

1. **禁止补造项**：公司或组织名称、证书或职业资格、学校或学历、姓名和联系方式等身份信息。检测到现有资料中没有的新值时，让模型删除或恢复原内容，最多纠正一次。
2. **推测性补全项**：成果数字、性能比例、职责强度、项目规模、团队人数、使用时长、业务影响和具体职责细节。允许在合理范围内生成，但必须在所属条目末尾添加 `【待确认】`。

Harness 不判断推测数字是否“绝对真实”，只检查禁止补造项和标签是否存在。包装质量、说服力和岗位相关性放到 Scenario Eval，不在每个 Run 中调用独立语义验证模型。

## 6. 纠正分类

| 错误 | 默认纠正 | 上限/终点 |
| --- | --- | --- |
| JSON/Schema 参数错误 | 返回精确 issue 给模型修正 | 同指纹 1 次，之后暂停 |
| 工具不在白名单 | 拒绝，不给模型试探替代越权工具 | 立即结束该分支 |
| 目标、交付物或必要范围不明确 | `AskUserQuestion` | 等待用户，不创建 Todo、不继续写入 |
| 新增公司、证书、学校/学历或身份信息 | 指出新增值并让模型删除或恢复原内容 | 最多纠正 1 次 |
| 推测性硬事实缺少 `【待确认】` | 要求模型在所属条目末尾补标签 | 最多纠正 1 次 |
| 简历含 `【待确认】` | 保存 Run 内待确认草稿，以文本列出条目 | 进入 `waiting_user_input` |
| 需要确认 | 固定 proposal 并等待 | 接受/拒绝/过期 |
| revision 冲突 | 重新读取并展示冲突 | 不自动重放写入 |
| Provider 瞬时错误 | 输出前有界退避 | 默认 1 次，遵守 Retry-After |
| Provider 流畸形/半截工具参数 | 失败并记录协议错误 | 不执行部分调用 |
| 工具 timeout 且状态未知 | 对账 | 明确前禁止重试 |
| 工具结果 Output Schema 失败 | 隔离结果并报实现错误 | 不交给模型当事实 |
| 摘要不变量漂移 | 拒绝摘要并重试一次 | 再失败则确定性收缩或暂停 |
| 最终回复的执行状态与 receipt 不一致 | 按 Run 状态替换为正确的简短说明 | 不调用额外验证模型 |
| 达到轮次/工具/token 预算 | checkpoint + paused | 用户显式继续或缩小目标 |

“纠正”不是无限重试。每次纠正必须记录错误指纹、输入变化和为什么仍安全。

## 7. 简历草稿与最终回复纠正

### 7.1 处理流程

```text
模型生成简历草稿
    ↓
是否新增公司、证书、学校/学历或身份信息？
    ├─ 是 → 指出新增值并让模型删除，最多纠正一次
    └─ 否
         ↓
推测性补全是否都带【待确认】？
    ├─ 否 → 要求补标签，最多纠正一次
    └─ 是
         ↓
是否存在【待确认】？
    ├─ 否 → 按普通确认策略调用 UpdateResume
    └─ 是 → 保存待确认草稿并进入 waiting_user_input
```

待确认草稿保存在 Run 内，不在用户确认前调用 `UpdateResume` 写入正式简历：

```ts
interface PendingResumeDraft {
  draftId: string;
  runId: string;
  resumeId: string;
  baseRevision: number;
  content: string;
  uncertainItems: Array<{
    id: string;
    text: string;
  }>;
  contentHash: string;
}
```

即使会话使用 `fully_trusted`，存在 `【待确认】` 时也必须等待用户，因为免除的是普通编辑确认，不是对推测事实的授权。

### 7.2 文本确认

最终回复直接列出所有推测性补全，并告诉用户可以用文本确认或修改：

```text
简历优化稿已经生成，其中有 3 项推测性补全：

1. “将接口响应时间降低约 30%”
2. “独立负责缓存模块设计”
3. “支撑日均百万级请求”

这些条目已标记为【待确认】。你可以回复：
- “全部确认”
- “确认第 1、3 条，删除第 2 条”
- “第 1 条改为降低约 15%”
```

确认解析保持简单、明确：

- `全部确认`：接受全部待确认项。
- `确认第 1、3 条`：只接受指定项，未确认项继续保留等待。
- `删除第 2 条`：从草稿中删除对应补全。
- `第 1 条改为……`：使用用户提供的新文本替换该项并视为已确认。
- “好”“继续”“可以”等模糊回复不自动解释为全部确认，应继续询问具体选择。

应用确认时必须校验 `draftId`、`contentHash` 和 `baseRevision`。确认或修改完成后移除相应 `【待确认】` 标签，再调用 `UpdateResume`；若 revision 已变化，则停止写入并展示冲突。

### 7.3 最终动作状态

最终聊天回复只校验动作是否真实发生，不验证简历每句话：

- 有成功 `UpdateResume` receipt 才能说“简历已更新”。
- 草稿含待确认项时只能说“已生成待确认草稿”。
- 写入失败或状态未知时明确说明未完成，不能通过重新措辞伪装成功。

这部分只读取 Run 状态和 Tool Receipt，不生成额外的事实声明或证据包，也不调用独立验证模型。

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
resume.draft_waiting_confirmation|confirmed|modified
context.compacted|compaction_rejected
response.validation_failed|corrected
run.paused|completed|failed|cancelled
```

每条事件有 ordinal、时间、run/session/request ID、schemaVersion 和脱敏 payload。API Key、Authorization、原始敏感文件、无关个人信息和绝对路径不写入 Trace。

## 10. 测试与评估

| 层级 | 必测内容 |
| --- | --- |
| Unit | Policy、状态机、预算、Schema、资源键、错误分类、禁止补造项与标签检查 |
| Contract | Prompt/Tool/Provider/Context manifest，一致的错误码与事件联合 |
| Integration | Provider mock、工具 timeout、事务崩溃、幂等对账、压缩失败、重启恢复 |
| Security | Prompt injection、路径逃逸、越权工具、敏感文件、SSRF、Trace 泄密 |
| Scenario Eval | 简历包装质量、禁止补造项新增率、待确认标签覆盖率、工具选择和完成率 |
| E2E | 文本确认/修改/删除、普通确认接受/拒绝/过期、取消、冲突、离线恢复 |
| Fault Injection | 每个 checkpoint 后崩溃、SSE 任意断点、Worker 退出、数据库忙、磁盘满 |

关键指标建议：

- 未授权副作用率必须为 0。
- 重复写入率必须为 0。
- 无 receipt 的完成声明率必须为 0。
- 禁止补造项进入正式简历的比例必须为 0。
- 未确认且未带标签的推测性补全进入正式简历的比例必须为 0。
- Prompt injection 导致能力扩张率必须为 0。
- 0.2.0 岗位网络工具执行次数必须为 0；模型猜中禁用工具名时实现函数调用次数也必须为 0。
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

涉及岗位网络能力时还必须校验产品版本：0.2.0 直接拒绝发布；0.3.0 只能启用用户明确 URL 的 `ReadUrl`，且必须完成 SSRF、重定向、响应限长、取消、超时、脱敏、审计和站点条款专项验收。

模型升级视为行为变更，即使 API Schema 不变，也需重新跑场景 eval 和高风险回归。

## 12. 当前实现优先纠正项

A-01 已固定绿色回归的统一等待、确认时重加锁、只读并发与写屏障、畸形 SSE 失败和完整 TurnGroup 行为不得回退。文档复审通过后，A-03 按以下当前缺口推进：

1. 将 0.2.0 生产场景/工具清单收窄为 12 个本地工具，把 `SearchJobs`/`ReadUrl` 降为禁用草案，并在执行入口再次校验冻结白名单。
2. 以 execution token/state revision 丢弃取消后的迟到 Provider/Tool 事件。
3. 将 Scenario、Prompt、Tool、DataScope 和 Provider 合并为宿主实际消费的原子 Run 快照。
4. 为单工具派生 AbortSignal/deadline；超时写入进入 `status_unknown` 对账。
5. 强制生产 Host 注入持久化 Tool Ledger；写工具不得静默退化到内存幂等。
6. 在 Run 创建期编译 Prompt Manifest 并传给 Provider，删除 Provider 的业务 Prompt 回退所有权。
7. 在 Observability 入口统一脱敏 Key、Authorization、绝对路径和无关个人信息。
8. 对含 `【待确认】` 的草稿强制等待文本确认，不受 `fully_trusted` 模式豁免。

每项先使用 A-01 的现有回归或失败证据复现；缺少失败用例的版本清单/宿主接线项必须先补失败用例。修复后把对应 `it.fails` 改为普通回归测试，一个差距一个提交。A-03 不实现 `SearchJobs` 或联网 `ReadUrl`。

## 13. 总结

Harness 是 Agent 可靠性的主要来源：它在模型之外执行权限、状态、预算、Schema、幂等和动作回执规则。简历内容只做轻量纠正：禁止补造公司、证书、学校/学历和身份信息，其他合理推测必须标记 `【待确认】` 并通过文本让用户确认或修改。纠正保持有界，不做逐句证据审计或多模型验证。
