import { EventEmitter } from 'node:events';
import type { BrowserWindow, BrowserWindowConstructorOptions, Cookie, CookiesSetDetails, Session, WebContents } from 'electron';
import { describe, expect, it, vi } from 'vitest';
vi.mock('electron', () => ({ BrowserWindow: class {}, session: {} }));
import { IsMimoLoginNavigation, IsMimoLoginUrl, MimoAccountService, ParseMimoBalance } from '../../../apps/desktop/src/mimo-account';
import type { MimoSessionSnapshot, MimoSessionStore } from '../../../apps/desktop/src/mimo-session-store';

const SecretCookies: Cookie[] = [
  { name: 'api-platform_serviceToken', value: 'private-session-token', domain: 'platform.xiaomimimo.com', path: '/', httpOnly: true, secure: true, sameSite: 'lax', hostOnly: true, session: true },
  { name: 'userId', value: 'private-user-id', domain: '.xiaomimimo.com', path: '/', httpOnly: false, secure: true, sameSite: 'lax', hostOnly: false, session: true },
];
const Balance = () => Response.json({ code: 0, data: { balance: '21.66', currency: 'CNY', cashBalance: '20', giftBalance: '1.66', secret: 'private-upstream-field' } });

class LoginWindow extends EventEmitter {
  destroyed = false;
  webContents = Object.assign(new EventEmitter(), { setWindowOpenHandler: vi.fn() });
  loadURL = vi.fn(async (_url: string) => undefined);
  show = vi.fn();
  focus = vi.fn();
  isDestroyed = () => this.destroyed;
  close = vi.fn(() => { this.destroyed = true; this.emit('closed'); });
}

function Setup(initialCookies = SecretCookies, sessionStore?: MimoSessionStore) {
  let stored = [...initialCookies];
  const cookies = Object.assign(new EventEmitter(), { get: vi.fn(async () => stored), flushStore: vi.fn(async () => undefined), set: vi.fn(async (details: CookiesSetDetails) => {
    stored = [...stored.filter((cookie) => cookie.name !== details.name), { ...details, name: details.name!, value: details.value!, domain: details.domain ?? 'platform.xiaomimimo.com', hostOnly: !details.domain, sameSite: details.sameSite ?? 'unspecified' }];
  }) });
  const accountSession = Object.assign(new EventEmitter(), {
    cookies, fetch: vi.fn(async (_url: string, _init?: RequestInit) => Balance()),
    setPermissionRequestHandler: vi.fn(), setPermissionCheckHandler: vi.fn(),
    clearStorageData: vi.fn(async () => { stored = []; }), clearCache: vi.fn(async () => undefined), closeAllConnections: vi.fn(async () => undefined),
  });
  const window = new LoginWindow();
  const createWindow = vi.fn((_options: BrowserWindowConstructorOptions) => window as unknown as BrowserWindow);
  const service = new MimoAccountService({ getParent: () => undefined, getSession: () => accountSession as unknown as Session, createWindow, sessionStore });
  return { service, cookies, accountSession, window, createWindow, setCookies: (value: typeof SecretCookies) => { stored = value; } };
}

describe('MiMo 控制台账户会话', () => {
  it('退出后 Chromium 丢弃会话 Cookie 时，新服务从授权存储恢复，保留原有属性与期限', async () => {
    let snapshot: MimoSessionSnapshot | null = null;
    const store = { Load: vi.fn(async () => snapshot), Save: vi.fn(async (value: MimoSessionSnapshot) => { snapshot = structuredClone(value); }), Clear: vi.fn(async () => { snapshot = null; }) };
    const first = Setup(SecretCookies, store);
    expect((await first.service.ReadUsage()).status).toBe('ready');
    expect(store.Save).toHaveBeenCalledOnce();
    // 模拟完整进程退出：Cookie 容器为空，而系统加密授权仍在磁盘中。
    const restarted = Setup([], store);
    expect((await restarted.service.ReadUsage()).status).toBe('ready');
    expect(restarted.cookies.set).toHaveBeenCalledTimes(2);
    expect(restarted.cookies.set.mock.calls[0][0]).toMatchObject({ name: 'api-platform_serviceToken', httpOnly: true, secure: true, sameSite: 'lax' });
    expect(restarted.cookies.set.mock.calls[0][0]).not.toHaveProperty('domain');
    expect(restarted.cookies.set.mock.calls[0][0]).not.toHaveProperty('expirationDate');
    expect(restarted.cookies.set.mock.calls[1][0].domain).toBe('.xiaomimimo.com');
    await restarted.service.Disconnect();
    expect((await Setup([], store).service.ReadUsage()).status).toBe('needs_auth');
  });

  it('不恢复服务端已过期的授权 Cookie；服务端拒绝时删除旧授权，避免下次重启反复使用', async () => {
    const expired = SecretCookies.map((cookie) => ({ ...cookie, expirationDate: Date.now() / 1000 - 10 }));
    const store = { Load: vi.fn(async () => ({ version: 1 as const, validUntil: Date.now() + 100000, cookies: expired })), Save: vi.fn(async () => undefined), Clear: vi.fn(async () => undefined) };
    const restored = Setup([], store);
    expect((await restored.service.ReadUsage()).status).toBe('needs_auth');
    expect(restored.cookies.set).not.toHaveBeenCalled(); expect(restored.accountSession.fetch).not.toHaveBeenCalled();
    const invalid = Setup(SecretCookies, store);
    invalid.accountSession.fetch.mockResolvedValueOnce(new Response('', { status: 401 }));
    expect((await invalid.service.ReadUsage()).status).toBe('needs_auth');
    expect(store.Clear).toHaveBeenCalledOnce();
  });
  it('未授权时不发网络请求，不把缺失会话显示为零余额', async () => {
    const { service, accountSession } = Setup([]);
    expect(await service.ReadUsage()).toMatchObject({ status: 'needs_auth', balances: [], canDisconnect: false });
    expect(accountSession.fetch).not.toHaveBeenCalled();
  });

  it('仅通过隔离 Session 请求固定官方余额地址，不向桥接返回 Cookie 或响应的其它字段', async () => {
    const { service, cookies, accountSession } = Setup();
    const usage = await service.ReadUsage();
    expect(cookies.get).toHaveBeenCalledWith({ url: 'https://platform.xiaomimimo.com/api/v1/balance' });
    expect(accountSession.fetch).toHaveBeenCalledWith('https://platform.xiaomimimo.com/api/v1/balance', expect.objectContaining({ credentials: 'include', redirect: 'error', method: 'GET' }));
    expect(accountSession.fetch.mock.calls[0][1]?.headers).not.toHaveProperty('Cookie');
    expect(usage).toMatchObject({ status: 'ready', canDisconnect: true, balances: [{ amount: '21.66', currency: 'CNY' }] });
    expect(JSON.stringify(usage)).not.toContain('private-');
    const denyPermission = accountSession.setPermissionRequestHandler.mock.calls[0][0];
    const callback = vi.fn(); denyPermission({}, 'media', callback); expect(callback).toHaveBeenCalledWith(false);
  });

  it.each([401, 403])('HTTP %i 表示需要重新登录，不提示修改模型 API Key', async (status) => {
    const { service, accountSession } = Setup();
    accountSession.fetch.mockResolvedValueOnce(new Response('', { status }));
    expect(await service.ReadUsage()).toMatchObject({ status: 'needs_auth', balances: [], canDisconnect: true });
  });

  it('并发查询共享一次请求，断开授权使迟到的成功响应失效，并清除专用会话', async () => {
    const { service, accountSession, cookies } = Setup();
    let resolve!: (value: Response) => void;
    accountSession.fetch.mockImplementationOnce(() => new Promise<Response>((done) => { resolve = done; }));
    const first = service.ReadUsage(); const second = service.ReadUsage();
    expect(first).toBe(second);
    await vi.waitFor(() => expect(accountSession.fetch).toHaveBeenCalledOnce());
    const disconnect = service.Disconnect();
    expect(accountSession.fetch.mock.calls[0][1]?.signal?.aborted).toBe(true);
    resolve(Balance());
    expect(await first).toMatchObject({ status: 'needs_auth', balances: [], canDisconnect: false });
    await disconnect;
    expect(accountSession.closeAllConnections).toHaveBeenCalledOnce(); expect(accountSession.clearStorageData).toHaveBeenCalledOnce(); expect(cookies.flushStore).toHaveBeenCalledOnce();
    expect(await service.ReadUsage()).toMatchObject({ status: 'needs_auth' });
    expect(accountSession.fetch).toHaveBeenCalledOnce();
  });

  it('普通应用窗口不获得导航权限，登录窗口只放行已知 HTTPS 登录域名', async () => {
    const { service, window, createWindow } = Setup([]);
    const pending = service.OpenLogin();
    const preferences = createWindow.mock.calls[0][0].webPreferences!;
    expect(preferences).toMatchObject({ sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, webviewTag: false });
    expect(preferences.preload).toBeUndefined();
    const contents = window.webContents as unknown as WebContents;
    expect(IsMimoLoginNavigation(contents, 'https://account.xiaomi.com/pass/serviceLogin')).toBe(true);
    expect(IsMimoLoginNavigation({} as WebContents, 'https://account.xiaomi.com/pass/serviceLogin')).toBe(false);
    for (const url of ['http://platform.xiaomimimo.com', 'file:///secret', 'https://platform.xiaomimimo.com.evil.test', 'https://attacker@account.xiaomi.com', 'https://account.xiaomi.com:8443/', 'javascript:alert(1)']) expect(IsMimoLoginUrl(url)).toBe(false);
    const preventDefault = vi.fn(); window.webContents.emit('will-redirect', { preventDefault }, 'https://evil.test'); expect(preventDefault).toHaveBeenCalledOnce();
    const popup = window.webContents.setWindowOpenHandler.mock.calls[0][0];
    expect(popup({ url: 'https://evil.test' })).toEqual({ action: 'deny' });
    expect(window.loadURL).toHaveBeenCalledTimes(1);
    window.close(); await expect(pending).resolves.toEqual({ authorized: false });
    expect(IsMimoLoginNavigation(contents, 'https://account.xiaomi.com')).toBe(false);
  });

  it('重复点击复用登录窗口，取消登录移除监听器，不清理其它会话', async () => {
    const { service, window, cookies, accountSession, createWindow } = Setup([]);
    const first = service.OpenLogin(); const second = service.OpenLogin();
    expect(second).toBe(first); expect(createWindow).toHaveBeenCalledOnce(); expect(window.focus).toHaveBeenCalledOnce();
    window.close(); await expect(first).resolves.toEqual({ authorized: false });
    expect(cookies.listenerCount('changed')).toBe(0); expect(accountSession.clearStorageData).not.toHaveBeenCalled();
  });

  it('登录后余额校验成功才自动关闭，随后可以读取授权余额', async () => {
    const { service, window, cookies, setCookies } = Setup([]);
    const pending = service.OpenLogin();
    await vi.waitFor(() => expect(cookies.get).toHaveBeenCalled());
    setCookies(SecretCookies); cookies.emit('changed', {}, SecretCookies[0]);
    await expect(pending).resolves.toEqual({ authorized: true });
    expect(window.close).toHaveBeenCalledOnce(); expect(cookies.listenerCount('changed')).toBe(0);
    expect(await service.ReadUsage()).toMatchObject({ status: 'ready' });
  });

  it('断开授权会结束未完成的登录流程；登录加载错误向调用方反馈', async () => {
    const first = Setup([]); const pending = first.service.OpenLogin();
    await first.service.Disconnect(); await expect(pending).resolves.toEqual({ authorized: false });
    const second = Setup([]); second.window.loadURL.mockRejectedValueOnce(new Error('private-url'));
    await expect(second.service.OpenLogin()).rejects.toThrow('无法加载 MiMo 登录页面');
    expect(second.cookies.listenerCount('changed')).toBe(0);
  });

  it('网络错误不暴露原始错误和会话字段', async () => {
    const { service, accountSession } = Setup();
    accountSession.fetch.mockRejectedValueOnce(new Error('private-session-token'));
    const result = await service.ReadUsage(); expect(result.status).toBe('error'); expect(JSON.stringify(result)).not.toContain('private-');
  });
});

describe('MiMo 余额解析', () => {
  it.each(['0', '0E-9', '-0.01'])('允许真实金额 %s', (amount) => {
    expect(ParseMimoBalance({ code: 0, data: { balance: amount, currency: 'CNY' } })).toMatchObject({ status: 'ready', balances: [{ amount }] });
  });
  it.each([null, '', false, 'NaN', 'Infinity', {}])('无效余额 %j 不能变成零', (balance) => {
    expect(ParseMimoBalance({ code: 0, data: { balance, currency: 'CNY' } })).toMatchObject({ status: 'error', balances: [] });
  });
  it('拒绝业务失败，并识别业务层授权过期', () => {
    expect(ParseMimoBalance({ code: 500, data: { balance: 10, currency: 'CNY' } }).status).toBe('error');
    expect(ParseMimoBalance({ code: 401, message: 'private-token' }).status).toBe('needs_auth');
  });
});
