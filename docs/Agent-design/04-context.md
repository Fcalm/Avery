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
4. 当前 Run 业务快照：选中简历、岗位、Profile、项目授权；确认模式由 Runtime Reminder 追加。
5. 已压缩的早期对话摘要及来源范围。
6. 最近完整用户轮次，包含不可拆分的工具调用组。
7. 当前 Run 已产生的工具结果。
8. 当前用户输入与附件引用。

Provider 必需的连续性状态由 Adapter 生成。例如某些推理模型要求在工具调用链中回传特定字段，该字段属于 Provider continuity，不等同于可见会话或通用记忆。

## 3. 不可变快照

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

构建期间任一关键 revision 改变时，快照作废并重新准备；不能把新简历内容和旧 revision 拼成一个请求。

SessionPrefixSnapshot 原子冻结 Scenario、Prompt Manifest 与 Tool Manifest；每个 RunSnapshot 引用该 Session 快照，并冻结本 Run 的 DataScope、Provider/模型与预算。发送前不得重新读取“最新工具列表”替换快照定义，否则仍会产生混合版本。

### 3.1 SessionPrefixSnapshot

Session 首次实际使用时一次性生成完整稳定前缀，包含编译后的 System Prompt、Session Context、Tool Schema/顺序及对应哈希。后续点击发送只创建新 Run，复用相同 Session 前缀，不按 Run 重新编译。

快照只允许在以下两个边界重建：

1. 快照创建满 24 小时后的下一次新 Run；运行中的 Run 不热替换。
2. 用户显式执行 `/reload`。

场景切换会创建新 Session，不属于 `/reload`。模型切换可能使 Provider 前缀缓存未命中，但不会重建 Session 快照。Provider 自身缓存可能早于 24 小时失效，此时重新发送字节一致的前缀即可，不为了供应商缓存失效改写本地快照。

不引入 `ContextCacheEpoch`。独立 epoch 只有在需要让多个缓存消费者比较“逻辑代际”时才有价值；当前 `snapshotId + compiledHash + createdAt + expiresAt + sessionRevision + refreshReason` 已能回答身份、内容、有效期和刷新原因，额外 epoch 只会形成第二事实源。

Runtime Reminder 位于稳定前缀之后，以 `user` 角色 append-only 追加。正常追加不得删除或替换旧 reminder，否则会同时破坏语义历史和 Provider 前缀缓存。只有显式 Context 压缩会重写后续消息视图，并明确造成缓存失效。

## 4. Token 预算

```text
inputBudget = contextLimit
            - reservedOutputTokens
            - providerProtocolReserve
            - toolGrowthReserve
```

默认建议：

- `reservedOutputTokens`：取模型输出上限与上下文的 15% 中较小的合理值，但不少于场景最低输出需要。
- `providerProtocolReserve`：5%，用于 Provider 包装、未知 tokenizer 偏差和结束事件。
- `toolGrowthReserve`：10%，工具场景用于后续工具结果；无工具请求可回收。

在 `inputBudget` 内的初始软配额：

| 部分 | 建议上限 | 超限处理 |
| --- | ---: | --- |
| Prompt + Tool schemas | 20% | 减少场景工具、压缩描述；不裁剪安全规则 |
| 结构化记忆与业务快照 | 20% | 按字段重要性和当前目标选取 |
| 早期摘要 | 15% | 重新压缩并保留不变量 |
| 最近完整轮次 | 35% | 至少保留最近 5 个完整用户轮次；预算不足时先收缩其他部分或暂停，不能减少到 5 轮以下，也不能拆工具组 |
| 当前工具结果 | 10% | 分页、结构化裁剪或 artifact reference |

这是软配额，未使用部分可按优先级回收。当前用户输入、待确认提案和最近失败信息具有高优先级，不能因比例表被裁掉。

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

历史保留和压缩以 `TurnGroup` 为单位：

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
- 在一个未完成工具链中间生成摘要并移除 Provider 必需状态。

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

第一版在预计输入达到 `inputBudget` 的 70% 时预压缩，而不是等到 Provider 拒绝请求。场景可以降低阈值，不得自行提高；调整默认值必须更新 ADR 和压缩回归基线。

顺序：

1. 识别可重建的派生内容；正常追加路径不得就地删除或替换旧 Runtime Reminder，只有本次明确进入压缩流程时才可重建消息视图并记录缓存失效。
2. 将大型工具结果替换为带哈希的 artifact reference 和已验证摘要。
3. 将已结束的早期 TurnGroup 送入独立摘要调用。
4. 生成结构化摘要：目标、事实、决策、约束、工具结果、未完成事项、来源范围。
5. Harness 验证关键 ID、数字、日期、否定词、权限和 pending 状态未漂移。
6. 保存 `MemoryVersion`、摘要、覆盖事件范围、Prompt 版本和哈希。
7. 重新构建 Context 并复测 token。

摘要不得直接覆盖原始历史；原始事件仍保存在本地，用于恢复、审计和重新压缩。

## 10. 压缩失败

- 首次摘要失败：允许一次受控重试，携带结构化验证问题，不扩大输入范围。
- 第二次失败：尝试只做确定性去重、分页和 artifact 化。
- 仍超预算：Run 进入 `paused`，提示新建会话、缩小材料范围或选择需保留内容。
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
- Scenario/Prompt/Tool/DataScope/Provider 使用相同 Run snapshot revision；运行中重载不会混入当前请求。
- 0.2.0 Context 不包含 `SearchJobs`、`ReadUrl` Schema 或任何岗位网络结果。
- 预算计算为 Prompt、工具 Schema、消息和协议开销分别记账。
- 最近轮次按完整 TurnGroup 保留。
- 压缩前后 confirmed facts、pending interaction、权限和 receipt 集合一致。
- 大工具结果分页后始终是合法 JSON，且显示省略量。
- Provider Usage 缺失时 UI 为未知，压缩预估值不冒充真实 usage。
- 文件中的提示注入不会进入可信 Prompt 层。
- 摘要失败两次后暂停，不静默丢历史。

## 13. 总结

Context 是有预算、可追踪、可重建的请求快照。完整历史和业务事实保留在各自存储中；压缩只替换模型输入视图，不改写事实。工具结果通过分页与 artifact 引用控制规模，任何截断和摘要都必须显式、可验证、可回溯。
