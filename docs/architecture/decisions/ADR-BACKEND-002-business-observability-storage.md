# ADR-BACKEND-002：Business 与 Observability 分库存储

> 状态：已接受  
> 决策日期：2026-08-21  
> 相关实现：`apps/backend/src/business-store.ts`、`apps/backend/src/observability-store.ts`

## 上下文

业务实体、版本、附件引用与恢复记录需要强一致和长期留存；日志与 Agent Trace 属于可裁剪的诊断数据，并可能包含经脱敏后的请求摘要。将两者放入同一数据库会使 Trace 留存、清空或损坏影响业务恢复边界。

## 决策

1. 工作空间 Business DB 是会话、简历、岗位、投递、附件、版本与 Saga 状态的事实源。
2. 用户数据目录中的 Observability DB 只保存脱敏日志和 Trace；它不可参与业务写入事务，也可独立清空与裁剪。
3. Provider usage 以 `provider_usage` Trace 事件保存原始事实；会话账本和 Trace 汇总均不得使用本地 token 估算冒充真实 usage。
4. API Key、Authorization、绝对路径和正文敏感字段在写入 Observability DB 前脱敏。

## 替代方案

- **单一 SQLite 数据库**：部署简单，但留存/清空策略与恢复风险耦合，否决。
- **上传云端可观测平台**：超出本地优先和默认无遥测边界，否决。
- **只保留内存日志**：重启后无法诊断恢复问题，不采用。

## 影响

正面：业务完整性与诊断留存解耦，Trace 清理不影响用户实体。负面：跨库只能进行语义对账，不能假设 ACID 原子提交；必须把 usage 来源、降级和时间边界显式展示。

## 迁移

1. 新的诊断字段先进入 Observability DB，不修改 Business DB 的恢复语义。
2. 读取 Trace 时按 `provider_usage` 原始事件聚合，保留 unavailable 次数。
3. 变更表结构使用 `CREATE/ALTER` 的向前兼容路径，并验证旧 Observability DB 可打开。

## 回退

Observability DB 不可用时业务继续执行，会话仅保留其本地 usage 状态；记录受限日志并提示诊断降级。不得因为 Trace 写入失败让已成功的业务命令返回可重试失败。
