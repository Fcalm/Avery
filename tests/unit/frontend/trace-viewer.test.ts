import { describe, expect, it } from 'vitest';
import type { AgentObservability, AgentTraceEvent } from '../../../packages/contracts/src/index';
import { BuildApiRequests, BuildTimeline, CreateTraceTokenUsage } from '../../../src/features/developer/components/TraceViewer';

function Event(ordinal: number, eventType: string, payload: unknown): AgentTraceEvent {
  return { ordinal, eventType, payload, tokenCount: 1, createdAt: ordinal };
}

function Trace(usage: AgentObservability['traces'][number]['usage']): AgentObservability['traces'][number] {
  return { requestId: 'request-test', sessionId: 'session-1', model: 'model-a', state: 'completed', summary: '', createdAt: 1, completedAt: 2, eventCount: 1, usage };
}

describe('TraceViewer timeline', () => {
  it('将缓存命中、未命中输入与输出 token 拆为互不重叠的圆环分段', () => {
    const first = Trace({ source: 'provider', promptTokens: 100, completionTokens: 20, totalTokens: 120, reportedRequestCount: 1, unreportedRequestCount: 0 });
    const second = Trace({ source: 'provider', promptTokens: 100, completionTokens: 30, totalTokens: 130, reportedRequestCount: 1, unreportedRequestCount: 0 });
    Object.assign(first.usage, { cachedInputTokens: 25 });

    expect(CreateTraceTokenUsage([first, second])).toEqual({ cachedInputTokens: 25, uncachedInputTokens: 175, outputTokens: 50, totalTokens: 250 });
  });

  it('新轨迹只展示 append-only 消息，不展开 API 请求中的重复历史', () => {
    const events = [
      Event(1, 'message_appended', { messageId: 'm1', apiRequestIndex: 1, source: 'system', message: { role: 'system', content: 'prompt' } }),
      Event(2, 'message_appended', { messageId: 'm2', apiRequestIndex: 1, source: 'user', message: { role: 'user', content: 'question' } }),
      Event(3, 'provider_request', { apiRequestIndex: 1, kind: 'completion', model: 'model-a', messageCount: 2, toolCount: 1, messages: [{ role: 'system', content: 'prompt' }, { role: 'user', content: 'question' }] }),
      Event(4, 'message_appended', { messageId: 'm3', apiRequestIndex: 1, source: 'provider', message: { role: 'assistant', content: '', tool_calls: [{ id: 'call-1' }] } }),
      Event(5, 'message_appended', { messageId: 'm4', apiRequestIndex: 1, source: 'tool', message: { role: 'tool', tool_call_id: 'call-1', content: '{"ok":true}' } }),
      Event(6, 'provider_request', { apiRequestIndex: 2, kind: 'completion', model: 'model-a', messageCount: 4, toolCount: 1, messages: [{ role: 'system', content: 'prompt' }, { role: 'user', content: 'question' }, { role: 'assistant', content: '', tool_calls: [{ id: 'call-1' }] }, { role: 'tool', tool_call_id: 'call-1', content: '{"ok":true}' }] }),
      Event(7, 'message_appended', { messageId: 'm5', apiRequestIndex: 2, source: 'provider', message: { role: 'assistant', content: 'done' } }),
    ];

    const timeline = BuildTimeline('append-only', 1, events);
    const requests = BuildApiRequests('append-only', 1, events);

    expect(timeline.map((event) => event.payload)).toEqual([
      { role: 'system', content: 'prompt' },
      { role: 'user', content: 'question' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'call-1' }] },
      { role: 'tool', tool_call_id: 'call-1', content: '{"ok":true}' },
      { role: 'assistant', content: 'done' },
    ]);
    expect(requests).toHaveLength(2);
    expect(requests[1]).toMatchObject({ apiRequestIndex: 2, model: 'model-a', messageCount: 4, toolCount: 1 });
    expect((requests[1].payload as { messages: unknown[] }).messages).toHaveLength(4);
  });

  it('append-only 消息按 messageId 保留真实的相同正文消息', () => {
    const timeline = BuildTimeline('same-content', 1, [
      Event(1, 'message_appended', { messageId: 'message-1', apiRequestIndex: 1, source: 'user', message: { role: 'user', content: '继续' } }),
      Event(2, 'message_appended', { messageId: 'message-2', apiRequestIndex: 2, source: 'user', message: { role: 'user', content: '继续' } }),
    ]);

    expect(timeline).toHaveLength(2);
    expect(timeline.map((event) => event.payload)).toEqual([
      { role: 'user', content: '继续' },
      { role: 'user', content: '继续' },
    ]);
  });

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

  it('动态提醒改变中间前缀时不重复展示其后的既有历史', () => {
    const events = [
      Event(1, 'message', { apiRequestIndex: 1, direction: 'input', messageIndex: 0, message: { role: 'system', content: 'prompt' } }),
      Event(2, 'message', { apiRequestIndex: 1, direction: 'input', messageIndex: 1, message: { role: 'user', content: 'reminder-1' } }),
      Event(3, 'message', { apiRequestIndex: 1, direction: 'input', messageIndex: 2, message: { role: 'user', content: 'task' } }),
      Event(4, 'message', { apiRequestIndex: 1, direction: 'output', source: 'provider', message: { role: 'assistant', content: '', tool_calls: [{ id: 'call-1' }] } }),
      Event(5, 'message', { apiRequestIndex: 1, direction: 'append', source: 'tool', message: { role: 'tool', tool_call_id: 'call-1', content: '{"ok":true}' } }),
      Event(6, 'message', { apiRequestIndex: 2, direction: 'input', messageIndex: 0, message: { role: 'system', content: 'prompt' } }),
      Event(7, 'message', { apiRequestIndex: 2, direction: 'input', messageIndex: 1, message: { role: 'user', content: 'reminder-2' } }),
      Event(8, 'message', { apiRequestIndex: 2, direction: 'input', messageIndex: 2, message: { role: 'user', content: 'task' } }),
      Event(9, 'message', { apiRequestIndex: 2, direction: 'input', messageIndex: 3, message: { role: 'assistant', content: '', tool_calls: [{ id: 'call-1' }] } }),
      Event(10, 'message', { apiRequestIndex: 2, direction: 'input', messageIndex: 4, message: { role: 'tool', tool_call_id: 'call-1', content: '{"ok":true}' } }),
      Event(11, 'message', { apiRequestIndex: 2, direction: 'output', source: 'provider', message: { role: 'assistant', content: 'done' } }),
    ];

    const timeline = BuildTimeline('dynamic-prefix', 1, events);

    expect(timeline.map((event) => event.payload)).toEqual([
      { role: 'system', content: 'prompt' },
      { role: 'user', content: 'reminder-1' },
      { role: 'user', content: 'task' },
      { role: 'user', content: 'reminder-2' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'call-1' }] },
      { role: 'tool', tool_call_id: 'call-1', content: '{"ok":true}' },
      { role: 'assistant', content: 'done' },
    ]);
  });

  it('同一请求中确实重复出现的相同消息不会被误删', () => {
    const timeline = BuildTimeline('repeated-user-message', 1, [
      Event(1, 'message', { apiRequestIndex: 1, direction: 'input', messageIndex: 0, message: { role: 'user', content: '继续' } }),
      Event(2, 'message', { apiRequestIndex: 1, direction: 'input', messageIndex: 1, message: { role: 'user', content: '继续' } }),
      Event(3, 'message', { apiRequestIndex: 1, direction: 'output', source: 'provider', message: { role: 'assistant', content: 'done' } }),
    ]);

    expect(timeline.map((event) => event.payload)).toEqual([
      { role: 'user', content: '继续' },
      { role: 'user', content: '继续' },
      { role: 'assistant', content: 'done' },
    ]);
  });
});
