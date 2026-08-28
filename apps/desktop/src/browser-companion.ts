import { app, BrowserWindow, Menu, session, WebContentsView } from 'electron';
import type { BrowserWindowConstructorOptions, WebContents } from 'electron';
import { createServer, type Server } from 'node:http';
import { resolve } from 'node:path';

const CompanionFlag = '--offerget-browser-companion';
const ProfileSwitch = '--offerget-browser-profile=';
const ParentPidSwitch = '--offerget-browser-parent-pid=';

/** 伴随模式由 Backend 以固定参数启动；普通 Renderer 和网页均不能切换进该模式。 */
export function IsBrowserCompanionProcess(argv: readonly string[] = process.argv): boolean {
  return argv.includes(CompanionFlag);
}

function ReadSwitch(argv: readonly string[], prefix: string): string | undefined {
  const value = argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
  return value?.trim() || undefined;
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

const SecureWindowOptions: BrowserWindowConstructorOptions = {
  width: 1280,
  height: 900,
  minWidth: 720,
  minHeight: 560,
  show: true,
  autoHideMenuBar: true,
  backgroundColor: '#ffffff',
  title: 'OfferGet Agent Browser',
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
function ConfigurePage(contents: WebContents): void {
  contents.setWindowOpenHandler(({ url }) => IsAllowedBrowserCompanionUrl(url)
    ? { action: 'allow', overrideBrowserWindowOptions: SecureWindowOptions }
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
  app.setPath('userData', resolve(profile));
  const parentPid = Number(ReadSwitch(argv, ParentPidSwitch) ?? 0);

  let readyServer: Server | null = null;
  app.whenReady().then(async () => {
    session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    session.defaultSession.setPermissionCheckHandler(() => false);
    session.defaultSession.on('will-download', (_event, item) => item.cancel());
    app.on('web-contents-created', (_event, contents) => ConfigurePage(contents));
    Menu.setApplicationMenu(null);
    const server = createServer((_request, response) => {
      response.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'",
        'cache-control': 'no-store',
      });
      response.end('<!doctype html><title>OfferGet Agent Browser</title><style>body{font:16px system-ui;margin:48px;color:#4b5563}</style><p>OfferGet 隔离浏览器已就绪，等待 Agent 打开岗位页面。</p>');
    });
    readyServer = server;
    await new Promise<void>((resolveListen, rejectListen) => {
      server.once('error', rejectListen);
      server.listen(0, '127.0.0.1', () => resolveListen());
    });
    const readyAddress = server.address();
    if (!readyAddress || typeof readyAddress === 'string') throw new Error('Browser companion ready page failed to bind.');
    const window = new BrowserWindow(SecureWindowOptions);
    await window.loadURL(`http://127.0.0.1:${readyAddress.port}/shell`);
    const browserView = new WebContentsView({ webPreferences: SecureWindowOptions.webPreferences });
    const ResizeBrowserView = (): void => {
      const [width, height] = window.getContentSize();
      browserView.setBounds({ x: 0, y: 0, width, height });
    };
    window.contentView.addChildView(browserView);
    ResizeBrowserView();
    window.on('resize', ResizeBrowserView);
    window.on('closed', () => { if (!browserView.webContents.isDestroyed()) browserView.webContents.close(); });
    await browserView.webContents.loadURL(`http://127.0.0.1:${readyAddress.port}/ready`);
    browserView.webContents.focus();
    window.show();
    window.focus();

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
