# A-03 与里程碑 G 快速代码复审（2026-08-21）

> 审查范围：A-03 八项 Agent 安全差距、A-04/B-05/F-05 Usage 对账、B-06/F-06 文档收口。以阻断缺陷和最小回归为主。

## 1. 结论

| 范围 | 结论 | 说明 |
| --- | --- | --- |
| A-03 | **请求修改** | 取消后迟到 completion 仍可能进入 Usage、历史和工具执行；另需按既定要求拆分八项提交。 |
| A-04 Agent Usage 实现 | 当前实现通过 | Mock 三方对账通过；真实 DeepSeek 门禁因无凭据跳过，A-04 不完全关闭。 |
| B-05 Usage 入库/Trace | 通过 | Provider fact、会话持久化与 Trace 聚合口径一致。 |
| B-06 Backend ADR | 通过 | 四项 ADR 均具备上下文、决策、替代方案、影响、迁移与回退。 |
| F-05 Renderer Usage | 通过 | 正确区分真实百分比、Provider 未返回“未知”和新会话“—”。 |
| F-06 前端专项文档 | 通过 | 响应式、键盘、焦点、拖拽及证据矩阵已形成规范。 |

## 2. 阻断发现

### [P1] 取消后迟到 completion 仍可触发副作用

`packages/agent-core/src/kernel.ts` 只在 `onDelta` 中检查 `signal.aborted`。若 Provider 忽略 AbortSignal，并在取消后 resolve 一个带 tool call 的 completion，`await StreamCompletion()` 后仍会：

1. 调用 `onModelUsage`；
2. 把 assistant completion 写入 transcript；
3. 进入 `RunToolBatch`。

同时，`ExecuteWithTimeout` 在进入时若发现父 signal 已经 aborted，只中止子 controller；随后才注册父 signal 的 abort listener，已发生的 abort 不会再次触发，因此工具实现仍会被调用。写工具可能在取消后开始执行。

现有测试只覆盖 Provider 在 abort 时 reject，以及终态后的 `onDelta` 回调；没有覆盖 Provider 忽略取消后 resolve completion/tool call 的路径。

**要求**：

- 在 Provider await 结束后、处理 Usage/历史/tool calls 前再次执行取消门禁；取消必须进入唯一 `cancelled` 终态。
- 工具执行入口对“进入时 signal 已 aborted”直接返回 `CANCELLED`，不得调用底层端口。
- 新增回归：Provider 忽略 abort，稍后返回带写工具调用的 completion；断言无 Usage、无工具调用、无 completed/error 终态，只有 cancelled。

## 3. 提交流程问题

提交 `007be26 feat(agent): 固化运行快照与真实 usage 对账` 同时包含 A-03 多个安全边界与 B-05 Usage 对账，违反 A-03 “一个安全边界一个提交”的既定要求。功能修复完成后，在合并前按八项安全边界、Usage 实现和测试/文档逻辑拆分提交；不得把提交标题只写成 Usage 而实际携带白名单、快照、Ledger、超时、脱敏和确认策略。

## 4. 本次验证

| 检查 | 结果 |
| --- | --- |
| 根 TypeScript `tsc --noEmit -p tsconfig.json` | 通过 |
| `npm test` | Vitest 61 passed、1 live test skipped；Backend 8/8 |
| `npm run build:renderer` | 通过 |
| `git diff --check` | 通过 |

跳过项是显式开关保护的真实 DeepSeek 测试。没有有效 `DEEPSEEK_API_KEY` 时不得宣称真实三方对账完成。

## 5. 下一步安排

1. **Agent 开发立即返工 A-03 取消边界**，仅处理本报告 P1，并补失败再修复的回归测试。
2. **Agent 开发整理提交历史**：A-03 八项、A-04 Usage、测试与文档按逻辑拆分后再报审。
3. **后端开发认领并提交 Desktop 视觉冒烟变更**；不得留在前端提交中。B-05/B-06 无需功能返工。
4. **前端开发 F-05/F-06 当前通过**，暂不继续改动；待真实 DeepSeek 门禁执行后只复核实际 UI 数据，不重新设计展示口径。

## 6. Agent 整改重审（2026-08-21）

### 结论

**代码通过，P1 已关闭；合并前仍须完成提交拆分。**

- Kernel 在 Provider completion 返回后、Usage/历史/tool call 处理前再次检查 Run 取消状态。
- 工具批次每个阶段及每次调用前检查取消状态，并把同一 Run signal 传入工具上下文。
- 工具模块在进入时 signal 已取消的情况下直接返回 `CANCELLED`，底层端口调用次数为 0。
- 新增回归覆盖“Provider 忽略 AbortSignal，取消后迟到返回写工具 completion”，断言无 Usage、无 assistant/tool 历史、无工具执行，唯一终态为 `cancelled`。

### 重审验证

| 检查 | 结果 |
| --- | --- |
| Agent 定向 Vitest | 5 个文件、46 项全部通过 |
| 根 TypeScript | 通过 |
| `git diff --check` | 通过 |

### 剩余合并门禁

提交历史仍保留 `007be26 feat(agent): 固化运行快照与真实 usage 对账`，尚未按 A-03 八项安全边界与 A-04 Usage 逻辑拆分。此项不再要求修改代码，但必须在合并前完成；拆分后只需核对提交范围与提交说明，无需再次进行功能代码审查。
