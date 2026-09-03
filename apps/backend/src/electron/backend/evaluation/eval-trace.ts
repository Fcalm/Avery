import type { EvalTraceNode, EvalTraceNodeType } from '@avery/contracts';

function AsRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function Sanitize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(Sanitize);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([key]) => !/^(?:reasoning|reasoning_content|thinking|chain_of_thought|password|captcha|cookie|authorization|fileContent|attachmentContent)$/i.test(key))
    .map(([key, item]) => [key, Sanitize(item)]));
}

function Classify(type: string): EvalTraceNodeType {
  if (type.includes('user')) return 'user';
  if (type === 'tool_call') return 'tool_call';
  if (type === 'tool_result') return 'tool_result';
  if (type.includes('confirmation')) return 'confirmation';
  if (type.includes('snapshot') || type.includes('page')) return 'page_state';
  if (type.includes('error') || type === 'failed') return 'error';
  if (type === 'loop_turn' || type.includes('model') || type.includes('assistant') || type.includes('delta') || type === 'completed') return 'model';
  return 'event';
}

function ToolName(payload: Record<string, unknown>): string | undefined {
  const nested = AsRecord(payload.payload);
  const value = nested.toolName ?? nested.name ?? payload.toolName ?? payload.name;
  return typeof value === 'string' ? value : undefined;
}

function IsPrivateThoughtEvent(type: string): boolean {
  return /(?:thinking|reasoning)/i.test(type);
}

/** Trace 只展示可观察事件，不推断或存储模型隐藏思维链。 */
export function NormalizeEvalTrace(events: unknown[], finalState: unknown): EvalTraceNode[] {
  let modelTurn = 0;
  const observableEvents = events.filter((event) => !IsPrivateThoughtEvent(String(AsRecord(event).type ?? 'event')));
  const nodes = observableEvents.map((event, sequence): EvalTraceNode => {
    const record = AsRecord(event);
    const rawPayload = AsRecord(record.payload);
    const type = String(record.type ?? 'event');
    if (type === 'loop_turn') modelTurn += 1;
    const payload = AsRecord(Sanitize(rawPayload));
    const nodeType = Classify(type);
    const serialized = JSON.stringify(payload);
    const status = nodeType === 'error' || serialized.includes('"ok":false') ? 'error'
      : nodeType === 'confirmation' && payload.accepted === false ? 'rejected'
        : serialized.includes('"ok":true') ? 'ok' : undefined;
    const toolName = ToolName(payload);
    return {
      id: `trace-${sequence + 1}`, ordinal: sequence + 1, kind: nodeType,
      title: toolName ? `${type}: ${toolName}` : type,
      createdAt: Number(record.createdAt ?? Date.now()),
      ...(status ? { status } : {}), ...(toolName ? { toolName } : {}), ...(modelTurn > 0 ? { modelTurn } : {}), summary: toolName ? `${toolName} ${status ?? type}` : type, details: payload,
    };
  });
  nodes.push({
    id: `trace-${nodes.length + 1}`, ordinal: nodes.length + 1, kind: 'fixture_state', title: 'Final fixture state',
    createdAt: Date.now(), status: 'ok', summary: '最终 Fixture 与业务状态快照', details: AsRecord(finalState),
  });
  return nodes;
}
