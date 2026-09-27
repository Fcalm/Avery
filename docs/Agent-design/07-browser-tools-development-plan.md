# Browser Tools：个人浏览器迁移规划

## 1. 目标与结论

Avery 的浏览器能力统一迁移到用户日常使用的 Chrome 或 Edge。浏览器扩展负责页面操作，本地桥接服务负责与 Agent、文件资源和 CronTask 通信。目标方案不再依赖隔离 Electron 浏览器、独立 Profile、`agent-browser` CLI 或远程调试端口。

PB-03/PB-04 已由用户确认完成，PB-05 已通过代码、安装包、生产浏览器和定时链路回归。浏览器测评 Runner 已完成本地案例并保存轨迹；发布收尾完成前，不将 PB-05 标记为整体通过。

模型可见的 `Browser*` 工具名称和 Schema 保持不变。模型不能接触扩展 API、本地通信协议、页面脚本、选择器、Cookie 或文件路径。

## 2. 覆盖范围

- 在 BOSS、第三方招聘平台、企业招聘官网和用户指定 URL 中搜索、读取和操作页面。
- 复用个人浏览器已有的账号、Cookie、登录验证和网络环境。
- 填写普通输入框、原生下拉、自定义下拉、级联菜单和日期控件。
- 上传已授权的简历、图片和其他投递材料。
- 支持交互式 Run 和 CronTask 后台 Run。
- 在登录失效、验证码、账号异常或结果不确定时停止并生成待接管会话。

不实现验证码绕过、风控对抗、密码读取、浏览器历史采集或跨任务页面复用。

## 3. 总体架构

```text
Agent Model
    ↓ Browser Tool Call
Tool Scheduler + Harness
    ↓ Schema、权限、确认、资源和取消校验
Browser Tool Adapter
    ↓ 内部稳定协议
Avery Browser Bridge
    ↓ 回环 HTTP 长轮询（随机令牌鉴权）
Avery Browser Extension
    ↓ Extension API + 最小调试命令通道
用户日常 Chrome / Edge
```

| 组件 | 职责 |
| --- | --- |
| Browser Tool Adapter | 保持现有工具契约，生成受控操作，不包含浏览器品牌分支 |
| Browser Bridge | 管理扩展连接、任务标签页、文件物化、超时、取消和稳定错误 |
| Browser Extension | 创建任务标签页、只附着任务标签页、执行白名单命令并返回结构化结果 |
| 页面操作模块 | Snapshot、读取、点击、填写、表单识别和 DOM 状态轮询；正文固定在 Host 版本中 |
| Harness | 控制任务权限、高风险确认、资源授权、幂等和结果对账 |

Bridge 仅监听 `127.0.0.1`，令牌保存在应用用户数据目录和扩展本地存储中，不进入页面、模型和 Trace。扩展只执行随版本发布的固定操作模块，不调用 `Runtime.enable`，Agent 输入不得被拼接为任意 JavaScript 执行。

## 4. 授权与页面边界

### 4.1 设备级启用

用户首次启用“个人浏览器自动化”时安装 Avery 扩展，并一次性授予其网页访问权限。该权限用于覆盖未知企业招聘域名和跨域投递流程，不要求用户在每次 Run 中重新点击扩展或授权标签页。

扩展权限不直接等于 Agent 权限。Avery 只把本次任务创建或登记的标签页加入 `browserTaskId`，模型只能读取和操作这些任务标签页；用户原有的邮箱、网盘、后台系统和其他标签页不得进入 Snapshot、Trace 或工具结果。

个人浏览器沿用用户当前网络环境，允许访问公开或内网招聘页面。导航仅接受 `http/https`，拒绝 `file:`、`chrome:`、`edge:`、`devtools:`、扩展页面和携带明文凭据的 URL。

### 4.2 Run 级授权

交互式 Run 使用当前会话的确认权限和文件授权。发送消息、提交申请、上传敏感材料等动作继续经过 Harness；`fully_trusted` 只降低确认频率，不扩大工具和资源范围。

### 4.3 CronTask 级授权

创建或更新投递 CronTask 时，在一次确认中冻结：

```ts
interface BrowserTaskGrant {
  mode: 'personal_browser_extension';
  purpose: 'job_search' | 'job_application' | 'boss_contact';
  allowNavigation: boolean;
  allowFormFill: boolean;
  allowFileUpload: boolean;
  allowExternalSend: boolean;
  resourceIds: string[];
  grantedAt: string;
  revokedAt?: string;
}
```

授权持久绑定到真实 `cronTaskId`。后台执行时不再弹出标签页授权或 CDP 连接确认；任务删除、执行周期结束或用户撤销后立即失效。旧任务不能自动获得新版授权。

## 5. 生命周期

| 对象 | 生命周期 | 作用 |
| --- | --- | --- |
| `browserDeviceId` | 一次扩展安装 | 标识已配对的个人浏览器，不进入模型参数 |
| `browserConnectionId` | 一次扩展在线连接 | 维护本机鉴权长轮询和健康状态 |
| `browserTaskId` | 一次浏览器任务 | 登记任务标签页、页面 revision 和授权 |
| `agentSessionId` | 一段连续对话 | 持有场景、上下文和工具快照 |
| `runId` | 一次发送或一次 Cron occurrence | 持有工具账本、确认、取消和结果 |

Chrome 或 Edge 已运行时，扩展连接现有浏览器；未运行时，Avery 可以正常启动用户配置的浏览器，扩展加载后恢复连接。Avery 不复制、迁移或清理用户 Profile。

任务结束后关闭由该任务创建的标签页；用户原有标签页保持不变。连接断开后废弃全部页面引用，恢复时重新登记标签页并生成 Snapshot。

## 6. 工具执行映射

| 工具 | 个人浏览器实现 |
| --- | --- |
| `BrowserNavigate` | 扩展创建任务标签页或导航当前任务标签页，返回最终 URL |
| `BrowserSnapshot` | 固定页面操作模块提取可见交互元素、字段上下文和稳定引用 |
| `BrowserScreenshot` | 扩展截取当前任务标签页可见区域，并按视觉模型规则临时注入 |
| `BrowserReadPage` | 固定页面操作模块返回限长正文、标题、URL 和截断信息 |
| `BrowserClick` | 重新校验引用和可见性后执行点击 |
| `BrowserFill` | 聚焦、清空并填写文本控件，触发页面需要的输入事件 |
| `BrowserFillForm` | 复用既有字段特征、语义匹配和动态控件执行器 |
| `BrowserValidateForm` | 重新读取必填项和浏览器校验状态，不触发提交 |
| `BrowserSelect` | 处理原生下拉以及已识别的站点自定义选项 |
| `BrowserSetChecked` | 设置任务页面内的复选框或单选项 |
| `BrowserPressKey` | 只接受既有按键枚举 |
| `BrowserUploadFile` | Bridge 校验并读取授权资源，扩展将文件绑定到目标上传控件 |
| `BrowserWait` | 固定页面操作模块有界轮询 URL、文本、元素或 DOM 稳定状态 |
| `BrowserSwitchTab` | 只切换当前 `browserTaskId` 登记的标签页 |
| `BrowserGoBack` | 在当前任务标签页执行历史返回并推进页面 revision |

`ContactBossJobs` 和 `CollectJobs` 继续通过相同 Browser Bridge 使用业务专用状态机，不把 URL、DOM、选择器和重试策略暴露给模型。

## 7. CronTask 执行

```text
occurrence 到期
  ↓
读取 BrowserTaskGrant 和冻结资源
  ↓
浏览器已运行 ── 是 ──→ 等待扩展连接
  │
  否
  ↓
正常启动用户配置的 Chrome / Edge
  ↓
扩展创建后台任务标签页
  ↓
执行岗位搜索、表单填写、上传或发送
  ↓
验证结果、写 Tool Ledger、关闭任务标签页
```

电脑关机或休眠时沿用 CronTask 的补执行规则，只补最近一次。浏览器无法启动、扩展离线、登录失效、验证码、短信验证或账号异常时写为 `needsAttention`，不得无界重试或伪造成功。

CronTask 使用冻结的持久文件资源，不继承普通会话临时附件。执行期间的高风险动作由 `BrowserTaskGrant` 和业务幂等账本共同约束，不在后台弹出阻塞确认框。

## 8. 错误、取消与审计

- Browser Bridge 为连接失败、扩展离线、标签页消失、导航失败、页面引用过期、操作超时和结果不确定提供稳定错误码。
- 每个可能产生外部副作用的动作先写检查点；超时或连接断开后无法确定结果时返回 `status_unknown`，恢复前先对账。
- 同一 `browserTaskId` 的页面动作串行执行；不同测评任务可使用独立任务标签页并发，真实投递默认按平台策略串行。
- Trace 记录 Agent tool call/result、任务标签页 ID、耗时和稳定错误，不记录 Cookie、Authorization、密码、完整页面正文或本地文件路径。
- 页面内容始终是不可信数据，不能修改工具白名单、确认权限、资源授权或 System Prompt。

## 9. 迁移步骤与验收

### PB-01：扩展与本地桥接

- 建立扩展与 Avery 的本机鉴权连接。
- 支持浏览器在线探测、正常启动、任务标签页创建和断线恢复。

验收：无需远程调试端口和独立 Profile；Avery 能在已登录个人浏览器中创建任务标签页，且不能枚举用户其他标签页内容。

### PB-02：通用浏览器工具

- 将第 6 节工具接入扩展 Runtime。
- 保持既有 Tool Schema、page revision、确认和文件资源协议。

验收：本地拟真招聘站的读取、点击、填表、验证、截图和上传通过；旧引用、未授权文件和非任务标签页操作被拒绝。

### PB-03：真实招聘流程

- 验证 BOSS 岗位采集、打招呼和图片上传。
- 验证至少两个不同供应商的企业招聘官网完整投递流程。

验收：复用用户登录态完成提交前全流程；实际发送或提交只在测试账号及明确授权下执行；验证码和登录失效能暂停接管。

### PB-04：CronTask

- 创建任务时冻结 `BrowserTaskGrant` 和持久资源。
- 支持浏览器未运行时正常启动并等待扩展连接。

验收：BOSS 与企业官网各完成一次无人值守测试；执行时不需要标签页授权或 CDP 确认；离线和登录失效产生可恢复会话。

### PB-05：移除旧 Runtime

- 删除隔离 companion、独立 Profile、`agent-browser` CLI 和个人浏览器 CDP 设置入口。
- 清理仅服务旧 Runtime 的打包资源、IPC、测试和文案。

验收：受影响构建、契约测试、浏览器工具测试、BOSS/企业官网冒烟和 CronTask 回归全部通过，安装包不再包含旧浏览器 Runtime。

## 10. 进度

| 阶段 | 状态 | 说明 |
| --- | --- | --- |
| 目标架构与权限模型 | 已完成 | 本文冻结个人浏览器扩展、Bridge 和任务级授权方案 |
| PB-01 扩展与本地桥接 | 已完成 | Chrome 实测已完成扩展配对、任务标签页创建与单标签页边界校验 |
| PB-02 通用浏览器工具 | 已完成 | Chrome 实测已通过导航、Snapshot、读取、输入、选择、文件上传与截图 |
| PB-03 真实招聘流程 | 用户确认完成 | 下方 2026-09-14 审核是历史快照；本轮不重跑真实站点 |
| PB-04 CronTask | 用户确认完成 | 下方 2026-09-14 审核是历史快照；本轮不重跑无人值守任务 |
| PB-05 移除旧 Runtime | 生产浏览器、定时链路及测评 Runner 已回归，待发布收尾 | 本地浏览器测评 3 个案例已执行并留存 trace，其中 2 个任务完成；本轮新候选包已完成打包和内容检查，但未安装验证，PB-05 不因此视为整体通过 |

## 11. 阶段审核、待办与发布收尾（2026-09-14 只读盘点）

本节原为 2026-09-14 的审核快照。用户在 2026-09-23 确认 PB-03/PB-04 完成并授权开始 PB-05；历史缺口保留供核对，不作为本轮最新状态。PB-05 仍需独立取得完整放行证据。

### 11.1 PB-03 阶段审核：真实招聘流程

状态：阻断，仍为“进行中”。PB-01/PB-02 现有 Chrome 单标签页记录继续保留，但不代表多任务标签页、跨域新窗口和真实站点流程已完成。当前代码与记录的具体缺口如下：

- [ ] 任务标签页模型必须支持同一任务的标签页集合、窗口和生命周期；当前扩展仍只保存一个 `TaskTabStorageKey`，`Target.createTarget` 会关闭旧任务页，Runtime 仍只返回 `task`。补齐 `tabs.onCreated`、`openerTabId`、关闭/失联清理、跨域导航和 `target=_blank` 新窗口接管，并实现真实的 `BrowserSwitchTab`。不得把目标收窄为永远单标签页。
- [ ] 收紧 Bridge 的任务边界：`apps/backend/src/electron/backend/browser-extension-bridge.ts` 当前只转发通用 operation/payload，没有 `browserTaskId`、目标归属或按任务隔离；`apps/backend/src/electron/backend/personal-browser-extension-runtime.ts` 也只把消息包装为通用 `cdp`。补齐任务登记、目标校验、断连后引用失效和跨任务拒绝，不能只依赖扩展的全局单标签页状态。
- [ ] 增加并保存完整的新链路 `AgentHost → AgentBrowserRuntime → BrowserExtensionBridge → 扩展 → 浏览器` AgentHost smoke。当前 `scripts/smoke-browser-migration-pb03.mjs` 的 collect/contact 分支使用 AgentHost，但 enterprise 分支的 `RunEnterprise` 直接调用 Runtime，不能作为企业官网 Host 流程证据；`apps/backend/src/electron/backend/evaluation/browser-eval-runner.ts` 仍以未注入 Bridge 的旧 `AgentBrowserRuntime`（当前约第 94-101 行）运行，不能作为本阶段迁移证据，其统一替换留在 PB-05。
- [ ] 在测试账号和明确授权下完成 BOSS 岗位采集/打招呼/图片上传，以及两个不同供应商企业官网的提交前完整流程：导航、岗位/表单读取、普通选择、级联选择、文本输入、简历/图片上传、条款勾选和提交前确认。当前脚本每次运行接受一个 `--enterprise-url`，可以用两个不同 ATS URL 分别运行并关联两份证据；目前仍缺第二家企业官网的真实证据。BOSS 现有证据仍是只读 Snapshot，联系分支默认停在确认门前，不能替代完整证据。最终证据可以停在提交前且不产生外部副作用，不以实际提交为硬门槛；真实简历上传和第二家企业仍待验收。
- [ ] 验证非任务标签页不可见且不可操作、旧 revision/失联引用拒绝、跨域和新窗口仍属于正确任务、扩展断连后可恢复、登录失效/验证码进入 `needsAttention`、上传资源越权拒绝、失败/未知状态不自动重试或重复发送。
- [ ] 记录任务/窗口/标签页清单、精确命令、提交前最终状态、无副作用证明、脱敏日志/截图/trace，并保存可复核产物。当前 `artifacts/browser-migration/pb03/*/summary.json` 仅有 `observed`、`blocked_missing_explicit_contact_target` 和 `blocked_missing_enterprise_url`，没有可放行的 `passed`/`passed_pre_submit` 产物。`scripts/smoke-browser-extension.mjs` 当前是直接调用 Runtime 的本地 smoke，不能单独作为 AgentHost 或真实站点评测证据；新增的 `scripts/smoke-browser-migration-pb03.mjs` 可作为 AgentHost smoke 入口，但必须有分项结果和产物后才能计入验收。

PB-03 放行证据：逐项测试结果和失败日志；AgentHost 新链路 smoke 记录；BOSS 与两个企业供应商的站点/账号范围；新窗口及跨域 target 归属记录；上传资源哈希/冻结来源；提交前确认和最终停留状态（可为未提交）。任一链路缺失，状态保持阻断。

### 11.2 PB-04 阶段审核：CronTask 与 BrowserTaskGrant

状态：实现完成，待完成剩余真实环境验收。`BrowserTaskGrant` 仅使用第 4.3 节字段，未新增版本、expiry 或额外 scope 抽象。文件级执行清单如下：

- [x] `packages/contracts/src/cron-task.ts`、`packages/contracts/src/index.ts`：新增并导出强类型 `BrowserTaskGrant` schema/type，接入 `CronTaskDto` 与创建确认输入；grant 仅包含 `mode`、`purpose`、四个 `allow*` 布尔值、`resourceIds`、`grantedAt` 和可选 `revokedAt`，任务 ID 作为所属任务关系而不是新增 grant 字段。
- [x] `migrations/business/v14-cron-browser-task-grant.sql` 与 `migrations/business/manifest.json`：以后续增量迁移持久化 grant JSON；旧布尔值不自动升级，临时附件路径不进入授权。
- [x] `apps/backend/src/electron/repositories/cron-task-repository.ts`、`apps/backend/src/electron/backend/services/cron-task-service.ts`、`apps/backend/src/business-store.ts`：Create/Read/Update/Revoke/Claim 按 `cronTaskId` 读写同一 grant，冻结资源 ID，任务删除/撤销会持久化 `revokedAt`，保留 revision、幂等和审计写入。已授权任务修改执行消息时要求重新创建并确认，避免无确认扩权。
- [x] `apps/backend/src/electron/backend/agent-host.ts`、`apps/backend/src/electron/backend/agent-browser-runtime.ts`：Prepare/Confirm、Get/Revoke 和 SendScheduled 只传递经确认的 grant；运行时按 `allow*` 与 `resourceIds` 拒绝越权，不以连接在线或旧 bool 充当授权。
- [x] `apps/backend/src/electron/backend/services/cron-runner-service.ts`：从 claim 的任务持久记录传递同一 grant；登录失效、用户问答、确认等待与 TaskGrant 越权导致的 `paused` 均记为 `needsAttention`，不误记为成功。
- [x] `packages/contracts/src/bridge.ts`、`apps/backend/src/router.ts`、`apps/backend/src/electron/backend/services/agent-run-service.ts`、`apps/desktop/src/preload.cts`、`electron/preload.cjs` 及 `src/features/assistant/api/agentQueries.ts`/`src/features/settings/pages/SettingsPage.tsx`：同步 CronTask grant 的窄 IPC/状态展示与撤销调用，不暴露本地路径、凭据或额外授权字段。
- [ ] 自动化文件：`tests/unit/backend/cron-task.test.ts`、`tests/unit/backend/cron-runner-service.test.ts`、`tests/unit/backend/agent-host-browser-failures.test.ts`、`tests/unit/backend/agent-browser-runtime.test.ts`、`tests/unit/backend/personal-browser-cdp-runtime.test.ts`；覆盖 grant schema/持久化/恢复/撤销、资源隔离、Runner 传递、重启、并发、冷启动和拒绝路径。
- [ ] 覆盖浏览器未启动、Bridge/扩展冷启动、系统定时唤醒、扩展断连、登录失效和验证码接管；BOSS 与一个企业官网各完成一次无人值守执行，不出现标签页授权或 CDP 确认；失败/未知状态进入可恢复会话且不重复发送。
- [ ] 真实证据记录浏览器/扩展启动时间线、任务状态迁移、grant 前后快照、`needsAttention` 原因、恢复结果和最终状态。

PB-04 放行证据：迁移后的 schema/contract/Repository/IPC/Runner 测试结果；数据库脱敏前后快照；grant 与资源清单；冷启动/系统唤醒日志；BOSS 与一个企业官网的无人值守记录；撤销后的拒绝证明；错误状态和恢复账本。PB-03 未签字前不执行本阶段实现。

### 11.3 PB-05 阶段审核：统一迁移与移除旧 Runtime

状态：代码、打包、生产浏览器、定时链路及浏览器测评 Runner 已回归，待发布收尾；PB-03/PB-04 已由用户确认完成。待办：

- [x] 生产链路和评测链路统一到 Bridge/扩展；移除旧 `agent-browser` CLI、companion、隔离 Profile 和个人浏览器 CDP 设置入口。测评 Runner 复用生产 Bridge，并冻结 Chrome/Edge 选择与本地 fixture origin。
- [x] 清理旧生产与评测消费者：Runtime 仅通过扩展创建任务驱动；AgentHost、Backend 组合根和测评 Runner 共用 Bridge；删除 companion、ClearBrowserProfile IPC/契约/设置入口。`personal-browser-cdp-runtime.ts` 保留为扩展消息的受限动作实现，不再直接附着远程调试端口。
- [x] 清理/改造旧 smoke 与诊断消费者：移除依赖 CLI/companion/远程调试的八个旧脚本及 npm 别名，保留 `smoke-browser-extension.mjs` 与 `smoke-browser-migration-pb03.mjs` 并移除旧构造参数。最终真实流程证据仍须经过 AgentHost，不能以直接 Runtime fixture 冒充。
- [x] 保留并改造发布校验：`release-preflight`、`check-cjs`、`verify-package-contents`、`smoke-packaged-app` 和 `smoke-installed-app` 已运行通过。包内容校验检查旧 agent-browser/companion 缺席及扩展资源存在；打包版冒烟禁用系统 CronTask 同步，避免测试修改真实计划任务。`write-release-manifest`、安装生命周期和视觉烟测未在本轮执行，不计入已通过证据。
- [x] 移除 `agent-browser` 依赖和 `asarUnpack` 配置，保留扩展 `extraResources`；包内容校验新增旧二进制缺席与扩展 manifest/Worker 存在检查，新增 `smoke:browser-migration` 别名。
- [x] 代码、依赖和打包门禁：2026-09-23 `npm test` 为 497 passed / 1 skipped，后端 Node 测试 8 passed；`npm run build`、`check-cjs`、`release-preflight`、扩展 `host-init-only`、目录包启动 IPC、Windows 安装包内容检查与静默安装/启动/卸载均通过。包内 5613 个条目，无禁入文件、无旧浏览器二进制，扩展版本 0.2.0。已修复打包后 Skill 根目录误算为 `node_modules/skills` 的 ENOENT；安装包自带可执行文件能读取默认场景 1 个和投递场景 4 个 Skill。最新安装包 `Avery-Setup-0.1.0-x64.exe` 的 SHA-256 为 `36A3DD46D217C613044AA91BCAF9DFDB565283B465DC82F84381A614EBA83018`。
- [x] 生产 AgentHost 真实浏览器回归：安装版对话已消除 Skill 路径 ENOENT；岗位采集、导航、表单填写/校验有成功工具回执，文件上传由用户实测成功。18:43 一次任务页清理出现 `status_unknown/BROWSER_COMMAND_TIMEOUT`，用户确认原因为 Chrome 在已填写表单关闭时弹出“不保存”确认；随后 18:48 的任务页清理回执为 `confirmed`。不把前一次未知清理伪装为成功。
- [x] 定时浏览器回归：2026-09-23 18:56 的投递场景 CronTask 准时执行，Run/Trace 均为 `completed`；`LoadSkill`、`CollectJobs` 成功，任务页清理 `confirmed`。
- [x] 浏览器测评 Runner 使用同一扩展 Bridge 完成本地案例并保存 trace。2026-09-24 Run `run-10252c22-e69c-497b-9c7d-27a05d65f9a1` 的 3 个案例均完成执行并写入 `trace.json`；岗位筛选读取 JD 和进入投递页两个案例各得 100 分，完整投递案例得 30 分、任务未完成。此项仅验证 Runner/Bridge 路径及轨迹留存，不代表完整投递能力通过；前端测评结果显示问题另行处理。

2026-09-24 接续检查：`release-preflight`、`check-cjs`、`npm test`（Vitest 498 通过、1 跳过；后端 Node 测试 8 通过）、`npm run build` 与 `git diff --check` 已通过。项目内两个新输出目录均在 Electron 解压后的 `win-unpacked.tmp` 改名阶段返回 `EPERM`；改用系统临时目录后目录包和 Windows 安装器构建成功。最终目录包启动/IPC 冒烟通过（Renderer、Backend、Agent 与 Browser Runtime 状态均正常，1012ms 就绪），包内容检查通过（5623 项，无禁入文件及旧浏览器二进制，扩展 0.2.0）。候选安装器为 `C:\Users\FANWEI~1\AppData\Local\Temp\avery-pb05-next-20260924\Avery-Setup-0.1.0-x64.exe`，SHA-256 为 `DCE8BCD63563BA121F9810146118763579A7C40F5053000DD355339FCA9D75F5`。该包来自尚未整理提交的工作区，未做安装后冒烟，不标记 PB-05 放行。

测评 Run 完成后再次核对该候选包：`verify-package-contents` 通过，安装器哈希未变。当前用户目录已有 Avery 安装；现有 `smoke-installed-app.mjs` 会执行同一应用身份的静默安装与卸载，故未对该候选包运行安装后冒烟，以免覆盖现有安装的注册信息。

用户本轮明确跳过后续打包测试，继续代码与提交范围审查。旧 `agent-browser` 依赖、CLI 调用、companion 生产入口及远程调试端口设置均无命中；`PersonalBrowserCdpRuntime` 仍保留为扩展 Bridge 后面的受限动作实现，不能按文件名误判为旧直连入口。浏览器 Bridge/Worker、Runtime、测评服务与评分、定时 Runner 的 6 个相关单测文件共 110 项通过；随后全量 `npm test`（Vitest 498 通过、1 跳过；后端 Node 测试 8 通过）、`npm run build`、`release-preflight` 和 `check-cjs` 通过。迁移代码与旧 CLI 清理已分类提交为 `8302875`、`8ef1a35`；未跟踪的 `release-pb05/` 构建产物未纳入版本控制。跳过安装冒烟不等同于发布验证通过。

PB-05 放行证据：旧消费者搜索清单及零命中例外；依赖树与安装包文件清单；干净构建和安装后扩展加载/配对/任务页测试；生产 AgentHost 与评测 Runner 的同一路径 trace；完整测试报告。未取得前两阶段签字不得移除兼容实现。

### 11.4 发布收尾与基线隔离

- [ ] 放行顺序固定为：PB-03 审核签字 → PB-04 实现与审核 → PB-05 实现与审核 → 全量测试/类型检查/构建 → 目录包与 Windows 安装包 → 安装后冒烟与发布前清单。可执行命令清单是：`node scripts/release-preflight.mjs`（可选 `--require-builder-cache`）、`node scripts/check-cjs.mjs`、`npm test`、`npm run build`、`npm run smoke:browser-migration`、`npm run pack:dir`、目录包的 `node scripts/smoke-packaged-app.mjs`、`npm run pack:win`、安装包的 `node scripts/smoke-installed-app.mjs`，以及最终 `node scripts/verify-package-contents.mjs` 与 `node scripts/write-release-manifest.mjs`。`pack:dir`/`pack:win` 默认输出到 `release-rebuild`；`verify-package-contents.mjs` 需在有 Windows 安装器的 pack:win 后运行。本轮用本机 Electron 路径和独立临时输出目录完成安装包验证，不代表默认 `release-rebuild` 目录已生成可发布产物；`smoke:browser-migration` 的 `host-init-only` 不代表真实浏览器已通过。
- [ ] 每阶段使用独立 Conventional Commit，提交前复核 `git status`/`git diff`，确认迁移范围无漏提交，并记录依赖/密钥/缓存/构建产物；无关用户改动明确保留在当前上下文，不清理或强行覆盖；发布产物必须对应可复现提交，父代理审核后才允许合并或 push。未完成阶段不得以旧 CDP、旧 companion、孤立 fixture 或单浏览器记录替代。
- [x] 历史 HEAD 基线：`78c5cbd`（提交时间 2026-09-13 21:18:08 +0800；该时间不代表审计发生时间）。当时记录的分支为 `feature/prototype-ui-shell`，相对 `main` 为 `main...HEAD = 0 49`，共同祖先 `48254faf`。工作区已有迁移代码、扩展、测试和多份规划文档未提交，另有 UI/README 等变更；旧版设计文档的删除为既有用户改动，当时不恢复、不代提交、不纳入迁移提交。
- [x] 历史复核（2026-09-14）：实际仓库为 `D:\Avery\project`（旧路径 `D:\OfferGet-Rebuild\project` 已不存在）；当时分支是 `feature/prototype-ui-shell`，`HEAD e7beab6`，相对 `main` 为 `main...HEAD = 0 53`，较上述历史基线新增 4 个提交。工作区仍有用户/代理未提交改动及未跟踪文件；当时保留 `Avery-prototype/` 与旧版设计文档删除。此前出现的 `codex/personal-browser-migration` 仅属于历史基线记录，不是当时分支。
- [ ] 接续路径：迁移链路与旧 CLI 清理已分类提交；2026-09-27 经用户确认，原型单独提交，旧版 DESIGN 文档作废并清理依赖引用，视频文档暂不提交；上述变更与迁移提交及构建产物隔离。是否合并到目标分支或 push 留待单独审核，不以本轮分类提交代替发布放行。

发布收尾放行证据：最终分支/提交图、迁移范围无漏提交审计记录及无关用户改动保留记录、可复现提交对应的全量测试与构建日志、安装包 SHA256/版本、安装后扩展加载及 Chrome/Edge smoke、真实站点无副作用/回执记录、旧 Runtime 搜索与包内容检查、审核签字记录。
