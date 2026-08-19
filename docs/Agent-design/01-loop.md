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
    maxWallTimeMs: number;
    maxInputTokens: number;
    maxOutputTokens: number;
  };
  pendingInteraction?: PendingInteraction;
  lastCheckpointId?: string;
  lastError?: StructuredRunError;
  result?: RunResult;
  createdAt: string;
  updatedAt: string;
}
```

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

| 当前状态 | 事件 | 下一状态 | 必要动作 |
| --- | --- | --- | --- |
| `created` | `run.start` | `preparing` | 冻结场景、Provider、Prompt 和权限快照 |
| `preparing` | context ready | `model_streaming` | 预算检查并持久化 request manifest |
| `model_streaming` | final text | `completed` | Harness 验证最终声明后提交终态 |
| `model_streaming` | tool calls | `tool_validating` | 聚合完整调用，不执行半截参数 |
| `tool_validating` | valid batch | `tools_running` | 生成调度计划与工具账本 |
| `tool_validating` | need repair | `model_streaming` | 返回结构化错误，最多纠正一次 |
| `tools_running` | continue | `model_streaming` | 追加按原调用顺序排列的结果 |
| `tools_running` | ask user | `waiting_user_input` | checkpoint 后发送问题事件 |
| `tools_running` | need approval | `waiting_confirmation` | 固定提案哈希，checkpoint 后发确认卡 |
| 任意活动态 | budget/policy/conflict | `paused` | 保存可恢复原因与建议动作 |
| 任意非终态 | user cancel | `cancelled` | abort、取消未启动工具、对账已启动副作用 |
| `waiting_user_input` | valid answer | `preparing` | 追加回答事件，清除 pending interaction |
| `waiting_confirmation` | accept | `tools_running` | 校验提案哈希和 revision，只执行已冻结的确认命令 |
| `waiting_confirmation` | reject | `preparing` 或 `cancelled` | 记录拒绝；是否继续由提案策略决定 |
| `paused` | explicit resume | `preparing` | 验证阻断条件已变化后恢复 |

终态不允许转出。需要“继续”时创建新 Run，并通过 `parentRunId` 关联，而不是篡改已完成记录。

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

      if (outcome.disposition === 'wait_user') {
        await store.waitForUser(runId, outcome.interaction);
        return;
      }
      if (outcome.disposition === 'wait_confirmation') {
        await store.waitForConfirmation(runId, outcome.interaction);
        return;
      }
      if (outcome.disposition === 'pause') {
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

接受确认后不再让模型重新生成工具参数。Harness 直接把冻结提案交给 Tool Scheduler；执行成功后，Loop 才把 receipt 作为结果请求模型生成说明。这样可以保证用户看到的 diff 与真正执行的参数完全一致。

这比“等待期间一直持锁”更安全，也更适合桌面应用重启恢复。

## 8. 多工具、停止与取消

- Provider 返回的同批工具调用必须先完整聚合，再统一验证和规划。
- 只读、无依赖、资源键不冲突的工具可以并行；写操作、用户交互和状态快照刷新是屏障。
- 某个工具要求等待时，屏障后的工具全部标记 `SKIPPED_AFTER_WAIT`，不得继续产生副作用。
- 用户取消立即触发共享 `AbortSignal`，取消未启动节点；已启动写操作必须通过幂等账本查询最终状态。
- Provider 已产生部分文本后失败，不透明重试并拼接第二份输出；应保留诊断并允许用户显式重试。
- 停止生成不等于回滚已完成副作用。UI 必须分别展示“生成已停止”和“已完成的动作”。

## 9. 预算与熔断

至少限制：

- 模型子轮数：默认 12。
- 工具调用总数：默认 32，场景可降低。
- 相同错误指纹：最多纠正 1 次。
- 相同工具名 + 规范化参数：读工具最多自动重试 1 次，写工具不得无业务幂等键重试。
- 单次 Execution 墙钟时间：默认 5 分钟；进入用户等待后不累计。
- Provider 输入、输出与工具结果 token 预算。

预算耗尽进入 `paused`，保留 transcript、工具账本和下一步建议。不得伪装成正常完成，也不得自动创建新 Run 绕过上限。

## 10. 恢复策略

启动时扫描非终态 Run：

- `waiting_*`：恢复问题卡或确认卡，不自动调用模型。
- `paused`：恢复原因与可执行操作，不自动重试。
- 活动态且 lease 已过期：先对账最后一个工具账本，再从最后 checkpoint 恢复。
- Provider 流中断且没有副作用：标记可重试，不拼接未知残片。
- 写工具状态未知：进入 `paused`，调用只读对账接口；禁止再次写入。

## 11. Loop 验证清单

- 状态转换表外的转换全部被拒绝。
- 两个 Execution 不能同时推进同一个 Run。
- checkpoint 早于等待 UI 事件和副作用成功事件。
- 工具调用与结果组不会在历史裁剪时拆开。
- 取消、确认和 Provider 完成并发发生时，只有一次 CAS 成功。
- 应用在每个 checkpoint 后崩溃，重启均不会重复写入或丢失确认卡。
- 达到预算时保存可恢复状态，不产生无限循环。

## 12. 总结

Loop 的本质是持久化状态机，而不是模型调用循环。它必须把模型、工具、用户等待和副作用切成可审计的状态转换；任何等待都释放执行资源，任何恢复都从 checkpoint 和 revision 继续，任何副作用都通过持久化幂等账本确认结果。
