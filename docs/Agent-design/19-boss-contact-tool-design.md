# BOSS 批量打招呼工具方案

> 状态：第一版已开发并完成真实 CDP 验证
> 更新时间：2026-09-11
> 适用场景：投递场景 `application`

## 1. 目标范围

`ContactBossJobs` 使用用户已授权且已登录的个人浏览器，依次向岗位库中的 BOSS 直聘岗位发起沟通、发送消息和可选图片，并验证每一项实际结果。

第一版支持：

- 每次调用处理 1 至 10 个已经保存的 BOSS 岗位。
- 使用账号首条常用语；兼容“立即沟通”自动发送和进入聊天页后选择发送两种账号配置。
- 使用 Agent 为指定岗位生成的自定义消息。
- 向批次内全部岗位发送同一张已授权图片。
- 处理“立即沟通 -> 关闭首次沟通弹窗 -> 继续沟通 -> 聊天页”的完整流程。
- 批次级确认、逐项检查点、防重、消息与图片送达验证。

第一版不支持：

- 企业官网或其他第三方平台。
- 自动发送简历卡片。
- 自动交换微信或电话。
- 在首次沟通弹窗内选择常用语、发送自定义消息或上传图片。
- 模型提供 URL、选择器、页面脚本、浏览器命令、延迟或重试策略。

## 2. 工具定义

工具名称：

```text
ContactBossJobs
```

工具风险属性：

```text
sideEffect: external_action
risk: high
idempotency: required
isConcurrencySafe: false
allowedScenarios: [application]
requiredResources: [bound_resume, personal_browser]
```

同一个会话同一时间只允许一个活动 BOSS 联系批次。批次内部串行处理岗位，不并发打开或发送多个聊天会话。

## 3. 输入 Schema

```json
{
  "items": [
    {
      "jobId": "job-001",
      "message": {
        "mode": "first_quick_phrase"
      }
    },
    {
      "jobId": "job-002",
      "message": {
        "mode": "custom",
        "text": "您好，我有三年产品规划和跨团队协作经验，希望进一步了解这个岗位。"
      }
    }
  ],
  "imageAssetId": "asset-resume-image-001"
}
```

约束：

- `items` 必须包含 1 至 10 项，`jobId` 不得重复。
- `jobId` 必须指向岗位库中 `channel=boss_zhipin` 的有效岗位。
- `message.mode` 只允许 `first_quick_phrase` 或 `custom`。
- `custom` 必须提供 1 至 1000 字符的 `text`；`first_quick_phrase` 不得提供 `text`。
- `imageAssetId` 可选。提供时，同一张图片发送给批次内全部岗位。
- 不接受 `count`、`resumeId`、URL、本地路径、selector、按钮文本、脚本、浏览器命令、延迟、重试次数或风险策略。
- 不同岗位需要不同图片时必须拆分为不同批次。

## 4. 消息来源

### 4.1 首条预设招呼语

`first_quick_phrase` 表示使用 BOSS 账号当前配置的首条常用语。

执行规则：

1. 点击前写入 `initial_greeting_sending` 检查点。
2. 只点击当前岗位页中可见的“立即沟通”。
3. 首次沟通弹窗包含“已发送”消息时，保存完整规范文本并写入 `message_sent`。
4. 弹窗只建立沟通关系时写入 `contact_started`，关闭弹窗并点击“继续沟通”。
5. 进入目标聊天页后，只有 `contact_started` 分支打开“常用语”、选择首条正文并验证己方消息；已经获得“已发送”回执的分支不得重复发送。

确认提案冻结 `first_quick_phrase` 选择模式，不冻结账号设置中可能变化的正文。要求确认具体全文时使用 `custom` 模式；平台已经自动发送账号预设招呼语时，Host 仍在聊天页继续发送冻结的自定义文本。

### 4.2 自定义消息

`custom` 模式使用冻结的 `text`：

1. 进入并校验聊天会话。
2. 定位聊天输入框并清理残留草稿。
3. 输入完整冻结文本。
4. 执行发送动作。
5. 在当前会话的己方消息中验证规范化后的完整文本。

输入完成后必须等待页面移除发送按钮的 CSS 禁用态，再刷新页面引用并点击发送。

自定义消息不得在首次沟通弹窗中发送。

## 5. 图片资源

`imageAssetId` 是 Host 管理的持久资源 ID，不是模型可见的本地路径。Host 必须：

1. 校验资源属于当前用户，并已授权给当前 Run 或 CronTask。
2. 校验文件大小、真实文件头、MIME、扩展名和支持格式一致。
3. 第一版只接受有效 PNG 或 JPEG 图片。
4. 将虚拟资源物化为浏览器可以读取的短寿命临时文件。
5. 通过聊天页“发送图片”控件内的隐藏 `input[type=file]` 绑定文件。
6. 等待图片预览、上传状态或自动发送状态；需要显式发送时只点击聊天页当前图片对应的发送动作。
7. 验证当前会话中出现新的己方图片消息。
8. 批次不再使用临时文件后立即清理物化副本。

交互 Run 可以使用本轮授权的持久图片资源。CronTask 只能使用创建或更新任务时冻结授权的持久图片资源，不继承普通会话的临时附件。

## 6. 执行前校验

Host 在产生确认提案前校验：

- 当前场景为 `application`。
- 已通过 `ReadResume({resumeId})` 建立有效简历绑定，revision 未变化。
- 每个 `jobId` 存在且属于 BOSS 直聘。
- 岗位 URL 来自岗位库，且通过 BOSS 域名与规范 URL 校验。
- 当前岗位未被删除，确认使用的岗位 revision 可以冻结。
- 当前用户已授权个人浏览器。
- `imageAssetId` 存在时资源有效且授权范围匹配。

确认后、每个岗位真正执行前再次校验岗位 revision、浏览器连接、BOSS 登录状态和防重记录。

## 7. 批次确认

### 7.1 冻结内容

确认提案冻结：

- 全部岗位 ID、岗位 revision、公司和岗位名称。
- 每项消息模式和完整自定义消息。
- `first_quick_phrase` 的动态选择语义。
- 简历 ID 与 revision。
- 图片资源 ID、文件哈希和授权依据。
- 批次 ID、会话 ID和 proposal hash。

确认后不得替换岗位、消息、简历或图片。

### 7.2 确认策略

- `always_confirm`：确认整个批次。
- `allow_low_risk`：确认整个批次。
- `fully_trusted`：无图片的批次按场景策略执行。
- 包含图片时，交互 Run 必须进行一次明确包含“向全部目标发送图片”的批次确认；不逐个图片重复弹窗。
- CronTask 使用创建或更新任务时冻结的无人值守授权、岗位选择规则和持久图片资源授权，不在定时执行时弹窗等待。

### 7.3 紧凑确认窗口

确认窗口不使用内部滚动区域，最多 10 个岗位必须同时可见。示例：

```text
即将联系 10 个岗位

1. 字节跳动 · 产品经理｜首条常用语
2. 某科技公司 · 数据产品经理｜您好，我有三年产品…
3. 科大讯飞 · 产品运营｜首条常用语

图片：产品经理简历长图.png
简历：产品经理简历 V3

[取消] [确认发送]
```

显示规则：

- 每个岗位只占一行，公司、岗位和自定义消息预览超出宽度时使用 CSS 省略号。
- `first_quick_phrase` 固定显示“首条常用语”，不在默认窗口展开正文。
- 图片只显示一次小缩略图和单行文件名；简历只显示一次单行名称。
- 视觉截断只发生在 Renderer，不能修改冻结数据、确认哈希、实际消息、文件名或 Trace。
- 完整数据保留在确认提案中；不得在创建提案时使用截断字符串替代原始参数。

## 8. BOSS 页面状态机

```text
JOB_DETAIL_NEW
  -> INITIAL_GREETING_SENDING
  -> INITIAL_CONTACT_MODAL（已发送回执）
  -> JOB_DETAIL_CONTACTED
  -> CHAT_READY
  -> MESSAGE_SENT
  -> IMAGE_SENT（可选）
  -> CONTACT_VERIFIED
```

全局停止状态：

```text
SITE_RISK
LOGIN_REQUIRED
JOB_CLOSED
WRONG_CHAT
BROWSER_UNAVAILABLE
```

### 8.1 `JOB_DETAIL_NEW`

1. 使用岗位库中的 URL 打开岗位详情页。
2. 校验页面岗位、公司和来源岗位 ID。
3. 发现“立即沟通”后执行点击。
4. 点击前写入 `initial_greeting_sending`。
5. 等待首次沟通弹窗中的“已发送”回执、聊天页跳转或“继续沟通”状态。
6. 无法确定发送结果时写入 `uncertain` 并停止当前项。

### 8.2 `INITIAL_CONTACT_MODAL`

1. 读取弹窗中可能存在的“已发送”完整消息作为平台首条招呼语回执。
2. 不使用弹窗输入框，不在弹窗中上传图片或再次点击发送。
3. 存在回执时，`first_quick_phrase` 写入 `message_sent`，`custom` 写入 `initial_greeting_sent`；不存在回执时写入 `contact_started`。
4. 关闭首次沟通弹窗。
5. 轮询等待岗位详情页出现“继续沟通”。
6. 进入 `JOB_DETAIL_CONTACTED`。

### 8.3 `JOB_DETAIL_CONTACTED`

1. 点击“继续沟通”。
2. 等待聊天 URL、聊天容器和会话标题稳定。
3. 进入 `CHAT_READY`。

### 8.4 `CHAT_READY`

发送前必须确认：

- 当前企业、岗位或来源岗位 ID 与目标一致。
- 当前会话不存在明显的招聘者或企业冲突。
- 消息入口可用。
- 首次沟通结果已经确认为自动发送消息或仅建立沟通关系。
- 提供图片时发送图片入口及其隐藏文件输入框可用。

校验失败时不得在当前会话发送任何内容。

### 8.5 消息与图片顺序

1. `first_quick_phrase` 在平台已自动发送时不再重复发送，否则在聊天页选择首条常用语；`custom` 在聊天页发送并验证冻结文本。
2. 保存消息步骤检查点。
3. 提供 `imageAssetId` 时发送并验证图片。
4. 保存图片步骤检查点。
5. 写入业务联系状态和最终回执。

消息已经成功但图片失败时，结果为 `partial`，恢复时只处理图片，不重复发送消息。

## 9. 防重与目标校验

工具内部读取持久化岗位、投递状态和联系尝试，不依赖 Agent 对每个岗位再次调用防重工具。

满足任一条件时不得重新发送消息：

- 本地已有该来源岗位的成功联系记录。
- 当前岗位已经进入正式投递或更后的业务状态。
- 正确聊天会话中已经存在本批次冻结的完整消息。
- 上次消息发送结果为 `uncertain`，尚未完成会话核对。

网页显示已经联系但本地没有成功记录时，返回 `CONTACT_ALREADY_EXISTS` 并保存可审计事件，不补发消息。

岗位页面、聊天对象或岗位上下文不一致时返回 `WRONG_CHAT`，停止当前项且不发送消息或图片。

## 10. 批次执行与恢复

`ContactBossJobs` 创建持久化批次，由 Host 长任务执行器串行运行。Agent Run 等待该工具的最终结果，不通过模型轮询批次状态，也不消耗额外模型轮次。UI 通过事件显示批次总数、当前序号和当前步骤。

每个岗位至少保存以下子步骤：

```text
pending
initial_greeting_sending
initial_greeting_sent
chat_opened
message_sending
message_sent
image_sending
image_sent
contacted
partial
skipped
failed
uncertain
```

恢复规则：

- `contacted`、`skipped` 和 `failed` 不重复执行。
- `pending` 从岗位详情页开始。
- `chat_opened` 从聊天会话复核开始。
- `message_sent` 只继续可选图片步骤。
- `initial_greeting_sending`、`message_sending` 和 `image_sending` 在进程中断后转为 `uncertain`，必须先核对真实聊天记录。
- `initial_greeting_sent` 只继续进入聊天页发送冻结的自定义消息。
- `uncertain` 不得直接重复发送对应内容。
- 用户取消时停止创建新的外部动作；当前已发出的动作进入结果核对后结束。
- 验证码、登录失效、限流、账号异常或站点风险停止整个批次，剩余项保持 `pending` 并标记待接管原因。

批次长任务不使用普通原子浏览器工具的 120 秒整体超时。每个页面等待、消息发送和图片上传分别使用有界步骤超时；批次受取消信号、持久检查点和总墙钟上限控制。

## 11. 结果协议

```json
{
  "ok": false,
  "batchId": "boss-contact-001",
  "status": "completed_with_failures",
  "summary": {
    "requested": 5,
    "contacted": 3,
    "partial": 1,
    "skipped": 1,
    "failed": 0,
    "uncertain": 0
  },
  "results": [
    {
      "jobId": "job-001",
      "outcome": "contacted",
      "message": {
        "mode": "first_quick_phrase",
        "verified": true
      },
      "image": {
        "requested": true,
        "verified": true
      },
      "verifiedAt": "2026-09-11T14:30:00+08:00"
    },
    {
      "jobId": "job-006",
      "outcome": "skipped",
      "code": "CONTACT_ALREADY_EXISTS"
    }
  ],
  "stoppedReason": null
}
```

工具结果只返回批次摘要、每项结果、稳定错误码和必要的截断预览。页面 DOM、选择器、轮询详情、文件路径和完整调试信息只进入受脱敏保护的 Trace。

## 12. 业务状态与执行状态

岗位业务状态增加：

```text
saved -> contacted -> applied -> written_test -> interviewing -> ended
```

含义：

- `contacted`：已经在 BOSS 正确聊天会话中验证发送了消息。
- `applied`：已经完成正式投递或发送了构成正式申请的材料。

图片发送失败但消息已经验证成功时，岗位业务状态可以进入 `contacted`，批次项同时保留 `partial` 执行结果。业务状态和批次执行结果分别持久化。

## 13. 错误码

第一版至少包含：

```text
BOSS_JOB_NOT_FOUND
BOSS_JOB_NOT_ELIGIBLE
BOSS_JOB_CLOSED
BOSS_LOGIN_REQUIRED
BOSS_BROWSER_UNAVAILABLE
BOSS_SITE_RISK_DETECTED
BOSS_INITIAL_MODAL_NOT_FOUND
BOSS_CONTINUE_CONTACT_NOT_FOUND
BOSS_CHAT_NOT_READY
BOSS_WRONG_CHAT
MESSAGE_SEND_FAILED
MESSAGE_STATUS_UNKNOWN
IMAGE_ASSET_NOT_AUTHORIZED
IMAGE_FORMAT_INVALID
IMAGE_UPLOAD_FAILED
IMAGE_STATUS_UNKNOWN
CONTACT_ALREADY_EXISTS
BATCH_CANCELLED
BATCH_WALL_TIME_EXCEEDED
```

## 14. 模块边界

```text
ContactBossJobs Tool
  -> BossContactService
      -> BossContactBatchRepository
      -> Job/Application repositories
      -> AssetResolver
      -> PersonalBrowserAuthorization
      -> BossContactExecutor
          -> BossPageStateDetector
          -> BossChatAdapter
```

- Tool 层负责 Schema、资源门禁、确认提案、幂等和结果协议。
- Service 层负责冻结计划、批次编排、业务状态和检查点。
- Executor 负责单个岗位的确定性状态机。
- BOSS 页面选择器、弹窗识别、常用语和隐藏图片输入逻辑只存在于 BOSS Adapter。
- 个人浏览器 Runtime 只提供受限浏览器原语，不承担岗位业务状态和批次编排。

## 15. 验收标准

- 一次调用只接受 1 至 10 个不重复的已保存 BOSS 岗位，批内严格串行。
- 工具不能使用模型提供的 URL、路径、选择器、脚本、延迟或重试策略。
- 新岗位能够完成“立即沟通 -> 关闭弹窗 -> 继续沟通 -> 聊天页”。
- 已建立沟通的岗位能够从“继续沟通”直接进入并校验聊天页。
- `first_quick_phrase` 兼容“立即沟通”自动发送与聊天页选择发送，并以当前会话中的己方消息为最终证据。
- `custom` 只在聊天页发送冻结文本，并通过正确会话中的己方消息验证。
- 有效 PNG/JPEG 持久资源能够通过隐藏文件输入框上传并验证图片消息。
- 未授权、伪造格式、扩展名与文件头不一致或超过上限的图片被拒绝。
- 消息成功而图片失败时返回 `partial`，恢复不会重复发送消息。
- 本地已联系、网页已联系、`uncertain` 和错误聊天四类场景不会重复发送。
- 点击按钮、设置文件输入或页面跳转本身均不能作为成功证据。
- 最多 10 个岗位在确认窗口中全部可见，长公司名、岗位名、消息和文件名只在显示层省略。
- 完整确认数据、实际发送数据和 proposal hash 不受 UI 截断影响。
- 每个岗位和每个消息/图片步骤写入持久检查点，进程中断后按照子步骤安全恢复。
- 检测到验证码、登录失效、限流或账号异常时停止整个批次并保留剩余项。
- Agent 等待 Host 最终结果，不通过重复模型调用轮询批次状态。

## 16. 开发与验证进度

- `ContactBossJobs` 已加入投递场景工具白名单、Schema、资源门禁和批次确认链路。
- 已实现 BOSS 联系服务、批次与逐项检查点持久化、岗位联系状态和确认后结果回传。
- 已实现个人浏览器串行状态机、目标聊天校验、默认招呼语、自定义消息和 PNG/JPEG 图片上传路径。
- 包级 TypeScript 构建通过；相关单元与回归测试通过。
- 2026-09-11 使用真实 Chrome CDP 验证两个 BOSS 岗位：两次“立即沟通”均出现“已发送”回执；佳联国际岗位从 `message_sent` 检查点续跑至聊天页成功，未重复发送消息。
- 2026-09-11 在关闭账号自动招呼语后完成真实链路验证：等待发送按钮退出 CSS 禁用态后，自定义消息发送成功；PNG 图片通过隐藏文件输入框上传并显示“送达”。
- 2026-09-12 验证个人 Chrome 失焦场景：每次鼠标动作前重新激活专用 BOSS target 后，Avery 位于前台时仍能展开常用语面板；用户无需持续保持 Chrome 前台。
- 真实测试未出现验证码、限流、账号异常或站点风控。
