# ADR-BACKEND-001：Main 与 Backend Utility Process 职责分界

> 状态：已接受  
> 决策日期：2026-08-21  
> 相关实现：`apps/desktop/src/main.ts`、`apps/desktop/src/gateway.ts`、`apps/backend/src/host.ts`

## 上下文

Electron Main 同时接触窗口、`safeStorage`、原生对话框和应用生命周期。业务数据库、Agent 编排、恢复和导出请求可能耗时或失败重试；将其放在 Main 会阻塞窗口响应并扩大 Renderer 可触达的能力面。

## 决策

1. Main 只拥有窗口、会话安全策略、受控桌面适配器与 Backend Utility Process 生命周期。
2. Backend Utility Process 拥有业务命令编排、数据库 Worker 调度、Agent 宿主和恢复状态；Main 通过带 requestId 的异步消息访问。
3. Renderer 只经 preload 固定 Bridge 调用；Gateway 校验来源、频率、负载与写命令信封后才转发。
4. 原生能力采用 Main 注入的窄 capability，Backend 不直接持有 BrowserWindow、dialog 或 safeStorage。

## 替代方案

- **全部业务留在 Main**：实现较少，但会阻塞 UI，且把高权限与业务故障混在同一故障域，否决。
- **Renderer 直接访问 Node/Electron**：绕过最小权限与输入校验，永久否决。
- **每个业务模块一个 Utility Process**：隔离更强，但目前会显著增加 IPC、生命周期和调试成本，暂不采用。

## 影响

正面：窗口响应与业务故障隔离；凭据、路径和原生能力集中在 Main；Backend 可独立重启。负面：需要维护消息协议、超时、崩溃退避与 capability 错误处理。

## 迁移

1. Desktop 组合根负责启动 `CreateBackendHost`，所有业务新能力先定义 contracts/Gateway/Host 路由。
2. Main 中遗留业务同步 I/O 迁至 Backend Worker 或 Utility Process。
3. 每个迁移命令补来源拒绝、超时、重启和错误信封测试。

## 回退

Utility Process 启动或握手失败时，Gateway 返回稳定的可重试 Backend 不可用错误；不得把业务临时迁回 Main 或开启 nodeIntegration。保留最后可用的持久化业务数据，待 Backend 恢复后重试用户意图。
