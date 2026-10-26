import { BrowserWindow, session } from 'electron';
import type { BrowserWindowConstructorOptions, Session, WebContents } from 'electron';
import type { ProviderAccountUsage } from '@avery/contracts';
import { IsMimoSessionCookie, MimoSessionCookieNames, MimoSessionRetentionMs, MimoSessionStoreError, type MimoSessionStore } from './mimo-session-store';

export const MimoConsoleUrl = 'https://platform.xiaomimimo.com/#/console/balance';
const BalanceUrl = 'https://platform.xiaomimimo.com/api/v1/balance';
const ConsoleOrigin = 'https://platform.xiaomimimo.com';
const AccountPartition = 'persist:avery-mimo-account';
const LoginHosts = new Set(['platform.xiaomimimo.com', 'account.xiaomi.com', 'id.mi.com']);
const LoginContents = new WeakSet<WebContents>();
const CookieNames = MimoSessionCookieNames;

/** 仅允许固定官方 HTTPS 主机，拒绝自定义协议、带凭据 URL 与相似后缀域名。 */
export function IsMimoLoginUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.port && LoginHosts.has(url.hostname);
  } catch { return false; }
}

/** 默认导航拒绝策略只对注册过的登录窗口放行；普通应用窗口不会获得远程导航能力。 */
export function IsMimoLoginNavigation(contents: WebContents, url: string): boolean {
  return LoginContents.has(contents) && IsMimoLoginUrl(url);
}

function NeedsAuth(canDisconnect = false): ProviderAccountUsage {
  return { provider: 'MIMO', name: 'MiMo', billing: 'metered', status: 'needs_auth', balances: [], dashboardUrl: MimoConsoleUrl, canDisconnect, message: canDisconnect ? 'MiMo 授权已失效，请重新登录。' : '登录 MiMo 控制台后可查看余额。' };
}

function AccountError(message: string, canDisconnect: boolean): ProviderAccountUsage {
  return { ...NeedsAuth(canDisconnect), status: 'error', message };
}

/** 仅提取官方余额字段，不返回响应正文或 Cookie；缺失金额不能被转换为零。 */
export function ParseMimoBalance(json: unknown): ProviderAccountUsage {
  if (!json || typeof json !== 'object' || !('code' in json)) return AccountError('MiMo 返回的余额格式无效。', true);
  if (json.code === 401 || json.code === 403) return NeedsAuth(true);
  if (json.code !== 0 || !('data' in json) || !json.data || typeof json.data !== 'object') return AccountError('MiMo 余额查询未成功，请稍后刷新。', true);
  const data = json.data;
  const amount = 'balance' in data ? data.balance : undefined;
  const currency = 'currency' in data ? data.currency : undefined;
  if ((typeof amount !== 'string' && typeof amount !== 'number') || !/^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(String(amount)) || !Number.isFinite(Number(amount)) || typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency)) return AccountError('MiMo 未返回有效的余额或币种。', true);
  return { ...NeedsAuth(true), status: 'ready', message: undefined, balances: [{ currency, amount: String(amount) }], updatedAt: new Date().toISOString() };
}

type LoginResult = { authorized: boolean };
type LoginState = { window: BrowserWindow; result: Promise<LoginResult>; finish: (authorized: boolean, error?: Error) => void };
export type MimoAccountDiagnostic = { event: string; code?: string | number; host?: string };

/**
 * MiMo 账户服务：登录与余额请求共用独立 Chromium 持久会话；Cookie 不跨进程、不写业务配置。
 * 断开授权中止在途请求并清除此专用分区，代次校验防止旧回包重新显示已撤销的余额。
 */
export class MimoAccountService {
  private accountSession?: Session;
  private login?: LoginState;
  private reading?: Promise<ProviderAccountUsage>;
  private request?: AbortController;
  private generation = 0;
  private disconnecting?: Promise<void>;
  private restoring?: Promise<void>;

  constructor(private readonly options: {
    getParent: () => BrowserWindow | undefined;
    getSession?: () => Session;
    createWindow?: (options: BrowserWindowConstructorOptions) => BrowserWindow;
    /** 诊断仅包含事件、错误码和主机名，禁止记录 Cookie、查询参数与页面正文。 */
    onDiagnostic?: (detail: MimoAccountDiagnostic) => void;
    sessionStore?: MimoSessionStore;
  }) {}

  private Session(): Session {
    if (!this.accountSession) {
      this.accountSession = this.options.getSession?.() ?? session.fromPartition(AccountPartition);
      this.accountSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
      this.accountSession.setPermissionCheckHandler(() => false);
      this.accountSession.on('will-download', (event) => event.preventDefault());
    }
    return this.accountSession;
  }

  /** 仅返回脱敏快照；并发读取共用一次请求，不允许 Renderer 提供 URL、Cookie 或请求头。 */
  ReadUsage(): Promise<ProviderAccountUsage> {
    if (this.disconnecting) return this.disconnecting.then(() => NeedsAuth());
    if (this.reading) return this.reading;
    const generation = this.generation;
    const operation = this.FetchUsage(generation).finally(() => { if (this.reading === operation) this.reading = undefined; });
    this.reading = operation;
    return operation;
  }

  /** persistent 分区不会保留无期限 Cookie；首次查询先恢复系统加密的会话授权。 */
  private RestoreSession(accountSession: Session): Promise<void> {
    if (this.restoring) return this.restoring;
    this.restoring = (async () => {
      if (!this.options.sessionStore) return;
      const current = await accountSession.cookies.get({ url: BalanceUrl });
      // 新登录和 Chromium 已保留的凭据优先，不能被旧快照覆盖。
      if (['api-platform_serviceToken', 'userId'].every((name) => current.some((cookie) => cookie.name === name && cookie.value))) return;
      const snapshot = await this.options.sessionStore.Load();
      if (!snapshot) return;
      const cookies = snapshot.cookies.filter((cookie) => IsMimoSessionCookie(cookie) && (cookie.expirationDate === undefined || cookie.expirationDate > Date.now() / 1000));
      if (!['api-platform_serviceToken', 'userId'].every((name) => cookies.some((cookie) => cookie.name === name))) return;
      for (const cookie of cookies) {
        await accountSession.cookies.set({
          url: `${ConsoleOrigin}${cookie.path}`, name: cookie.name, value: cookie.value,
          ...(!cookie.hostOnly ? { domain: cookie.domain } : {}), path: cookie.path,
          secure: cookie.secure, httpOnly: cookie.httpOnly, sameSite: cookie.sameSite,
          ...(cookie.expirationDate !== undefined ? { expirationDate: cookie.expirationDate } : {}),
        });
      }
      await accountSession.cookies.flushStore();
    })().catch((error) => { this.restoring = undefined; throw error; });
    return this.restoring;
  }

  private async FetchUsage(generation: number): Promise<ProviderAccountUsage> {
    let canDisconnect = false;
    try {
      const accountSession = this.Session();
      await this.RestoreSession(accountSession);
      const cookies = (await accountSession.cookies.get({ url: BalanceUrl })).filter((cookie) => CookieNames.has(cookie.name) && cookie.value);
      canDisconnect = cookies.length > 0;
      if (generation !== this.generation) return NeedsAuth();
      if (!['api-platform_serviceToken', 'userId'].every((name) => cookies.some((cookie) => cookie.name === name))) return NeedsAuth(canDisconnect);
      const controller = new AbortController();
      this.request = controller;
      const response = await accountSession.fetch(BalanceUrl, {
        method: 'GET', credentials: 'include', redirect: 'error', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]),
        headers: { Accept: 'application/json', Referer: MimoConsoleUrl, Origin: ConsoleOrigin },
      });
      if (generation !== this.generation) return NeedsAuth();
      if (response.status === 401 || response.status === 403 || (response.status >= 300 && response.status < 400)) {
        await this.options.sessionStore?.Clear();
        return NeedsAuth(true);
      }
      if (!response.ok) return AccountError(`MiMo 余额查询失败（${response.status}）。`, true);
      const json: unknown = await response.json();
      if (generation !== this.generation) return NeedsAuth();
      const usage = ParseMimoBalance(json);
      if (usage.status === 'needs_auth') await this.options.sessionStore?.Clear();
      if (usage.status === 'ready' && this.options.sessionStore) {
        // 请求可能更新 Cookie，保存最新凭据；保留服务端期限，不人为延长服务端登录有效期。
        const latest = (await accountSession.cookies.get({ url: BalanceUrl })).filter(IsMimoSessionCookie).map(({ name, value, domain, path, httpOnly, secure, sameSite, hostOnly, expirationDate }) => ({ name, value, domain, path, httpOnly, secure, sameSite, hostOnly, expirationDate }));
        if (generation !== this.generation) return NeedsAuth();
        await this.options.sessionStore.Save({ version: 1, validUntil: Date.now() + MimoSessionRetentionMs, cookies: latest });
        await accountSession.cookies.flushStore();
      }
      return generation === this.generation ? usage : NeedsAuth();
    } catch (error) {
      return generation === this.generation ? AccountError(error instanceof MimoSessionStoreError ? error.message : 'MiMo 连接失败、授权跳转或返回数据异常，请重新登录或稍后刷新。', canDisconnect) : NeedsAuth();
    } finally { this.request = undefined; }
  }

  /** 打开无 preload 的官方登录窗口；仅验证余额成功才自动结束，手动关窗保留明确的未完成状态。 */
  OpenLogin(): Promise<LoginResult> {
    this.options.onDiagnostic?.({ event: 'open-login' });
    if (this.disconnecting) return Promise.reject(new Error('正在断开 MiMo 授权，请稍后重试。'));
    if (this.login && !this.login.window.isDestroyed()) { this.login.window.show(); this.login.window.focus(); return this.login.result; }
    const accountSession = this.Session();
    const options: BrowserWindowConstructorOptions = {
      width: 1000, height: 760, minWidth: 760, minHeight: 600, title: '登录 MiMo · Avery', parent: this.options.getParent(), autoHideMenuBar: true,
      webPreferences: { session: accountSession, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, webviewTag: false },
    };
    const window = this.options.createWindow?.(options) ?? new BrowserWindow(options);
    this.options.onDiagnostic?.({ event: 'window-created' });
    const contents = window.webContents;
    LoginContents.add(contents);
    let resolve!: (value: LoginResult) => void;
    let reject!: (error: Error) => void;
    const result = new Promise<LoginResult>((done, fail) => { resolve = done; reject = fail; });
    let finished = false;
    let checking = false;
    let checkAgain = false;
    const state: LoginState = { window, result, finish: (authorized, error) => {
      if (finished) return;
      finished = true;
      accountSession.cookies.removeListener('changed', OnCookieChanged);
      LoginContents.delete(contents);
      if (this.login === state) this.login = undefined;
      if (error) reject(error);
      else resolve({ authorized });
    } };
    this.login = state;
    const Probe = async () => {
      if (checking) { checkAgain = true; return; }
      checking = true;
      try {
        do {
          checkAgain = false;
          if (finished || this.disconnecting) break;
          const usage = await this.ReadUsage();
          if (!finished && usage.status === 'ready') { state.finish(true); if (!window.isDestroyed()) window.close(); }
        } while (checkAgain && !finished);
      } finally { checking = false; }
    };
    const OnCookieChanged = (_event: unknown, cookie: Electron.Cookie) => { if (CookieNames.has(cookie.name)) void Probe(); };
    accountSession.cookies.on('changed', OnCookieChanged);
    contents.on('did-finish-load', () => { void Probe(); });
    contents.on('will-redirect', (event, url) => {
      let host = '';
      try { host = new URL(url).hostname; } catch { /* 非 URL 不记录原文。 */ }
      this.options.onDiagnostic?.({ event: IsMimoLoginUrl(url) ? 'redirect-allowed' : 'redirect-blocked', host });
      if (!IsMimoLoginUrl(url)) event.preventDefault();
    });
    contents.on('did-fail-load', (_event, code, _description, _url, isMainFrame) => { if (isMainFrame) this.options.onDiagnostic?.({ event: 'main-frame-load-failed', code }); });
    contents.on('render-process-gone', (_event, details) => this.options.onDiagnostic?.({ event: 'login-renderer-gone', code: details.reason }));
    // 不创建任意弹窗；官方登录弹窗合并到当前隔离窗口，其它主机全部拒绝。
    contents.setWindowOpenHandler(({ url }) => {
      if (IsMimoLoginUrl(url)) void window.loadURL(url).catch(() => { state.finish(false, new Error('无法加载 MiMo 登录页面。')); if (!window.isDestroyed()) window.close(); });
      return { action: 'deny' };
    });
    window.on('closed', () => { this.options.onDiagnostic?.({ event: 'window-closed' }); state.finish(false); });
    void window.loadURL(MimoConsoleUrl).then(() => Probe()).catch(() => { state.finish(false, new Error('无法加载 MiMo 登录页面。')); if (!window.isDestroyed()) window.close(); });
    return result;
  }

  /** 仅清除 MiMo 专用分区，保留模型 API Key、系统浏览器及其它 Avery 会话的数据。 */
  Disconnect(): Promise<void> {
    if (this.disconnecting) return this.disconnecting;
    this.generation += 1;
    this.request?.abort();
    const login = this.login;
    login?.finish(false);
    if (login && !login.window.isDestroyed()) login.window.close();
    const operation = (async () => {
      const accountSession = this.Session();
      // 先关闭此分区的连接，防止登录页的迟到 Set-Cookie 在清理后恢复会话。
      await accountSession.closeAllConnections();
      await this.reading;
      await this.options.sessionStore?.Clear();
      await accountSession.clearStorageData();
      await accountSession.clearCache();
      await accountSession.cookies.flushStore();
    })().finally(() => { if (this.disconnecting === operation) this.disconnecting = undefined; });
    this.disconnecting = operation;
    return operation;
  }
}
