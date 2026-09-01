import { app, BrowserWindow, Menu, session } from 'electron';
import type { BrowserWindowConstructorOptions, WebContents } from 'electron';
import { appendFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { resolve } from 'node:path';

const CompanionFlag = '--offerget-browser-companion';
const ProfileSwitch = '--offerget-browser-profile=';
const ParentPidSwitch = '--offerget-browser-parent-pid=';
const HiddenFlag = '--offerget-browser-hidden';
let companionWindow: BrowserWindow | null = null;

/** 伴随模式由 Backend 以固定参数启动；普通 Renderer 和网页均不能切换进该模式。 */
export function IsBrowserCompanionProcess(argv: readonly string[] = process.argv): boolean {
  return argv.includes(CompanionFlag);
}

function ReadSwitch(argv: readonly string[], prefix: string): string | undefined {
  const value = argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
  return value?.trim() || undefined;
}

/** 只记录 companion 生命周期原因，不写网页地址、页面内容或用户数据。 */
async function RecordRendererExit(profilePath: string, reason: string, exitCode: number): Promise<void> {
  const entry = JSON.stringify({ createdAt: new Date().toISOString(), event: 'render_process_gone', reason, exitCode });
  await appendFile(resolve(profilePath, 'companion-events.jsonl'), `${entry}\n`, 'utf8').catch(() => undefined);
}

export function IsAllowedBrowserCompanionUrl(value: string): boolean {
  if (value === 'about:blank') return true;
  try {
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password;
  } catch {
    return false;
  }
}

/** 启动页手动前往与 Agent 导航共享相同的协议和凭据限制，未提供协议时默认使用 HTTPS。 */
function NormalizeBrowserCompanionNavigation(value: string): string | null {
  const raw = value.trim();
  if (!raw) return null;
  const candidate = /^[a-z][a-z\d+.-]*:/i.test(raw) ? raw : `https://${raw}`;
  return IsAllowedBrowserCompanionUrl(candidate) ? candidate : null;
}

function CreateBrowserStartPage(hasInvalidUrl = false): string {
  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Avery 隔离浏览器</title>
    <style>
      :root { color: #000; background: #eef4ea; font-family: "SF Pro Display", "PingFang SC", "Microsoft YaHei", Arial, sans-serif; }
      * { box-sizing: border-box; }
      body { display: grid; min-width: 0; min-height: 100vh; margin: 0; place-items: center; background: #eef4ea; }
      main { width: min(560px, calc(100vw - 48px)); transform: translateY(-4vh); }
      h1 { margin: 0 0 24px; color: #000; font-size: clamp(42px, 8vw, 72px); font-weight: 600; letter-spacing: -.06em; line-height: 1; text-align: center; }
      form { position: relative; }
      input { display: block; width: 100%; height: 56px; border: 1px solid #c6c6c6; border-radius: 4px; padding: 0 92px 0 16px; color: #000; background: #fff; font: inherit; font-size: 16px; outline: none; }
      input:focus { border-color: #000; }
      button { position: absolute; top: 4px; right: 4px; bottom: 4px; min-width: 76px; border: 0; border-radius: 4px; color: #fff; background: #000; font: inherit; font-size: 14px; font-weight: 600; cursor: pointer; }
      button:hover { background: #282828; }
      button:focus-visible { outline: 2px solid #000; outline-offset: 3px; }
      .error { min-height: 18px; margin: 8px 0 0; color: #ae3527; font-size: 12px; text-align: center; }
    </style>
  </head>
  <body>
    <main>
      <h1>Avery</h1>
      <form action="/go" method="get">
        <input type="url" name="url" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="输入网址" aria-label="输入要前往的网址" autofocus required />
        <button type="submit">前往</button>
      </form>
      <p class="error" role="alert">${hasInvalidUrl ? '请输入有效的 HTTP 或 HTTPS 地址。' : ''}</p>
    </main>
  </body>
</html>`;
}

const SecureWindowOptions: BrowserWindowConstructorOptions = {
  width: 1280,
  height: 900,
  minWidth: 720,
  minHeight: 560,
  show: true,
  autoHideMenuBar: true,
  backgroundColor: '#ffffff',
  title: 'Avery 隔离浏览器',
  webPreferences: {
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    webSecurity: true,
    allowRunningInsecureContent: false,
    navigateOnDragDrop: false,
  },
};

/** 所有伴随进程网页 target 使用同一组最小权限策略；只允许普通网页和安全弹出窗口。 */
function ConfigurePage(contents: WebContents, hidden = false): void {
  contents.setWindowOpenHandler(({ url }) => IsAllowedBrowserCompanionUrl(url)
    ? { action: 'allow', overrideBrowserWindowOptions: { ...SecureWindowOptions, show: !hidden } }
    : { action: 'deny' });
  contents.on('will-attach-webview', (event) => event.preventDefault());
  contents.on('will-navigate', (event, url) => { if (!IsAllowedBrowserCompanionUrl(url)) event.preventDefault(); });
  contents.on('will-redirect', (event, url) => { if (!IsAllowedBrowserCompanionUrl(url)) event.preventDefault(); });
}

/** 启动只承载招聘网页的独立 Electron 进程；本分支不会创建 OfferGet 主窗口或 Backend。 */
export function StartBrowserCompanion(argv: readonly string[] = process.argv): void {
  const profile = ReadSwitch(argv, ProfileSwitch);
  if (!profile) {
    console.error('Browser companion profile is unavailable.');
    app.exit(2);
    return;
  }
  const profilePath = resolve(profile);
  app.setPath('userData', profilePath);
  const parentPid = Number(ReadSwitch(argv, ParentPidSwitch) ?? 0);
  const hidden = argv.includes(HiddenFlag);

  let readyServer: Server | null = null;
  app.whenReady().then(async () => {
    session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    session.defaultSession.setPermissionCheckHandler(() => false);
    session.defaultSession.on('will-download', (_event, item) => item.cancel());
    app.on('web-contents-created', (_event, contents) => ConfigurePage(contents, hidden));
    Menu.setApplicationMenu(null);
    const server = createServer((request, response) => {
      const requestUrl = new URL(request.url ?? '/', 'http://127.0.0.1');
      if (requestUrl.pathname === '/go') {
        const target = NormalizeBrowserCompanionNavigation(requestUrl.searchParams.get('url') ?? '');
        if (target) {
          response.writeHead(302, { location: target, 'cache-control': 'no-store' });
          response.end();
          return;
        }
      }
      response.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'",
        'cache-control': 'no-store',
      });
      response.end(CreateBrowserStartPage(requestUrl.pathname === '/go'));
    });
    readyServer = server;
    await new Promise<void>((resolveListen, rejectListen) => {
      server.once('error', rejectListen);
      server.listen(0, '127.0.0.1', () => resolveListen());
    });
    const readyAddress = server.address();
    if (!readyAddress || typeof readyAddress === 'string') throw new Error('Browser companion ready page failed to bind.');
    const window = new BrowserWindow({ ...SecureWindowOptions, show: !hidden });
    companionWindow = window;
    window.on('closed', () => { companionWindow = null; });
    // 唯一网页 target 直接承载招聘页面；Renderer 消失时结束进程，由 Backend 按既有流程重建。
    window.webContents.on('render-process-gone', (_event, details) => {
      console.error(`Browser companion renderer exited: ${details.reason} (${details.exitCode}).`);
      void RecordRendererExit(profilePath, details.reason, details.exitCode).finally(() => app.exit(3));
    });
    await window.loadURL(`http://127.0.0.1:${readyAddress.port}/ready`);
    if (!hidden) {
      window.webContents.focus();
      window.show();
      window.focus();
    }

    if (Number.isSafeInteger(parentPid) && parentPid > 0) {
      const timer = setInterval(() => {
        try { process.kill(parentPid, 0); } catch { clearInterval(timer); app.quit(); }
      }, 2_000);
    }
  }).catch((error) => {
    console.error('Browser companion failed to start:', error);
    app.exit(1);
  });

  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', () => { readyServer?.close(); readyServer = null; });
}
