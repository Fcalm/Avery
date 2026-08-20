# R-01 代码审查报告

> 审查日期：2026-08-20  
> 审查分支：`fix/backend-idempotency-boundary`  
> 审查范围：`7d00adb..691df8a`（`6daeaaa`、`7e65521`、`691df8a`）  
> 当前结论（第三次审查）：**通过，可按逻辑拆分提交后合并**  
> 工作边界：本次仅审查与更新重建文档，未修改任何代码、配置或生成物。

## 1. 结论

R-01 已按“失败用例 → 修复 → 完成记录”拆成三个提交；Router 在显式收到稳定 `idempotencyKey` 时，同键串行、内存回放、payload 冲突和重启回放测试均通过，业务成功后回放文件写盘失败也不再把成功响应改写为可重试失败。

但生产 IPC 链路没有任何一层生成或传入稳定幂等键：Gateway 固定调用 `backendHost.Command(channel, undefined, ...args)`，而 Router 只有在 `idempotencyKey` 为字符串时才启用回放。现有 5 个测试直接调用 Router 并手工注入键，因此没有覆盖真实 Renderer → Preload → Gateway → Host → Router 路径。

本轮实际复现结果为：按生产 Gateway 的 `undefined` 参数连续发起两次相同写命令，两次响应均成功，业务方法执行 2 次。因此 R-01 的核心目标尚未在应用中生效，暂不允许合并。

## 2. 审查发现

### R-01-F1【P1 · 阻断】生产 Gateway 固定丢弃幂等键，真实写请求仍不可重放

证据：

- `apps/desktop/dist/gateway.js:72` 固定传入 `undefined`：`backendHost.Command(channel, undefined, ...args)`。
- `apps/backend/src/router.ts:254` 要求 `resolvedIdempotencyKey` 为字符串才设置 `replayable = true`。
- `electron/preload.cjs`、`packages/contracts/src/bridge.ts` 与 `src/shared/platform/platformClient.ts` 的 Workspace Bridge 方法均没有信封或幂等键参数。
- `apps/backend/test/backend-idempotency.test.cjs` 的 5 个用例全部直接调用 `backend.HandleCommand(...)` 并手工提供 `idem-*`，未经过生产 Gateway。

最小复现结果：

```json
{
  "gatewayArgument": "undefined",
  "executions": 2,
  "firstOk": true,
  "secondOk": true
}
```

影响：

- Renderer 发出的所有当前写操作仍绕过持久化回放、进程内回放和同键并发锁。
- 超时、Backend 崩溃或调用方重试时仍可能重复产生 revision、审计记录或其他副作用。
- 进度文档“Host/Gateway 消息增加 `idempotencyKey` 字段透传”和“R-01 完成”的表述与生产行为不一致。

整改要求：

1. 以 `packages/contracts` 的 `RequestEnvelope` 为唯一协议来源，明确写命令信封如何进入 Preload/Gateway，禁止继续增加互不一致的手工参数清单。
2. 稳定键必须在“单次用户写意图”边界生成，并在该意图的自动重试、超时重试中保持不变；新的用户操作必须生成新键。不得由 Host 在每次传输时临时生成，也不得由 Gateway 为每次 `ipcRenderer.invoke` 随机生成。
3. Gateway 必须校验信封并把键传给 Host；Host 的内部 `requestId` 仅用于请求追踪和响应配对，不与幂等键混用。
4. 增加生产链路测试，至少覆盖 Preload/Gateway 参数解析到 Router 的透传，以及同一用户写意图以不同内部 requestId 重试时业务副作用只有 1 次。
5. 与前端开发核对 TanStack Mutation 的重试生命周期，确保键保存在 mutation 调用上下文而不是每次底层调用重新生成。

验收标准：真实 Bridge 写方法能够携带稳定键；生产链路集成测试中，同一用户写意图的串行重试与并发重试均只执行一次业务；新用户写意图不错误回放旧结果。

### R-01-F2【P2】测试直接加载已提交 `dist`，可能对陈旧产物给出假绿

证据：

- `apps/backend/package.json` 的 `test` 仅执行 `node --test test/*.test.cjs`，没有确保 Backend 先从当前源码构建。
- 测试通过 `require('../dist/router.js')` 与 `require('../dist/idempotency-store.js')` 加载生成物，而不是当前 `src`。
- 下一阶段 B-02 计划停止跟踪 `dist`；干净检出后直接执行当前测试入口将缺少被测模块，或者在本地开发中误测上一次构建产物。

整改要求：R-01 至少增加可靠的测试前构建步骤，保证测试必定对应当前源码；B-03 再迁移到正式测试框架。B-02 移除 `dist` 后，`npm test --workspace @offerget/backend` 必须仍能在干净检出中运行。

### R-01-F3【P2】持久化失败被完全静默，无法判断跨重启幂等是否降级

`IdempotencyStore.Put` 与 Router 都吞掉落盘异常。阶段性方案“业务成功后仍返回成功”可以避免客户端因假失败盲目重试，但磁盘满、权限错误或重命名失败后，跨进程重启回放能力已经丢失，当前没有日志、健康状态或可观测事件提示降级。

整改要求：在不泄露 payload、凭据和绝对路径的前提下记录稳定错误码与降级状态；增加“落盘失败 → 进程重启”的边界说明和测试预期。若本阶段不实现业务写入与幂等记录的原子事务，文档不得宣称跨该故障场景仍具备 exactly-once 语义。

## 3. 已通过项目

- 提交拆分符合 Conventional Commits，工作区干净。
- `npm test --workspace @offerget/backend`：5/5 通过。
- `tsc -p apps/backend/tsconfig.json --noEmit`：通过。
- Electron 隔离恢复模式冒烟：通过；`rendererLoaded: true`、`backendReady: true`、`startupReadyMs: 767`、`recoveryMode: healthy`。
- 同键进程内串行实现能够防止 Router 内部并发穿透。
- 同键不同 payload 返回 `REVISION_CONFLICT`，显式提供稳定键时的 Router 行为符合预期。

上述结果只能说明应用可启动、Router 局部实现成立，不能抵消生产链路没有提供幂等键的阻断问题。

## 4. 下一步任务安排

### 立即执行人：后端开发

继续在 `fix/backend-idempotency-boundary` 完成 R-01-F1；不要合并当前分支，也不要提前开始 B-02。后端开发负责 Contracts/Gateway/Host/Router 协议闭环和生产链路集成测试。

### 协作人：前端开发

只参与稳定键生命周期核对：确认键在单次 TanStack Mutation 意图及其重试中复用、新用户操作生成新键。前端开发暂不独立修改 Backend Router，也不在本轮合入 design-v2 或 lockfile。

### Agent 开发

本轮无新增任务，继续等待 B-03 测试骨架；R-01 不得扩展到 Agent Tool Ledger 重构。

## 总结

R-01 的 Router 局部实现与 5 个单元测试均通过，Electron 也能正常启动，但生产 Gateway 固定传入 `undefined`，导致所有真实 IPC 写请求仍不启用幂等回放。当前分支请求修改、暂不合并；下一步继续由后端开发补齐 Contracts/Preload/Gateway/Host/Router 的稳定键闭环，并由前端开发核对 Mutation 重试生命周期。

## 5. 第二次审查结果

> 复审日期：2026-08-20  
> 复审对象：`691df8a` 之上的未提交工作区整改  
> 复审结论：**仍请求修改，暂不提交/合并**

本次整改已解决上一轮的两个局部问题：Backend 测试入口会先构建 Contracts 与 Backend，避免直接测试陈旧 `dist`；`IdempotencyStore` 也增加了脱敏告警、健康状态与“持久化失败后不承诺跨重启 exactly-once”的测试说明。新增生产链路测试通过，Backend 测试从 5 个增加到 7 个。

但复审发现以下阻断：

### R-01-F4【P1 · 阻断】根 TypeScript 检查失败，当前改动无法构建

执行 `tsc --noEmit -p tsconfig.json` 失败，共报告 30 处类型错误：

- `src/features/workspace/api/mutationHelper.ts` 包装 `useMutation` 后未显式保留 `TVariables`/`TResult` 泛型，TanStack 将变量类型推断为 `void`，导致所有页面的 `mutate`/`mutateAsync` 参数报错。
- `src/shared/platform/platformClient.ts` 的 `RemoveConversationMessage` 丢失 `messageId` 转发，把 `WriteCommandOptions` 放到了第二参数位置；除了类型错误，运行时还会让 Preload 把 options 对象当作 messageId，最终被 Router 判为 `VALIDATION_ERROR`。

验收：根 TypeScript `--noEmit` 检查必须为 exit 0；为 `RemoveConversationMessage` 增加参数透传测试，确保 payload 精确为 `[conversationId, messageId]`。

### R-01-F5【P1 · 阻断】附件导入仍发送无幂等键的写信封

`src/shared/platform/platformClient.ts` 的 `ImportAttachment` 没有接收或调用 `ResolveWriteOptions`。真实助手附件导入路径会生成如下 IPC：

```json
["workspace:import-attachment", { "payload": ["C:/fixture.txt", "text/plain"] }]
```

同时 `WriteCommandEnvelopeSchema` 仍把 `idempotencyKey` 定义为可选，Gateway 会接受该信封；Router 随后把请求视为不可回放写入。由此可见，生产链路“所有可重放写命令必须有稳定键”的不变量仍未闭合。

验收：`WriteCommandEnvelopeSchema` 对可重放写命令要求非空稳定键；`ImportAttachment` 与其他写入口统一经过 `ResolveWriteOptions`；增加缺键返回 `VALIDATION_ERROR` 和附件导入键透传测试。

### R-01-F6【P2】Mutation 键缓存没有在一次意图结束后释放

`useWorkspaceMutation` 用变量对象作为 WeakMap key，但成功或失败 settle 后不删除。若调用方在后续新用户操作中复用同一个变量对象，会复用旧幂等键并回放上一次结果，而不是执行新的用户意图。

验收：键只覆盖一次 Mutation 生命周期及其自动重试；settle 后必须释放，使后续新意图获得新键。补测试覆盖“同一变量对象自动重试复用键”和“settle 后再次提交生成新键”。

复审验证：

| 检查项 | 结果 |
| --- | --- |
| Backend 测试 | 7/7 通过 |
| Contracts TypeScript `--noEmit` | 通过 |
| Backend TypeScript `--noEmit` | 通过 |
| 根 TypeScript `--noEmit` | **失败，30 处错误** |
| 缺少幂等键的写信封 | Schema 仍接受 |
| 附件导入生产路径 | 复现为无键写信封 |

第二次审查后，立即执行人仍为后端开发；前端开发协助核对 Mutation 生命周期。修复 F4/F5/F6 并通过根类型检查、7 个既有测试及新增生产链路测试后，再提交第三次审查。

## 6. 第三次审查结果

> 复审日期：2026-08-20  
> 复审对象：第二次审查后的未提交工作区整改  
> 复审结论：**通过，可提交并合并**

第二次审查的阻断项已全部关闭：

- `useWorkspaceMutation` 显式保留 `TResult`、`Error`、`TVariables` 泛型，根 TypeScript 检查恢复通过。
- `RemoveConversationMessage` 已完整转发 `conversationId` 与 `messageId`，并增加 Preload payload 断言。
- `ImportAttachment` 已统一调用 `ResolveWriteOptions`；`WriteCommandEnvelopeSchema` 现在强制非空 `idempotencyKey`，Gateway 对缺键写信封返回 `VALIDATION_ERROR`。
- 写意图键由独立存储管理，同一次 Mutation 自动重试复用；`onSettled` 后释放，同一 variables 对象的新意图会生成新键。
- Backend 测试入口先构建 Contracts 与 Backend，避免陈旧 `dist` 假绿；持久化降级会输出脱敏稳定错误码并通过 `GetHealth` 暴露状态。

第三次审查验证：

| 检查项 | 结果 |
| --- | --- |
| 根 TypeScript `tsc --noEmit` | 通过 |
| Contracts TypeScript `tsc --noEmit` | 通过 |
| Backend TypeScript `tsc --noEmit` | 通过 |
| Backend 测试 | 8/8 通过 |
| 缺键写信封 | 正确拒绝为 `VALIDATION_ERROR` |
| Preload/Gateway/Router 稳定键透传 | 通过 |
| Electron 隔离恢复模式冒烟 | 通过；Renderer/Backend ready，793 ms，recovery healthy |
| `git diff --check` | 通过；仅有既有 CRLF/LF 提示，无 whitespace error |

审查未发现新的阻断问题。考虑当前整改包含 Contracts/Preload/Gateway/Renderer/Backend/Test/Docs 多个层次，提交时应按逻辑拆分代码、测试与文档，禁止一次性使用含糊提交说明。提交完成并确认工作区干净后，可合并回 `main`，随后按既定计划由后端开发执行 B-02。
