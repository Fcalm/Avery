import { dialog, ipcMain, type BrowserWindow, type IpcMain } from 'electron';
import { AppUpdateStateSchema, type ResultEnvelope, type AppUpdateState } from '@avery/contracts';
import { CreateGatewayLimiter, ValidateSender } from './gateway';
import type { AppUpdateService } from './app-updates';

export const AppUpdateChannels = ['app-update:read', 'app-update:check', 'app-update:download', 'app-update:install'] as const;

/** 仅主窗口主 frame 可更新；无参数协议不允许网页指定下载地址或安装文件。 */
export function RegisterAppUpdateControls({ service, webContentsGetter, ipcMainApi = ipcMain, confirmInstall = async (window) => {
  const result = await dialog.showMessageBox(window, { type: 'question', title: '安装更新', message: '重启并安装 Avery 更新？',
    detail: '请先保存编辑内容并结束正在运行的任务。', buttons: ['取消', '重启安装'], defaultId: 0, cancelId: 0 });
  return result.response === 1;
} }: {
  service: AppUpdateService;
  webContentsGetter: () => BrowserWindow | undefined;
  ipcMainApi?: Pick<IpcMain, 'handle'>;
  confirmInstall?: (window: BrowserWindow) => Promise<boolean>;
}): void {
  const limiter = CreateGatewayLimiter({ burst: 6, refillPerSecond: 0.2 });
  let installFlight = false;
  for (const channel of AppUpdateChannels) ipcMainApi.handle(channel, async (event, ...args: unknown[]): Promise<ResultEnvelope<AppUpdateState | boolean>> => {
    const window = webContentsGetter();
    if (!ValidateSender(event, webContentsGetter) || !window || event.senderFrame !== window.webContents.mainFrame) {
      return { ok: false, error: { code: 'PERMISSION_DENIED', message: '更新请求来源无效。', retryable: false } };
    }
    if (args.length) return { ok: false, error: { code: 'VALIDATION_ERROR', message: '更新操作不接受参数。', retryable: false } };
    if (!limiter.Allow(`${event.sender.id}:${channel}`)) return { ok: false, error: { code: 'WORKSPACE_BUSY', message: '操作过于频繁，请稍后重试。', retryable: true } };
    try {
      if (channel === 'app-update:install') {
        if (installFlight || service.GetState().status !== 'downloaded') return { ok: true, data: false };
        installFlight = true;
        try {
          if (!await confirmInstall(window) || !ValidateSender(event, webContentsGetter)) return { ok: true, data: false };
          return { ok: true, data: await service.Install() };
        } finally { installFlight = false; }
      }
      if (channel === 'app-update:check') await service.Check();
      // 下载在 Main 持续运行，IPC 立即回传状态；进度通过单独事件推送。
      if (channel === 'app-update:download') void service.Download();
      return { ok: true, data: AppUpdateStateSchema.parse(service.GetState()) };
    } catch {
      return { ok: false, error: { code: 'INTERNAL_ERROR', message: '更新操作失败，请稍后重试。', retryable: true } };
    }
  });
}
