import { ipcMain } from 'electron';
import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from 'electron';
import { FunctionRouteChannels, MethodRoutes, WriteCommandChannels } from '@offerget/backend/dist/router';
import { WriteCommandEnvelopeSchema } from '@offerget/contracts';

export const MaxGatewayPayloadBytes = 10 * 1024 * 1024;
export const WindowControlChannels = ['window:minimize', 'window:toggle-maximize', 'window:close'] as const;

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
export function RegisterGateway({ backendHost, webContentsGetter, ipcMainApi = ipcMain }: { backendHost: BackendHostPort; webContentsGetter: () => BrowserWindow | undefined; ipcMainApi?: IpcMainPort }): void {
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
    const window = webContentsGetter();
    if (window && !window.isDestroyed()) window.webContents.send('agent:stream', event);
  });
}

/** 无边框窗口控制也必须经过相同来源验证，绝不把 BrowserWindow 暴露给 Renderer。 */
export function RegisterWindowControls({ webContentsGetter, ipcMainApi = ipcMain }: { webContentsGetter: () => BrowserWindow | undefined; ipcMainApi?: IpcMainPort }): void {
  const actions: Record<(typeof WindowControlChannels)[number], (window: BrowserWindow) => boolean> = {
    'window:minimize': (window) => { window.minimize(); return true; },
    'window:toggle-maximize': (window) => { if (window.isMaximized()) window.unmaximize(); else window.maximize(); return window.isMaximized(); },
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
