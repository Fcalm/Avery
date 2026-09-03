import { describe, expect, it } from 'vitest';
import type { AgentTraceEvent } from '../../../packages/contracts/src/index';
import { BuildTimeline } from '../../../src/features/developer/components/TraceViewer';

function Event(ordinal: number, eventType: string, payload: unknown): AgentTraceEvent {
  return { ordinal, eventType, payload, tokenCount: 1, createdAt: ordinal };
}

describe('TraceViewer timeline', () => {
  it('以 API input 为权威去除跨请求历史和 append 重复，同时保留终态输出', () => {
    const events = [
      Event(1, 'provider_request', { apiRequestIndex: 1, kind: 'completion' }),
      Event(2, 'message', { apiRequestIndex: 1, direction: 'input', kind: 'completion', messageIndex: 0, message: { role: 'system', content: 'prompt' } }),
      Event(3, 'message', { apiRequestIndex: 1, direction: 'input', kind: 'completion', messageIndex: 1, message: { role: 'user', content: 'question' } }),
      Event(4, 'message', { apiRequestIndex: 1, direction: 'output', source: 'provider', message: { role: 'assistant', content: '', tool_calls: [{ id: 'a' }, { id: 'b' }] } }),
      Event(5, 'message', { apiRequestIndex: 1, direction: 'append', source: 'tool', message: { role: 'tool', tool_call_id: 'a', content: '{"ok":true}' } }),
      Event(6, 'message', { apiRequestIndex: 1, direction: 'append', source: 'tool', message: { role: 'tool', tool_call_id: 'b', content: '{"ok":false}' } }),
      Event(7, 'provider_request', { apiRequestIndex: 2, kind: 'completion' }),
      Event(8, 'message', { apiRequestIndex: 2, direction: 'input', kind: 'completion', messageIndex: 0, message: { role: 'system', content: 'prompt' } }),
      Event(9, 'message', { apiRequestIndex: 2, direction: 'input', kind: 'completion', messageIndex: 1, message: { role: 'user', content: 'question' } }),
      Event(10, 'message', { apiRequestIndex: 2, direction: 'input', kind: 'completion', messageIndex: 2, message: { role: 'assistant', content: '', tool_calls: [{ id: 'a' }, { id: 'b' }] } }),
      Event(11, 'message', { apiRequestIndex: 2, direction: 'input', kind: 'completion', messageIndex: 3, message: { role: 'tool', tool_call_id: 'a', content: '{"ok":true}' } }),
      Event(12, 'message', { apiRequestIndex: 2, direction: 'input', kind: 'completion', messageIndex: 4, message: { role: 'tool', tool_call_id: 'b', content: '{"ok":false}' } }),
      Event(13, 'message', { apiRequestIndex: 2, direction: 'output', source: 'provider', message: { role: 'assistant', content: 'done' } }),
    ];

    const timeline = BuildTimeline('run-1', 1, events);

    expect(timeline).toHaveLength(6);
    expect(timeline.map((event) => event.title)).toEqual(['System', 'User', 'Assistant', 'Tool', 'Tool', 'Assistant']);
    expect(timeline[2].detail).toContain('2 tool calls');
    expect(timeline[3].payload).toMatchObject({ tool_call_id: 'a' });
    expect(timeline[4].payload).toMatchObject({ tool_call_id: 'b' });
    expect(timeline.map((event) => event.apiRequestIndex)).toEqual([1, 1, 2, 2, 2, 2]);
    expect(new Set(timeline.map((event) => JSON.stringify(event.payload))).size).toBe(timeline.length);
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
