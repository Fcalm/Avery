import { app, clipboard, ipcMain, Notification, shell } from 'electron';
import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from 'electron';
import { FunctionRouteChannels, MethodRoutes, WriteCommandChannels } from '@avery/backend/dist/router';
import { WriteCommandEnvelopeSchema } from '@avery/contracts';

export const MaxGatewayPayloadBytes = 10 * 1024 * 1024;
export const WindowControlChannels = ['window:minimize', 'window:toggle-maximize', 'window:is-maximized', 'window:close'] as const;
export const GeneralControlChannels = ['app:get-workspace-directory', 'app:open-workspace-directory', 'app:set-login-item'] as const;

type ResultEnvelope = { ok: boolean; data?: unknown; error?: { code: string; message: string; retryable: boolean; details?: unknown } };
type BackendHostPort = { Command: (channel: string, idempotencyKey: string | undefined, ...args: unknown[]) => Promise<unknown>; OnEvent: (listener: (event: unknown) => void) => void; state: () => string };
type IpcMainPort = Pick<IpcMain, 'handle'>;

/** 单窗口/通道令牌桶：允许短时突发，避免 Renderer 错误循环压垮 Backend。 */
export function CreateGatewayLimiter({ burst = 30, refillPerSecond = 20 }: { burst?: number; refillPerSecond?: number } = {}) {
  const buckets = new Map<string, { tokens: number; at: number }>();
  return {
    Allow(key: string, now = Date.now()): boolean {
      const previous = buckets.get(key) ?? { tokens: burst, at: now };
      const tokens = Math.min(burst, previous.tokens + Math.max(0, now - previous.at) / 1000 * refillPerSecond);
      if (tokens < 1) { buckets.set(key, { tokens, at: now }); return false; }
      buckets.set(key, { tokens: tokens - 1, at: now });
      return true;
    },
  };
}

/** 只接受主窗口当前页面：file 生产页或与已加载页面同源的开发页。 */
export function ValidateSender(event: IpcMainInvokeEvent, getWindow: () => BrowserWindow | undefined): boolean {
  const window = getWindow();
  if (!window || window.isDestroyed() || event.sender !== window.webContents || !event.senderFrame) return false;
  const frameUrl = String(event.senderFrame.url || '');
  const loadedUrl = String(window.webContents.getURL() || '');
  if (frameUrl.startsWith('file://') && loadedUrl.startsWith('file://')) return true;
  try { return new URL(frameUrl).origin === new URL(loadedUrl).origin; } catch { return false; }
}

/** 所有命令先通过来源、频率、大小和写信封校验，再进入 Backend Utility Process。 */
export function RegisterGateway({ backendHost, webContentsGetter, notificationIconPath, ipcMainApi = ipcMain }: { backendHost: BackendHostPort; webContentsGetter: () => BrowserWindow | undefined; notificationIconPath?: string; ipcMainApi?: IpcMainPort }): void {
  const limiter = CreateGatewayLimiter();
  for (const channel of [...Object.keys(MethodRoutes), ...FunctionRouteChannels]) {
    ipcMainApi.handle(channel, async (event, ...args: unknown[]): Promise<ResultEnvelope> => {
      if (!ValidateSender(event, webContentsGetter)) return { ok: false, error: { code: 'PERMISSION_DENIED', message: 'IPC sender is invalid.', retryable: false } };
      if (!limiter.Allow(`${event.sender.id}:${channel}`)) return { ok: false, error: { code: 'WORKSPACE_BUSY', message: '请求过于频繁，请稍后重试。', retryable: true } };
      let serialized: string | undefined;
      try { serialized = JSON.stringify(args); } catch { return { ok: false, error: { code: 'VALIDATION_ERROR', message: 'IPC payload is not serializable.', retryable: false } }; }
      if (serialized && Buffer.byteLength(serialized, 'utf8') > MaxGatewayPayloadBytes) return { ok: false, error: { code: 'VALIDATION_ERROR', message: 'IPC payload is too large.', retryable: false } };
      let commandArgs = args;
      let idempotencyKey: string | undefined;
      if (WriteCommandChannels.has(channel)) {
        if (args.length !== 1) return { ok: false, error: { code: 'VALIDATION_ERROR', message: 'IPC write command envelope is invalid.', retryable: false } };
        const parsed = WriteCommandEnvelopeSchema.safeParse(args[0]);
        if (!parsed.success) return { ok: false, error: { code: 'VALIDATION_ERROR', message: 'IPC write command envelope is invalid.', retryable: false } };
        commandArgs = parsed.data.payload;
        idempotencyKey = parsed.data.idempotencyKey;
      }
      try {
        const result = await backendHost.Command(channel, idempotencyKey, ...commandArgs);
        if (result && typeof result === 'object' && typeof (result as { ok?: unknown }).ok === 'boolean') return result as ResultEnvelope;
        return { ok: false, error: { code: 'INTERNAL_ERROR', message: 'Backend returned an invalid result.', retryable: true } };
      } catch (error) {
        return { ok: false, error: { code: 'INTERNAL_ERROR', message: error instanceof Error ? error.message : 'Backend is unavailable.', retryable: true, details: { backendState: backendHost.state() } } };
      }
    });
  }
  backendHost.OnEvent((event) => {
    if (IsRunCompletedEvent(event)) void NotifyRunCompleted({ backendHost, webContentsGetter, iconPath: notificationIconPath }, event);
    const window = webContentsGetter();
    if (!window || window.isDestroyed()) return;
    if (event && typeof event === 'object' && (event as { type?: unknown }).type === 'evaluation_event') {
      window.webContents.send('evaluation:event', (event as { event?: unknown }).event);
      return;
    }
    window.webContents.send('agent:stream', event);
  });
}

/** Agent 流的完成事件：只有它触发系统通知，其余事件仍原样转发渲染层。 */
function IsRunCompletedEvent(event: unknown): boolean {
  return Boolean(event && typeof event === 'object' && (event as { type?: unknown }).type === 'completed');
}

type SettingsReader = { Command: (channel: string, idempotencyKey: string | undefined, ...args: unknown[]) => Promise<unknown> };

async function ReadGeneralSettings(backendHost: SettingsReader): Promise<{ notifyOnComplete?: boolean; notifySound?: boolean } | undefined> {
  const envelope = await backendHost.Command('workspace:get-settings', undefined) as { ok?: boolean; data?: { notifyOnComplete?: boolean; notifySound?: boolean } } | undefined;
  return envelope?.ok === true ? envelope.data : undefined;
}

async function ResolveConversationTitle(backendHost: SettingsReader, sessionId: string): Promise<string> {
  const envelope = await backendHost.Command('workspace:get-view-model', undefined) as { ok?: boolean; data?: { conversations?: Array<{ id?: string; title?: string }> } } | undefined;
  const conversation = envelope?.ok === true ? envelope.data?.conversations?.find((item) => item.id === sessionId) : undefined;
  return conversation?.title ?? 'Avery 任务';
}

/** 长任务完成后，只在用户没有盯着窗口时弹系统通知；托盘里隐藏的窗口同样会收到。 */
async function NotifyRunCompleted({ backendHost, webContentsGetter, iconPath }: { backendHost: SettingsReader; webContentsGetter: () => BrowserWindow | undefined; iconPath?: string }, event: unknown): Promise<void> {
  try {
    const window = webContentsGetter();
    if (!window || window.isDestroyed()) return;
    if (window.isVisible() && window.isFocused()) return;
    const settings = await ReadGeneralSettings(backendHost);
    if (settings?.notifyOnComplete !== true) return;
    const sessionId = (event as { sessionId?: unknown }).sessionId;
    const title = typeof sessionId === 'string' && sessionId ? await ResolveConversationTitle(backendHost, sessionId) : 'Avery 任务';
    const notification = new Notification({ title: '任务已完成', body: `「${title}」已完成。`, silent: settings.notifySound !== true, ...(iconPath ? { icon: iconPath } : {}) });
    notification.on('click', () => {
      const target = webContentsGetter();
      if (!target || target.isDestroyed()) return;
      if (target.isMinimized()) target.restore();
      target.show();
      target.focus();
    });
    notification.show();
  } catch {
    // 通知是锦上添花：读取设置或弹通知失败都不影响任务完成流程，也不向渲染层抛错。
  }
}

/** 系统能力通道：文本复制、工作空间目录与开机自启；每条通道都要通过来源校验。 */
export function RegisterGeneralControls({ webContentsGetter, workspacePath, ipcMainApi = ipcMain }: { webContentsGetter: () => BrowserWindow | undefined; workspacePath: string; ipcMainApi?: IpcMainPort }): void {
  const clipboardLimiter = CreateGatewayLimiter();
  // 网页剪贴板权限默认拒绝；只向可信应用窗口开放有界的纯文本写入，不开放读取或任意格式。
  ipcMainApi.handle('app:write-clipboard-text', (event, ...args: unknown[]): ResultEnvelope => {
    if (!ValidateSender(event, webContentsGetter)) return { ok: false, error: { code: 'PERMISSION_DENIED', message: '剪贴板请求来源无效。', retryable: false } };
    if (!clipboardLimiter.Allow(`${event.sender.id}:clipboard`)) return { ok: false, error: { code: 'WORKSPACE_BUSY', message: '复制操作过于频繁，请稍后重试。', retryable: true } };
    if (args.length !== 1 || typeof args[0] !== 'string' || !args[0].length || Buffer.byteLength(args[0], 'utf8') > 64 * 1024) {
      return { ok: false, error: { code: 'VALIDATION_ERROR', message: '复制内容必须是非空文本，且不超过64KB。', retryable: false } };
    }
    try {
      clipboard.writeText(args[0]);
      return { ok: true, data: true };
    } catch {
      return { ok: false, error: { code: 'INTERNAL_ERROR', message: '无法写入系统剪贴板，请稍后重试。', retryable: true } };
    }
  });
  const handlers: Record<(typeof GeneralControlChannels)[number], (input: unknown) => Promise<unknown> | unknown> = {
    'app:get-workspace-directory': () => workspacePath,
    'app:open-workspace-directory': async () => {
      const error = await shell.openPath(workspacePath);
      if (error) throw new Error(error);
      return true;
    },
    'app:set-login-item': (openAtLogin: unknown) => {
      // 布尔之外一律按关闭处理，防止 Renderer 传入意外结构改写系统登录项。
      app.setLoginItemSettings({ openAtLogin: openAtLogin === true });
      return true;
    },
  };
  for (const channel of GeneralControlChannels) {
    ipcMainApi.handle(channel, async (event, ...args: unknown[]) => {
      if (!ValidateSender(event, webContentsGetter)) return false;
      if (channel === 'app:set-login-item' && args.length !== 1) return false;
      return handlers[channel](args[0]);
    });
  }
}

/** 无边框窗口控制也必须经过相同来源验证，绝不把 BrowserWindow 暴露给 Renderer。 */
export function RegisterWindowControls({ webContentsGetter, ipcMainApi = ipcMain, maximize, frameSize }: { webContentsGetter: () => BrowserWindow | undefined; ipcMainApi?: IpcMainPort; maximize?: { Toggle: () => boolean; IsMaximized: () => boolean }; frameSize?: () => { width: number; height: number; unit: 'physical' } | undefined }): void {
  // 只返回当前主窗口的尺寸；不接收窗口标识或几何参数，避免 Renderer 扩大系统能力范围。
  ipcMainApi.handle('window:get-frame-size', (event, ...args: unknown[]) => {
    if (args.length || !ValidateSender(event, webContentsGetter)) throw new Error('Invalid window frame request');
    const window = webContentsGetter();
    if (!window || window.isDestroyed()) throw new Error('Window unavailable');
    const physicalSize = frameSize?.();
    if (physicalSize) return physicalSize;
    // 原生窗口边界使用 DIP，页面布局使用 CSS 像素；必须扣除页面缩放而非复用 Renderer 已取整的视口。
    const bounds = window.getContentBounds();
    const zoom = window.webContents.getZoomFactor();
    return { width: bounds.width / zoom, height: bounds.height / zoom, unit: 'css' };
  });
  const actions: Record<(typeof WindowControlChannels)[number], (window: BrowserWindow) => boolean> = {
    'window:minimize': (window) => { window.minimize(); return true; },
    // 宿主提供受控的最大化实现（透明 acrylic 窗口的原生最大化不可靠）；未提供时回退原生行为
    'window:toggle-maximize': (window) => { if (maximize) return maximize.Toggle(); if (window.isMaximized()) window.unmaximize(); else window.maximize(); return window.isMaximized(); },
    'window:is-maximized': (window) => maximize ? maximize.IsMaximized() : window.isMaximized(),
    'window:close': (window) => { window.close(); return true; },
  };
  for (const channel of WindowControlChannels) {
    ipcMainApi.handle(channel, (event) => {
      if (!ValidateSender(event, webContentsGetter)) return false;
      const window = webContentsGetter();
      return Boolean(window && !window.isDestroyed() && actions[channel](window));
    });
  }
}
