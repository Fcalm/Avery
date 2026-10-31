import type { AgentMessage } from '@avery/agent-sdk';

/**
 * 只补齐中断批次缺失的协议回执，不删除或重排原消息，也不重放工具。
 * 旧调用没有已提交回执时，其业务结果只能记为未知；不能把缺失解释为未执行或成功。
 * 待确认检查点在恢复原 Run 时另行补齐，不进入此路径。
 */
export function ReconcileInterruptedTools(history: AgentMessage[], settled = new Map<string, AgentMessage>()): { history: AgentMessage[]; recovered: AgentMessage[] } {
  const output: AgentMessage[] = [];
  const recovered: AgentMessage[] = [];
  for (let index = 0; index < history.length; index += 1) {
    const message = history[index];
    output.push(message);
    if (message.role !== 'assistant' || !message.tool_calls?.length) continue;
    const pending = new Set(message.tool_calls.map((call) => call.id));
    while (history[index + 1]?.role === 'tool') {
      const result = history[++index];
      pending.delete(result.tool_call_id ?? '');
      output.push(result);
    }
    for (const id of pending) {
      const result = settled.get(id) ?? {
        role: 'tool' as const, tool_call_id: id,
        content: JSON.stringify({ ok: false, code: 'TOOL_RESULT_MISSING', status: 'unknown', runtimeRecovery: true,
          message: '上次运行中断，工具回执未提交到会话历史。这不代表操作未执行，也不能据此认定成功；先核对页面或业务持久化回执，勿直接重复提交、发送或删除。' }),
      };
      output.push(result); recovered.push(result);
    }
  }
  return { history: recovered.length ? output : history, recovered };
}
