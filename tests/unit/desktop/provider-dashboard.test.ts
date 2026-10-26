import type { BrowserWindow, IpcMainInvokeEvent } from 'electron';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { openExternal } = vi.hoisted(() => ({ openExternal: vi.fn() }));
vi.mock('electron', () => ({ app: {}, clipboard: {}, ipcMain: {}, Notification: class {}, shell: { openExternal } }));
vi.mock('@avery/backend/dist/router', () => ({ FunctionRouteChannels: [], MethodRoutes: {}, WriteCommandChannels: new Set() }));
import { RegisterGeneralControls } from '../../../apps/desktop/src/gateway';

function Setup(mimoAccount?: Parameters<typeof RegisterGeneralControls>[0]['mimoAccount']) {
  const handlers = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>();
  const url = 'file:///D:/Avery/project/dist/index.html';
  const contents = { id: 1, getURL: () => url };
  const window = { isDestroyed: () => false, webContents: contents } as unknown as BrowserWindow;
  RegisterGeneralControls({ webContentsGetter: () => window, workspacePath: 'D:/test', mimoAccount, ipcMainApi: { handle: (channel, handler) => { handlers.set(channel, handler); } } });
  return { handlers, open: handlers.get('app:open-provider-dashboard')!, event: { sender: contents, senderFrame: { url } } as unknown as IpcMainInvokeEvent };
}
beforeEach(() => openExternal.mockReset());
describe('供应商控制台入口', () => {
  it.each([
    ['DeepSeek', 'https://platform.deepseek.com/usage'],
    ['MIMO', 'https://platform.xiaomimimo.com/#/console/balance'],
    ['Z.AI', 'https://open.bigmodel.cn/finance-center/finance/overview'],
  ])('可信窗口只能按 %s 的固定地址打开', async (provider, url) => {
    const { open, event } = Setup();
    await expect(open(event, provider)).resolves.toMatchObject({ ok: true });
    expect(openExternal).toHaveBeenCalledExactlyOnceWith(url);
  });
  it.each(['https://example.com', 'file:///secret', '__proto__', '自定义', undefined, {}])('拒绝任意地址或无效供应商 %j', async (provider) => {
    const { open, event } = Setup();
    await expect(open(event, provider)).resolves.toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } });
    expect(openExternal).not.toHaveBeenCalled();
  });
  it('拒绝不可信窗口、额外参数，并明确反馈系统浏览器错误', async () => {
    const { open, event } = Setup();
    await expect(open({ ...event, sender: {} } as IpcMainInvokeEvent, 'DeepSeek')).resolves.toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } });
    await expect(open(event, 'DeepSeek', 'https://evil.test')).resolves.toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } });
    expect(openExternal).not.toHaveBeenCalled();
    openExternal.mockRejectedValueOnce(new Error('unavailable'));
    await expect(open(event, 'DeepSeek')).resolves.toMatchObject({ ok: false, error: { code: 'INTERNAL_ERROR' } });
  });
  it('MiMo 账户通道只允许可信主窗口的无参调用，不能注入 URL、Cookie 或请求头', async () => {
    const service = { ReadUsage: vi.fn(async () => ({ provider: 'MIMO', name: 'MiMo', billing: 'metered' as const, status: 'needs_auth' as const, balances: [] })), OpenLogin: vi.fn(async () => ({ authorized: false })), Disconnect: vi.fn(async () => undefined) };
    const { handlers, event } = Setup(service);
    for (const channel of ['app:mimo-account-usage', 'app:mimo-account-login', 'app:mimo-account-disconnect']) {
      const action = handlers.get(channel)!;
      await expect(action({ ...event, sender: {} } as IpcMainInvokeEvent)).resolves.toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } });
      await expect(action(event, { Cookie: 'private-token', url: 'https://evil.test' })).resolves.toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } });
      await expect(action(event)).resolves.toMatchObject({ ok: true });
    }
    expect(service.ReadUsage).toHaveBeenCalledOnce(); expect(service.OpenLogin).toHaveBeenCalledOnce(); expect(service.Disconnect).toHaveBeenCalledOnce();
  });
  it('MiMo 主进程错误不把原始会话数据带入桥接响应', async () => {
    const { handlers, event } = Setup({ ReadUsage: vi.fn(async () => { throw new Error('private-session-token'); }), OpenLogin: vi.fn(), Disconnect: vi.fn() });
    const response = await handlers.get('app:mimo-account-usage')!(event);
    expect(response).toMatchObject({ ok: false, error: { code: 'INTERNAL_ERROR' } });
    expect(JSON.stringify(response)).not.toContain('private-');
  });
});
