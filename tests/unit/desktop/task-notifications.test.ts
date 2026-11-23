import { EventEmitter } from 'node:events';
import type { BrowserWindow } from 'electron';
import type { NoticeSubmitResult, TaskCompletionNotice } from '../../../apps/desktop/src/task-completion';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const files = vi.hoisted(() => ({ readFile: vi.fn(async (_path: string) => Buffer.from('sound')) }));
const channels = vi.hoisted(() => ({ events: new Map<string, (...args: unknown[]) => unknown>(), invokes: new Map<string, (...args: unknown[]) => unknown>() }));
vi.mock('node:fs/promises', () => files);
vi.mock('electron', () => ({
  BrowserWindow: vi.fn(function (options: Record<string, unknown>) { const window = new NoticeWindow(options); windows.push(window); return window; }),
  screen: { getDisplayMatching: () => ({ workArea: { x: 1920, y: 0, width: 1440, height: 900 } }) },
  ipcMain: {
    on: (name: string, listener: (...args: unknown[]) => unknown) => channels.events.set(name, listener),
    handle: (name: string, listener: (...args: unknown[]) => unknown) => channels.invokes.set(name, listener),
    removeListener: (name: string) => channels.events.delete(name), removeHandler: (name: string) => channels.invokes.delete(name),
  },
}));
import { TaskNotificationWindows } from '../../../apps/desktop/src/task-notifications';

class NoticeWindow extends EventEmitter {
  destroyed = false;
  webContents = Object.assign(new EventEmitter(), { mainFrame: {}, setWindowOpenHandler: vi.fn() });
  setMenu = vi.fn();
  showInactive = vi.fn();
  loadURL = vi.fn(async (_url: string) => undefined);
  getBounds = () => ({ x: 2964, y: 780, width: 380, height: 104 });
  setBounds = vi.fn();
  constructor(readonly options: Record<string, unknown>) { super(); }
  isDestroyed() { return this.destroyed; }
  close() { this.destroy(); }
  destroy() { if (!this.destroyed) { this.destroyed = true; this.emit('closed'); } }
}
let windows: NoticeWindow[] = [];
const services: TaskNotificationWindows[] = [];

function Fixture() {
  const parent = {
    isDestroyed: () => false, isVisible: () => false, isFocused: () => false, isMinimized: () => true,
    getBounds: () => ({ x: 2000, y: 100, width: 1200, height: 800 }), restore: vi.fn(), show: vi.fn(), focus: vi.fn(), webContents: { send: vi.fn() },
  };
  const log = vi.fn();
  const respond = vi.fn(async (_notice: TaskCompletionNotice, _payload: unknown): Promise<NoticeSubmitResult> => ({ ok: true }));
  const service = new TaskNotificationWindows({ getMainWindow: () => parent as unknown as BrowserWindow, soundPath: '/audio/task-complete.wav', assetDirectory: '/assets', preloadPath: '/electron/task-notice-preload.cjs', respond, log });
  services.push(service);
  return { parent, log, service, respond };
}
function Navigate(window: NoticeWindow, url: string) {
  const event = { url, preventDefault: vi.fn() };
  window.webContents.emit('will-navigate', event);
  return event;
}
const notice = { sessionId: 'conversation', requestId: 'run', title: '修改简历', playSound: true };
const approval: TaskCompletionNotice = { ...notice, interaction: { kind: 'approval', id: 'approval', summary: '替换第一条工作经历' } };
const sender = (window: NoticeWindow) => ({ sender: window.webContents, senderFrame: window.webContents.mainFrame });
const action = (window: NoticeWindow, value: unknown) => channels.events.get('task-notice:action')!(sender(window), value);
const submit = (window: NoticeWindow, value: unknown) => channels.invokes.get('task-notice:submit')!(sender(window), value);

beforeEach(() => { windows = []; channels.events.clear(); channels.invokes.clear(); files.readFile.mockClear(); vi.useFakeTimers(); });
afterEach(() => { services.splice(0).forEach(service => service.Stop()); vi.useRealTimers(); });

describe('桌面完成通知生命周期', () => {
  it('在应用所在显示器右下角显示紧凑白底窗口，不抢焦点且只加载通知专用 preload', async () => {
    const f = Fixture(); f.service.Show(notice);
    await vi.waitFor(() => expect(windows[0]?.showInactive).toHaveBeenCalledTimes(1));
    expect(windows[0].options).toMatchObject({ x: 2964, y: 780, width: 380, height: 104, backgroundColor: '#ffffff', skipTaskbar: true, focusable: false,
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, autoplayPolicy: 'no-user-gesture-required' } });
    expect((windows[0].options.webPreferences as object)).toHaveProperty('preload', '/electron/task-notice-preload.cjs');
    expect(f.parent.focus).not.toHaveBeenCalled();
    const html = decodeURIComponent(windows[0].loadURL.mock.calls[0][0]);
    expect(html).toContain('data:audio/wav;base64,');
    vi.advanceTimersByTime(8000);
    expect(windows[0].destroyed).toBe(true);
  });

  it('通知悬停时保留，关闭后依次展示并行任务，静音时不读取音频', async () => {
    const f = Fixture(); f.service.Show({ ...notice, playSound: false });
    f.service.Show({ ...notice, sessionId: 'second', playSound: false });
    await vi.waitFor(() => expect(windows[0]?.showInactive).toHaveBeenCalled());
    action(windows[0], 'pause');
    vi.advanceTimersByTime(16000);
    expect(windows).toHaveLength(1); expect(windows[0].destroyed).toBe(false);
    action(windows[0], 'resume');
    vi.advanceTimersByTime(8000);
    await vi.waitFor(() => expect(windows[1]?.showInactive).toHaveBeenCalled());
    expect(files.readFile.mock.calls.some(([path]) => path.endsWith('.wav'))).toBe(false);
    f.service.Stop();
    expect(windows[1].destroyed).toBe(true);
  });

  it('只允许固定动作；点击通知恢复窗口并定位对应对话，关闭不唤起应用', async () => {
    const f = Fixture(); f.service.Show(notice);
    await vi.waitFor(() => expect(windows[0]?.showInactive).toHaveBeenCalled());
    expect(Navigate(windows[0], 'https://evil.example').preventDefault).toHaveBeenCalled();
    expect(f.parent.show).not.toHaveBeenCalled();
    action(windows[0], 'open');
    expect(f.parent.restore).toHaveBeenCalledTimes(1);
    expect(f.parent.webContents.send).toHaveBeenCalledExactlyOnceWith('app:task-notification-open', notice.sessionId);
    expect(f.parent.focus).toHaveBeenCalledTimes(1);
    f.service.Show({ ...notice, playSound: false });
    await vi.waitFor(() => expect(windows[1]?.showInactive).toHaveBeenCalled());
    action(windows[1], 'dismiss');
    expect(f.parent.show).toHaveBeenCalledTimes(1);
  });

  it('审批提示支持键盘输入且不自动消失；X 只关闭通知，不提交取消决定', async () => {
    const f = Fixture(); f.service.Show(approval);
    await vi.waitFor(() => expect(windows[0]?.showInactive).toHaveBeenCalled());
    expect(windows[0].options.focusable).toBe(true);
    vi.advanceTimersByTime(24000); action(windows[0], 'resume'); vi.advanceTimersByTime(24000);
    expect(windows[0].destroyed).toBe(false);
    action(windows[0], 'dismiss');
    expect(f.respond).not.toHaveBeenCalled();
  });

  it('主界面处理交互后，仅关闭同一 Run 的等待提示，其他会话和完成提醒保留', async () => {
    const f = Fixture(); f.service.Show(approval);
    f.service.Show({ ...approval, sessionId: 'unrelated' });
    await vi.waitFor(() => expect(windows[0]?.showInactive).toHaveBeenCalled());
    f.service.DismissInteractions({ sessionId: notice.sessionId, requestId: notice.requestId });
    expect(windows[0].destroyed).toBe(true);
    await vi.waitFor(() => expect(windows[1]?.showInactive).toHaveBeenCalled());
    f.service.DismissInteractions({ sessionId: notice.sessionId, requestId: notice.requestId });
    expect(windows[1].destroyed).toBe(false);
  });

  it('拒绝其他窗口和子 frame 提交、任意动作及超量载荷；有效提交绑定当前提案', async () => {
    const f = Fixture(); f.service.Show(approval);
    await vi.waitFor(() => expect(windows[0]?.showInactive).toHaveBeenCalled());
    const invoke = channels.invokes.get('task-notice:submit')!;
    expect(await invoke({ sender: {}, senderFrame: {} }, { action: 'confirm' })).toMatchObject({ ok: false });
    expect(await invoke({ ...sender(windows[0]), senderFrame: {} }, { action: 'confirm' })).toMatchObject({ ok: false });
    expect(await submit(windows[0], { action: 'answer', answers: { q: 'x'.repeat(600000) } })).toMatchObject({ ok: false });
    action(windows[0], 'execute-anything');
    expect(f.respond).not.toHaveBeenCalled();
    expect(await submit(windows[0], { action: 'confirm' })).toEqual({ ok: true });
    expect(f.respond).toHaveBeenCalledExactlyOnceWith(approval, { action: 'confirm' });
    expect(windows[0].destroyed).toBe(true);
  });

  it('提交失败保留窗口以便重试，同一窗口的并发提交被阻止', async () => {
    const f = Fixture(); let finish!: (result: NoticeSubmitResult) => void;
    f.respond.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    f.service.Show(approval);
    await vi.waitFor(() => expect(windows[0]?.showInactive).toHaveBeenCalled());
    const first = submit(windows[0], { action: 'confirm' });
    expect(await submit(windows[0], { action: 'confirm' })).toMatchObject({ ok: false });
    expect(f.respond).toHaveBeenCalledTimes(1);
    finish({ ok: false, message: '请重试' }); await first;
    expect(windows[0].destroyed).toBe(false);
    expect(await submit(windows[0], { action: 'confirm' })).toEqual({ ok: true });
    expect(f.respond).toHaveBeenCalledTimes(2);
  });

  it('通知按内容高度收紧，窗口高度受限，外部窗口不能修改尺寸', async () => {
    const f = Fixture(); f.service.Show(notice);
    await vi.waitFor(() => expect(windows[0]?.showInactive).toHaveBeenCalled());
    const resize = channels.events.get('task-notice:resize')!;
    resize({}, 180); resize(sender(windows[0]), NaN);
    expect(windows[0].setBounds).not.toHaveBeenCalled();
    resize(sender(windows[0]), 93);
    expect(windows[0].setBounds).toHaveBeenLastCalledWith({ height: 93, y: 791 });
    resize(sender(windows[0]), 1000);
    expect(windows[0].setBounds).toHaveBeenLastCalledWith({ height: 480, y: 404 });
  });
});
