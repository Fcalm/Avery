import { describe, expect, it, vi } from 'vitest';
import type { TaskCompletionNotice } from '../../../apps/desktop/src/task-completion';
import { BuildNoticeResponse, SubmitNoticeInteraction } from '../../../apps/desktop/src/task-notification-interaction';

const approval: TaskCompletionNotice = { sessionId: 'original-session', requestId: 'original-run', title: '修改简历', playSound: false, interaction: { kind: 'approval', id: 'proposal', summary: '修改第一条' } };
const question: TaskCompletionNotice = { ...approval, interaction: { kind: 'question', id: 'question-id', questions: [
  { id: 'city', question: '城市', options: ['广州', '其他'] }, { id: 'degree', question: '学历', options: ['本科', '硕士'] },
] } };

describe('桌面通知的结构化交互响应', () => {
  it('会话及交互 ID 绑定主进程原提案；取消审批等同拒绝，取消问答沿用任务取消接口', () => {
    expect(BuildNoticeResponse(approval, { action: 'confirm' })).toEqual({ sessionId: 'original-session', requestId: 'original-run', interactionId: 'proposal', kind: 'approval', approved: true });
    expect(BuildNoticeResponse(approval, { action: 'cancel' })).toMatchObject({ kind: 'approval', approved: false });
    expect(BuildNoticeResponse(question, { action: 'cancel' })).toMatchObject({ kind: 'cancel', interactionId: 'question-id' });
    expect(BuildNoticeResponse(approval, { action: 'confirm', sessionId: 'injected' })).toBeUndefined();
    expect(BuildNoticeResponse(approval, { action: 'answer', answers: { city: '广州' } })).toBeUndefined();
  });

  it('问答必须回答全部问题，拒绝额外 ID 和空文本；其他答案支持自由填写', () => {
    expect(BuildNoticeResponse(question, { action: 'answer', answers: { city: ' 上海 ', degree: '本科' } })).toMatchObject({ kind: 'answer', answers: { city: '上海', degree: '本科' } });
    for (const answers of [{ city: '广州' }, { city: '广州', degree: '本科', extra: 'x' }, { city: ' ', degree: '本科' }, { city: '广州', degree: '未提供的选项' }]) {
      expect(BuildNoticeResponse(question, { action: 'answer', answers })).toBeUndefined();
    }
  });

  it('先核对原会话等待点再提交决定，同一个决定重试使用同一个幂等键', async () => {
    const command = vi.fn(async (channel: string, _key: string | undefined, ..._args: unknown[]) => channel === 'agent:get-session-assistant-state'
      ? { ok: true, data: { pendingEvents: [{ type: 'resume_confirmation', sessionId: 'original-session', requestId: 'original-run', confirmationId: 'proposal', reason: '修改' }] } }
      : { ok: true, data: { accepted: true } });
    expect(await SubmitNoticeInteraction(command, approval, { action: 'confirm' })).toEqual({ ok: true });
    expect(command.mock.calls[0]).toEqual(['agent:get-session-assistant-state', undefined, 'original-session']);
    expect(command.mock.calls[1]).toEqual(['agent:respond-interaction', expect.stringMatching(/^task-notice:[a-f0-9]{64}$/), expect.objectContaining({ sessionId: 'original-session', interactionId: 'proposal', approved: true })]);
    await SubmitNoticeInteraction(command, approval, { action: 'confirm' });
    expect(command.mock.calls[1][1]).toBe(command.mock.calls[3][1]);
  });

  it('已处理、不同会话或不同 Run 的请求不执行决定，后端失败可重试', async () => {
    for (const event of [undefined, { type: 'resume_confirmation', sessionId: 'other-session', requestId: 'original-run', confirmationId: 'proposal' }, { type: 'resume_confirmation', sessionId: 'original-session', requestId: 'other-run', confirmationId: 'proposal' }]) {
      const command = vi.fn(async () => ({ ok: true, data: { pendingEvents: event ? [event] : [] } }));
      expect(await SubmitNoticeInteraction(command, approval, { action: 'confirm' })).toMatchObject({ ok: false, stale: true });
      expect(command).toHaveBeenCalledTimes(1);
    }
    const unavailable = vi.fn(async () => { throw new Error('offline'); });
    expect(await SubmitNoticeInteraction(unavailable, approval, { action: 'confirm' })).toMatchObject({ ok: false });
  });

  it('用户点击早于检查点保存时，让原 Run 的宿主等待并校验交互，不提前宣告失效', async () => {
    const command = vi.fn(async (channel: string) => channel === 'agent:get-session-assistant-state'
      ? { ok: true, data: { activeRequestId: 'original-run', pendingEvents: [] } }
      : { ok: true, data: { accepted: true } });
    expect(await SubmitNoticeInteraction(command, question, { action: 'answer', answers: { city: '广州', degree: '本科' } })).toEqual({ ok: true });
    expect(command).toHaveBeenCalledWith('agent:respond-interaction', expect.any(String), expect.objectContaining({ sessionId: 'original-session', requestId: 'original-run', interactionId: 'question-id' }));
  });
});
