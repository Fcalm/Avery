import { describe, expect, it, vi } from 'vitest';
import type { AgentStreamEvent, ConversationPresentation } from '../../../packages/agent-sdk/src';
import { ConversationRecorder } from '../../../apps/backend/src/electron/backend/conversation-recorder';

describe('会话过程持久化屏障', () => {
  it('只有保存成功后才发布展示快照，文本和终态顺序一致', async () => {
    const saved: ConversationPresentation[] = [], emitted: AgentStreamEvent[] = [];
    const recorder = new ConversationRecorder('request1', 'session1', async (sessionId, snapshot) => { expect(sessionId).toBe('session1'); saved.push(snapshot); return { saved: true }; }, (event) => emitted.push(event));
    recorder.Accept({ type: 'content_delta', activity: { kind: 'text', partId: 'text1', delta: '答案' } });
    expect(emitted).toEqual([]);
    recorder.Accept({ type: 'completed' });
    await recorder.Flush();
    expect(saved.at(-1)).toMatchObject({ status: 'completed', parts: [{ text: '答案' }] });
    expect(emitted.every((event) => event.sessionId === 'session1' && saved.includes(event.presentation!))).toBe(true);
  });

  it('恢复等待消息后确认只更新原会话、原工具，不创建第二份消息', async () => {
    let stored: ConversationPresentation | undefined;
    const save = vi.fn(async (_owner, snapshot: ConversationPresentation) => { stored = snapshot; return { saved: true }; });
    const recorder = new ConversationRecorder('request1', 'session1', save, () => undefined);
    recorder.Accept({ type: 'conversation_activity', activity: { kind: 'tool', stepId: 's1', toolCallId: 'c1', name: 'UpdateResume', toolStatus: 'waiting' } });
    recorder.Accept({ type: 'waiting_confirmation' }); await recorder.Flush();
    const restored = new ConversationRecorder('request1', 'session1', save, () => undefined, stored);
    await restored.ResolveInteraction(true);
    expect(stored).toMatchObject({ requestId: 'request1', status: 'completed' });
    expect(stored?.parts).toHaveLength(1);
    expect(stored?.parts[0]).toMatchObject({ stepId: 's1', status: 'succeeded' });
  });

  it('未知浏览器结果不会被确认动作标记为成功', async () => {
    let stored: ConversationPresentation | undefined;
    const recorder = new ConversationRecorder('request1', 'session1', async (_owner, snapshot) => { stored = snapshot; return { saved: true }; }, () => undefined);
    recorder.Accept({ type: 'conversation_activity', activity: { kind: 'tool', toolCallId: 'c1', name: 'BrowserClick', toolStatus: 'waiting' } });
    await recorder.ResolveInteraction(true, 'failed', '执行结果未知');
    expect(stored?.parts[0]).toMatchObject({ status: 'failed', summary: '执行结果未知' });
    expect(stored?.status).toBe('failed');
  });

  it('会话删除后取消文本批次，不发布迟到快照', async () => {
    const save = vi.fn(async () => ({ saved: true }));
    const publish = vi.fn();
    const recorder = new ConversationRecorder('request1', 'session1', save, publish);
    recorder.Accept({ type: 'conversation_activity', activity: { kind: 'text', partId: 'p1', delta: '片段' } });
    recorder.Dispose();
    recorder.Accept({ type: 'completed' });
    await recorder.Flush();
    expect(save).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });

  it('存储失败必须可见且 Flush 拒绝，不发送伪造的已保存快照', async () => {
    const events: AgentStreamEvent[] = [];
    const recorder = new ConversationRecorder('request1', 'session1', async () => { throw new Error('disk unavailable'); }, (event) => events.push(event));
    recorder.Accept({ type: 'completed' });
    await expect(recorder.Flush()).rejects.toThrow('disk unavailable');
    expect(events.every((event) => event.type === 'conversation_save_error')).toBe(true);
  });
});
