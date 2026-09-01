# 投递场景 Agent E2E：开发规划与进度

> 状态：开发中
> 更新时间：2026-08-24
> 依赖：[Browser Tools 开发规划](./07-browser-tools-development-plan.md)、[Tools](./03-tools.md)、[Harness](./06-harness.md)

## 1. 目标与验收边界

本规划补齐投递场景的正式端到端验证。验证必须从 `AgentHost.Send` 或桌面发送入口开始，经场景快照、System Prompt、模型 Provider、Agent Loop、Tools Module、Harness、浏览器 Runtime、`agent-browser` CLI 和隔离 Electron 浏览器到达网页；测试不得直接调用 CLI 或 `AgentBrowserRuntime.Execute` 后声称 Agent 能力通过。

第一阶段测试站只在本机临时启动，不部署公网环境。自动回归使用确定性的 `ScriptedProvider`，真实模型只作为本地人工评估项，不能替代稳定回归。生产环境仍使用公开 URL/DNS 校验；本地测试通过构造参数注入“仅允许本次随机 loopback origin”的测试策略，禁止环境变量、隐藏开关或通配 localhost 放行。

完成标准：Agent 能在包含多个岗位和真实表单控件的本地站点完成“搜索岗位 → 选择匹配岗位 → 阅读 JD → 填写文本字段 → 操作普通下拉菜单 → 操作多级联动所在地 → 上传授权简历 → 同意条款 → 经用户确认提交 → 读取成功回执”，且全链路没有越权工具、重复提交、旧页面引用复用或无回执完成声明。

## 2. 测试分层

| 层级 | 入口 | Provider | 浏览器 | 目的 | 发布门禁 |
| --- | --- | --- | --- | --- | --- |
| 契约/单元测试 | 模块或 Runtime | Stub | Stub | Schema、白名单、风险、URL 策略、引用失效 | 必须 |
| Agent 集成 E2E | `AgentHost.Send` | `ScriptedProvider` | 真实隔离 Electron + CLI | 确定性验证完整 Agent 数据流 | 必须 |
| 桌面冒烟 | Renderer 发送入口 | `ScriptedProvider` 或受控模型 | 打包后的隔离 Electron | IPC、安装包路径、确认 UI 与浏览器可见性 | 发布前必须 |
| 真实模型评估 | 桌面发送入口 | OpenAI / DeepSeek | 本地测试站 | 评估模型识别页面和规划能力 | 非阻断诊断；形成基线后再设阈值 |
| 真实招聘站人工兼容性 | 桌面发送入口 | 已支持 Provider | 隔离 Electron | 登录、验证码、站点差异与条款适配 | 正式开放投递前必须 |

自动化的主证据是 Agent 集成 E2E，而不是直接 CLI 冒烟。CLI 伴随进程冒烟继续保留，用于快速定位执行层故障。

## 3. 本地测试站设计

### 3.1 岗位数据

测试站至少提供 6 个岗位，覆盖相近名称、无匹配结果和不同工作地点，示例：

- Agent 平台工程师（北京 / 平台研发 / 全职）
- 大模型应用工程师（上海 / AI 应用 / 全职）
- 前端工程师（杭州 / Web / 全职）
- 数据分析师（深圳 / 数据 / 全职）
- 产品经理（北京 / 产品 / 全职）
- NLP 实习生（上海 / 算法 / 实习）

搜索结果必须由用户输入的关键词动态过滤，Agent 需要读取多个结果后选择目标岗位；不得把唯一岗位或目标 ref 硬编码到 Prompt。

### 3.2 页面与表单控件

测试站使用语义化 HTML 和可访问名称，至少包含：

| 能力 | 控件/行为 | 断言 |
| --- | --- | --- |
| 搜索 | 关键词输入框、搜索按钮、结果列表 | 输入“Agent”后只展示匹配岗位 |
| JD 阅读 | 岗位详情按钮、职责与要求 | Agent 读取目标标题、地点与核心要求 |
| 文本填写 | 姓名、邮箱、手机号、自我介绍 | 提交状态保存规范化值 |
| 普通下拉 | 工作方式或工作年限 `<select>` | Agent 选择指定选项 |
| 所在地级联 | 省/直辖市 → 城市两个 `<select>` | 上级变化后下级选项重建，Agent 必须重新 Snapshot |
| 职类级联 | 职类 → 方向两个 `<select>` | 覆盖第二组多级联动，不依赖单一地点实现 |
| 文件上传 | 简历 `<input type=file>` | 只接受 Host 授权 `fileId`，站点记录文件名 |
| 协议确认 | 条款 checkbox | Harness 将其识别为强制确认动作 |
| 最终提交 | “提交申请”按钮 | Harness 冻结 proposal 并等待确认 |
| 回执与幂等 | 成功页/状态接口、提交计数 | 生成稳定回执，重复点击不会产生第二次申请 |
| 人工接管 | 登录/验证码专用路径 | Agent 暂停，用户处理后以新 Snapshot 恢复 |

测试站通过仅供测试进程读取的 `/__test/state` 返回已搜索关键词、选择岗位、表单值、上传文件名、提交计数和回执。页面本身不暴露测试控制 API 给模型，测试结束后服务器与临时数据必须关闭和清理。

## 4. 确定性 ScriptedProvider

`ScriptedProvider` 是测试驱动器，不是第二套 Agent，也不进入生产包。它只通过模型协议返回标准 Tool Calls，并从历史中的 Tool Result 动态查找 Snapshot 颁发的 ref；不能直接访问 DOM、测试站状态、CLI 或 Runtime。

脚本步骤：

1. 调用 `BrowserNavigate` 打开测试站。
2. `BrowserSnapshot` 后定位“关键词”，调用 `BrowserFill`；定位“搜索岗位”，调用 `BrowserClick`。
3. 重新 Snapshot，选择“Agent 平台工程师”，进入并读取 JD。
4. 打开申请表，逐项填写文本字段。
5. 使用 `BrowserSelect` 选择普通下拉；选择省份后重新 Snapshot，再选择城市；职类级联同理。
6. 使用 `BrowserUploadFile(fileId)`；等待用户确认后执行被冻结的上传 proposal。
7. 重新 Snapshot，使用 `BrowserSetChecked` 同意条款；等待确认后继续。
8. 重新 Snapshot，点击“提交申请”；等待确认后执行被冻结的提交 proposal。
9. 新 Run 中读取成功回执，最终回复只能依据 Tool Result 和站点成功状态声明完成。

ScriptedProvider 每一步校验可见工具清单等于投递场景冻结白名单；若看到写简历、写档案、原始 CLI、`SearchJobs` 或其他越权工具，测试立即失败。

## 5. 开发部分与验收标准

### AP-01：冻结投递场景协议

开发内容：

- 统一投递场景 Prompt、100 轮预算、30 个工具白名单、强制确认动作和完成证据。
- 修正文档中“投递场景暂未实现/不可创建 Run”与现状冲突的描述。
- 明确等待确认通过 `ConfirmBrowserAction` 执行原 proposal，后续继续任务必须从新 Snapshot 开始。

验收标准：

- [x] 场景快照包含 17 个共享只读/Todo/交互/CronTask/投递状态工具和 13 个浏览器工具，共 30 个；其中 `BrowserFillForm` 仅批量填写普通输入框。
- [ ] 投递场景不包含任何简历或档案写工具，不包含 `SearchJobs`、`ReadUrl`、Shell 或原始 CLI。
- [ ] Prompt 明确页面不可信、旧 ref 不复用、强制确认、`STATUS_UNKNOWN` 不重试和 receipt 完成证据。
- [ ] README、Tools、Loop、Harness 与专项规划对投递场景状态无矛盾。

### AP-02：本地多岗位测试站

开发内容：

- 建立可由 Node 随机 loopback 端口启动/停止的 fixture server。
- 实现多岗位搜索、JD、完整申请表、两组级联下拉、上传、条款、一次性提交与状态查询。
- 提供自动生成的临时授权简历文件；测试结束统一清理。

验收标准：

- [ ] 至少 6 个岗位，关键词搜索同时覆盖多结果、单结果和无结果。
- [ ] 普通下拉、所在地级联和职类级联均能通过原生浏览器交互操作。
- [ ] 改变上级下拉后下级 DOM/选项发生变化，旧 ref 不能作为可靠操作依据。
- [ ] 缺少必填项、未上传或未勾选协议时无法提交。
- [ ] 成功提交只产生一次回执，状态端点的 `submissionCount` 为 1。

### AP-03：测试专用依赖与导航策略注入

开发内容：

- 为 `AgentHost` 提供构造期模块工厂和浏览器端口注入点，生产默认装配保持不变。
- 为浏览器 Runtime 注入窄化的 `normalizeNavigationUrl` 策略；生产默认仍为 `NormalizePublicBrowserUrl`。
- 本地测试策略只接受运行时生成的精确 origin，拒绝其他 localhost、私网、协议和 origin。

验收标准：

- [ ] 无注入时生产代码路径、公开 URL 校验和 Electron 安全配置不变。
- [ ] 测试策略只能访问本次 fixture origin，不能用它访问任意 loopback 地址。
- [ ] 注入点不经过 Renderer/IPC，不接受用户输入或环境变量切换。
- [ ] 单元测试覆盖默认策略和精确 origin 测试策略的隔离。

### AP-04：AgentHost 完整链路 E2E

开发内容：

- 实现仅测试使用的 `ScriptedProvider`。
- 从 `AgentHost.Send` 发起多个连续 Run，处理上传、协议与最终提交确认。
- 使用真实 `agent-browser` CLI 和隔离 Electron companion 操作本地测试站。
- 断言事件、历史、工具账本、proposal、receipt 和站点最终状态。

验收标准：

- [ ] 测试入口是 `AgentHost.Send`，不直接调用 Runtime/CLI 完成业务步骤。
- [ ] 完整执行搜索、JD、文本填写、普通下拉、两组级联、上传、协议与提交。
- [ ] 每个强制确认在用户同意前站点状态不变化；拒绝确认时动作不执行。
- [ ] 确认后页面变化使旧 proposal 失效；后续 Run 首个页面操作前重新 Snapshot。
- [ ] 最终 `submissionCount === 1`，receipt 存在，Agent 最终回复与站点状态一致。
- [ ] 全程没有简历/档案写入、越权工具调用或主窗口 CDP target 暴露。

### AP-05：取消、失败与人工接管 E2E

开发内容：

- 增加用户拒绝确认、取消、过期 ref、页面变化、伴随进程退出、提交结果未知、登录/验证码接管用例。
- 对外部动作设置断言：失败或未知时不自动重试，不生成虚假完成声明。

验收标准：

- [x] 拒绝上传/协议/提交任一确认时对应动作调用次数为 0。
- [x] 取消后迟到 Tool Result 不进入历史、不触发下一模型轮次。
- [x] 旧 ref 和旧 proposal 均被稳定错误拒绝。
- [x] `STATUS_UNKNOWN` 时 `submissionCount` 至多为 1，Agent 要求用户核对而不重试。
- [x] 登录/验证码触发 `browser_user_action`，恢复后先 Snapshot 再操作。
- [x] companion 异常退出可恢复，但不会复用失效引用或重复外部动作。

### AP-06：桌面、打包与真实模型评估

开发内容：

- 在打包目录运行同一本地 fixture，验证 Renderer → IPC → AgentHost → companion 链路。
- 用 DeepSeek 在固定任务上进行本地测试站评估，记录模型、参数、轮数、工具错误与完成率；OpenAI 暂不接入，不以兼容接口冒充正式支持。
- 在正式开放前执行真实招聘站人工兼容性检查，登录和验证码始终由用户接管。

验收标准：

- [ ] 打包应用无需全局 Node、CLI 或额外浏览器即可完成本地测试站流程。
- [ ] 确认卡、浏览器可见窗口、停止/恢复和最终状态在桌面 UI 可观察。
- [x] DeepSeek 至少运行 10 次固定评估并保留结构化结果；首份基线为 10/10 完成，不据此立即设置发布阈值。
- [ ] 真实站点测试使用测试账号和可撤销材料，不向真实雇主产生未经明确批准的投递。
- [ ] 真实站点差异只推动原子工具/页面语义改进，不引入按网站硬编码按钮位置的高层工具。

## 6. 实施顺序与统一验证

实施顺序：`AP-01 → AP-02 → AP-03 → AP-04 → AP-05 → AP-06`。本次开发先完成 AP-01 至 AP-04 的确定性主路径；AP-05、AP-06 需要在主路径稳定后继续扩展，未完成时不得把投递场景标记为正式发布。

代码完成后统一执行，不以分部测试代替整体验证：

1. 受影响的 TypeScript 构建和全部 Vitest/Workspace 测试。
2. 隔离浏览器 companion 冒烟。
3. AgentHost 投递场景 E2E 冒烟。
4. Windows 目录打包与打包 companion/Agent E2E 冒烟。
5. `git diff --check`、进程清理、临时目录清理和状态核对。

## 7. 进度

| 部分 | 状态 | 证据/说明 |
| --- | --- | --- |
| AP-01 投递场景协议 | 已完成 | 已同步开发态/未发布状态；场景冻结 17 个共享工具和 13 个浏览器工具（12 个原子工具与 1 个受限批量输入工具） |
| AP-02 本地多岗位测试站 | 已完成 | 6 个岗位、普通下拉、所在地/职类两组级联、上传、条款、回执与重复提交保护 |
| AP-03 测试注入边界 | 已完成 | Host 构造期模块/Runtime 注入；Runtime 默认公网策略不变，单元测试验证 E2E 仅允许精确 fixture origin |
| AP-04 AgentHost 主路径 E2E | 已完成 | `smoke:agent-application` 从 `AgentHost.Send` 驱动生产 CLI 执行器/真实 companion，完成确认链路并取得唯一回执 |
| AP-05 失败与人工接管 E2E | 已完成 | 三类确认拒绝/重规划、取消迟到、旧 ref/proposal、状态未知、用户接管及 companion 恢复回归通过 |
| AP-06 桌面/打包/真实模型 | 公开测试中 | 应用已开放真实投递入口；打包链路、完整根构建及 DeepSeek 10 次基线通过，同一事务桌面 UI 自动化和真实站点人工检查待完成 |

### 7.1 2026-08-24 AP-01～AP-04 统一验证

- `npm test`：通过；Vitest 25 个文件通过、1 个跳过，100 个用例通过、1 个跳过；Backend Node Test 8/8 通过。
- `npm run smoke:agent-application`：通过；入口为 `AgentHost.Send`，实际结果为 6 个岗位、1 个普通下拉、2 组级联下拉、3 次强制确认、`submissionCount=1`、回执 `LOCAL-APPLICATION-0001`。
- `npm run smoke:browser-companion`：通过；Snapshot、Fill、Click 正常，CDP 仅暴露 2 个 companion target，未暴露 OfferGet 主窗口。
- Backend、Desktop main TypeScript 编译通过；Desktop preload 使用 `--noEmit` 类型检查通过；Renderer Vite 构建通过。
- 根 `npm run build` 的唯一失败发生在写入已被当前 Electron 进程映射的 `electron/preload.cjs`，错误为 Windows user-mapped section 文件锁；本次未修改 preload，类型检查与其余构建已分别通过。关闭占用该文件的应用后仍需补跑一次完整根构建，不能据此将 AP-06 标记完成。
- E2E 暴露并修复 Windows CLI 误超时：`agent-browser` daemon 可能继承管道句柄，等待 ChildProcess `close` 会拖到超时；Runtime 改用单次 CLI 进程 `exit` 作为命令终态，并用进程级 namespace 避免复用崩溃遗留 daemon。

### 7.2 2026-08-24 AP-05 统一验证

- `smoke:agent-application` 对上传、协议和最终提交分别执行一次拒绝，再使用新 `tool_call_id`、新 Snapshot 与新 proposal 重新规划；共出现 6 次确认，其中 3 次拒绝，最终仍只有一次提交和一个回执。
- AgentHost 回归验证登录/CAPTCHA Snapshot 触发 `browser_user_action` 与 `waiting_user_input`；用户继续后首个浏览器工具是新 `BrowserSnapshot`。
- AgentHost 回归验证外部动作返回 `STATUS_UNKNOWN` 时立即暂停；下一 Run 只要求用户核对，Browser Runtime 执行次数不增加。
- Runtime 回归模拟 companion 退出：自动启动新 companion，崩溃前 ref/proposal 返回 `BROWSER_STALE_PAGE_REF`，重新 Snapshot 后才允许点击。
- 复用既有 Core 回归验证取消后迟到 Provider completion 不写 Usage/历史、不执行工具；复用浏览器 Tools 回归验证已开始写动作取消后进入不可重试的 `STATUS_UNKNOWN`。
- `npm test`：Vitest 26 个文件通过、1 个跳过，104 个用例通过、1 个跳过；Backend Node Test 8/8 通过。
- `npm run build`：完整通过，先前 `electron/preload.cjs` 文件锁已在关闭占用进程后解除。
- `npm run smoke:browser-companion`：通过；CDP target 隔离及 Snapshot/Fill/Click 保持正常。

### 7.3 2026-08-25 AP-06 阶段验证

- Windows 目录包构建通过，输出为 `release-rebuild/ap06/win-unpacked`。
- 打包桌面冒烟通过：Renderer 已加载、Backend ready，Renderer 经 preload/IPC 读取 AgentHost 和 Browser Runtime 状态均成功，启动就绪 627 ms。
- 打包投递冒烟通过：只使用包内 `agent-browser` CLI 与 `OfferGet.exe` companion，最终 `submissionCount=1`，回执为 `LOCAL-APPLICATION-0001`。
- 上述桌面 IPC 与打包投递是两条独立证据，尚未覆盖 Renderer 在同一事务中发起投递并观察确认卡、停止/恢复和最终状态；不据此勾选完整桌面 UI 验收项。
- DeepSeek `deepseek-v4-flash` 已完成 10 次固定评估：10/10 成功，平均 28.2 模型轮次，平均耗时 79.55 秒。旧版 70 个“错误”中包含 30 个正常确认等待；实际问题以 stale ref 为主，分类与修复见 `10-application-release-validation.md`。
- 真实招聘站需要测试账号、可撤销材料及逐站授权，本轮未执行任何真实投递、上传或消息发送。
- 根 `npm run build` 首次因 `electron/preload.cjs` 被 Windows user-mapped section 短暂占用而失败；未强制覆盖文件，统一回归结束后按原命令重试已完整通过。完整记录与执行说明见 `10-application-release-validation.md`。
- `npm test`：Vitest 26 个文件通过、1 个跳过，104 个用例通过、1 个跳过；Backend Node Test 8/8 通过。`smoke:browser-companion` 与 `smoke:agent-application` 均通过。

## 8. 风险与不变量

- 本地 fixture 的导航放行仅是测试依赖注入，不是产品功能；任何生产入口都不得关闭 SSRF/DNS 检查。
- ScriptedProvider 证明的是 Agent 编排与安全链路，不证明真实模型必然能规划成功；真实模型评估必须独立记录。
- 测试站使用原生控件提高可重复性，但不能代表所有招聘站的自定义组件；后续真实站点兼容性仍不可省略。
- 上传、协议和最终提交可能产生多个确认，这是当前强制安全边界，不为减少测试步骤而合并或绕过。
- 页面变化后必须重新 Snapshot。尤其是级联菜单，上级选择会重建下级选项，旧引用不能继续使用。
- 只有成功 Tool Receipt 与站点最终状态共同成立时，Agent 才能声明投递完成。

## 9. 总结

投递场景的完成标准不是“CLI 能点击网页”，而是 Agent 在冻结权限和用户确认边界内，能可靠地理解多个岗位、操作真实表单结构并用回执证明外部动作。本地多岗位测试站提供稳定、可重复的主链路证据；生产 URL 安全策略、真实模型能力和真实招聘站兼容性分别保留独立验证，不能相互替代。
