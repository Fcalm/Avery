# Tools：白名单、执行管道与并发编排

## 1. 设计原则

- 默认无工具；场景只授予完成目标所需的最小集合。
- “模型看得见”与“运行时允许执行”必须引用同一份 ScenarioSnapshot。
- Schema 校验只证明形状正确，不证明调用有权限、语义合理或可安全执行。
- 读写权限在 Tool Scheduler 和 Backend Port 两层校验。
- 写工具必须可幂等、可审计、可对账；不能只设置一个 `isWrite` 布尔值。
- 工具结果是外部不可信数据，返回模型前要校验、脱敏和限长。

## 2. 规范化工具契约

```ts
interface AgentToolDefinition<TInput, TOutput> {
  name: string;
  version: string;
  description: string;
  inputSchema: object;
  outputSchema: object;
  sideEffect: 'none' | 'local_draft' | 'persistent_write' | 'external_action';
  risk: 'low' | 'medium' | 'high';
  confirmation: 'never' | 'scenario_policy' | 'always';
  idempotency: 'not_needed' | 'required';
  concurrency: {
    mode: 'parallel_safe' | 'serial';
    resourceKeys(input: TInput): string[];
  };
  limits: {
    timeoutMs: number;
    maxInputBytes: number;
    maxOutputBytes: number;
    maxRecords?: number;
  };
  allowedScenarios: string[];
  requiredCapabilities: string[];
}
```

`resourceKeys` 示例：`resume:123`、`session:456:tasks`、`project:789:files`。调度器用它建立读写屏障，端口仍需使用真实资源锁和 revision。

## 3. 首批场景白名单

下表使用目标工具名。`interaction.ask` 是等待入口，不是普通回复；`task.*` 仅在确有多步骤长任务时启用。

| 场景 | 只读工具 | 草稿/写工具 | 明确禁止 |
| --- | --- | --- | --- |
| 简历优化 `resume_optimization` | `profile.read`、`resume.read`、`attachment.read` | `resume.patch.preview`、`resume.patch.commit`、`interaction.ask`、`task.create/update/list/get` | 任意项目目录、岗位写入、导出、浏览器、网络、Shell |
| 岗位定制简历 `job_tailored_resume` | 上述只读 + `job.read` | `resume.variant.preview`、`resume.variant.commit`、`interaction.ask`、`task.*` | 修改原岗位事实、自动投递、导出、任意网络 |
| 项目经历提炼 `project_extraction` | `project.glob`、`project.search`、`project.read`、`profile.read`、`resume.read` | `resume.patch.preview`、`resume.patch.commit`、`interaction.ask`、`task.*` | 项目写入/执行、项目外路径、敏感文件、任意网络 |
| 投递辅助 `application_assistance` | `job.read`、`profile.read`、`resume.version.read`、`application.read` | `application.plan.preview`、`application.answer.preview`、`interaction.ask`、`task.*` | 浏览器提交、验证码处理、账号操作、修改冻结简历版本、任意网络 |

补充规则：

- `*.commit` 只有在用户明确请求持久化变更时才可调用；白名单存在不等于本轮已授权写入。
- `resume.patch.commit` 只接收结构化模块级 patch，不允许整份文本覆盖，遵循 PRD 7.3.2。
- 投递执行器属于独立 Automation Domain。未来若接入，只能通过版本化的业务命令创建自动化任务，不能给普通 Agent 浏览器或脚本工具。
- 场景切换生成新快照，权限取新旧集合的当前值，不做并集。

## 4. 与当前 12 个工具的迁移关系

| 当前名称 | 目标名称/处理 |
| --- | --- |
| `Read` | 按授权来源拆为 `attachment.read` / `project.read` |
| `Glob` | `project.glob`；附件列表由 Context 提供，不混用路径域 |
| `Grep` | `project.search`；使用安全搜索语义，限制正则复杂度 |
| `ReadProfile` | `profile.read` |
| `ReadResume` | `resume.read` |
| `CreateResume` | `resume.variant.preview/commit` 或结构化 `resume.create.*` |
| `EditResume` | 替换为模块级 `resume.patch.preview/commit` |
| `AskUserQuestion` | `interaction.ask`，返回统一 wait disposition |
| `TaskCreate/Update/List/Get` | `task.create/update/list/get` |

迁移期可以保留旧 Provider-visible 名称，但注册表内部必须分配稳定工具 ID 和版本，避免名称重构破坏 Tool Ledger。

## 5. Schema 策略

内部采用“受限 JSON Schema 2020-12 子集”：

- 允许：`type`、`properties`、`required`、`additionalProperties: false`、`enum`、`items`、`min/max`、`minLength/maxLength`、`pattern`、`format` 的受控集合。
- 默认禁止：远程 `$ref`、递归 Schema、复杂 `oneOf/anyOf/allOf`、动态关键字和 Provider 不一致的格式扩展。
- 顶层必须是 object，所有写工具必须 `additionalProperties: false`。
- 字符串、数组、对象深度和总字节数均有上限。
- Input 和 Output 都有 Schema；Provider 只看到经 Adapter 下编译后的 Input Schema。

建议以 TypeScript 类型 + Zod 作为开发源，构建时生成规范化 JSON Schema，再由 AJV 运行时校验。必须增加生成物一致性测试，避免 Zod、JSON Schema 和实现三份契约漂移。

## 6. 调用校验管道

按以下顺序执行，任何一步失败都不调用实现：

1. 聚合 Provider 的完整工具调用和参数增量。
2. 校验调用数量、名称长度、参数字节数和 JSON 深度。
3. 用 `ScenarioSnapshot.toolIds` 查白名单。
4. 解析 JSON；拒绝重复键、非有限数字和原型污染键。
5. 按内部 Input Schema 校验。
6. 执行业务语义校验：资源是否存在、ID 是否属于当前会话、revision 是否可用。
7. Harness 计算 Policy Decision：`allow | deny | require_confirmation | pause`。
8. 为写调用建立业务幂等键和 Tool Ledger 记录。
9. 调度并执行，传入 `AbortSignal`、deadline、actor 和授权依据。
10. 校验 Output Schema，脱敏、限长并生成 Tool Receipt。

Provider 的 strict tool calling 可以提高参数命中率，但不能替代上述任何一步。

## 7. 参数纠正

只允许确定性、无语义猜测的规范化，例如去除对象原型、统一已声明的日期格式。以下行为禁止自动纠正：

- 把任意字符串猜成资源 ID。
- 为写工具补造缺失字段。
- 删除未知字段后继续写入。
- 将模糊自然语言确认转换为布尔授权。
- 因 Schema 不兼容而放宽 `additionalProperties`。

无效调用返回：

```json
{
  "ok": false,
  "code": "INVALID_TOOL_ARGUMENTS",
  "retryability": "model_repair_once",
  "issues": [{ "path": "/resumeId", "rule": "required" }]
}
```

同一错误指纹只给模型一次修正机会。第二次仍失败则暂停或转为用户可操作错误，不循环试探。

## 8. 并发调度

### 8.1 规划规则

Provider 返回一批调用后，调度器建立 DAG：

- 显式依赖优先；没有显式依赖时不推测数据依赖。
- 只有 `sideEffect = none`、`parallel_safe` 且资源键不冲突的节点可并行。
- 写操作、确认、提问、动态权限变化和 Context 刷新都是屏障。
- 同一资源的读取可以在同一快照 revision 上并行；任一写入后必须刷新快照再继续。
- 结果追加到模型上下文时按 Provider 原始 tool call 顺序排列，不按完成时间排列。

### 8.2 执行顺序示例

```text
批次：[profile.read, resume.read, project.read, resume.patch.commit, task.update]

阶段 A：profile.read ─┐
       resume.read  ──┼─ 并行，全部成功后过屏障
       project.read ──┘
阶段 B：resume.patch.commit  串行写入并刷新 resume revision
阶段 C：task.update          串行写入 session:tasks
```

若阶段 A 中一个工具失败：

- 与它无依赖的读结果仍可返回。
- 阶段 B 是否可运行由预先生成的依赖和 Harness Policy 决定，不能临时靠模型猜。
- 若出现 `waiting_*`，后续阶段全部跳过并记录原因。

## 9. 超时、取消与幂等

- 每个工具接收 `AbortSignal` 和绝对 deadline；只 `Promise.race` 不算取消。
- 读工具超时可按策略重试一次；写工具只有在相同业务幂等键下才能查询或重放。
- 幂等键至少包含 `sessionId + runId + stableToolId + proposalHash`，由 Harness 生成，不信任模型输入。
- Tool Ledger 在执行前写 `started`，完成后写 `succeeded/failed/status_unknown` 和外部回执。
- 超时后无法证明副作用未发生时标记 `STATUS_UNKNOWN`，先调用只读对账，不自动再写。
- 用户取消只阻止未开始和可取消动作；已经提交的事务以最终仓储状态为准。

## 10. 工具结果协议与限长

```ts
interface ToolEnvelope<T> {
  ok: boolean;
  code: string;
  data?: T;
  receipt?: {
    receiptId: string;
    toolId: string;
    resourceIds: string[];
    revisions?: Record<string, number>;
    idempotencyKey?: string;
  };
  pagination?: { cursor?: string; hasMore: boolean };
  truncation?: { truncated: boolean; omittedCount?: number; artifactRef?: string };
  retryability: 'none' | 'safe_once' | 'model_repair_once' | 'user_action';
  message: string;
}
```

- 结果必须始终是合法结构，不能按字符硬切 JSON。
- 列表默认最多 100 条，搜索默认最多 50 条；具体值由工具注册表定义。
- 单条文本先按行/段落边界裁剪，返回 `artifactRef`、摘要和省略量。
- 敏感字段在写入 Trace 和返回模型前分别脱敏。
- 大结果使用游标分页；模型必须明确请求下一页，不能一次性把整个项目塞入 Context。

## 11. 测试清单

- 每个场景只暴露白名单工具，切换场景不累加。
- 未知工具、同名不同版本和大小写变体均被拒绝。
- Schema fuzz：超深对象、巨大数组、重复键、`__proto__`、NaN、额外字段。
- Prompt injection 不能注册工具或扩大路径范围。
- 并行读结果顺序稳定；写屏障后读取到新 revision。
- 超时写入的最终状态会对账，不产生第二次提交。
- 重启后相同幂等键返回原 receipt。
- 等待确认出现后，批次剩余写工具没有执行。

## 12. 总结

Tools 的安全边界由场景白名单、规范化 Schema、Policy、窄端口、资源锁和持久化账本共同组成。并行只用于可证明独立的只读调用；写入、确认和上下文刷新必须形成屏障。模型可以提出调用，但不能决定自己是否获准执行。
