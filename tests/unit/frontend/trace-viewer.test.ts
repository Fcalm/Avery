import { describe, expect, it } from 'vitest';
import type { AgentTraceEvent } from '../../../packages/contracts/src/index';
import { BuildTimeline } from '../../../src/features/developer/components/TraceViewer';

function Event(ordinal: number, eventType: string, payload: unknown): AgentTraceEvent {
  return { ordinal, eventType, payload, tokenCount: 1, createdAt: ordinal };
}

describe('TraceViewer timeline', () => {
  it('按 API 请求显示真实消息，并将 tool call 与每条 result 分开', () => {
    const events = [
      Event(1, 'provider_request', { apiRequestIndex: 1, kind: 'completion' }),
      Event(2, 'message', { apiRequestIndex: 1, direction: 'input', kind: 'completion', messageIndex: 0, message: { role: 'system', content: 'prompt' } }),
      Event(3, 'message', { apiRequestIndex: 1, direction: 'output', source: 'provider', message: { role: 'assistant', content: '', tool_calls: [{ id: 'a' }, { id: 'b' }] } }),
      Event(4, 'message', { apiRequestIndex: 1, direction: 'append', source: 'tool', message: { role: 'tool', tool_call_id: 'a', content: '{"ok":true}' } }),
      Event(5, 'message', { apiRequestIndex: 1, direction: 'append', source: 'tool', message: { role: 'tool', tool_call_id: 'b', content: '{"ok":false}' } }),
      Event(6, 'provider_request', { apiRequestIndex: 2, kind: 'completion' }),
      Event(7, 'message', { apiRequestIndex: 2, direction: 'input', kind: 'completion', messageIndex: 0, message: { role: 'system', content: 'prompt' } }),
    ];

    const timeline = BuildTimeline('run-1', 1, events);

    expect(timeline).toHaveLength(5);
    expect(timeline.map((event) => event.title)).toEqual(['System', 'Assistant', 'Tool', 'Tool', 'System']);
    expect(timeline[1].detail).toContain('2 tool calls');
    expect(timeline[2].payload).toMatchObject({ tool_call_id: 'a' });
    expect(timeline[3].payload).toMatchObject({ tool_call_id: 'b' });
    expect(timeline.map((event) => event.apiRequestIndex)).toEqual([1, 1, 1, 1, 2]);
  });

  it('旧 Trace 的 tool_call 和 tool_result 也不再合并', () => {
    const timeline = BuildTimeline('legacy', 1, [
      Event(1, 'tool_call', { name: 'Read' }),
      Event(2, 'tool_result', { name: 'Read', ok: true }),
    ]);

    expect(timeline).toHaveLength(2);
    expect(timeline.map((event) => event.detail)).toEqual(['Read · Call', 'Read · Result']);
  });
});
