import type { BrowserWindow, IpcMainInvokeEvent } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import type { AppUpdateService } from '../../../apps/desktop/src/app-updates';
vi.mock('electron', () => ({ dialog: {}, app: {}, clipboard: {}, ipcMain: {}, Notification: class {}, shell: {} }));
vi.mock('@avery/backend/dist/router', () => ({ FunctionRouteChannels: [], MethodRoutes: {}, WriteCommandChannels: new Set() }));
import { AppUpdateChannels, RegisterAppUpdateControls } from '../../../apps/desktop/src/app-update-ipc';

function Fixture() {
  const frame = { url: 'file:///app/index.html' }, contents = { id: 1, mainFrame: frame, getURL: () => frame.url };
  const window = { isDestroyed: () => false, webContents: contents } as unknown as BrowserWindow;
  const event = { sender: contents, senderFrame: frame } as unknown as IpcMainInvokeEvent;
  const handlers = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => Promise<unknown>>();
  const state = { revision: 0, status: 'downloaded', currentVersion: '0.2.0', version: '0.3.0' };
  const service = { GetState: vi.fn(() => state), Check: vi.fn(), Download: vi.fn(), Install: vi.fn(async () => true) };
  const confirm = vi.fn(async (_window: BrowserWindow) => true);
  RegisterAppUpdateControls({ service: service as unknown as AppUpdateService, webContentsGetter: () => window,
    ipcMainApi: { handle: vi.fn((channel, handler) => { handlers.set(channel, handler); }) }, confirmInstall: confirm });
  return { event, handlers, service, confirm, invoke: (channel: string, ...args: unknown[]) => handlers.get(channel)!(event, ...args) };
}
describe('更新 IPC 权限及安装确认', () => {
  it('仅注册固定四个入口，禁止参数、其他窗口和子 frame', async () => {
    const f = Fixture(); expect([...f.handlers.keys()]).toEqual(AppUpdateChannels);
    for (const channel of AppUpdateChannels) {
      expect(await f.invoke(channel, 'https://evil.test/payload.exe')).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } });
      expect(await f.handlers.get(channel)!({ ...f.event, sender: {} } as IpcMainInvokeEvent)).toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } });
      expect(await f.handlers.get(channel)!({ ...f.event, senderFrame: { url: 'file:///app/index.html' } } as IpcMainInvokeEvent)).toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } });
    }
    expect(f.service.Install).not.toHaveBeenCalled();
  });
  it('取消原生确认不会安装，确认后才安装', async () => {
    const f = Fixture(); f.confirm.mockResolvedValueOnce(false);
    expect(await f.invoke('app-update:install')).toEqual({ ok: true, data: false });
    expect(f.service.Install).not.toHaveBeenCalled();
    expect(await f.invoke('app-update:install')).toEqual({ ok: true, data: true });
    expect(f.service.Install).toHaveBeenCalledTimes(1);
  });
  it('确认进行中不重复弹窗；未下载的状态不能安装', async () => {
    const f = Fixture(); let resolve!: (confirmed: boolean) => void;
    f.confirm.mockImplementationOnce(() => new Promise<boolean>(r => { resolve = r; }));
    const first = f.invoke('app-update:install');
    expect(await f.invoke('app-update:install')).toEqual({ ok: true, data: false });
    expect(f.confirm).toHaveBeenCalledTimes(1); resolve(true); await first;
    f.service.GetState().status = 'available';
    expect(await f.invoke('app-update:install')).toEqual({ ok: true, data: false });
    expect(f.confirm).toHaveBeenCalledTimes(1);
  });
});
