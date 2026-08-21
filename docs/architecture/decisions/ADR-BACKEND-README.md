# Backend 架构决策记录索引

本索引补充同目录的 Agent ADR。`ADR-BACKEND-*` 记录 Electron、Backend、数据与 Bridge 边界；状态为“已接受”的决策应由实现、测试和发布门禁共同执行。

| ADR | 状态 | 决策 |
| --- | --- | --- |
| [ADR-BACKEND-001](./ADR-BACKEND-001-main-backend-process-boundary.md) | 已接受 | Main 与 Backend Utility Process 职责分界 |
| [ADR-BACKEND-002](./ADR-BACKEND-002-business-observability-storage.md) | 已接受 | Business 与 Observability 分库存储 |
| [ADR-BACKEND-003](./ADR-BACKEND-003-workspace-saga-recovery.md) | 已接受 | 工作空间跨文件/数据库操作采用 Saga |
| [ADR-BACKEND-004](./ADR-BACKEND-004-bridge-versioning.md) | 已接受 | Bridge 注册表与协议兼容策略 |

被替代的 ADR 保留原文；新 ADR 必须显式链接被替代项，并说明迁移与回退。
