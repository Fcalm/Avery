"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.BrowserPanelHost = void 0;
exports.RegisterBrowserPanel = RegisterBrowserPanel;
const electron_1 = require("electron");
const gateway_1 = require("./gateway");
const browser_policy_1 = require("./browser-policy");
const BrowserPartition = 'persist:offerget-in-app-browser';
const BrowserChannels = ['browser:show', 'browser:hide', 'browser:navigate', 'browser:back', 'browser:forward', 'browser:reload'];
/** 浏览器使用独立持久化分区；下载与所有设备/媒体权限均默认拒绝。 */
function ConfigureBrowserSession() {
    const browserSession = electron_1.session.fromPartition(BrowserPartition);
    browserSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    browserSession.setPermissionCheckHandler(() => false);
    browserSession.on('will-download', (_event, item) => item.cancel());
}
/** 主进程拥有网页视图、边界和导航策略，Renderer 从不直接取得 WebContents。 */
class BrowserPanelHost {
    getWindow;
    view = null;
    attached = false;
    constructor(getWindow) {
        this.getWindow = getWindow;
    }
    IsBrowserContents(contents) {
        return this.view?.webContents === contents;
    }
    AllowNavigation(url) {
        return (0, browser_policy_1.NormalizeBrowserAddress)(url) !== null;
    }
    GetOrCreateView() {
        if (this.view && !this.view.webContents.isDestroyed())
            return this.view;
        ConfigureBrowserSession();
        const view = new electron_1.WebContentsView({
            webPreferences: {
                contextIsolation: true,
                nodeIntegration: false,
                sandbox: true,
                webSecurity: true,
                allowRunningInsecureContent: false,
                navigateOnDragDrop: false,
                partition: BrowserPartition,
            },
        });
        view.setBackgroundColor('#ffffff');
        view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
        view.webContents.on('will-navigate', (event, url) => { if (!this.AllowNavigation(url))
            event.preventDefault(); });
        view.webContents.on('will-redirect', (event, url) => { if (!this.AllowNavigation(url))
            event.preventDefault(); });
        this.view = view;
        return view;
    }
    Show(bounds) {
        const window = this.getWindow();
        if (!window || window.isDestroyed())
            return false;
        const view = this.GetOrCreateView();
        view.setBounds(bounds);
        if (!this.attached) {
            window.contentView.addChildView(view);
            this.attached = true;
        }
        view.setVisible(true);
        return true;
    }
    Hide() {
        const window = this.getWindow();
        if (!this.view || !window || window.isDestroyed())
            return false;
        this.view.setVisible(false);
        if (this.attached) {
            window.contentView.removeChildView(this.view);
            this.attached = false;
        }
        return true;
    }
    async Navigate(address) {
        const url = (0, browser_policy_1.NormalizeBrowserAddress)(address);
        if (!url)
            return { accepted: false, reason: '仅支持 http 或 https 地址，且不允许在地址中包含账号信息。' };
        const view = this.GetOrCreateView();
        try {
            await view.webContents.loadURL(url);
            return { accepted: true, url };
        }
        catch {
            return { accepted: false, reason: '网页无法打开，请检查地址或网络连接。' };
        }
    }
    GoBack() { if (!this.view?.webContents.canGoBack())
        return false; this.view.webContents.goBack(); return true; }
    GoForward() { if (!this.view?.webContents.canGoForward())
        return false; this.view.webContents.goForward(); return true; }
    Reload() { if (!this.view || this.view.webContents.isDestroyed())
        return false; this.view.webContents.reload(); return true; }
    Destroy() {
        this.Hide();
        if (this.view && !this.view.webContents.isDestroyed())
            this.view.webContents.close();
        this.view = null;
    }
}
exports.BrowserPanelHost = BrowserPanelHost;
/** 内嵌浏览器 IPC：复用主窗口来源校验，再校验每一项高风险输入。 */
function RegisterBrowserPanel({ host, webContentsGetter, ipcMainApi = electron_1.ipcMain }) {
    const IsValidSender = (event) => (0, gateway_1.ValidateSender)(event, webContentsGetter);
    ipcMainApi.handle(BrowserChannels[0], (event, bounds) => {
        const window = webContentsGetter();
        const safeBounds = window && IsValidSender(event) ? (0, browser_policy_1.NormalizeBrowserBounds)(bounds, window.getContentSize()) : null;
        return { shown: Boolean(safeBounds && host.Show(safeBounds)) };
    });
    ipcMainApi.handle(BrowserChannels[1], (event) => ({ hidden: IsValidSender(event) && host.Hide() }));
    ipcMainApi.handle(BrowserChannels[2], (event, address) => IsValidSender(event) ? host.Navigate(address) : { accepted: false, reason: '浏览器请求来源无效。' });
    ipcMainApi.handle(BrowserChannels[3], (event) => ({ navigated: IsValidSender(event) && host.GoBack() }));
    ipcMainApi.handle(BrowserChannels[4], (event) => ({ navigated: IsValidSender(event) && host.GoForward() }));
    ipcMainApi.handle(BrowserChannels[5], (event) => ({ reloaded: IsValidSender(event) && host.Reload() }));
}
