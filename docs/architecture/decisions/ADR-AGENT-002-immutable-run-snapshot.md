# ADR-AGENT-002：Session 稳定前缀与原子 Run 快照

> 状态：已接受
>
> 决策日期：2026-08-20
>
> 实现授权：已授权；Runtime Reminder 与 Session 前缀快照于 2026-08-22 开始实施

## 上下文

Prompt、工具定义、数据范围和 Provider 能力若分别读取“最新值”，会产生无法重放的混合请求：模型可能看到旧 Prompt、新工具或不同 revision 的业务数据。只把工具从模型请求中隐藏也不够，执行入口仍可能调用全局已注册工具。应用重启、会话重载和取消并发会进一步放大这种漂移。

## 决策

Session 首次实际使用时原子冻结并持久化一个 `SessionPrefixSnapshot`，至少包含：

- Scenario ID、版本与启用状态。
- Prompt Manifest、编译器版本与 `compiledHash`。
- Tool definition ID/版本/名称的有序白名单与 `toolPolicyHash`。
- Session Context 编译正文、来源哈希、`createdAt`、`expiresAt`、`sessionRevision` 和 `refreshReason`。

该快照只在创建满 24 小时后的下一次新 Run 或用户显式 `/reload` 时重建。Provider 缓存提前失效时重发相同前缀；模型切换只造成缓存未命中，不重建快照；场景切换直接创建新 Session。

每次点击发送创建一个 `RunSnapshot`，它引用 `SessionPrefixSnapshot`，并至少冻结：

- DataScope、业务实体 ID、授权来源和 revision。
- Provider Adapter/协议/模型能力快照。
- Run 预算和策略版本。

确认权限是可在 Run 中显式切换的运行状态，不固化进稳定前缀。权限变化同步更新工具入口，并在下一模型轮次通过 append-only Runtime Reminder 告知模型；完全信任仍不扩展白名单或资源授权。

Context Builder、Provider 请求、工具执行校验和 Harness 审计必须同时记录 `sessionSnapshotId` 与 `runSnapshotId`。执行入口按冻结工具 ID 和名称再次校验；全局注册表中存在定义不代表本 Run 有权执行。会话重载只影响新 Run，不能改变活动 Run。

等待、暂停和进程恢复继续使用原快照。若原 Adapter 或工具版本无法恢复，Run 进入 `paused` 并要求用户创建新 Run，不静默换用新版本。

## 替代方案

- **每次请求读取最新配置**：易实现，但不可重放且容易越权，否决。
- **分别冻结 Prompt、工具和数据快照**：比完全可变更好，但缺少原子 revision 仍会混搭，否决。
- **只依赖 Prompt 声明权限**：模型输出不可信，不能成为安全边界，否决。
- **只冻结工具名**：无法识别同名 Schema/实现升级，信息不足，否决。
- **增加 `ContextCacheEpoch`**：现有 snapshotId/hash/revision/时间与刷新原因已覆盖身份和代际，额外 epoch 会形成第二事实源，否决。

## 影响

正面影响：

- 权限、Context、Provider 和 Trace 可以对账。
- 取消、等待、重启恢复时不再依赖进程内“最新状态”。
- 场景白名单获得模型可见层和执行层一致的事实源。

负面影响：

- 需要持久化 manifest、哈希与版本迁移。
- 模块或 Prompt 更新不会影响已创建 Run，用户可能需要新建 Run 才能使用新能力。
- 恢复逻辑必须处理已下线版本。

## 迁移

1. 定义版本化 `SessionPrefixSnapshot`、`RunSnapshot` Schema 和 hash 规则。
2. 将 Session Context、Prompt、Module 与 Tool 快照组合为一次原子创建与持久化操作。
3. 修改 Loop、Context、Provider 与 Tool Scheduler 只接收 snapshot 引用，不读取全局最新列表。
4. 为跨 Run 前缀复用、24 小时刷新、`/reload`、白名单旁路和 hash 漂移补回归测试。

## 回退

迁移期间可以用功能开关让新 Run 回到旧 Host 路径，但必须同时禁用所有写工具和网络候选，避免在非原子快照下扩大副作用。已创建的新快照保留，不降级改写；必要时暂停对应 Run 并让用户创建兼容的新 Run。
