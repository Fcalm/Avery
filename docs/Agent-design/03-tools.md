# Tools：白名单、执行管道与并发编排

## 1. 设计原则

- 默认无工具；每次 Run 只暴露当前 ScenarioSnapshot 允许的最小集合。
- 工具名称表达模型需要区分的业务意图，不按存储来源或执行阶段过度拆分。
- “模型看得见”与“运行时允许执行”引用同一份工具快照。
- Schema 校验只证明形状正确，不证明调用有权限、语义合理或可安全执行。
- 读写权限在 Tool Scheduler 和 Backend Port 两层校验。
- 确认、预览和提交是 Harness 的执行阶段，不分别注册成模型工具。
- 工具结果是外部不可信数据，返回模型前必须校验、脱敏和限长。

## 2. 工具命名

模型可见名称统一采用 PascalCase，通过大写字母划分单词，不使用点、下划线、连字符或其他特殊分隔符：

```text
Read
Glob
Grep
ReadResume
UpdateResume
SearchJobs
ReadUrl
CreateTodo
```

名称必须匹配：

```regex
^[A-Z][A-Za-z0-9]{0,63}$
```

规则：

- 工具名称区分大小写，发布后保持稳定。
- 动作优先放在名称前面，例如 `ReadResume`、`UpdateProfile`、`CreateTodo`。
- 工具版本、业务域和内部唯一 ID 使用独立字段，不编码进模型可见名称。
- 内部可以保存 `{ name: 'ReadResume', version: 1, domain: 'resume' }`，无需使用 `resume.read.v1`。
- 工具重命名视为协议变更，必须有迁移和 Provider fixture，不能静默复用旧 Tool Ledger。

## 3. 规范化工具契约

```ts
interface AgentToolDefinition<TInput, TOutput> {
  id: string;
  name: string;
  version: number;
  domain: string;
  description: string;
  inputSchema: object;
  outputSchema: object;
  sideEffect: 'none' | 'local_write' | 'external_action';
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

`resourceKeys` 示例：`resume:123`、`run:456:todos`、`workspace:789:files`。它们是调度器内部资源标识，不是模型可见工具名。端口仍需使用真实资源锁和 revision。

## 4. 场景白名单

### 4.1 默认场景

默认场景 `default` 是第一阶段唯一启用的场景。

| 能力 | 模型可见工具 |
| --- | --- |
| UTF-8 文件读取 | `Read`、`Glob`、`Grep` |
| 档案 | `ReadProfile`、`UpdateProfile` |
| 简历 | `ReadResume`、`CreateResume`、`UpdateResume` |
| 岗位发现 | `SearchJobs`、`ReadUrl` |
| Run Todo | `CreateTodo`、`UpdateTodo`、`ReadTodo` |
| 用户交互 | `AskUserQuestion` |

明确禁止：

- 填写申请表、上传投递材料、操作登录态或提交申请。
- Shell、任意 HTTP、任意 Header、任意浏览器或脚本执行。
- 项目文件写入、未授权路径访问和敏感文件读取。
- 将搜索结果自动写入岗位库；第一阶段岗位结果只作为 Run 内临时数据。

白名单存在不等于本轮必须把全部工具发给模型。Host 可以根据当前意图进一步收窄，例如简单简历修改不暴露 `SearchJobs` 和 `ReadUrl`。

### 4.2 投递场景占位

投递场景 `application` 第一阶段只保留产品占位，不实现、不启用，也不注册任何浏览器或 Automation 工具：

```ts
{
  id: 'application',
  name: '投递场景',
  enabled: false,
  status: 'planned',
  toolNames: []
}
```

用户尝试进入时由应用层直接返回“投递场景暂未开放”，不得创建一个空能力 Run，也不得临时复用默认场景权限。

## 5. MVP 工具定义

### 5.1 `Read`、`Glob`、`Grep`

三个工具统一处理授权范围内的 UTF-8 文件，不按附件、工作目录或代码项目拆成不同工具。

| 工具 | 职责 |
| --- | --- |
| `Read` | 读取一个授权范围内的 UTF-8 文件 |
| `Glob` | 按路径模式枚举授权范围内的文件 |
| `Grep` | 在授权范围内的 UTF-8 文件中搜索文本 |

文件来源由虚拟路径或会话挂载区分，例如：

```text
workspace://src/index.ts
attachment://notes.md
project://offerget/package.json
artifact://document/abc123.txt
```

其中 `project` 仅表示用户显式授权的代码项目挂载，不是“项目经历”业务实体。模型仍调用统一的 `Read`、`Glob`、`Grep`。

共同限制：

- 严格按 UTF-8 解码，拒绝非法编码、二进制内容和超大文件。
- 只接受授权虚拟路径或授权根目录下的相对路径。
- 解析 canonical path 后再次检查根目录包含关系，拒绝符号链接逃逸和路径替换。
- 遵守敏感文件、扩展名、单文件大小、总读取量和结果条数限制。
- PDF、Word 和图片先由附件解析管道生成 UTF-8 artifact，再通过 `Read` 读取；`Read` 本身不承担多格式解析。

### 5.2 档案与简历

业务实体使用独立工具，因为它们具有结构化 Schema、revision、资源锁和不同写入规则：

```text
ReadProfile
UpdateProfile
ReadResume
CreateResume
UpdateResume
```

`UpdateProfile` 和 `UpdateResume` 接收结构化 patch 与 expected revision。是否展示 diff、等待确认或直接提交由 Harness 根据场景策略决定，模型不调用 Preview/Commit 工具。包含未确认 `【待确认】` 的简历草稿不能调用 `UpdateResume` 写入正式版本；Harness 必须先完成文本确认并移除已确认标签。

### 5.3 岗位发现

MVP 只保留：

```text
SearchJobs
ReadUrl
```

`SearchJobs` 用于自主生成查询、选择注册来源、翻页、去重并返回岗位摘要和 URL。`ReadUrl` 用于读取选中候选岗位的完整页面内容。

典型流程：

```text
ReadProfile / ReadResume
→ SearchJobs
→ 筛选候选结果
→ ReadUrl 读取部分完整 JD
→ 向用户展示有依据的推荐
```

搜索边界：

- 不要求用户逐个提供 URL；当用户目标明确包含岗位发现时，Agent 可以自主决定查询词、来源和翻页。
- 每个 Run 有查询数、结果数、读取 URL 数、下载量和墙钟预算。
- `ReadUrl` 仅允许 `http/https`，拒绝本机、内网、文件协议、疑似凭据 URL 和非预期重定向。
- 使用无登录态、无用户 Cookie 的网络端口；需要登录或交互的页面不能转为浏览器操作。
- 搜索结果和页面正文是不可信数据，必须记录来源、抓取时间和不确定性。
- 不输出缺乏依据的单一匹配百分比；应列出硬条件、证据、冲突和待确认项。
- 不创建持续后台扫描。周期搜索需要未来单独定义范围、频率和停止条件。

第一阶段不提供 `SaveJob`、`ReadJob` 或 `AddJobToLibrary`。搜索结果作为当前 Run 的临时数据；岗位库保存流程明确后再决定由 UI 还是 Agent 执行。

### 5.4 Todo

Todo 是当前 Run 的执行清单，不属于整个 Session，避免旧目标污染新任务。MVP 保留：

```text
CreateTodo
UpdateTodo
ReadTodo
```

`CreateTodo` 的工具描述必须明确：

> 为当前 Run 创建 Todo。只有当用户目标、预期交付物和必要范围已经明确时才能使用；存在关键歧义时应先提问，简单单步任务不得创建 Todo。

推荐 Input：

```ts
interface CreateTodoInput {
  todos: Array<{
    title: string;
    description?: string;
  }>;
}
```

一次允许创建 1–10 条，每个 Run 最多 20 条。ID、顺序和初始状态由系统生成；默认状态为 `pending`。

状态只保留：

```ts
type TodoStatus = 'pending' | 'inProgress' | 'completed' | 'cancelled';
```

允许的状态转换：

```text
pending → inProgress | cancelled
inProgress → completed | cancelled
```

`completed` 和 `cancelled` 为终态。Todo 不设置 `blocked`；缺少用户输入时由 Run 进入 `waiting_user_input`，需要确认时进入 `waiting_confirmation`，其他阻断进入 `paused`，当前 Todo 可以继续保持 `inProgress`。

`ReadTodo` 不拆成 List/Get。Todo 数量有界，因此一次返回当前 Run 的完整列表、revision 和各状态计数。`CreateTodo`、`UpdateTodo` 成功后也返回最新完整列表，避免模型立即重复读取。

第一阶段不把 Todo 状态自动注入 Context，也不由 Harness 强制模型调用 `ReadTodo`。通过 Trace 观察：

- 明确多步骤任务是否主动创建 Todo。
- 恢复、压缩或等待后是否主动读取进度。
- 是否遗漏状态更新或在未完成时提前宣称完成。
- 是否对简单单步任务滥用 Todo。

在得到基线数据前，不增加自动注入或强制读取，以免掩盖模型的自然 Todo 管理能力。

### 5.5 用户交互

`AskUserQuestion` 是结构化等待入口。工具返回统一 wait disposition，Loop 持久化问题后进入 `waiting_user_input`，而不是继续请求模型或保持悬空 Promise。

## 6. 与当前工具的迁移关系

| 当前名称 | MVP 处理 |
| --- | --- |
| `Read` | 保留；严格定义为授权 UTF-8 文件读取 |
| `Glob` | 保留；不改为 Project 特定工具 |
| `Grep` | 保留；不改为 Project 特定工具 |
| `ReadProfile` | 保留 |
| 当前无 `UpdateProfile` | 新增 `UpdateProfile` |
| `ReadResume` | 保留 |
| `CreateResume` | 保留；确认阶段由 Harness 管理 |
| `EditResume` | 更名为 `UpdateResume`，改为结构化 patch |
| `AskUserQuestion` | 保留，统一 wait disposition |
| `TaskCreate` | 更名并调整为批量 `CreateTodo` |
| `TaskUpdate` | 更名为 `UpdateTodo` |
| `TaskList` / `TaskGet` | 合并为一个 `ReadTodo` |
| 当前无岗位搜索 | 新增 `SearchJobs`、`ReadUrl` |

迁移时 Todo 从 Session 级 Task 转为 Run 级实体，需要显式数据迁移或仅对新 Run 启用，不能把旧会话任务静默归入错误 Run。

## 7. Schema 策略

内部采用受限 JSON Schema 2020-12 子集：

- 允许：`type`、`properties`、`required`、`additionalProperties: false`、`enum`、`items`、`min/max`、`minLength/maxLength`、`pattern` 和受控 `format`。
- 默认禁止：远程 `$ref`、递归 Schema、复杂 `oneOf/anyOf/allOf`、动态关键字和 Provider 不一致的扩展。
- 顶层必须是 object，所有写工具必须 `additionalProperties: false`。
- 字符串、数组、对象深度和总字节数均有上限。
- Input 和 Output 都有 Schema；Provider 只看到 Adapter 下编译后的 Input Schema。

建议以 TypeScript 类型 + Zod 作为开发源，构建时生成规范化 JSON Schema，再由 AJV 运行时校验，并增加生成物一致性测试。

## 8. 调用校验管道

任何一步失败都不调用实现：

1. 聚合 Provider 的完整工具调用和参数增量。
2. 校验调用数量、名称、参数字节数和 JSON 深度。
3. 用 `ScenarioSnapshot.toolIds` 查白名单。
4. 解析 JSON；拒绝重复键、非有限数字和原型污染键。
5. 按内部 Input Schema 校验。
6. 执行业务语义校验：资源归属、revision、Run ID 和路径授权。
7. Harness 计算 `allow | deny | require_confirmation | pause`。
8. 为写调用建立业务幂等键和 Tool Ledger。
9. 调度并执行，传入 `AbortSignal`、deadline、actor 和授权依据。
10. 校验 Output Schema，脱敏、限长并生成 Tool Receipt。

Provider 的 strict tool calling 只能提高参数命中率，不能替代上述步骤。

## 9. 参数纠正

只允许确定性、无语义猜测的规范化。以下行为禁止自动纠正：

- 把任意字符串猜成资源 ID。
- 为写工具补造缺失字段。
- 删除未知字段后继续写入。
- 将模糊自然语言确认转换为授权。
- 因 Schema 不兼容而放宽 `additionalProperties`。

无效调用返回结构化 issue，同一错误指纹只给模型一次修正机会；第二次仍失败则暂停或转为用户可操作错误。

## 10. 并发调度

- 只有 `sideEffect = none`、`parallel_safe` 且资源键不冲突的调用可以并行。
- 写操作、确认、提问、动态权限变化和 Context 刷新都是屏障。
- 同一资源的读取可以在相同 revision 上并行；任一写入后必须刷新快照。
- 结果按 Provider 原始 tool call 顺序追加，不按完成时间排列。

示例：

```text
批次：[ReadProfile, ReadResume, Read, UpdateResume, UpdateTodo]

阶段 A：ReadProfile ─┐
       ReadResume  ──┼─ 并行读取
       Read        ──┘
阶段 B：UpdateResume    串行写入并刷新 resume revision
阶段 C：UpdateTodo      串行写入 run:todos
```

若某个节点进入 `waiting_*`，屏障后的工具全部标记 `SKIPPED_AFTER_WAIT`，不得继续产生副作用。

## 11. 超时、取消与幂等

- 每个工具接收 `AbortSignal` 和绝对 deadline；只使用 `Promise.race` 不算真正取消。
- 读工具超时可以按策略重试一次；写工具只有在相同业务幂等键下才能查询或重放。
- 幂等键至少包含 `sessionId + runId + toolDefinitionId + proposalHash`，由 Harness 生成。
- Tool Ledger 在执行前写 `started`，完成后写 `succeeded/failed/status_unknown` 和回执。
- 超时后无法证明副作用未发生时标记 `STATUS_UNKNOWN`，先对账，不自动再次写入。
- 用户取消只阻止未开始和可取消动作；已提交事务以最终仓储状态为准。

## 12. 工具结果协议与限长

```ts
interface ToolEnvelope<T> {
  ok: boolean;
  code: string;
  data?: T;
  receipt?: {
    receiptId: string;
    toolDefinitionId: string;
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

- 结果始终保持合法结构，不能按字符硬切 JSON。
- 列表和搜索结果使用注册表中的最大条数与游标分页。
- 文本按行、段落或结构边界裁剪，返回省略量和 artifact reference。
- 敏感字段在写入 Trace 和返回模型前分别脱敏。

## 13. 测试清单

- 模型可见工具名全部符合 PascalCase 规则且跨 Provider 可接受。
- 默认场景按意图进一步收窄工具，不暴露任何投递或浏览器能力。
- 投递场景处于禁用占位，不能创建 Run 或继承默认场景工具。
- `Read`、`Glob`、`Grep` 可以访问授权虚拟挂载，但不能路径逃逸、读取非法 UTF-8 或敏感文件。
- `SearchJobs`、`ReadUrl` 不能访问 localhost、内网、文件协议或携带用户 Cookie。
- 岗位搜索结果不会自动写入岗位库。
- `CreateTodo` 在目标含关键歧义或单步任务中不应被模型调用。
- Todo 不出现 `blocked`，Run 等待/暂停状态与 Todo `inProgress` 可以并存。
- 无 Todo 自动注入时记录主动读取率、进度遗漏率和提前完成率。
- Preview/Commit 不作为模型工具；确认后执行的参数与 proposal hash 完全一致。
- 并行读结果顺序稳定；写屏障后读取到新 revision。
- 超时写入会对账，不产生第二次提交。
- 重启后相同幂等键返回原 receipt。

## 14. 总结

MVP 工具集优先使用少量、高辨识度的 PascalCase 工具。`Read`、`Glob`、`Grep` 是通用 UTF-8 文件只读能力，来源差异由虚拟挂载和端口授权处理；简历、档案、岗位搜索和 Todo 只在权限、Schema 或副作用真正不同的地方拆分。确认阶段属于 Harness，投递场景暂不实现，Todo 先在无自动注入条件下验证模型自身的进度管理能力。
