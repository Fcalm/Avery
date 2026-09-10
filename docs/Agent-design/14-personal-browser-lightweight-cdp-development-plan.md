# 个人浏览器轻量 CDP 开发规划

## 1. 背景与结论

Avery 需要复用用户已经登录的 Chrome 或 Edge 操作 BOSS 直聘。当前个人浏览器模式仍把浏览器级 CDP WebSocket 交给 `agent-browser 0.34.0`。该版本在首次连接时会附着页面并执行 `Page.enable`、`Runtime.enable`、`Network.enable`、`WebMCP.enable` 和 `Target.setAutoAttach`。

2026-09-04 的逐项实测确认：浏览器级 CDP 连接、单 target 附着、单次 `Runtime.evaluate`、`Page.navigate`、`Target.createTarget`、`Page.captureScreenshot`、鼠标事件和逐字符输入均不会单独触发 BOSS 风控；仅执行一次 `Runtime.enable` 后，BOSS 页面约 1 秒内变成异常 target，用户界面同时出现风控。因此，调整导航、Snapshot 或操作间隔不能修复现有个人浏览器模式，必须让 Chrome/Edge 绕过 `agent-browser` 的初始化过程。

本次采用以下边界：

- Electron 隔离浏览器继续使用现有 `agent-browser` CLI、daemon、独立 Profile 和测试环境。
- Chrome/Edge 个人浏览器改用 Avery 内部的轻量原始 CDP 驱动。
- Agent 可见的浏览器工具名称、参数 Schema、System Prompt 和 Harness 确认协议保持不变。
- 个人浏览器仍只允许操作 `zhipin.com`，只附着单个受控任务 target，不读取或暴露其他私人标签页。
- 第一版只实现核心能力，不引入 CDP 代理、`agent-browser` fork、网络拦截或复杂行为模拟。

## 2. 已验证事实

| 实验 | 唯一新增行为 | 结果 |
|---|---|---|
| B1 | 连接浏览器级 CDP WebSocket | 正常 |
| B2 | `Target.attachToTarget` | 正常 |
| C | 单次 `Runtime.evaluate`，不启用 Runtime 域 | 正常 |
| D | 单次 `Page.navigate` | 正常 |
| E1 | 启动真实 `agent-browser` | 授权后立即触发风控，CLI 未返回 tab 列表 |
| F1 | 单次 `Runtime.enable` | 约 1 秒后 target URL 变为 `null/`，用户确认出现风控 |
| T1 | `Target.createTarget` 新建 BOSS 标签页 | 正常 |
| T2 | 固定语义元素扫描 | 79 个可见元素，正常 |
| T3 | 不执行 `Page.enable`，直接 `Page.captureScreenshot` | 正常 |
| T4 | `Input.dispatchMouseEvent` 聚焦输入框 | 正常 |
| T5 | 清空输入框并用 `Input.insertText` 逐字符输入 | 正常 |
| T6 | 输入关键词并点击搜索控件 | 正常 |
| T7 | 命中第二个岗位链接并切换动态详情面板 | 正常；BOSS 不改变 URL，而是更新当前页结构 |
| T8 | 创建专用任务标签页、附着新 target、执行语义 Snapshot | 正常 |

原始诊断结果位于本地 `artifacts/boss-cdp-diagnostics/`，诊断脚本为 `scripts/diagnose-boss-cdp.mjs`。诊断日志不得提交页面正文、字段值、查询参数、截图或用户私人标签页信息。

## 3. 目标架构

```text
Agent browser tools
        |
        v
BrowserAutomationPort / Harness
        |
        v
AgentBrowserRuntime
   |                    |
   | engine=electron    | engine=chrome/edge
   v                    v
agent-browser CLI       PersonalBrowserCdpRuntime
isolated companion      raw CDP + one BOSS task target
```

`AgentBrowserRuntime` 继续持有统一的提案冻结、风险分类、确认、URL 校验、文件授权、页面 revision、节流、取消和错误映射。底层执行按浏览器类型分流，不能让模型选择或接触原始 CDP 方法。

## 4. CDP 安全边界

### 4.1 固定禁止的方法

个人浏览器驱动不得发送：

```text
Runtime.enable
Page.enable
Network.enable
WebMCP.enable
Debugger.enable
DOM.enable
Fetch.enable
Target.setAutoAttach
Runtime.addBinding
Page.addScriptToEvaluateOnNewDocument
```

驱动维护显式方法白名单。新增 CDP 方法必须先补充用途、风险和测试；未登记的方法在写入 WebSocket 前直接拒绝。

### 4.2 允许的核心方法

第一版仅按工具需要开放：

```text
Target.getTargets
Target.createTarget
Target.attachToTarget
Target.activateTarget
Target.getTargetInfo
Page.navigate
Page.getNavigationHistory
Page.navigateToHistoryEntry
Page.captureScreenshot
Runtime.evaluate
Runtime.releaseObject
Input.dispatchMouseEvent
Input.dispatchKeyEvent
Input.insertText
DOM.setFileInputFiles
```

允许列表不代表任意调用。每个方法的参数必须由 Host 固定构造；模型不能提供 JavaScript、CDP method、targetId、sessionId、objectId 或本地文件路径。

### 4.3 target 隔离

1. 从已校验浏览器的 `DevToolsActivePort` 获取 `127.0.0.1` WebSocket。
2. 用户显式检测连接或首次浏览器动作时发起授权。
3. 使用 `Target.getTargets` 仅在内存中确认至少存在一个 `zhipin.com` 页面，以证明登录 Context 可用。
4. 首次页面工具统一使用 `Target.createTarget` 创建专用 BOSS 任务标签页：`BrowserNavigate` 使用已校验的目标 URL，其他工具复制登录锚点当前的 BOSS URL。
5. 只附着该任务 target；后续动作始终复用它。
6. 非 BOSS target 不进入工具结果、Trace、标签注册表或日志。
7. target 离开 `zhipin.com` 后停止读取和交互，返回稳定错误，不能自动附着其他标签页补位。

## 5. 工具实现映射

| Agent 工具 | Chrome/Edge 轻量实现 | 约束 |
|---|---|---|
| `BrowserNavigate` | 尚无任务标签页时用目标 URL 执行 `Target.createTarget`；已有任务标签页时使用 `Page.navigate` | 导航前后校验 BOSS 主域；不复用用户原标签页历史栈 |
| `BrowserSnapshot` | 固定 `Runtime.evaluate` 枚举可见交互元素 | 不使用 Accessibility/DOM enable，不注入属性，不读取密码值 |
| `BrowserReadPage` | 固定脚本读取 URL、标题和限长正文 | 页面内容按不可信数据处理并限长 |
| `BrowserScreenshot` | `Page.captureScreenshot` | 不执行 `Page.enable`；沿用 16 MiB PNG 校验和视觉模型限制 |
| `BrowserClick` | 校验 ref 和命中点后发送鼠标移动、按下、释放 | 成功不要求 URL 变化；执行后废弃旧 ref |
| `BrowserFill` | 鼠标聚焦、Ctrl+A、Backspace、`Input.insertText` | 不使用 DOM setter；逐字符小间隔输入 |
| `BrowserFillForm` | 一次工具调用内执行 Host 私有计划中的 Fill、精确 Select 与普通 Radio Check | 来源只允许已选档案/已绑定简历；不点击协议、上传或提交；不保证事务回滚 |
| `BrowserSelect` | 原生 `<select>` 使用固定受控逻辑 | 自定义下拉仍使用 Snapshot + Click |
| `BrowserSetChecked` | 状态不同时发送真实鼠标点击 | 继续识别协议/隐私复选框并强制确认 |
| `BrowserPressKey` | `Input.dispatchKeyEvent` | 只接受既有按键白名单 |
| `BrowserUploadFile` | 固定解析 file input，`DOM.setFileInputFiles` | 只接受 Host 授权的 `fileId`；保持 25 MiB 上限和强制确认 |
| `BrowserWait` | 轮询 URL、文本、选择器或 `document.readyState` | `networkidle` 降级为 readyState + DOM 稳定，并在结果中明确 `waitMode: dom_stable` |
| `BrowserSwitchTab` | 个人浏览器第一版只登记当前专用任务 target | 其他 tabId 返回 `BROWSER_TAB_NOT_FOUND`，不附着登录锚点或私人标签页 |
| `BrowserGoBack` | `Page.getNavigationHistory` + `Page.navigateToHistoryEntry` | 执行后废弃旧 ref |

## 6. Snapshot 与引用设计

固定 Snapshot 只枚举以下候选：

```text
a[href]
button
input
textarea
select
[role]
[contenteditable=true]
```

输出模型可见字段包括 role、name、type、disabled/checked 状态、限长文本、安全链接和 `@eN`。密码值、隐藏字段值、内部选择器、objectId 和结构路径不得输出。

驱动内部为每个 ref 保存定位指纹：tag、role、type、可访问名称、稳定属性和结构位置。动作前重新定位，并使用 `document.elementFromPoint` 验证点击坐标命中目标或其子节点。页面 revision 不匹配、指纹变化或命中失败统一返回 `BROWSER_STALE_PAGE_REF`，不能点击相似元素补救。

BOSS 岗位列表点击后可能只更新右侧详情面板而不改变 URL。`BrowserClick` 的成功条件是 Chrome 确认收到完整输入事件；动作后始终废弃旧引用，由下一次 `BrowserSnapshot` 判断新页面状态。

## 7. Harness、取消与日志

以下既有行为不得因驱动替换而改变：

- 公开 URL/DNS 校验和个人浏览器 BOSS 域限制。
- proposal hash、page revision 和陈旧引用拒绝。
- 上传、发送、提交、授权、协议等高风险动作确认。
- BOSS 可见窗口要求、动作最小间隔和 CronTask 任务级授权。
- 验证码、频率限制和账号异常检测即停止，不尝试绕过。
- 用户接管后重置引用，恢复时先重新 Snapshot。
- 命令发送前取消返回 `CANCELLED`；可能已产生副作用后失去响应返回 `status_unknown`。
- Trace 继续以 Agent tool call/result 为单位，不记录 CDP payload、页面正文、输入明文、本地路径或私人标签页。

CDP 客户端只记录方法名、耗时、结果类型、目标状态和稳定错误码。浏览器关闭、用户拒绝授权、target 消失和 WebSocket 断开必须能区分。

## 8. 代码改动

### PB-01：轻量 CDP Runtime

新增：

```text
apps/backend/src/electron/backend/personal-browser-cdp-runtime.ts
```

单文件包含小型 WebSocket 请求管理、方法白名单、target 生命周期、固定页面读取、内部 ref、输入事件和取消处理。第一版不拆分为多个抽象层，也不新增第三方依赖。

验收标准：

- 能连接授权式 Chrome/Edge WebSocket，创建并只附着一个 BOSS 任务 target。
- 任何执行路径都不能发送固定禁止方法。
- 关闭 Runtime 只断开 CDP，不结束用户浏览器或清理用户 Profile。
- 非 BOSS 页面和 target 在发送页面命令前被拒绝。

### PB-02：统一 Runtime 分流

修改 `agent-browser-runtime.ts`：

- Electron 分支保留现有 CLI/daemon 行为。
- Chrome/Edge 分支委托 `PersonalBrowserCdpRuntime`。
- `Prepare`、`Execute`、风险判定、确认、文件解析和 page revision 继续由统一边界持有。
- `GetStatus(true)` 使用安全的原始连接和 `Target.getTargets`，不再运行 `agent-browser tab`。
- `RetireBrowserInstance` 分别关闭 CLI daemon 或轻量 CDP socket。

验收标准：

- 浏览器设置和持久化格式不变。
- 切换 engine 时旧会话和引用被清理。
- Chrome/Edge 不启动 `agent-browser` 进程；Electron 仍能正常启动 companion。
- 用户拒绝授权、缺少 BOSS 页面和连接断开返回现有稳定错误族。

### PB-03：工具能力接入

按第 5 节映射接入 14 个现有工具，不增加模型可见工具。

验收标准：

- Snapshot、Read、Screenshot、Navigate、Click、Fill 和岗位动态详情满足真实 BOSS 核心链路。
- FillForm、原生 Select、Checked、Upload、Wait、SwitchTab、GoBack 在本地测试页满足既有契约。
- 高风险动作仍由 Harness 确认，驱动不存在绕过确认的直接入口。

### PB-04：设置状态和文档

修改设置页状态文案：

- Electron 显示为 Avery 隔离浏览器。
- Chrome/Edge 显示为连接已登录 BOSS 页面的轻量个人浏览器。
- “刷新连接状态”只执行安全探测，不调用 `agent-browser`。

同步更新 `07-browser-tools-development-plan.md`、`08-electron-cdp-compatibility-validation.md` 和 Agent-design 索引。

验收标准：

- 设置保存、重启恢复和 engine 切换行为不变。
- 状态文案不再声称 Chrome/Edge 使用 `agent-browser`。
- 文档明确两种驱动的适用范围和 BOSS 风控根因。

## 9. 最小验证方案

本次不运行全量测试、完整 Provider 测评、完整应用投递 E2E 或全平台打包。只执行能覆盖本次改动风险的最小集合。

### 9.1 自动化测试

1. 新增轻量 CDP Runtime 单元测试：连接、创建任务 target、Snapshot、Click/Fill、Screenshot 和禁止方法断言。
2. 更新 `agent-browser-runtime.test.ts`：验证 Electron 走 CLI，Chrome/Edge 不调用 CLI。
3. 运行浏览器工具与 Harness 相关的既有单元测试，确认确认、ref 和文件授权没有回归。
4. 运行受影响 TypeScript 项目的类型检查。

建议命令以项目现有脚本为准，只选择对应测试文件，不运行整个测试仓库。

### 9.2 本地冒烟

在现有本地招聘测试页只跑一次组合流程：Snapshot → FillForm → Select/Checked → Upload 到提交前。目标是验证没有被真实 BOSS 页面覆盖的表单能力，不重复跑 10 次测评。

### 9.3 真实 BOSS 人工冒烟

只跑一次已验证的非敏感链路：

```text
连接已登录 Chrome
→ 创建专用任务标签页
→ Snapshot
→ 输入关键词并搜索
→ 点击第二个岗位并读取动态详情
→ Screenshot
→ 停止
```

不得在本次冒烟中发起沟通、上传真实简历或投递。人工确认没有风控、回退、`null/` target 或其他私人标签页暴露即可。

## 10. 不进入第一版的内容

- CDP 受控代理和页面调试端口探测拦截。
- `agent-browser` fork 或修改第三方二进制。
- `Runtime.enable`、Network 监听和跨域 iframe 自动附着。
- 任意脚本执行工具。
- 复杂随机行为、时间窗、限额或“随机翘班”。
- 验证码、滑块或站点安全机制绕过。
- 与本次驱动替换无关的浏览器工具重命名或 Prompt 重构。

## 11. 进度

| 阶段 | 状态 | 说明 |
|---|---|---|
| 风控根因隔离 | 已完成 | `Runtime.enable` 被确认是充分触发条件 |
| 轻量 CDP 原语验证 | 已完成 | target、Snapshot、截图、点击、输入、搜索和动态详情均通过 |
| 方案与最小测试范围 | 已完成 | 以本文为开发依据 |
| PB-01 轻量 CDP Runtime | 已完成 | 已实现显式方法白名单、单任务 target、固定 Snapshot/Read、受控输入、截图与取消处理 |
| PB-02 Runtime 分流 | 已完成 | Chrome/Edge 已切换到轻量 CDP，Electron 继续使用原 CLI/companion；连接状态探测不再启动 CLI |
| PB-03 工具能力接入 | 已完成 | 14 个既有工具已映射；模型可见契约、Harness 确认、文件授权与页面 revision 保持不变 |
| PB-04 设置与文档 | 已完成 | 设置页已说明轻量个人浏览器与专用任务页，核心 Tools、Browser Tools、Electron CDP 文档和索引已同步 |
| 最小自动化与冒烟 | 已完成 | 4 个相关测试文件共 41 项通过，Backend/Contracts/Agent SDK/Renderer 构建通过；生产轻量驱动真实连接 Chrome，并从专用 BOSS 任务页取得 41 个可交互引用 |

### 11.1 2026-09-04 最小验证记录

- `personal-browser-cdp-runtime.test.ts` 与 `agent-browser-runtime.test.ts`：26 项通过。
- `browser-tools.test.ts` 与 `agent-host-browser-failures.test.ts`：15 项通过。
- `@avery/backend`、`@avery/contracts`、`@avery/agent-sdk` TypeScript 构建通过；Renderer Vite 构建通过。
- 静态白名单审查确认生产轻量驱动没有发送 `Runtime.enable`、`Page.enable`、`Network.enable`、`WebMCP.enable` 或 `Target.setAutoAttach` 的路径。
- 首次真实冒烟发现 target URL 会早于渲染文档提交更新，生产 Snapshot 因读取到 `about:blank` 而拒绝结果；驱动已增加固定 `location.href`/`readyState` 就绪轮询。第二次冒烟发现 BOSS 异步渲染可能晚于 DOM readyState，Snapshot 已改为短暂等待可交互结构出现，不使用固定长延迟。
- 最终真实冒烟通过：生产轻量驱动连接当前 Chrome，创建并只附着专用 BOSS 任务 target，Snapshot 返回 41 个可交互引用。测试没有搜索、填写、沟通、上传或投递，也没有发送任何禁止的 CDP 方法。

### 11.2 2026-09-04 CronTask 任务级浏览器授权

- 投递 CronTask 的周期级创建确认同时授予该任务个人浏览器权限，授权作为 `browserAuthorized` 持久绑定到真实 `cronTaskId`；设置页不再提供限时授权，只显示状态并允许撤销。
- 授权与连接状态分离：Avery 或浏览器重启不会删除任务授权，但执行时仍必须连接 Chrome/Edge、保持 BOSS 登录并通过浏览器自身的调试连接批准。
- Cron Runner 从数据库读取授权并传入 `SendScheduled`。Renderer 不能伪造 unattended 或授权字段；旧任务和已撤销任务返回 `BROWSER_CRON_ACCESS_REQUIRED`。
- 本功能不扩大到其他 CronTask、域名或本地文件；连接失败、登录失效和验证码继续由 Harness 暂停并生成待接管会话。
- 最小回归共 5 个测试文件、48 项通过；Contracts、Agent SDK、默认模块、Backend、Desktop 与 Renderer 构建通过。
