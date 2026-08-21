# ADR-BACKEND-004：Bridge 注册表与协议兼容策略

> 状态：已接受  
> 决策日期：2026-08-21  
> 相关实现：`packages/contracts/src/bridge.ts`、`apps/desktop/src/preload.cts`、`apps/desktop/src/gateway.ts`

## 上下文

Renderer、preload、Gateway、Main 与 Backend 跨多个构建产物协作。若每层手写方法清单或允许任意 IPC，升级时会出现缺方法、参数漂移、旧包与新 UI 混用，以及绕过写命令幂等边界的问题。

## 决策

1. `packages/contracts` 是 Bridge 名称、DTO、写信封和错误结构的唯一类型事实源；`BridgeNamespaces` 是暴露方法清单。
2. preload 只暴露注册表中的最小方法，不暴露 `ipcRenderer`；Backend 的可写通道必须接收稳定 idempotencyKey 信封。
3. Gateway 拒绝未知通道、非法来源、超限负载和不匹配的写负载，并返回稳定结果信封。
4. 兼容性采用加法优先：新增可选字段/方法并由消费者显式能力检测；破坏性删除、语义翻转或错误码变更必须新建版本化通道并完成全链路迁移后移除旧通道。

## 替代方案

- **Renderer 直接调用任意 IPC 字符串**：无法审计或收敛权限，否决。
- **preload 自动反射所有 Backend 方法**：会把内部能力暴露为公共协议，否决。
- **每次变更直接替换旧字段**：安装包与渲染缓存可能错配，不采用。

## 影响

正面：类型、运行时 schema 和测试可覆盖同一协议面；错误、重试与幂等语义一致。负面：新增能力必须经过 contracts、preload、Gateway、Host 和消费侧的完整链路，短期修改步骤更多。

## 迁移

1. 新能力先定义 contracts 类型与 schema，再添加 preload/Gateway/Host 实现及消费侧能力检测。
2. 为每个命名空间执行方法集合契约测试，为写命令执行 idempotency 与负载拒绝测试。
3. 记录弃用窗口；删除旧方法前确认已发布 Renderer、Desktop 与 Backend 均不再使用。

## 回退

发现协议不兼容时保留旧通道，禁用新消费者入口或回退到上一版本的加法接口。不得临时暴露原始 IPC、关闭 contextIsolation 或跳过 Gateway 校验来恢复功能。
