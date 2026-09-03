# F-03 契约消费侧一致性核对（2026-08-20）

> 状态：完成当前 R-01 增量范围；后续随 B-04 的 Desktop TypeScript 重建继续复核。
> 基线：`packages/contracts/src/bridge.ts`、`packages/contracts/src/envelope.ts`、`apps/backend/src/router.ts`。

## 核对结论

| 边界 | 结果 | 证据 |
| --- | --- | --- |
| Renderer `platformClient` → `WorkspaceBridge` | 通过 | 补齐恢复、备份诊断和附件清理的 7 个封装；编译期 `Record<keyof WorkspaceBridge, unknown>` 门禁覆盖全部方法名。 |
| Renderer `platformClient` → `DesktopAgentBridge` | 通过 | 编译期 `Record<keyof DesktopAgentBridge, unknown>` 门禁覆盖全部方法名。 |
| Preload → Contracts Bridge 方法表 | 通过 | 集成测试以 `BridgeNamespaces` 为来源，逐命名空间比较实际暴露方法。 |
| Preload/Gateway → 写命令信封 | 通过 | 所有 `WriteCommandChannels` 仅接受 `WriteCommandEnvelopeSchema`；稳定键与内部 `requestId` 分离。 |
| Gateway → Backend Router | 通过 | Gateway 从信封取 `payload` 与 `idempotencyKey`，只将后者传给 Host；Router 使用 `WriteArgsSchemas` 二次校验业务参数。 |

## 本轮修复的差异

此前 `WorkspaceBridge` 已声明而 `platformClient.workspace` 未封装的方法：

- `CleanupAttachments`
- `GetRecoveryStatus`
- `RecoverOperations`
- `GetDatabaseRecoveryStatus`
- `RestoreLatestBackup`
- `RestoreBackup`
- `ExportRecoveryDiagnostic`

现已全部经 `platformClient` 暴露。写方法统一调用 `ResolveWriteOptions`，保证脱离 TanStack Mutation 的单次写入也携带稳定幂等键；Mutation 自动重试仍复用调用意图内的键。

## 验证

- `npm test --workspace @avery/backend`：8/8 通过，包含 Bridge 方法清单、写信封、删除消息与附件导入透传。
- `tsc --noEmit -p tsconfig.json`：通过。
- `npm run build`：通过。

## 后续边界

本记录仅覆盖当前 CommonJS Preload/Gateway 行为基线和 Renderer 消费侧。B-04 将这些运行时迁移为 TypeScript 后，需复跑本测试，并将同一清单校验迁入正式 `tests/contract`。
