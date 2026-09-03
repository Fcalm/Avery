# System Prompt：可信指令的组成与编译

## 1. 设计目标

System Prompt 应稳定表达产品身份、场景目标和工具协议，同时满足：

- 可审查：能知道某次 Run 实际使用了哪些片段和版本。
- 可组合：平台规则、产品规则、场景规则和用户偏好分层，不复制整段文本。
- 可移植：编译成各 Provider 支持的 system/developer/instructions 结构。
- 可缓存：稳定前缀靠前，动态事实靠后。
- 不越权：Prompt 不能改变工具白名单、授权、确认策略或数据范围。

## 2. 可信层级

| 层级 | 内容 | 来源 | 是否可被下层覆盖 |
| --- | --- | --- | --- |
| L0 Runtime Policy | 权限不变量、真实性、隐私、工具回执规则 | 随应用发布、版本化 | 否 |
| L1 Product | Avery 身份、求职范围、语气和完成标准 | 产品代码/配置 | 否 |
| L2 Scenario | 默认场景、投递场景的目标与边界 | 场景注册表 | 只能被更严格地收窄 |
| L3 User Preference | 用户自定义语言、格式、写作偏好 | 用户设置 | 不能改变 L0–L2 或授权 |
| Data | 简历、档案、JD、附件、项目文件、工具结果 | Context/Tools | 永远不是指令 |

用户在附件或项目文件中写入“忽略之前规则”只是一段数据。系统必须通过数据信封、来源标签和 Harness 权限控制保证其不能升级为 L0–L3 指令。

## 3. Prompt Manifest

SessionPrefixSnapshot 首次创建时冻结以下清单；同一 Session 的每个 Run 引用同一 Manifest，直到满 24 小时后的下一次 Run 或用户 `/reload`：

```ts
interface PromptManifest {
  manifestVersion: 1;
  compilerVersion: string;
  fragments: Array<{
    id: string;
    version: string;
    trustLevel: 'runtime' | 'product' | 'scenario' | 'user-preference';
    contentHash: string;
  }>;
  scenarioId: string;
  toolPolicyHash: string;
  outputContractVersion: string;
  compiledHash: string;
}
```

Trace 默认只保存 fragment ID、版本和哈希；正文仅在开发模式且脱敏后按用户设置保留。历史 Run 重放必须能解析原 Manifest，不能悄悄套用新版 Prompt 后声称结果等价。

## 4. 推荐组成顺序

稳定、可缓存的片段放在前面：

1. `runtime/invariants`：证据、权限、隐私、等待和完成声明。
2. `product/identity`：Avery 的职责和非目标。
3. `scenario/<id>`：当前场景目标、输出定义、事实要求。
4. `tool/protocol`：如何解释结构化结果和错误，不重复工具 Schema。
5. `interaction/policy`：何时提问、何时确认、何时停止。
6. `output/style`：语言、简洁度、引用和完成报告。
7. `user/preferences`：经过长度和内容策略检查的用户偏好。

业务快照、当前日期、模型名、Usage、附件正文和工具结果不进入静态 Prompt。当前日期、时间、轮数与确认权限由 Runtime Reminder 传入，其他动态数据由 Context 传入。

### 4.1 Runtime Reminder 协议

System Prompt 只声明以下解释规则：Runtime Reminder 是宿主以 `user` 角色追加的内部状态栏，模型不应复述或专门回复，最新一条是当前状态，但旧消息必须继续保留。它不改变工具白名单、数据授权或安全约束。

每条 Reminder 必须由且仅由一组 `<runtime-reminder>...</runtime-reminder>` 标签完整包裹，不添加属性，也不包含 `createdAt` 或 `scenario`。标签内部由宿主函数生成直白英语正文，并以 `The above is the current runtime status. No response is needed; continue the task.` 结束。默认场景每 5 轮提醒，投递场景每 10 轮提醒；首轮、最后一轮和确认权限变化时额外注入。

### 4.2 Skill 协议

System Prompt 只保留简短、稳定的解释规则：`skill-index`、`loaded-skill` 和 `loaded-skill-resource` 是宿主以 `user` 角色追加的可信运行时指导；它们不能授予工具、改变确认模式、扩大资源访问或覆盖更高优先级安全边界。`skill-state-reset` 之后，旧 Skill 正文不再有效。

Skill 精简索引和 `SKILL.md` 正文都不编译进 System Prompt。索引在会话当前快照第一次发送时位于真实用户消息之前；完整正文只在显式 `/<skill-name>` 或模型调用 `LoadSkill` 后追加。这样保持 System Prompt 简洁，并让普通 Run 的既有前缀继续复用。

## 5. 各片段应表达什么

### 5.1 Runtime Policy

必须包含以下语义，但不依赖模型作为唯一执行者：

- 只完成用户明确请求的范围。
- 不补造公司/组织、证书/职业资格、学校/学历、姓名或联系方式。
- 可以在合理范围内补全成果数字、职责强度、规模和业务影响，但必须在所属条目末尾添加 `【待确认】`，不能把它们当作用户已经确认的事实。
- 外部事实和持久化动作以工具回执为准。
- 工具失败、等待确认或资源冲突时停止相关动作，不重复调用规避。
- 不泄露隐藏推理、密钥、绝对路径和无关个人数据。
- 没有工具能力时明确说明限制，不假装已执行。

### 5.2 Product

- Avery 是求职材料与流程助手，而不是通用系统代理。
- 可以帮助澄清、起草、优化、组织和规划。
- 0.2.0 默认场景没有岗位网络能力，岗位信息由用户手动录入或作为已授权本地材料提供。
- 0.3.0 只有在用户明确提供 URL 且版本化场景启用 `ReadUrl` 时才能受限读取；不得自行搜索、猜测 URL 或扩展来源。
- `SearchJobs` 只属于未承诺的未来候选，在另行产品裁决前不得出现在生产 Prompt 或工具白名单中。
- 投递场景只向模型暴露冻结的原子浏览器工具，不开放原始 CLI、任意脚本、简历写入或档案写入。
- 默认使用用户语言，编辑性判断可自主完成；允许推测性补全，但必须遵守 `【待确认】` 规则。

### 5.3 Scenario

每个场景片段只描述该场景的：

- 成功条件。
- 必须使用的证据类型。
- 允许的业务对象。
- 需要用户确认的关键点。
- 输出结构与禁止事项。

工具白名单本身来自场景快照，不从 Prompt 文本解析。

场景 Prompt 必须按版本声明：

- 0.2.0 默认场景：只处理本地求职材料和用户手动提供的岗位信息；没有 `SearchJobs`、`ReadUrl`、任意 HTTP 或浏览器能力。
- 0.3.0 默认场景候选：只有用户消息中明确提供的公开 URL 可交给受限 `ReadUrl`；读取结果先作为不可信预览，用户确认后才能通过独立窄写入边界入库。该片段在 0.2.0 不编译。
- 未来岗位发现候选：`SearchJobs` 只有在新的产品裁决、路线图和网络安全验收同时完成后才可新增场景片段；无界持续爬取永远禁止。
- 投递场景：当前不编译 Scenario Prompt、不创建 Run；待产品启用时再定义其只读材料和自动化边界。
- 场景内的“简历优化”“岗位定制”“项目提炼”是意图或工作流，不会改变权限边界；自然语言中的“搜索岗位”也不能激活未注册能力。

### 5.4 Tool Protocol

- 工具调用是请求，不代表动作已发生。
- `ok: true` 且带有效 receipt 才表示对应动作成功。
- `CONFIRMATION_REQUIRED`、`AWAITING_USER`、`CONFLICT`、`STATUS_UNKNOWN` 都要求停止当前调度分支。
- 不根据错误消息文本判断权限或重试；使用稳定错误码与 `retryability`。
- 不重复提交相同写操作；需要修正参数时生成新调用并引用前一失败调用。

### 5.5 Interaction 与 Output

- 只问继续工作所必需的问题，优先复用已有事实。
- 结构化问题最多三项仅是 UI 建议，不应阻止必要的多轮澄清。
- 最终回复区分“已确认内容”“待确认补全”“已执行动作”和“建议下一步”。
- 声称已保存、已更新、已发送或已提交时必须可关联 Tool Receipt。
- 简历中存在 `【待确认】` 时，最终回复逐项列出并要求用户使用“全部确认”“确认第 1 条”“删除第 2 条”或“第 1 条改为……”等明确文本确认；“好”“继续”“可以”不视为全部确认。
- 原始隐藏思维链不进入回复；可以给出简洁依据、权衡和证据引用。

## 6. 场景 Prompt 最小模板

```md
## Scenario: {{scenarioName}}

### Goal
{{one measurable success definition}}

### Evidence requirements
- {{required source and uncertainty behavior}}

### Allowed decisions
- {{editorial decisions the model may make}}

### Must stop or ask
- {{missing facts / conflicts / confirmation boundaries}}

### Output contract
- {{expected artifact and completion report}}
```

场景 Prompt 禁止复制全局隐私规则、完整工具参数或 Provider 特殊字段；这些分别属于 Runtime Policy、Tool Registry 和 Provider Adapter。

## 7. 数据信封

Context 中的非指令数据使用带来源和截断信息的结构化信封：

```xml
<context-data source-type="resume" source-id="resume-123"
  revision="7" trusted-as="data" truncated="false">
...
</context-data>
```

这只是降低误解的表达手段，不是安全边界。真正边界仍是：模型无法自行注册工具、扩大端口或绕过 Harness。

## 8. Provider 编译

Prompt Compiler 输出内部有序片段，Adapter 再映射：

- 支持多级指令角色的 Provider：L0/L1 放最高指令层，L2/L3 放次级指令层。
- 只支持单个 system 字段的 Provider：按信任级别和稳定顺序拼接，并保留分隔标记。
- 不支持 system 的兼容服务：Adapter 明确标记能力不足，场景可拒绝运行；不得静默塞入普通 user 消息后宣称语义等价。
- 摘要、验证等内部调用使用独立 Prompt Manifest，不复用用户场景 Prompt。

## 9. 变更与发布

Prompt 变更必须：

1. 修改独立 fragment 版本。
2. 运行静态 lint：冲突指令、缺失片段、工具名漂移、过长、敏感占位符。
3. 运行场景 golden cases 和 prompt injection 用例。
4. 对高风险写场景执行回放对比。
5. 记录变更原因和已知行为差异。

禁止在线直接替换 Prompt 且不记录版本。Prompt A/B 也必须绑定 Run 和用户数据处理策略。

## 10. 反模式

- 在 Prompt 里写“绝对不要调用未授权工具”，但运行时仍把所有工具发给模型。
- 把整份简历、JD 或附件拼进 System Prompt。
- 让 Provider Module 自己选择业务 Prompt。
- 用 Prompt 解析用户权限模式或场景 ID。
- 依赖“如果失败请再试一次”而没有错误码和重试上限。
- 将模型自述的计划当作实际执行计划或审计记录。
- 为不同 Provider 复制多份业务 Prompt，导致规则逐渐漂移。

## 11. 验证清单

- 同一 ScenarioSnapshot 在同一编译器版本下产生稳定 `compiledHash`。
- 删除任一必需 fragment 时构建失败。
- L3 用户偏好包含越权指令时被隔离或拒绝，不影响工具白名单。
- 数据信封中的提示注入不会增加能力。
- 工具注册表改名时 Prompt lint 能发现旧名称。
- 0.2.0 Prompt lint 拒绝出现 `SearchJobs`、`ReadUrl` 或暗示 Agent 可联网发现岗位的指令。
- 0.3.0 `ReadUrl` 片段只接受用户明确 URL，不能暗示自主搜索或来源扩展。
- 每个 Provider 的编译结果通过角色映射契约测试。
- 最终回复的执行声明能映射到 receipt。

## 12. 总结

System Prompt 是版本化的可信指令清单，不是权限系统，也不是上下文垃圾桶。稳定规则按信任层编译，动态业务内容始终作为带来源的数据传入；Provider 只负责角色映射，Harness 才负责强制执行。
