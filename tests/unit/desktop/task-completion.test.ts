import { describe, expect, it, vi } from 'vitest';
import { Script } from 'node:vm';
import { CreateTaskCompletionHandler, NoticeInteractionOf, TaskNotificationHtml } from '../../../apps/desktop/src/task-completion';

function Fixture() {
  const dependencies = {
    isForeground: vi.fn(() => false),
    readSettings: vi.fn(async (): Promise<{ notifyOnComplete?: boolean; notifySound?: boolean } | undefined> => ({ notifyOnComplete: true, notifySound: true })),
    readTitle: vi.fn(async () => '修改简历'), show: vi.fn(), dismissInteractions: vi.fn(), log: vi.fn(),
  };
  return { ...dependencies, handle: CreateTaskCompletionHandler(dependencies) };
}
const completed = { type: 'completed', sessionId: 'conversation-1', requestId: 'request-1' };

describe('任务完成通知', () => {
  it('只提醒已完成且具有会话和运行标识的任务，等待确认、取消和失败不误报', async () => {
    const f = Fixture();
    for (const type of ['content_delta', 'waiting_confirmation', 'question_requested', 'cancelled', 'error', 'run_released']) await f.handle({ ...completed, type });
    await f.handle({ type: 'completed' });
    expect(f.readSettings).not.toHaveBeenCalled();
    await f.handle(completed);
    expect(f.show).toHaveBeenCalledExactlyOnceWith({ sessionId: completed.sessionId, requestId: completed.requestId, title: '修改简历', playSound: true });
  });

  it('前台不打扰，旧配置的默认值与设置页面一致', async () => {
    const f = Fixture(); f.isForeground.mockReturnValue(true);
    await f.handle(completed); expect(f.readSettings).not.toHaveBeenCalled();
    f.isForeground.mockReturnValue(false); f.readSettings.mockResolvedValue({});
    await f.handle({ ...completed, requestId: 'background' });
    expect(f.show).toHaveBeenCalledExactlyOnceWith({ sessionId: completed.sessionId, requestId: 'background', title: '修改简历', playSound: true });
  });

  it('遵循通知、静音设置，设置读取失败时不使用默认值强行提醒', async () => {
    const f = Fixture(); f.readSettings.mockResolvedValueOnce({ notifyOnComplete: false });
    await f.handle(completed); expect(f.show).not.toHaveBeenCalled();
    f.readSettings.mockResolvedValueOnce({ notifyOnComplete: true, notifySound: false });
    await f.handle({ ...completed, requestId: 'silent' });
    expect(f.show).toHaveBeenCalledExactlyOnceWith({ sessionId: completed.sessionId, requestId: 'silent', title: '修改简历', playSound: false });
    f.readSettings.mockResolvedValueOnce(undefined);
    await f.handle({ ...completed, requestId: 'no-settings' });
    expect(f.show).toHaveBeenCalledTimes(1);
  });

  it('读取期间收到重复完成事件只提醒一次，返回前台后不补弹', async () => {
    const f = Fixture();
    let finish!: (value: { notifyOnComplete: boolean }) => void;
    f.readSettings.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const first = f.handle(completed);
    await f.handle(completed);
    expect(f.readSettings).toHaveBeenCalledTimes(1);
    finish({ notifyOnComplete: true }); await first;
    expect(f.show).toHaveBeenCalledTimes(1);
    f.isForeground.mockReturnValueOnce(false).mockReturnValueOnce(true);
    await f.handle({ ...completed, requestId: 'return-to-app' });
    expect(f.show).toHaveBeenCalledTimes(1);
  });

  it('标题和通知失败不影响任务事件处理，同一会话后续运行仍能提醒', async () => {
    const f = Fixture(); f.readTitle.mockRejectedValueOnce(new Error('deleted'));
    await f.handle(completed);
    expect(f.show).toHaveBeenLastCalledWith({ sessionId: completed.sessionId, requestId: completed.requestId, title: 'Avery 任务', playSound: true });
    f.show.mockImplementationOnce(() => { throw new Error('window failed'); });
    await expect(f.handle({ ...completed, requestId: 'second' })).resolves.toBeUndefined();
    expect(f.log).toHaveBeenCalledTimes(1);
    await f.handle({ ...completed, requestId: 'third' });
    expect(f.show).toHaveBeenCalledTimes(3);
  });

  it('同一 Run 的不同审批、问题和最终完成分别提醒，重复等待事件不重复弹窗', async () => {
    const f = Fixture();
    const approval = { ...completed, type: 'resume_confirmation', confirmationId: 'approval', resumeName: '简历', reason: '修改第一条经历' };
    await f.handle(approval); await f.handle(approval);
    expect(f.show).toHaveBeenCalledTimes(1);
    expect(f.show.mock.calls[0][0].interaction).toEqual({ id: 'approval', kind: 'approval', summary: '简历 · 修改第一条经历' });
    await f.handle({ ...completed, type: 'run_resumed' });
    const questions = [{ id: 'q', question: '所在城市？', options: ['广州', '其他'] }];
    await f.handle({ ...completed, type: 'question_requested', confirmationId: 'questions', questions });
    expect(f.show.mock.calls[1][0].interaction).toEqual({ id: 'questions', kind: 'question', questions });
    await f.handle(completed);
    expect(f.show).toHaveBeenCalledTimes(3);
    expect(f.dismissInteractions).toHaveBeenCalledWith({ sessionId: completed.sessionId, requestId: completed.requestId });
  });

  it('主界面已处理、任务取消或失败时，迟到的通知读取不会复活等待卡片', async () => {
    for (const type of ['run_resumed', 'cancelled', 'error']) {
      const f = Fixture(); let finish!: (title: string) => void;
      f.readTitle.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
      const pending = f.handle({ ...completed, type: 'resume_confirmation', confirmationId: 'approval', reason: '修改' });
      await Promise.resolve();
      await f.handle({ ...completed, type });
      finish('简历'); await pending;
      expect(f.show).not.toHaveBeenCalled();
      expect(f.dismissInteractions).toHaveBeenCalledTimes(1);
    }
  });

  it('浏览器风险和地址、定时任务摘要使用原提案，不从普通文本生成批准按钮', () => {
    expect(NoticeInteractionOf({ type: 'browser_confirmation', browserAction: { confirmationId: 'browser', summary: '发送消息', url: 'https://example.com', risk: 'high' } })).toEqual({ kind: 'approval', id: 'browser', summary: '发送消息', url: 'https://example.com', risk: 'high' });
    expect(NoticeInteractionOf({ type: 'cron_task_confirmation', confirmationId: 'cron', cronTask: { summary: '每天检查岗位' } })).toMatchObject({ summary: '每天检查岗位' });
    expect(NoticeInteractionOf({ type: 'waiting_confirmation', content: '请确认' })).toBeUndefined();
  });
});

describe('隔离的白色通知页面', () => {
  it('转义来自对话的 HTML，采用白色主题且只开放固定通知动作', () => {
    const html = TaskNotificationHtml({ title: '<img src=x onerror="alert(1)"> & 简历', nonce: 'test-nonce' });
    expect(html).toContain('&lt;img src=x onerror=&quot;alert(1)&quot;&gt; &amp; 简历');
    expect(html).not.toContain('<img');
    expect(html).toContain('background:#fff');
    expect(html).toContain('color-scheme:light');
    expect(html).toContain("default-src 'none'");
    expect(html).toContain("script-src 'nonce-test-nonce'");
    expect(html).not.toContain('<audio');
    expect(html).not.toContain('ipcRenderer');
  });

  it('只有启用声音时才嵌入本地音频，通知不调用系统提示音', () => {
    const html = TaskNotificationHtml({ title: '完成', nonce: 'test', soundData: 'UklGRg==' });
    expect(html).toContain('<audio autoplay src="data:audio/wav;base64,UklGRg=="');
  });

  it('紧凑的三行完成卡使用应用图标、常规字重 Avery 和 check-circle', () => {
    const html = TaskNotificationHtml({ title: '修改简历', nonce: 'test', brandData: 'aWNvbg==', fontData: 'Zm9udA==' });
    expect(html.indexOf('data:image/png;base64,')).toBeLessThan(html.indexOf('<h1>任务完成</h1>'));
    expect(html.indexOf('<h1>任务完成</h1>')).toBeLessThan(html.indexOf('id="task"'));
    expect(html).toContain('&#xe184;');
    expect(html).toContain('padding:10px 12px');
    expect(html).toContain('font-weight:400');
  });

  it('问答模板中来自模型的脚本结束标签不会逃逸，内嵌脚本可以正确解析', () => {
    const html = TaskNotificationHtml({ title: '问答', nonce: 'test', interaction: { kind: 'question', id: 'questions', questions: [{ id: 'q', question: '</script><script>alert(1)</script>', options: ['其他'] }] } });
    expect(html).not.toContain('</script><script>alert(1)');
    expect(html).toContain('\\u003c/script>');
    const script = html.match(/<script nonce="test">([\s\S]*?)<\/script>/)?.[1];
    expect(script).toBeTruthy();
    expect(() => new Script(script!)).not.toThrow();
  });
});
