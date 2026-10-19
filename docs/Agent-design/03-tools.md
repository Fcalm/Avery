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
DeleteTodo
LoadSkill
```

其中 `SearchJobs`、`ReadUrl` 仅用于说明未来草案也遵循同一命名规则，不代表 0.2.0 已注册。

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
  enabled: boolean;
  lifecycle: 'active' | 'disabled_draft' | 'planned';
  introducedIn?: string;
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

只有 `enabled = true` 且 `lifecycle = active` 的定义才能进入生产 Tool Registry 和 ScenarioSnapshot。`disabled_draft` 只允许保留 Schema、威胁模型和 fixture，`GetToolDefinitions()`、Prompt 编译和执行分发表必须同时排除。

## 4. 场景白名单

### 4.1 聊天场景

聊天场景保留内部 ID `default`，用于日常问答、授权资料分析和对话内草稿，不包含业务写入、浏览器或岗位网络工具。

| 能力 | 模型可见工具 |
| --- | --- |
| UTF-8 文件读取 | `Read`、`Glob`、`Grep` |
| 档案 | `ReadProfile` |
| 简历 | `ReadResume` |
| 已有岗位库只读查询 | `ReadJobs` |
| 投递记录 | `ReadApplicationStatus` |
| Run Todo | `ReadTodo` |
| Skill 渐进披露 | `LoadSkill` |
| 用户交互 | `AskUserQuestion` |
| 定时任务 | `ReadCronTask` |

明确禁止：

- 填写申请表、上传投递材料、操作登录态或提交申请。
- `SearchJobs`、`ReadUrl`、Shell、任意 HTTP、任意 Header、任意浏览器或脚本执行。
- 项目文件写入、未授权路径访问和敏感文件读取。
- 未经 `CreateCronTask` 周期级确认的后台搜索、定时执行、URL 提取、跨来源聚合和自动写入岗位库。

白名单存在不等于本轮必须把全部工具发给模型。Host 可以根据当前意图进一步收窄，但不得加入 0.2.0 注册表之外的工具。执行入口必须再次按冻结快照校验，不能只依赖“没有把定义发给模型”。

### 4.2 版本化网络能力

| 版本 | `ReadUrl` | `SearchJobs` | 约束 |
| --- | --- | --- | --- |
| 0.2.0 | `enabled: false` | `enabled: false` | 两者不注册、不进入 Prompt、不允许执行 |
| 0.3.0 候选 | 仅用户明确 URL，满足门禁后可启用 | `enabled: false` | 受限读取、预览；确认入库走独立窄写边界 |
| 未承诺未来版本 | 需重新评审 | 需重新评审 | 仅当前 Run 的有界按需发现；无界/后台/周期搜索永久禁止 |

保留 `SearchJobs`/`ReadUrl` 草案不代表产品已承诺实现。任何启用都必须修改产品版本、ScenarioSnapshot、Prompt fragment、Tool Registry 和发布门禁，不能只切换一个配置布尔值。

### 4.3 工作场景

工作场景保留内部 ID `application`，覆盖简历与档案编辑、Todo、定时任务、岗位库和受控浏览器求职流程。交互式会话开放下列工具；无人值守运行移除四个 CronTask 工具以及 `CreateResume`、`UpdateResume`、`UpdateProfile`，执行入口再次拒绝这些调用。

```ts
{
  id: 'application',
  name: '工作',
  enabled: true,
  status: 'active',
  toolNames: [
    'Read', 'Glob', 'Grep', 'ReadProfile', 'UpdateProfile', 'ReadResume', 'CreateResume', 'UpdateResume',
    'CreateTodo', 'UpdateTodo', 'DeleteTodo', 'ReadTodo', 'AskUserQuestion', 'LoadSkill',
    'CreateCronTask', 'ReadCronTask', 'UpdateCronTask', 'DeleteCronTask',
    'ExportResumeFile', 'CollectJobs', 'ReadJobs', 'ContactBossJobs', 'ReadApplicationStatus', 'SaveJob', 'UpdateApplicationStatus',
    'BrowserNavigate', 'BrowserSnapshot', 'BrowserScreenshot', 'BrowserReadPage', 'BrowserClick',
    'BrowserFill', 'BrowserFillForm', 'BrowserValidateForm', 'BrowserSelect', 'BrowserSetChecked', 'BrowserPressKey',
    'BrowserUploadFile', 'BrowserWait', 'BrowserSwitchTab', 'BrowserGoBack'
  ]
}
```

场景在会话首次发送时冻结；切换场景必须新建会话。浏览器工具名称与执行边界见 5.4 节和 `07-browser-tools-development-plan.md`，确认权限只改变普通动作的确认频率，不扩大工具、文件或网络权限。

聊天 30 轮，工作 100 轮。三档确认策略显示为“始终确认 / 低风险自动 / 完全信任”，均不扩展场景工具或资源授权。场景白名单同时用于工具暴露和执行入口。旧策略会话须显式 `/reload` 或新建会话后继续，不自动替换冻结前缀。

`UpdateProfile` 沿用现有宿主限制：目前没有档案提案确认通道，仅交互式工作且 `fully_trusted` 时可保存；其余档位返回明确限制，不以问答或文本同意替代确认授权。

`ExportResumeFile` 属于投递场景，用于把已绑定的简历准备成可上传文件；默认场景继续通过简历页面导出文件。工具契约见 5.2 节。

`CollectJobs`与岗位页共享确定性采集和直接入库服务，仅投递场景开放，无需绑定简历。参数为`channel`、`keyword`、`targetCount`、`jobSeekingTypes`、`educations`、可选`city/sourceIds`，默认100、最多1000；BOSS沿用当前授权浏览器，企业官网省略sourceIds时使用应用维护的已启用来源。工具声明local_write、业务幂等、串行任务锁，返回taskId、实际新增/已有/失败数量及来源摘要，不返回全部JD。取消、超时和失败保留已落盘部分并等待在途写入收尾；不发送或投递。

`ReadJobs`在默认及投递场景均开放，只读持久岗位库；支持渠道、关键词、城市、求职类型、学历、视图、排序、maxResults及cursor，默认20、最多100。后续页必须保留相同筛选和数量，或单独使用jobId获取详情。列表JD上限300字符、详情20000字符，截断由truncatedFields标示；包含已有投递和BOSS联系状态。已入库岗位无需再SaveJob，旧collectionId/candidateId引用返回明确失效错误；SaveJob仍支持浏览器直接观察的完整字段模式。实现与验收见[岗位库采集规划](20-job-library-collection-development-plan.md)第5节。

`ContactBossJobs` 每次串行联系 1 至 10 个已保存的 BOSS 岗位，使用平台预设首条招呼语或冻结的自定义消息，并可向全部目标发送同一张已授权 PNG/JPEG 图片。它只接受岗位 ID、消息模式和资源 ID；URL、DOM、选择器、页面脚本与重试策略均由 Host 持有。工具要求有效简历绑定和已授权个人浏览器，并通过批次提案确认、发送前检查点、送达验证和 `uncertain` 停止规则防止重复发送。

投递防重由 Agent 负责：保存或投递前必须调用 `ReadApplicationStatus` 检查持久化记录。`SaveJob` 不创建投递记录，也不要求绑定简历；只有浏览器返回有效成功回执后才能调用 `UpdateApplicationStatus(status='applied')`，该投递记录必须绑定实际使用的简历。Harness 不猜测公司、岗位和 URL 指纹，也不把“点击过提交按钮”当成已投递事实。
`ReadApplicationStatus` 支持按公司、岗位名和 URL 定向检索；无条件读取或匹配过多时每类最多返回 200 条并显式标记 `truncated`，既避免漏查旧投递，也防止工具结果无界增长。

简历绑定按真实数据依赖判断，不作为投递场景的统一门槛：

| 分类 | 工具/操作 | 规则 |
| --- | --- | --- |
| 强制绑定 | `UpdateResume`、`UpdateApplicationStatus`、`ContactBossJobs` | 三者声明 `requiredResources: ['bound_resume']`，由 Harness 统一门禁；前者还必须匹配绑定 ID，投递状态自动写入绑定 ID，BOSS 联系批次冻结简历 revision |
| 渐进读取并绑定 | `ReadResume` | 无参数只返回无正文索引；传入索引中的 `resumeId` 才返回正文并建立会话绑定 |
| 不绑定 | `CreateResume`、`CollectJobs`、`ReadJobs`、`ReadApplicationStatus`、`SaveJob`、浏览器搜索/读取/普通交互、Todo、Skill、Profile、CronTask 管理 | 这些动作本身不以简历作为数据归属 |
| 独立文件授权 | `BrowserUploadFile` | 需要 Run 中明确授权的 `fileId`；绑定简历不会自动授权某个 PDF/图片文件 |

`CreateCronTask` 本身不强制绑定简历；只有定时任务实际执行到读取简历或写入投递记录时才检查冻结的简历授权。这样工作日定时搜索和保存岗位可以独立运行，而实际投递仍保留可追踪的简历关联。

### 4.4 CronTask 定时任务

四个 CronTask 工具在工作场景开放，聊天仅开放 `ReadCronTask`。创建任务时，只读本地问答可选择 `scenarioId=default`，浏览器或业务写入任务选择 `application`；后台工作禁止编辑简历和档案。`CreateCronTask` 只冻结提案并展示一次周期级无人值守确认；确认前不写数据库、不注册系统任务。确认后每次 occurrence 创建独立会话，以真实 `user` 消息执行，并使用 `fully_trusted + unattended`，但仍受冻结场景、Schema、资源授权、网络边界与 Tool Ledger 约束。

投递 CronTask 的创建确认同时生成个人浏览器任务授权，并持久绑定到真实 `cronTaskId`；授权冻结任务用途、导航、填表、上传、外部发送和持久资源范围。单次任务完成、周期任务结束、任务删除或用户手动撤销后不再使用。后台 Run 通过 Browser Bridge 连接或正常启动用户配置的 Chrome/Edge，由扩展创建任务标签页，不在执行时等待标签页或远程调试授权；扩展离线、浏览器启动失败、未登录或需要人工处理时暂停并保留待接管会话。旧版本任务默认不获得新版授权。

支持 `once`、`daily` 和带 `daysOfWeek` 的 `weekly` 调度；重复时间按 IANA 时区的本地日历计算。关机或休眠导致多次逾期时只补最近一次，其余写为 `missed`。系统只维护一个 `Avery Cron Runner` 唤醒任务，业务数据库保存全部计划与运行历史。无人值守 Run 不暴露四个 CronTask 工具，防止递归调度。
创建确认会明示系统可在计划时间唤醒或后台启动应用。Windows 唤醒允许电池供电时启动，且切换到电池后不中止已开始的 Run。
第一版 CronTask 不继承交互 Run 的临时附件。纯岗位搜索和网页 JD 阅读可以创建不绑定简历的投递 CronTask；若创建前已通过 `ReadResume({resumeId})` 建立绑定，创建确认会冻结该简历授权。后台 Run 仍须先调用 `ReadResume` 读取授权范围内的索引和正文，不能靠任务参数自动注入。没有冻结简历授权时，任何实际需要简历内容或投递状态写入的步骤必须转为 `needsAttention`；页面强制上传本地文件时同样必须接管，不得绕过 Run 级文件授权。

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
project://avery/package.json
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

`ReadResume({})` 返回 `id/name/revision/updatedAt/targetRoles` 索引，不包含 `content` 或正文摘要；`ReadResume({resumeId})` 才返回完整正文，并把该 ID 与 revision 绑定到当前会话。`UpdateProfile` 和 `UpdateResume` 接收结构化 patch 与 expected revision。是否展示 diff、等待确认或直接提交由 Harness 根据场景策略决定，模型不调用 Preview/Commit 工具。包含未确认 `【待确认】` 的简历草稿不能调用 `UpdateResume` 写入正式版本；Harness 必须先完成文本确认并移除已确认标签。

#### `ExportResumeFile`

供投递场景将已绑定的简历版本准备为可上传文件。桌面导出已有 PDF 的 `printToPDF` 和 PNG 的 `capturePage().toPNG()` 实现；新增工具复用这两种格式，不新增 JPEG 转码。

```ts
type ExportResumeFileInput = { format: 'pdf' | 'png' };
type ExportResumeFileOutput = {
  fileId: string;
  fileName: string;
  mimeType: 'application/pdf' | 'image/png';
  resumeId: string;
  resumeRevision: number;
  sizeBytes: number;
  sha256: string;
};
```

- 先调用 `ReadResume({resumeId})` 建立绑定；工具只使用该绑定的 ID 和 revision，从后端读取正式简历内容。不接受模型提供的正文、任意文件路径或导出目录。
- `pdf` 用于企业官网简历上传；`png` 可作为 `ContactBossJobs.imageAssetId` 向 BOSS 聊天发送。同一个 `fileId` 也可传给 `BrowserUploadFile`。
- 宿主保存导出的原始文件，登记为当前 Run 授权的文件资源，返回不暴露物理路径的 `fileId`；必须同步更新执行时的授权资源清单，使后续上传工具能实际使用该 ID。Markdown 附件快照只用于阅读，不作为上传内容。
- 导出结果绑定简历 revision 和内容哈希，保留 `.pdf` 或 `.png` 扩展名、正确 MIME 与文件头；浏览器物化副本也必须保留该扩展名。PNG 超出完整截图范围或文件超过目标上传限制时明确失败，不返回截断文件。
- 本地导出不要求外发确认；网页上传和 BOSS 发图仍按原有确认与结果核验流程执行。`fileId` 不是网页 URL，工具不返回 `file:` 路径或公开下载地址。
- 当前工具仅在交互 Run 生成上传资源。定时任务不能调用它获取新的文件授权；定时上传仍需单独完成持久文件资源冻结和 `allowFileUpload` 授权。

### 5.3 岗位网络工具草案（0.2.0 禁用）

Schema 草案保留：

```text
SearchJobs
ReadUrl
```

两者在 0.2.0 都是 `enabled: false / disabled_draft`，不得由 `GetToolDefinitions()` 返回，也不得因为模型猜中名称而进入执行分发。

#### 0.3.0 `ReadUrl` 候选流程

只有 PM 裁决要求的以下流程可进入后续实现评审：

```text
用户消息明确包含一个公开 URL
→ Harness 绑定原始 URL 与当前 Run
→ ReadUrl 逐次校验初始地址和每次重定向
→ 输出不可信、带来源和截断信息的岗位预览
→ 用户确认
→ 通过独立窄写入边界入库
```

边界：

- URL 必须来自当前用户消息中的明确值；Agent 不得自行搜索、猜测、补全域名或跟随页面链接扩展来源。
- `ReadUrl` 仅允许公开 `http/https`；每次重定向重新校验，拒绝本机、内网、文件协议、携带凭据 URL 和跨域凭据转发。
- 使用无登录态、无用户 Cookie 的网络端口；需要登录或交互的页面不能转为浏览器操作。
- 限制响应体、内容类型、重定向次数、墙钟时间和下载量；不绕过验证码、反自动化或站点访问限制。
- 页面正文是不可信数据，必须记录原始/最终 URL、抓取时间、内容哈希、截断和不确定性。
- 不把简历全文、Profile 或其他敏感信息拼入网络请求，不计算岗位匹配分。
- `ReadUrl` 只读；岗位入库能力不能隐藏在同一个工具结果中。

#### 未来 `SearchJobs` 候选

`SearchJobs` 在 0.3.0 仍禁用。未来若另行裁决，只能在用户显式给出岗位、地区和关键词范围后访问登记来源，并受当前 Run 查询数、页数、结果数、下载量和墙钟预算约束。结果只作为临时数据；无界翻页、后台扫描、周期监控和“扫描全网”永久禁止。

`ReadUrl` 若未来启用，仍不得隐式入库。当前投递场景已经单独提供窄写工具 `SaveJob`：它只能保存 Agent 已通过受控浏览器观察到的岗位，具有独立 Schema、资源键、幂等账本和确认策略；它不是岗位搜索接口，也不依赖 `ReadUrl`。

### 5.4 浏览器操作工具（投递场景规划）

浏览器能力由 Host 映射到 Browser Bridge，再由 Avery 浏览器扩展在用户日常 Chrome/Edge 中执行。目标实现不使用隔离 Electron 浏览器、独立 Profile、`agent-browser` CLI 或远程调试端口。扩展通过仅监听 `127.0.0.1` 的随机令牌鉴权长轮询连接 Backend，并只附着 Avery 创建的任务标签页。模型只能调用冻结的 `Browser*` 工具，不能接触扩展 API、本机通信令牌、选择器、任意 JavaScript、Cookie 或本地文件路径。

扩展首次启用时由用户一次性授予网页访问权限，用于覆盖 BOSS、第三方招聘平台、未知企业官网和跨域投递流程。每次 Run 只登记任务创建的标签页，其他个人标签页不得进入模型结果或 Trace。个人浏览器沿用用户网络环境，允许访问公开或内网招聘页面；导航仅接受 `http/https`，拒绝浏览器内部页面、扩展页面、本地文件和携带明文凭据的 URL。页面输出限长，上传只接受 Host 签发的文件引用；提交、发送和敏感上传继续由 Harness 和 CronTask 的冻结任务授权控制。

规划工具列表：

| 工具 | 职责 | 执行映射 |
| --- | --- | --- |
| `BrowserNavigate` | 在当前标签页导航到指定 URL | 扩展创建任务标签页或导航当前任务标签页，记录最终 URL |
| `BrowserSnapshot` | 获取当前页面结构、可交互元素及稳定引用 | 固定页面操作模块执行语义扫描并返回截断信息 |
| `BrowserScreenshot` | 截取当前视口并仅向支持视觉输入的模型注入下一轮；不接受输出路径、不生成元素引用 | 扩展截取任务标签页，Host 读取后立即删除临时内容 |
| `BrowserReadPage` | 读取当前页面的正文内容 | 固定页面操作模块返回限长正文、标题和 URL |
| `BrowserClick` | 点击指定页面元素 | 重新校验 ref、可见性和命中目标后点击 |
| `BrowserFill` | 清空并填写指定输入框 | 固定页面操作模块聚焦、填写并触发页面输入事件 |
| `BrowserFillForm` | 选择投递档案和/或已绑定简历，由 Host 内部检查当前表单，经精确校验、上下文语义评分和全局冲突消解后填写文本框、原生下拉、日期选择器、自定义下拉、最多三级级联菜单或普通单选项；通过 `continuationId` 续填，并用短 `fieldId + candidateId` 处理歧义 | Host 保存短寿命来源和续填状态；动态控件每批最多执行两个并重新绑定 DOM，单字段失败进入 `skipped` 而不中断其余字段；结果返回摘要、`remainingCount`、`done`、`ambiguous`、`unmatched` 与 `missingFields` |
| `BrowserValidateForm` | 填写后重新检查必填项和浏览器原生校验结果；不触发提交 | 复用受控页面快照，仅返回字段引用、标签和问题，不回显字段值 |
| `BrowserSelect` | 选择指定下拉选项 | 固定页面操作模块处理原生下拉和已识别的自定义选项 |
| `BrowserSetChecked` | 设置复选框或单选项的选中状态 | 检查当前状态后在任务页面执行点击 |
| `BrowserPressKey` | 在当前页面按下指定按键 | 扩展只执行既有按键枚举 |
| `BrowserUploadFile` | 将 Host 授权的文件上传到指定网页控件 | Bridge 校验并读取资源，扩展绑定到目标上传控件 |
| `BrowserWait` | 等待元素、页面状态或 URL 变化 | 固定页面操作模块有界轮询 URL、文本、元素或 DOM 稳定 |
| `BrowserSwitchTab` | 切换到指定浏览器标签页 | 只允许当前浏览器任务已登记标签页 |
| `BrowserGoBack` | 返回当前标签页的上一历史页面 | 在任务标签页执行历史返回并推进 revision |

`BrowserFillForm → 按 continuationId 续填 → BrowserValidateForm` 构成低成本填表闭环。Inspect 是 FillForm 的 Host 内部步骤，不再作为 Agent 工具暴露；字段特征仅在 Host 的短寿命计划中使用，不进入模型上下文。首次调用只选择资料来源，后续调用只携带 `continuationId`、可选的短 `fieldId + candidateId` 决议，以及用户明确提供的规范字段 `decisions`。页面版本、DOM 引用、来源路径、类型兼容和不可复用来源冲突全部由 Host 保存并校验。稳定文本控件使用 Host 生成的 Batch；日期编辑器、自定义下拉和最多三级级联由 Host 每批最多执行两个，批次间重新检查页面并重绑定字段。表单批次超时只终止当前写操作，不把可见浏览器直接判定为崩溃并关闭。任何路径都不接受模型提供的 selector、CLI 参数、脚本或资料正文，也不执行上传、协议、导航和提交。

档案库提供 `application`（投递档案）模板，使用 `[个人信息]`、`[教育经历N]`、`[工作经历N]`、`[项目经历N]` 与 `[求职意向]` 分区和 `字段名：字段值` 格式。自动匹配只复制非空的明确值；模板与简历冲突、缺失或无法识别时跳过，不调用隐藏模型、不推测硬事实。密码、验证码、文件上传、协议和最终提交仍由各自工具处理；这不妨碍它们在已经冻结对应授权的无人值守任务中自动执行。

### 5.5 Todo

Todo 是当前 Run 的执行清单，不属于整个 Session，避免旧目标污染新任务。MVP 保留：

```text
CreateTodo
UpdateTodo
DeleteTodo
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

`DeleteTodo` 接收 `todoId`，用于彻底移除已经不属于当前任务范围的条目；如果只是放弃执行但仍需保留过程记录，应使用 `UpdateTodo` 将状态改为 `cancelled`。删除成功后返回被删除条目和最新完整列表，并写入 Tool Ledger 以支持幂等重放。

`ReadTodo` 不拆成 List/Get。Todo 数量有界，因此一次返回当前 Run 的完整列表、revision 和各状态计数。`CreateTodo`、`UpdateTodo`、`DeleteTodo` 成功后也返回最新完整列表，避免模型立即重复读取。

### 5.6 Skill 加载工具

`LoadSkill` 参数为 `skillId` 和可选 `resource`。不传 `resource` 时加载冻结快照中的 `SKILL.md`；只有主 Skill 已加载后，才能加载同一标准 Skill 目录中 `references/` 下已冻结的 UTF-8 参考资源。模型不能传入物理路径，也不能读取快照以外的 Skill。

`LoadSkill` 应作为当前工具批次的唯一调用。若 Provider 同批返回其他调用，Kernel 只执行第一个 `LoadSkill`，其余结果标记 `SKIPPED_FOR_SKILL_LOAD`，等待模型读取正文后重新规划。工具先完整读取并校验内容，再返回匹配 tool call 的成功结果；Kernel 随后以独立 `user` 消息追加正文。工具结果本身不嵌入正文，避免破坏 Provider tool-call 配对。重复加载同一版本或同一资源返回幂等状态，不重复占用上下文。

第一阶段不把 Todo 状态自动注入 Context，也不由 Harness 强制模型调用 `ReadTodo`。通过 Trace 观察：

- 明确多步骤任务是否主动创建 Todo。
- 恢复、压缩或等待后是否主动读取进度。
- 是否遗漏状态更新或在未完成时提前宣称完成。
- 是否对简单单步任务滥用 Todo。

在得到基线数据前，不增加自动注入或强制读取，以免掩盖模型的自然 Todo 管理能力。

### 5.7 用户交互

`AskUserQuestion` 是结构化等待入口。工具返回统一 wait disposition，Loop 持久化问题后进入 `waiting_user_input`，而不是继续请求模型或保持悬空 Promise。

用户答案经 `RespondToInteraction` 按问题 ID 提交，完整校验后作为原工具调用的最终结果追加，后端恢复原 Run。确认卡也走该入口，审批决定与实际工具执行结果分开记录，不模拟用户发送确认消息。

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
| 当前无岗位网络工具 | 0.2.0 保持无网络；保留 `SearchJobs`/`ReadUrl` 的 `disabled_draft` Schema，不注册 |

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
3. 用冻结 ScenarioSnapshot 中的 tool definition ID 与名称查白名单；名称存在于全局草案注册表也不代表允许执行。
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
批次 1：[ReadProfile, Read]

阶段 A：ReadProfile ─┐
       Read        ──┘ 并行读取

批次 2：ReadResume({})           串行读取索引
批次 3：ReadResume({resumeId})   串行读取正文并建立绑定
批次 4：UpdateResume             串行写入并刷新绑定 revision
批次 5：UpdateTodo               串行写入 run:todos
```

`ReadResume` 统一串行执行，避免同一批次读取多份正文时产生绑定竞态。若具体 `resumeId` 需要根据索引选择，模型必须先等待索引结果，再在下一轮读取正文；已明确知道 ID 时，Harness 仍按工具顺序先完成绑定再放行后续依赖写入。

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
- 0.2.0 默认场景不注册、不展示也不执行 `SearchJobs`、`ReadUrl`。
- 聊天暴露冻结的11个只读或交互工具；工作暴露冻结的40个工具，包含简历与档案编辑；两者都不包含 `SearchJobs` 或 `ReadUrl`。
- CronTask 创建确认前数据库与 OS 调度均无新增记录；无人值守 Run 即使恢复旧快照也不能调用 CronTask 工具。
- 多次逾期只执行最近 occurrence；既有 Run 活跃、浏览器长期占用、登录或验证码接管均写入明确的 `missed`/`needsAttention` 原因。
- 投递 Agent 在浏览器执行前读取投递状态，并只在有效回执后更新 `applied`。
- `Read`、`Glob`、`Grep` 可以访问授权虚拟挂载，但不能路径逃逸、读取非法 UTF-8 或敏感文件。
- 模型直接请求未进入冻结快照的已注册/草案工具时，执行入口返回 `TOOL_NOT_ALLOWED`，实现函数调用次数为 0。
- 0.3.0 fixture 必须证明 `ReadUrl` 只接受用户明确 URL，并拒绝 localhost、内网、文件协议、凭据、Cookie 和未校验重定向。
- `SearchJobs` 在 0.3.0 仍保持禁用；任何岗位网络结果都不会自动写入岗位库。
- `CreateTodo` 在目标含关键歧义或单步任务中不应被模型调用。
- Todo 不出现 `blocked`，Run 等待/暂停状态与 Todo `inProgress` 可以并存。
- 无 Todo 自动注入时记录主动读取率、进度遗漏率和提前完成率。
- Preview/Commit 不作为模型工具；确认后执行的参数与 proposal hash 完全一致。
- 并行读结果顺序稳定；写屏障后读取到新 revision。
- 超时写入会对账，不产生第二次提交。
- 重启后相同幂等键返回原 receipt。

## 14. 总结

MVP 工具集优先使用少量、高辨识度的 PascalCase 工具。`Read`、`Glob`、`Grep` 是通用 UTF-8 文件只读能力，来源差异由虚拟挂载和端口授权处理；简历、档案、Todo、投递状态和 CronTask 只在权限、Schema 或副作用真正不同的地方拆分。默认场景不注册岗位网络工具；投递场景使用 16 个受控浏览器工具，并额外提供不暴露选择器或脚本参数的 `CollectJobs` 岗位采集工具与 `ContactBossJobs` 批量打招呼工具；不启用旧 `SearchJobs` 草案。确认阶段属于 Harness；CronTask 以一次周期授权换取无人值守执行，但不扩展场景能力。
