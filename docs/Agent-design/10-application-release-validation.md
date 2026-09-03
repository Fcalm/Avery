# 投递 Agent 发布验证

## 1. 目标与证据边界

本文件承接 AP-06，只记录正式发布前的桌面、打包、真实模型和真实站点验证。三类证据不可互相替代：

- `smoke-packaged-app` 证明打包 Renderer、preload、IPC、Backend 与 AgentHost/Browser Runtime 状态查询可达。
- `smoke-packaged-agent-application` 证明 AgentHost 使用打包目录内的 CLI 与隔离浏览器 companion 能完成确定性本地投递站流程；它不证明 Renderer 已驱动整条投递业务流。
- `evaluate:deepseek-application` 证明真实 DeepSeek 在相同本地站点上的规划能力；它不改变工具、确认、导航和资源授权安全边界。

当前 AP-06 只评估 DeepSeek。OpenAI Adapter 暂不开发，也不以“自定义 OpenAI-compatible”配置替代正式 OpenAI 支持。

## 2. 打包态自动化

先构建 Windows 目录包，再分别执行桌面 IPC 和打包浏览器投递冒烟：

```powershell
npm run build
node node_modules/electron-builder/out/cli/cli.js --dir --config.directories.output=release-rebuild/ap06 --config.electronDist=node_modules/electron/dist

$env:AVERY_PACKAGED_EXE = (Resolve-Path 'release-rebuild/ap06/win-unpacked/Avery.exe').Path
npm run smoke
Remove-Item Env:AVERY_PACKAGED_EXE

$env:AVERY_PACKAGED_ROOT = (Resolve-Path 'release-rebuild/ap06/win-unpacked').Path
npm run smoke:packaged-agent-application
Remove-Item Env:AVERY_PACKAGED_ROOT
```

验收时必须同时确认：

- 桌面结果包含 `rendererAgentIpc.agentStatus=true` 和 `rendererAgentIpc.browserRuntimeStatus=true`。
- 投递结果包含 `packagedCli=true`、`packagedCompanion=true`、`submissionCount=1` 和稳定回执。
- 命令未从 `PATH` 搜索全局 CLI，也未启动系统浏览器。
- 若根构建失败，即使目录包基于局部构建可运行，也不得把根构建门禁标记为通过。

## 3. DeepSeek 固定评估

评估使用随机 loopback fixture、独立用户目录和独立浏览器 profile。导航测试策略只放行本次精确 origin；API Key 仅从环境读取，不写入结果或测试目录。

```powershell
$env:DEEPSEEK_API_KEY = '<测试密钥>'
$env:AVERY_DEEPSEEK_MODEL = 'deepseek-v4-flash'
$env:AVERY_EVALUATION_RUNS = '10'
npm run evaluate:deepseek-application
Remove-Item Env:DEEPSEEK_API_KEY
```

每轮保存独立结果 JSON 和脱敏运行日志 JSON，字段至少包括模型、耗时、发送次数、模型轮数、工具调用数、工具错误、正常确认等待、确认次数、人工接管、提交次数、回执、最终文本、Usage 和失败原因；汇总保存在同目录 `summary.json`，追加式过程日志保存在 `evaluation.log`。结果目录默认位于被 Git 忽略的 `artifacts/application-evaluation/`。

评估形成首份 10 次基线前不设完成率阈值。运行失败也必须保留原始结构化结果，禁止只重跑失败轮次后覆盖首轮基线。

## 4. 真实招聘站人工兼容性检查

真实站点检查不是自动投递测试。每个站点开始前必须记录测试账号归属、材料用途、允许到达的最远页面和用户本次批准范围；缺少任一项时只允许读取公开 JD。

检查顺序：

1. 用户接管登录与验证码，Agent 不读取、保存或转述验证码。
2. Agent 读取岗位列表和 JD，验证 Snapshot 语义与页面变化后的 ref 失效。
3. 在用户明确批准后，使用专用测试资料验证文本框、普通下拉和级联下拉；未批准时不上传文件。
4. 到达最终提交或发送消息前停止，验证确认卡中的动作、目标站点和风险说明。
5. 未获得针对该次真实动作的明确确认，不点击最终提交、不发送消息、不向真实雇主产生记录。
6. 记录失败对应的原子能力，例如 Snapshot 语义、Select、UploadFile、SwitchTab 或用户接管；禁止新增按站点命名的高层投递工具和硬编码坐标。

建议记录表：

| 字段 | 内容 |
| --- | --- |
| 站点与日期 | 域名、页面类型、验证时间 |
| 授权 | 测试账号归属、材料、最远允许步骤 |
| 页面能力 | 搜索、JD、普通下拉、级联下拉、上传、消息输入 |
| 接管 | 登录、验证码、异常风控及恢复后首次 Snapshot |
| 外部动作 | 是否在最终确认前停止；是否产生真实记录 |
| 差异与改进 | 失败的原子工具/页面语义，不记录站点专用坐标 |

## 5. 当前进度（2026-08-25）

- 投递场景已按用户决定以“公开测试”状态开放到应用：默认会话空页面提供明确入口，投递会话展示真实网站能力与安全边界，并可从输入栏场景菜单切换。
- 每次进入新的投递会话都会恢复 `always_confirm`；运行中的 Agent 不允许切换场景。公开入口不改变公网 URL/DNS 校验、登录与验证码接管、附件授权、冻结动作及外部提交确认。
- 打包目录构建成功；打包桌面 IPC 冒烟通过，启动就绪 627 ms。
- 打包 CLI/companion 投递冒烟通过：6 个岗位、普通下拉、两组级联下拉、6 次确认（含 3 次拒绝重规划）、一次提交、回执 `LOCAL-APPLICATION-0001`。
- 两条冒烟目前是可组合但独立的证据；尚未自动化“Renderer 发起投递 → UI 展示确认/停止恢复 → Backend AgentHost 执行”的同一业务事务，因此对应桌面 UI 验收项保持未完成。
- DeepSeek 10 次真实评估已完成，10/10 成功，首份结构化基线已保留。
- 真实招聘站检查需要用户提供测试账号、可撤销材料和逐站授权，当前未执行，也未产生任何真实投递或消息。
- 根构建首次受 Windows 对 `electron/preload.cjs` 的短暂 user-mapped section 锁影响；未删除或覆盖文件，统一回归结束后原命令重试已完整通过。

### 5.1 DeepSeek 首份基线与错误分析

2026-08-25 使用 `deepseek-v4-flash` 连续执行 10 次：完成率 100%，平均 28.2 个模型轮次，平均耗时 79.55 秒，单轮耗时范围 58.80～90.67 秒，平均 36.7 个工具结果。

旧版汇总报告 `totalToolErrors=70`，但其中 30 次是三类强制确认各出现一次的 `CONFIRMATION_REQUIRED`，属于正常等待状态，不是工具错误。其余 40 次按错误码分为：

| 数量 | 类型 | 分析与处理 |
| ---: | --- | --- |
| 34 | `BROWSER_STALE_PAGE_REF` | Prompt 未明确说明 `BrowserSelect` 也会使全部 ref 失效，而 Runtime 会在每次 Select 后强制失效。已同步协议，要求 Select 后以及跨 Run 恢复后先重新 Snapshot。 |
| 3 | `SKIPPED_AFTER_WAIT` | 模型在可能进入确认等待的动作后同批安排了后续调用；Scheduler 正确阻断。已要求上传、协议、发送与最终提交作为该批最后且唯一的浏览器动作。 |
| 1 | `BROWSER_ARGUMENT_INVALID` | `BrowserWait` 的 `kind=load` 使用了不支持的 value；工具说明已列出三个合法值。 |
| 1 | `BROWSER_FILE_NOT_AUTHORIZED` | 模型没有使用 runtime-context 中的精确附件 path 作为 fileId；Prompt 与工具说明已明确 display name 不能代替 fileId。 |
| 1 | `INVALID_JSON` | Provider 生成了畸形工具参数 JSON，现有一次纠正与结构化错误策略保持不变，不扩大容错。 |

评估结果 Schema 升级为 v2：`CONFIRMATION_REQUIRED` 计入 `expectedConfirmationWaits`，只有其余失败进入 `toolErrors`；每项错误同时记录工具名、脱敏参数、分类和错误码，汇总增加 `errorBreakdown`。这修正的是指标含义，不会隐藏原始等待或失败。

### 5.2 应用内投递会话首轮故障修复

应用内新建会话会把 `tool_array_snapshot_json` 初始化为 `[]`。Host 曾将这个空占位数组误判为已有的默认场景工具快照，导致投递场景首条消息触发“会话已绑定其他场景”，模型循环没有启动。修复后，只有该精确空数组被识别为“尚未生成快照”；其余非空或已持久化快照仍保持场景冻结。回归测试同时验证首次投递请求包含 `BrowserNavigate`，以及生成快照后仍不能在同一会话切换场景。

### 5.3 隔离浏览器失效 CDP 恢复

应用内 `BrowserNavigate` 曾返回 Windows `os error 10060`。复现时目标招聘站可直接访问、Backend 与 profile 锁持有进程正常，但 `DevToolsActivePort` 指向的端口已无监听；agent-browser daemon 仍报告会话存在，说明 companion 异常退出或重启后复用了绑定旧 CDP 端口的 daemon，而不是目标网站不可达。

修复后，agent-browser namespace 同时包含 Backend PID 与 companion 代次。每次重建 companion 都淘汰旧实例并切换全新 namespace，旧 daemon 的有限关闭失败不会阻塞新实例启动。只有不产生投递、上传或消息副作用的 `BrowserNavigate` 在传输/启动故障后允许以新实例重试一次；点击、填写、上传、发送和提交不自动重放。运行状态也区分组件缺失、已停止、健康和连接异常，错误消息直接显示在投递状态栏。

回归验证包括：失效 CDP 后两个导航分别使用不同 namespace、旧 companion 被关闭、第二次导航成功且状态恢复为健康；真实 companion 冒烟完成 CDP target 隔离、Snapshot、Fill 和 Click；全量自动化测试通过。

## 6. 总结

AP-06 已具备可重复的打包冒烟和 DeepSeek 结构化评估能力，完整根构建及 DeepSeek 10 次基线均已通过。投递场景现已进入应用内公开测试，但这不等于稳定版验收完成：同一事务内的桌面投递 UI 自动化和真实站点人工兼容性检查仍待完成，相关风险必须继续对用户可见。
