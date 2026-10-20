import type { BrowserWindow, IpcMainInvokeEvent } from 'electron';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { openExternal } = vi.hoisted(() => ({ openExternal: vi.fn() }));
vi.mock('electron', () => ({ app: {}, clipboard: {}, ipcMain: {}, Notification: class {}, shell: { openExternal } }));
vi.mock('@avery/backend/dist/router', () => ({ FunctionRouteChannels: [], MethodRoutes: {}, WriteCommandChannels: new Set() }));
import { RegisterGeneralControls } from '../../../apps/desktop/src/gateway';

function Setup() {
  const handlers = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>();
  const url = 'file:///D:/Avery/project/dist/index.html';
  const contents = { id: 1, getURL: () => url };
  const window = { isDestroyed: () => false, webContents: contents } as unknown as BrowserWindow;
  RegisterGeneralControls({ webContentsGetter: () => window, workspacePath: 'D:/test', ipcMainApi: { handle: (channel, handler) => { handlers.set(channel, handler); } } });
  return { open: handlers.get('app:open-deepseek-api-keys')!, event: { sender: contents, senderFrame: { url } } as unknown as IpcMainInvokeEvent };
}
beforeEach(() => openExternal.mockReset());
describe('引导服务商链接', () => {
  it('只在可信主窗口请求时打开固定的 DeepSeek 页面', async () => {
    const { open, event } = Setup();
    await expect(open(event)).resolves.toEqual({ ok: true, data: true });
    expect(openExternal).toHaveBeenCalledExactlyOnceWith('https://platform.deepseek.com/api_keys');
  });
  it('拒绝其他窗口及自定义参数，不能用于打开任意协议', async () => {
    const { open, event } = Setup();
    await expect(open({ ...event, sender: {} } as IpcMainInvokeEvent)).resolves.toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } });
    await expect(open(event, 'file:///secret')).resolves.toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } });
    expect(openExternal).not.toHaveBeenCalled();
  });
  it('系统浏览器打开失败明确反馈，允许用户重试', async () => {
    const { open, event } = Setup();
    openExternal.mockRejectedValueOnce(new Error('unavailable'));
    await expect(open(event)).resolves.toMatchObject({ ok: false, error: { code: 'INTERNAL_ERROR' } });
    await expect(open(event)).resolves.toMatchObject({ ok: true });
  });
});
