# Agent 架构决策记录

本目录维护 Avery 的架构决策记录。Agent 领域使用 `ADR-AGENT-*` 前缀，避免与后端、Desktop 等领域后续编号冲突。

| ADR | 状态 | 决策 |
| --- | --- | --- |
| [ADR-AGENT-001](./ADR-AGENT-001-versioned-job-network-scope.md) | 已接受 | 岗位网络能力按版本启用 |
| [ADR-AGENT-002](./ADR-AGENT-002-immutable-run-snapshot.md) | 已接受 | 原子冻结 Run 场景与权限快照 |
| [ADR-AGENT-003](./ADR-AGENT-003-context-budget-and-compaction.md) | 已接受 | Context、压缩阈值与 Run 预算 |
| [ADR-AGENT-004](./ADR-AGENT-004-tool-safety-and-correction.md) | 已接受 | 工具 Schema、确认、幂等和纠正规则 |
| [ADR-AGENT-005](./ADR-AGENT-005-provider-rollout.md) | 已接受 | Provider 独立适配与发布顺序 |

“已接受”表示产品经理已经裁决并通过文档复审。生产代码仍须严格按角色任务、前置测试和一项一提交的要求实施，不代表一次性授权扩大范围。

ADR 被替代时不删除原文件。新 ADR 必须链接被替代项、说明迁移与回退，并同步更新本索引和受影响设计文档。
