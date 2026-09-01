# Loop：可持久化的 Agent 运行循环

## 1. 职责与非职责

Loop 负责：

- 按状态机推进一次 Run。
- 请求 Context 快照和 Provider 输出。
- 将工具调用交给 Tool Scheduler。
- 在模型、工具、用户交互和取消之间建立明确边界。
- 在每个有副作用或可等待的边界写入 checkpoint。
- 在预算耗尽、策略拒绝和不可恢复错误时安全停止。

Loop 不负责：

- 决定用户是否有某项权限。
- 直接读写数据库、文件、凭据或网络。
- 解释某家 Provider 的 SSE 格式。
- 用 Prompt 代替工具鉴权。
- 在内存中长期等待用户。

## 2. 运行状态

```ts
type RunState =
  | 'created'
  | 'preparing'
  | 'model_streaming'
  | 'tool_validating'
  | 'tools_running'
  | 'waiting_user_input'
  | 'waiting_confirmation'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'cancelled';
```

其中：

- `waiting_user_input`：缺少事实、选择或材料，等待回答。
- `waiting_confirmation`：提案已经固定，等待显式接受或拒绝。
- `paused`：策略阻断、达到预算、外部服务限流、资源冲突或需要人工接管。
- `failed`：本 Run 无法安全恢复；不得把普通等待记为失败。

`generating`、`automatic_execution` 等 UI 展示态可以由上述内部状态和当前工具类型派生，不应另建互相冲突的事实源。

## 3. Run 数据结构

```ts
interface AgentRun {
  runId: string;
  sessionId: string;
  parentRunId?: string;
  state: RunState;
  stateRevision: number;
  scenarioSnapshotId: string;
  promptManifestHash: string;
  providerSnapshotId: string;
  contextSnapshotId?: string;
  executionAttempt: number;
  modelTurn: number;
  toolCallCount: number;
  budgets: {
    maxModelTurns: number;
    maxToolCalls: number;
  };
  pendingInteraction?: PendingInteraction;
  lastCheckpointId?: string;
  lastError?: StructuredRunError;
  result?: RunResult;
  createdAt: string;
  updatedAt: string;
}
```

一次点击“发送”创建一个新 Run，而不是创建新 Session。同一 Session 可以连续包含多个 Run；等待用户输入或确认后恢复的是原逻辑 Run，进程重启后承接它的则是新 Execution。场景切换由产品层新建 Session，因此不会在原 Session 中热切场景。

`AgentRun` 是权威状态机和审计对象，不应为了给模型显示状态而不断扩充字段。累计 input tokens 和浏览器动作数不设置硬预算；Provider 单请求仍必须服从模型的上下文长度，浏览器动作数未来启用投递场景后只作为 Trace 审计指标。

模型可见的运行状态栏使用独立的最小结构：

```ts
interface RuntimeReminderState {
  now: number;
  timeZone: string;
  usedTurns: number;
  maxTurns: number;
  confirmationMode: 'always_confirm' | 'allow_low_risk' | 'fully_trusted';
  finalTurn: boolean;
}
```

该结构只包含需要提醒模型的当前事实，不传 `createdAt`、`scenario`、Session ID、Run ID 或内部状态机字段。

`stateRevision` 用于 compare-and-swap，避免取消、确认和模型完成事件并发覆盖。实际执行进程还持有短租约：

```ts
interface RunLease {
  runId: string;
  executionId: string;
  leaseExpiresAt: string;
  heartbeatAt: string;
}
```

只有持有有效 lease 的 Execution 可以推进状态。进程崩溃后，由恢复器确认旧 lease 过期，再从 checkpoint 创建新 Execution。

## 4. 状态转换

| 当前状态                   | 事件                     | 下一状态                      | 必要动作                          |
| ---------------------- | ---------------------- | ------------------------- | ----------------------------- |
| `created`              | `run.start`            | `preparing`               | 校验场景已启用，原子冻结 Scenario、Provider、Prompt、工具和数据范围快照 |
| `preparing`            | context ready          | `model_streaming`         | 预算检查并持久化 request manifest     |
| `model_streaming`      | final text             | `completed`               | Harness 验证最终声明后提交终态           |
| `model_streaming`      | tool calls             | `tool_validating`         | 聚合完整调用，不执行半截参数                |
| `tool_validating`      | valid batch            | `tools_running`           | 生成调度计划与工具账本                   |
| `tool_validating`      | need repair            | `model_streaming`         | 返回结构化错误，最多纠正一次                |
| `tools_running`        | continue               | `model_streaming`         | 追加按原调用顺序排列的结果                 |
| `tools_running`        | ask user               | `waiting_user_input`      | checkpoint 后发送问题事件            |
| `tools_running`        | need approval          | `waiting_confirmation`    | 固定提案哈希，checkpoint 后发确认卡       |
| 任意活动态                  | budget/policy/conflict | `paused`                  | 保存可恢复原因与建议动作                  |
| 任意非终态                  | user cancel            | `cancelled`               | abort、取消未启动工具、对账已启动副作用        |
| `waiting_user_input`   | valid answer           | `preparing`               | 追加回答事件，清除 pending interaction |
| `waiting_confirmation` | accept                 | `tools_running`           | 校验提案哈希和 revision，只执行已冻结的确认命令  |
| `waiting_confirmation` | reject                 | `preparing` 或 `cancelled` | 记录拒绝；是否继续由提案策略决定              |
| `paused`               | explicit resume        | `preparing`               | 验证阻断条件已变化后恢复                  |

终态不允许转出。需要“继续”时创建新 Run，并通过 `parentRunId` 关联，而不是篡改已完成记录。

### 4.1 CronTask 后台 Run

`CreateCronTask` 的确认是针对整个 occurrence 周期的一次性授权，不属于某次浏览器动作确认。系统调度器只唤醒应用；Backend 从数据库原子 claim 到期 occurrence，创建独立 Session，把保存的消息作为真实 `user` 消息，再通过内部 `SendScheduled` 入口执行。该入口固定 `fully_trusted + unattended`，移除四个 CronTask 工具，并自行持久化 assistant 输出，不能依赖 Renderer 消费流事件。

多个逾期 occurrence 只 claim 最近一次，更早项写为 `missed(superseded_by_latest)`；同任务前次仍运行时写为 `missed(previous_run_active)`。登录、验证码、短信或必要信息缺失写为 `needsAttention`，不弹阻塞确认框。completed、failed、missed、needsAttention 都消费次数，单次失败不取消后续计划。

## 5. 主循环伪代码

```ts
async function executeRun(runId: string, signal: AbortSignal): Promise<void> {
  const lease = await harness.acquireLease(runId);
  try {
    while (!signal.aborted) {
      const run = await store.loadRun(runId);
      harness.assertLeaseAndTransition(run, lease);
      harness.assertBudgets(run);

      const prepared = await harness.prepareImmutableRunSnapshot(run);
      const context = await contextBuilder.build(prepared);
      await store.checkpoint(runId, 'model_request_ready', context.manifest);

      const completion = await provider.stream(context.request, signal);
      const modelOutput = await harness.validateProviderCompletion(completion);

      if (modelOutput.toolCalls.length === 0) {
        const verified = await harness.verifyFinalResponse(modelOutput);
        await store.completeRun(runId, verified);
        return;
      }

      const plan = await toolScheduler.plan(modelOutput.toolCalls, prepared);
      const outcome = await toolScheduler.execute(plan, signal);
      await store.checkpoint(runId, 'tool_batch_finished', outcome.receipts);

      if (outcome.disposition === 'waiting_user_input') {
        await store.waitForUser(runId, outcome.interaction);
        return;
      }
      if (outcome.disposition === 'waiting_confirmation') {
        await store.waitForConfirmation(runId, outcome.interaction);
        return;
      }
      if (outcome.disposition === 'paused') {
        await store.pauseRun(runId, outcome.reason);
        return;
      }

      await store.appendToolResults(runId, outcome.results);
    }
  } catch (error) {
    await harness.failOrPause(runId, error);
  } finally {
    await harness.releaseLease(lease);
  }
}
```

关键点：进入 `waiting_*` 后函数返回，释放 Provider 连接、计时器和进程资源。恢复由新事件重新调度，不保持悬空 Promise。

## 6. 等待用户输入

```ts
interface PendingQuestionInteraction {
  type: 'question';
  interactionId: string;
  runId: string;
  questions: Array<{
    id: string;
    prompt: string;
    required: boolean;
    options?: Array<{ id: string; label: string }>;
  }>;
  answerSchema: object;
  createdAt: string;
  expiresAt?: string;
}
```

规则：

1. 问题卡先持久化，后发送 UI 事件，防止 UI 看见卡片但后端无法恢复。
2. 回答必须携带 `interactionId` 和 `expectedStateRevision`。
3. 自由文本只能作为问题回答；确认写操作必须使用明确的确认命令，不能把“好”“继续”猜成授权。
4. 回答不完整时保持等待态，返回缺失字段，不把未答项交给模型猜测。
5. 新普通消息如果没有关联 pending interaction，默认不暗中取消等待；UI 应提示用户选择“回答当前问题”或“开始新任务并取消当前 Run”。
6. 等待可长期存在；涉及短期外部资源时只保存引用和 revision，不持有事务、文件句柄或进程锁。

## 7. 等待确认

确认对象必须冻结具体动作，而不是冻结一句描述：

```ts
interface PendingConfirmation {
  type: 'confirmation';
  interactionId: string;
  proposalId: string;
  proposalHash: string;
  toolName: string;
  canonicalArguments: unknown;
  resourceId: string;
  expectedRevision?: number;
  risk: 'low' | 'medium' | 'high';
  diff: unknown;
  expiresAt: string;
}
```

推荐流程：

1. 生成结构化变更提案和可读 diff。
2. 校验提案，但不执行持久化写入。
3. 保存规范化参数及其哈希，释放临时锁。
4. 进入 `waiting_confirmation`。
5. 用户接受时核对 `proposalHash`，重新读取资源并获取锁。
6. revision 一致才使用业务幂等键提交；不一致则进入 `paused`，展示新旧差异。
7. 成功后写 Tool Receipt；拒绝或过期后提案失效，不能复用。
8. 复用 `AskUserQuestion` 的恢复路径，把用户决定和实际执行结果整理为普通文本，以 `user` 角色保存并启动延续 Run；不使用额外标签或隐藏消息格式。

接受确认后不再让模型重新生成工具参数。Harness 直接把冻结提案交给 Tool Scheduler；执行结束后再以普通 `user` 消息向模型说明确认决定和执行结果。该消息与 `AskUserQuestion` 的答案一样进入会话历史和新 Trace，使模型能够继续任务，同时保证用户看到的 diff 与真正执行的参数完全一致。

这比“等待期间一直持锁”更安全，也更适合桌面应用重启恢复。

## 8. 多工具、停止与取消

- Provider 返回的同批工具调用必须先完整聚合，再统一验证和规划。
- 只读、无依赖、资源键不冲突的工具可以并行；写操作、用户交互和状态快照刷新是屏障。
- 某个工具要求等待时，屏障后的工具全部标记 `SKIPPED_AFTER_WAIT`，不得继续产生副作用。
- 用户取消立即触发共享 `AbortSignal`，取消未启动节点；已启动写操作必须通过幂等账本查询最终状态。
- Run 进入 `cancelled` 后，所有 Provider/Tool 回调还必须校验 execution token 和 `stateRevision`；迟到增量只能记脱敏诊断，不能再发送 UI 事件或写入其他会话。
- Provider 已产生部分文本后失败，不透明重试并拼接第二份输出；应保留诊断并允许用户显式重试。
- 停止生成不等于回滚已完成副作用。UI 必须分别展示“生成已停止”和“已完成的动作”。

## 9. 预算与熔断

至少限制：

- 模型子轮数：默认场景 30，投递场景 100；调整属于场景配置，不需要用额外的“轮数过多”策略阻止。
- 工具调用总数：默认 12，场景可降低。
- 相同错误指纹：最多纠正 1 次。
- 相同工具名 + 规范化参数：读工具最多自动重试 1 次，写工具不得无业务幂等键重试。
- Provider 单请求必须满足模型上下文上限；累计 input tokens 不设 Run 级硬预算。

模型轮数耗尽前必须在最后一轮提醒模型“不得发起新工具调用，应收束当前结果并说明未完成项”。若最后一轮仍返回工具调用，Kernel 不执行工具，写入 `TURN_BUDGET_EXHAUSTED` 结果并进入 `paused`。不得伪装成正常完成，也不得自动创建新 Run 绕过上限。

## 10. Runtime Reminder 注入

- 使用 `user` 角色追加，Provider 只接收 `role/content`；内部 metadata 不进入 API。
- 默认场景在首轮、每 5 个已使用模型轮次、最后一轮以及确认权限变化时注入；投递场景采用每 10 轮。
- 整条状态栏必须由且仅由一组 `<runtime-reminder>...</runtime-reminder>` 标签包裹；标签内部使用直白英语，例如 `Today is ...`、`Used turns: 20 of 30.`、`Current confirmation mode: ...`、`Loaded skills: ...`。
- 结尾固定表达：`The above is the current runtime status. No response is needed; continue the task.`
- 同一 Session 的正常追加过程中不得删除、替换或就地改写旧 reminder；最新一条代表当前状态，旧消息用于保持历史和前缀缓存稳定。
- reminder 是状态提示，不授予工具、资源或外部账号权限。

### 10.1 Skill 加载时序

- 会话当前 Skill 快照的索引只在该快照第一次真正发送时注入，顺序为 `skill_index user → 真实 user → 可选 loaded_skill user`。
- 模型自主加载时必须保持 `assistant tool_call → 匹配的 tool result → loaded_skill user`。含 `LoadSkill` 的批次只执行第一个 Skill 加载，其余调用返回 `SKIPPED_FOR_SKILL_LOAD`；下一轮读取正文后再规划动作。
- Kernel 只有在正文成功追加到 Transcript 后才更新会话级 `loadedSkills`；取消或失败且 Transcript 未保存时回滚本 Run 的临时状态。
- 同一版本重复加载是幂等操作，不重复追加正文。Skill 正文只能提供执行知识，不能扩大冻结工具、确认权限或资源范围。

## 11. 恢复策略

启动时扫描非终态 Run：

- `waiting_*`：恢复问题卡或确认卡，不自动调用模型。
- `paused`：恢复原因与可执行操作，不自动重试。
- 活动态且 lease 已过期：先对账最后一个工具账本，再从最后 checkpoint 恢复。
- Provider 流中断且没有副作用：标记可重试，不拼接未知残片。
- 写工具状态未知：进入 `paused`，调用只读对账接口；禁止再次写入。

## 12. Loop 验证清单

- 状态转换表外的转换全部被拒绝。
- 禁用场景不能创建 Run；0.2.0 默认场景快照中不得出现 `SearchJobs`、`ReadUrl`。
- 场景白名单必须在模型可见列表和执行入口使用同一份冻结快照，不能只隐藏工具定义。
- 两个 Execution 不能同时推进同一个 Run。
- checkpoint 早于等待 UI 事件和副作用成功事件。
- 工具调用与结果组不会在历史裁剪时拆开。
- 取消、确认和 Provider 完成并发发生时，只有一次 CAS 成功。
- 取消完成后迟到 Provider/Tool 事件不会进入 UI、Transcript 或其他 Run。
- 应用在每个 checkpoint 后崩溃，重启均不会重复写入或丢失确认卡。
- 达到预算时保存可恢复状态，不产生无限循环。
- runtime reminder 始终以 user 角色追加，权限变化会在下一模型轮次反映，旧 reminder 保持不变。
- Skill 索引和正文均以带内部来源的 user 角色追加，不会被计为真实用户轮次；reminder 显示当前会话已加载 Skill ID。
- 最后一轮的新工具调用不会进入 Tool Scheduler。

## 13. 总结

Loop 的本质是持久化状态机，而不是模型调用循环。它必须把模型、工具、用户等待和副作用切成可审计的状态转换；任何等待都释放执行资源，任何恢复都从 checkpoint 和 revision 继续，任何副作用都通过持久化幂等账本确认结果。
