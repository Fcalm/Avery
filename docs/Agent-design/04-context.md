# Context：上下文预算、工具结果与压缩

## 1. 核心定义

Context 不是数据库，也不是完整会话。它由“Session 首次建立的稳定前缀快照”和“每次模型请求追加的动态 transcript”共同组成；两者都从持久化事实派生，但刷新周期不同。

必须分开保存：

- `Conversation Store`：完整可见消息和完整工具调用组。
- `Business Store`：简历、档案、岗位、任务、权限和 revision 的事实源。
- `Tool Ledger`：调用参数哈希、执行状态、回执和对账结果。
- `Memory Store`：版本化结构化记忆和压缩摘要。
- `Request Context`：一次发给 Provider 的派生数据，可重建但不作为事实源。

## 2. Context 组成

按稳定到动态的顺序：

1. 编译后的 System Prompt Manifest。
2. 当前版本与场景快照实际启用的工具定义；`disabled_draft` 工具不得进入 Context。
3. 会话级结构化记忆：目标、已确认事实、决策、未完成工作。
4. 当前 Run 业务快照：岗位、Profile、项目授权和简历绑定元数据；简历正文只通过 `ReadResume({resumeId})` 工具结果渐进披露，不自动注入；确认模式由 Runtime Reminder 追加。
5. 已压缩的早期对话摘要及来源范围。
6. 最近完整用户轮次，包含不可拆分的工具调用组。
7. 当前 Run 已产生的工具结果。
8. 当前用户输入与附件引用。

Provider 必需的连续性状态由 Adapter 生成。例如某些推理模型要求在工具调用链中回传特定字段，该字段属于 Provider continuity，不等同于可见会话或通用记忆。

## 3. 不可变快照

工作场景每轮另附宿主本次读取的 `browserConnection`，只包含检测时间、浏览器类型、连接状态与协议版本，不保存为历史。当前握手事实更新历史断线信息；用户继续任务且连接恢复后，可用导航／观察重新核实页面。结果未知的外部写操作仍需对账，不自动重放。

浏览器接管后恢复时，若宿主仍持有该会话授权的任务页，首次模型请求前先读取全量页面观察，作为临时 `browserObservation` 一并发送。无法取得观察时明确保留未知或当前阻塞原因；不把旧登录提示当成当前事实，不重放旧动作。观察取消后不进入模型或持久历史。

```ts
interface ContextSnapshot {
  snapshotId: string;
  runId: string;
  sessionRevision: number;
  scenarioSnapshotId: string;
  promptManifestHash: string;
  toolManifestHash: string;
  businessRevisions: Record<string, number | string>;
  memoryVersion?: number;
  transcriptRange: { fromEvent: number; toEvent: number };
  attachments: Array<{ uri: string; contentHash: string }>;
  budgetReport: ContextBudgetReport;
  compiledHash: string;
}
```

构建期间任一关键 revision 改变时，快照作废并重新准备；简历绑定记录只保存 ID、revision 和绑定时间，不复制正文。依赖工具执行前重新读取当前 revision，不能把新简历内容和旧 revision 拼成一个请求。

SessionPrefixSnapshot 原子冻结 Scenario、Prompt Manifest 与 Tool Manifest；每个 RunSnapshot 引用该 Session 快照，并冻结本 Run 的 DataScope、Provider/模型与预算。发送前不得重新读取“最新工具列表”替换快照定义，否则仍会产生混合版本。

### 3.1 SessionPrefixSnapshot

Session 首次实际使用时一次性生成完整稳定前缀，包含编译后的 System Prompt、Session Context、Tool Schema/顺序及对应哈希。后续点击发送只创建新 Run，复用相同 Session 前缀，不按 Run 重新编译。

快照只允许在以下两个边界重建：

1. 快照创建满 24 小时后的下一次新 Run；运行中的 Run 不热替换。
2. 用户显式执行 `/reload`。

场景切换会创建新 Session，不属于 `/reload`。模型切换可能使 Provider 前缀缓存未命中，但不会重建 Session 快照。Provider 自身缓存可能早于 24 小时失效，此时重新发送字节一致的前缀即可，不为了供应商缓存失效改写本地快照。

不引入 `ContextCacheEpoch`。独立 epoch 只有在需要让多个缓存消费者比较“逻辑代际”时才有价值；当前 `snapshotId + compiledHash + createdAt + expiresAt + sessionRevision + refreshReason` 已能回答身份、内容、有效期和刷新原因，额外 epoch 只会形成第二事实源。

Runtime Reminder 位于稳定前缀之后，以 `user` 角色 append-only 追加。正常追加不得删除或替换旧 reminder，否则会同时破坏语义历史和 Provider 前缀缓存。只有显式 Context 压缩会重写后续消息视图，并明确造成缓存失效。

Skill 完整快照与 Session revision 一起冻结，但索引不进入 system role。当前快照第一次真正发送时，宿主在真实用户消息前追加一次 `<skill-index>` user 消息；显式 `/<skill-name>` 的正文位于真实用户消息后。TTL 到期或 `/reload` 后追加 `skill-state-reset`，下一次发送再追加新版索引，旧消息不就地修改。

### 3.2 Skill 三级披露

1. 索引层只包含标准 `name`、内容派生版本和 `description`，不包含正文与资源内容。
2. 主说明层通过 `/<skill-name>` 或 `LoadSkill({ skillId })` 加载冻结的 `SKILL.md`。
3. 资源层只有在主说明已加载后，才能通过 `LoadSkill({ skillId, resource })` 读取该 Skill 的 `references/` 冻结资源。

项目内 Skill 遵循通用目录格式：目录名使用小写连字符并与 `SKILL.md` frontmatter 的 `name` 一致；`name` 和 `description` 是必填字段，不再使用额外的 `manifest.json`。Avery 特有的场景限制放在可选的 `metadata.avery.scenarios` 中，缺省时只在 `default` 场景披露。`references/` 下的 UTF-8 文件由宿主自动发现并随会话快照冻结。

Snapshot 保存完整正文、资源和内容哈希，普通 Run 不重新读取磁盘。Skill ID 使用小写字母、数字和连字符；资源只能来自该 Skill 的 `references/` 目录。Backend 通过 realpath、UTF-8、文件数量、单文件和聚合大小限制阻止目录逃逸与无界上下文。Skill 是知识包而不是权限包，实际能力仍由冻结场景白名单、确认策略、资源授权和 Harness 共同决定。

## 4. Token 预算

`contextLimit` 由 Provider 统一解析：默认目标为 256K，并以模型能力上限钳制；用户在 API 配置中开启自定义限制时使用经 Provider 校验的自定义值。Context 与 Kernel 不维护第二份模型能力表。

```text
inputBudget = contextLimit - min(8192, contextLimit * 10%)
trigger = inputBudget * compressionThreshold / 100
```

沿用 Provider 设置的阈值。估算包括编译后的 system、工具定义、会话与动态上下文、历史及当前输入；每次业务模型调用前检查。估算是启发式预判，不保证等于供应商 tokenizer。

近期原文空间以 `min(inputBudget * 50%, trigger * 70%)` 为目标，扣除固定内容及摘要余量；手动压缩还限制为历史估算的 25%。这些是空间预算，不是固定保留轮数。当前用户原文、有效 Skill、最新运行提醒不静默截掉；放不下时暂停。

## 5. Token 计数

优先级：

1. Provider 官方 tokenizer/count API，且与当前模型一致。
2. 已验证的本地 tokenizer。
3. 字符启发式估算，并增加安全系数。

预判估算可以用于压缩，但必须标记 `estimated`。UI Usage 和计费事实仍只使用 Provider 响应中的真实 usage；两者不能共用一个字段。

```ts
interface TokenMeasurement {
  value: number;
  kind: 'provider_count' | 'local_tokenizer' | 'estimate';
  model: string;
  safetyMarginPercent: number;
}
```

## 6. 工具结果限长

每个工具在注册表中声明 `maxOutputBytes`、`maxRecords` 和可分页性。Context Builder 再施加本次请求总预算。

限长顺序：

1. 工具端先过滤无关字段、敏感字段和重复值。
2. 列表按相关性和稳定次序取前 N 条，并返回总数/省略数。
3. 文本按行、段落、页或 AST 节点裁剪，不从任意字节切断。
4. 大结果保存为本地 artifact，Context 只放摘要、哈希、来源和引用。
5. 仍超预算时要求模型选择页、文件或范围，不能继续隐式扩容。

示例：

```json
{
  "ok": true,
  "data": {
    "matches": [{ "path": "src/a.ts", "line": 12, "text": "..." }]
  },
  "pagination": { "cursor": "opaque-cursor", "hasMore": true },
  "truncation": {
    "truncated": true,
    "omittedCount": 138,
    "artifactRef": "artifact://tool-result/sha256"
  }
}
```

禁止把 JSON 序列化后直接 `slice`，这会产生无效结果或隐藏截断事实。

## 7. Transcript 原子组

普通历史读取仍可使用完整 `TurnGroup`；压缩以完整工具批次为最小单位，允许在同一复杂用户轮次内总结早期步骤：

```text
user message
assistant text/reasoning summary + tool calls
tool results (all call IDs paired)
assistant continuation
```

不允许：

- 单独保留 tool result 而丢掉 tool call。
- 保留 tool call 但丢掉结果，并让 Provider 误以为仍待执行。
- 仅按最后 40 条消息截取。
- 在一个未完成工具批次中间生成摘要并移除 Provider 必需状态。

取消、异常退出或工具预算耗尽后，每个已接受的调用仍需有配对回执。已结算结果保留；尚无可提交回执的中断调用由程序补充 `TOOL_RESULT_MISSING`，明确业务结果未知，不等于未执行或成功，不自动重放。已有断裂历史在新 Run 请求前恢复配对，原消息和用户重试内容保留；待确认检查点仍由原 Run 的结构化恢复处理。

`skill_index`、`loaded_skill`、`loaded_skill_resource`、`skill_state_reset` 和 Runtime Reminder 都是合成 user 消息，不建立新的真实用户 TurnGroup。位于首条真实用户消息之前的合成消息作为 `prefixMessages` 保持原顺序附着于该组。

## 8. 结构化记忆

压缩前先维护可验证的结构化记忆：

```ts
interface SessionMemory {
  version: number;
  goals: Array<{ text: string; status: string; sourceEventIds: string[] }>;
  confirmedFacts: Array<{ key: string; value: unknown; sourceRefs: string[] }>;
  decisions: Array<{ decision: string; rationale?: string; sourceEventIds: string[] }>;
  constraints: Array<{ text: string; source: 'user' | 'policy' | 'business' }>;
  pendingWork: Array<{ text: string; sourceEventIds: string[] }>;
  pendingInteractions: string[];
  toolOutcomes: Array<{ receiptId: string; summary: string }>;
}
```

记忆不是让模型随意改写的事实表。模型可提出候选，Harness 根据消息、业务仓储和 Tool Receipt 验证后提交。个人事实若来源冲突，保留冲突和来源，不自动选择“较新说法”。

第一阶段不把 Run Todo 快照自动注入 Context，也不在结构化记忆中复制 Todo Store。模型只能从既有工具结果或主动调用 `ReadTodo` 获取进度；Trace 记录其主动读取率、进度遗漏率和提前完成率，再决定是否需要自动注入。

Run 存在待确认简历草稿时，Context 必须保留 `draftId`、`contentHash`、`baseRevision`、带 `【待确认】` 的原始条目和用户已经确认/修改/删除的选择。压缩不得移除标签、合并不同待确认项或把未确认内容写成已确认事实。

## 9. 压缩触发与流程

预计输入达到预算乘以 Provider 保存的压缩阈值时触发；压缩后再次估算，候选必须比原视图更小且低于触发线。

顺序：

1. 识别可重建的派生内容；正常追加路径不得就地删除或替换旧 Runtime Reminder，只有本次明确进入压缩流程时才可重建消息视图并记录缓存失效。
2. 按预算选择近期原文，工具调用和全部回执完整配对；保留浏览器增量时必须同时保留完整依赖链，否则整链进入摘要。
3. 将早期历史规范化为数据供摘要阅读，不重放旧工具协议或隐藏推理。过大消息可分片阅读，原文完整保留；最多八次摘要请求。
4. 生成目标约束、关键事实、当前状态、浏览器任务、问题纠正与下一步摘要，参考保留尾部的最新纠正。
5. 附带程序事实源中的任务与动作回执状态；摘要不构成权限或事实源。语义检查依赖提示词与场景测试，当前未实现逐字段自动保真验证器。
6. 校验摘要非空、长度及压缩后完整预算，异步归档原文，然后持久化替换视图；失败回退旧视图。
7. 压缩后操作页面前重新观察，首次快照返回 full；不把摘要中的旧元素引用用于执行。

压缩还必须固定保留最新 Skill 索引、最近一次 `skill-state-reset`，以及 reset 之后每个已加载 Skill/资源的最新完整正文。不能只保留 reminder 中的 `Loaded skills` 列表而丢掉实际指令。

摘要不得直接覆盖原始历史；原始事件仍保存在本地，用于恢复、审计和重新压缩。

手动 `/compact [instructions]` 只允许空闲会话。Agent 先结合历史优化用户要求，仅提示词要求一次 `CompactContext` 调用，工具选择保持 auto，沿用当前思考设置。原始后缀不直传摘要模型；单次有效调用之外均失败，不执行业务工具。归档按会话与摘要 ID 隔离，可在后续定向压缩时展开来源；删除会话同时删除对应归档。

## 10. 压缩失败

- 首次摘要失败：允许一次受控重试，仍使用相同原文；参数或认证错误不重试。
- 仍失败或预算超限：Run 进入 `paused`，保留历史与当前浏览器任务页，提示缩小范围、重试压缩或新建会话。
- 取消、归档失败或保存失败不发布候选视图；手动命令保留输入草稿。
- 不允许静默删除最早五轮后继续，也不允许把压缩错误伪装成正常回复。

确定性丢弃仅限可证明可重建的派生内容，例如重复快照或已有完整 artifact 的展示片段；所有丢弃都记录 manifest。

## 11. Prompt Injection 与隐私

- 所有外部文本带 `sourceType/sourceId/contentHash/trustedAs=data`。
- 0.2.0 不存在岗位网页数据来源；用户粘贴的 JD 仍按普通不可信文本处理，不能转换成网络访问授权。
- 0.3.0 若启用 `ReadUrl`，Context 只接收经过网络端口验证、限长后的预览信封，并保留原始/最终 URL、抓取时间、哈希和截断状态；页面中的链接或指令不能触发第二次网络调用。
- 项目文件、附件和工具结果中的指令不参与 Prompt 编译。
- 敏感扫描发生在发送 Provider 前；命中密钥、私钥或明确排除路径时停止并报告。
- 只向 Provider 发送完成当前目标所需字段，避免把整份 Profile 或全部项目文件作为默认上下文。
- Trace 保存引用、长度、哈希和脱敏摘要；绝对路径、API Key、Authorization 和不必要正文不落 Trace。

## 12. 验证清单

- 相同快照输入产生稳定 `compiledHash`。
- 同一 Session 的普通 Run 复用同一 `SessionPrefixSnapshot`；24 小时和 `/reload` 之外不重建。
- Provider 缓存过期或模型切换不修改本地快照；场景切换创建新 Session。
- 旧 Runtime Reminder 在未压缩 transcript 中保持 append-only，Provider 请求中 metadata 已剥离。
- Skill 索引只在当前快照首次发送时注入；普通 Run 不重复，且不进入 system role。
- 压缩后仍保留有效 Skill 的最新正文，Skill 合成消息不增加真实用户 TurnGroup 数量。
- Scenario/Prompt/Tool/DataScope/Provider 使用相同 Run snapshot revision；运行中重载不会混入当前请求。
- 0.2.0 Context 不包含 `SearchJobs`、`ReadUrl` Schema 或任何岗位网络结果。
- 预算计算为 Prompt、工具 Schema、消息和协议开销分别记账。
- 同一用户轮次内也可压缩已完成工具批次，保留调用与回执配对。
- 压缩前后 confirmed facts、pending interaction、权限和 receipt 集合一致。
- 大工具结果分页后始终是合法 JSON，且显示省略量。
- Provider Usage 缺失时 UI 为未知，压缩预估值不冒充真实 usage。
- 文件中的提示注入不会进入可信 Prompt 层。
- 摘要失败两次后暂停，不静默丢历史。

## 13. 总结

Context 是有预算、可追踪、可重建的请求快照。完整历史和业务事实保留在各自存储中；压缩只替换模型输入视图，不改写事实。工具结果通过分页与 artifact 引用控制规模，任何截断和摘要都必须显式、可验证、可回溯。
