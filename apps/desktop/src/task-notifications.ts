import { BrowserWindow, ipcMain, screen, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { TaskNotificationHtml, type TaskCompletionNotice, type NoticeIdentity, type NoticeSubmitResult } from './task-completion';

const DisplayDuration = 8000;

/** 白底桌面提醒独立于系统主题；收到后台任务完成或交互事件后才创建窗口和加载资源。 */
export class TaskNotificationWindows {
  private window?: BrowserWindow;
  private timer?: ReturnType<typeof setTimeout>;
  private queue: TaskCompletionNotice[] = [];
  private stopped = false;
  private loading = false;
  private sound?: Promise<string | undefined>;
  private assets?: Promise<{ brandData?: string; fontData?: string }>;
  private current?: TaskCompletionNotice;
  private flights = new WeakMap<BrowserWindow, Promise<NoticeSubmitResult>>();

  constructor(private readonly input: {
    getMainWindow: () => BrowserWindow | undefined;
    soundPath: string;
    assetDirectory: string;
    preloadPath: string;
    iconPath?: string;
    respond: (notice: TaskCompletionNotice, payload: unknown) => Promise<NoticeSubmitResult>;
    log: (error: unknown) => void;
  }) {
    ipcMain.on('task-notice:action', this.OnAction);
    ipcMain.on('task-notice:resize', this.OnResize);
    ipcMain.handle('task-notice:submit', this.OnSubmit);
  }

  /** 只接受当前通知的顶层文档；主窗口、网页 iframe 和旧通知均不能替当前提案作决定。 */
  private IsSender(event: IpcMainEvent | IpcMainInvokeEvent): boolean {
    return Boolean(this.window && !this.window.isDestroyed() && event.sender === this.window.webContents && event.senderFrame === this.window.webContents.mainFrame);
  }

  private OnAction = (event: IpcMainEvent, action: unknown, ...extra: unknown[]): void => {
    if (extra.length || !this.IsSender(event)) return;
    if (action === 'pause') { clearTimeout(this.timer); return; }
    if (action === 'resume') { this.RestartTimer(); return; }
    if (action === 'open') {
      const target = this.input.getMainWindow();
      if (target && !target.isDestroyed() && this.current) {
        if (target.isMinimized()) target.restore();
        target.show();
        target.webContents.send('app:task-notification-open', this.current.sessionId);
        target.focus();
      }
      this.window?.close();
    } else if (action === 'dismiss') this.window?.close();
  };

  private OnResize = (event: IpcMainEvent, height: unknown, ...extra: unknown[]): void => {
    if (extra.length || !this.IsSender(event) || typeof height !== 'number' || !Number.isFinite(height) || height <= 0 || height > 2000) return;
    const window = this.window!;
    const area = screen.getDisplayMatching(window.getBounds()).workArea;
    const nextHeight = Math.max(88, Math.min(Math.ceil(height), 480, area.height - 32));
    window.setBounds({ height: nextHeight, y: area.y + area.height - nextHeight - 16 });
  };

  private OnSubmit = async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<NoticeSubmitResult> => {
    if (!this.IsSender(event)) return { ok: false, message: '此通知已失效。', stale: true };
    const window = this.window!;
    const notice = this.current;
    if (!notice?.interaction || args.length !== 1) return { ok: false, message: '无效的通知操作。' };
    try {
      const serialized = JSON.stringify(args[0]);
      if (!serialized || Buffer.byteLength(serialized) > 512 * 1024) return { ok: false, message: '提交内容过长，请在 Avery 中处理。' };
    } catch { return { ok: false, message: '无效的通知操作。' }; }
    if (this.flights.has(window)) return { ok: false, message: '正在提交，请稍候。' };
    const flight = this.input.respond(notice, args[0]).catch((): NoticeSubmitResult => ({ ok: false, message: '提交失败，请重试或返回对话处理。' }))
      .then((result) => {
        if (result.ok && this.window === window && !window.isDestroyed()) window.close();
        return result;
      }).finally(() => this.flights.delete(window));
    this.flights.set(window, flight);
    return flight;
  };

  Show(notice: TaskCompletionNotice): void {
    if (this.stopped) return;
    this.queue.push(notice);
    // 并行任务依次展示，不创建一排抢占桌面的窗口，也不叠加播放声音。
    if (this.queue.length > 20) this.queue.shift();
    void this.Next();
  }

  DismissInteractions(identity: NoticeIdentity): void {
    const matches = (notice: TaskCompletionNotice) => Boolean(notice.interaction && notice.sessionId === identity.sessionId && notice.requestId === identity.requestId
      && (!identity.interactionId || notice.interaction.id === identity.interactionId));
    this.queue = this.queue.filter((notice) => !matches(notice));
    if (this.current && matches(this.current)) {
      if (this.window) this.window.close();
      else this.current = undefined;
    }
  }

  Stop(): void {
    this.stopped = true;
    this.queue = [];
    clearTimeout(this.timer);
    ipcMain.removeListener('task-notice:action', this.OnAction);
    ipcMain.removeListener('task-notice:resize', this.OnResize);
    ipcMain.removeHandler('task-notice:submit');
    if (this.window && !this.window.isDestroyed()) this.window.destroy();
    this.window = undefined;
  }

  private RestartTimer(): void {
    clearTimeout(this.timer);
    if (this.current?.interaction) return;
    this.timer = setTimeout(() => this.window?.close(), DisplayDuration);
  }

  private async Next(): Promise<void> {
    if (this.stopped || this.window || this.loading) return;
    const notice = this.queue.shift();
    if (!notice) return;
    this.loading = true;
    this.current = notice;
    try {
      const readAsset = (path: string) => readFile(path).then((data) => data.toString('base64')).catch((error) => { this.input.log(error); return undefined; });
      const [soundData, assets] = await Promise.all([
        notice.playSound ? (this.sound ??= readAsset(this.input.soundPath)) : undefined,
        this.assets ??= Promise.all([
          readAsset(join(this.input.assetDirectory, 'assets', 'avery-icon.png')),
          readAsset(join(this.input.assetDirectory, 'fonts', 'phosphor', 'Phosphor-Regular.woff2')),
        ]).then(([brandData, fontData]) => ({ brandData, fontData })),
      ]);
      const parent = this.input.getMainWindow();
      if (this.current !== notice || this.stopped || !parent || parent.isDestroyed() || (parent.isVisible() && parent.isFocused())) return;
      const area = screen.getDisplayMatching(parent.getBounds()).workArea;
      const width = Math.min(380, Math.max(1, area.width - 32));
      const height = Math.min(notice.interaction ? 280 : 104, area.height);
      const window = new BrowserWindow({
        width, height, x: area.x + area.width - width - 16, y: area.y + area.height - height - 16,
        show: false, frame: false, backgroundColor: '#ffffff', roundedCorners: true, hasShadow: true,
        resizable: false, minimizable: false, maximizable: false, fullscreenable: false,
        alwaysOnTop: true, skipTaskbar: true, focusable: Boolean(notice.interaction),
        ...(this.input.iconPath ? { icon: this.input.iconPath } : {}),
        webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, autoplayPolicy: 'no-user-gesture-required', preload: this.input.preloadPath },
      });
      this.window = window;
      window.setMenu(null);
      window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      window.webContents.on('will-navigate', (event) => event.preventDefault());
      window.on('closed', () => {
        if (this.window === window) { this.window = undefined; this.current = undefined; clearTimeout(this.timer); }
        void this.Next();
      });
      window.webContents.on('render-process-gone', () => { if (!window.isDestroyed()) window.destroy(); });
      await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(TaskNotificationHtml({ title: notice.title, interaction: notice.interaction, nonce: randomUUID(), soundData, ...assets }))}`);
      if (!window.isDestroyed() && !this.stopped) { window.showInactive(); this.RestartTimer(); }
    } catch (error) {
      this.input.log(error);
      if (this.window && !this.window.isDestroyed()) this.window.destroy();
      this.window = undefined;
    } finally {
      this.loading = false;
      if (!this.window) this.current = undefined;
      if (!this.window && this.queue.length) void this.Next();
    }
  }
}
