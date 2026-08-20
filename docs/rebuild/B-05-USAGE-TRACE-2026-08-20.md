# B-05 真实 Usage 与 Trace 对账（2026-08-20）

## 结果

- Provider 仅在响应明确给出完整非负 `prompt_tokens`、`completion_tokens`、`total_tokens` 时生成 `provider` usage；缺失或无效字段统一记为 `unavailable`，不使用本地估算补齐。
- 每个模型响应的 usage 通过 `RecordTraceUsage` 写入 Trace 的 `provider_usage` 事件。Trace 汇总只聚合这些事实事件，`token_count` 继续只用于事件体量观察，绝不参与 usage 对账。
- AgentHost 使用同一份 usage 事实更新会话账本并原子写入 `agent-state.json`。重启后按 sessionId 恢复，缺失会话保持 `unavailable`，不会回退或串用其他会话数据。
- Trace 索引、Trace 展开事件和 `AgentSessionAssistantState` 均携带来源、输入/输出/总 token 以及上报/未上报请求数；凭据和绝对路径仍在观测入口脱敏。

## 验证

- Vitest：13 文件、48 用例通过，覆盖 Provider 真实 usage、缺失 usage、Trace 聚合不读取估算 token、会话 usage 重启恢复。
- `npm test`：Vitest 48/48 与 Backend 集成测试 8/8 通过。
- `npm run build` 与根 TypeScript 检查通过。

## 联调边界

前端 F-05 需消费新增的 Trace `usage` 字段，并以会话状态中的 usage 作为输入区展示来源；真实 Provider 端到端计费核验需要有效凭据，未在本地无凭据回归中伪造完成。
