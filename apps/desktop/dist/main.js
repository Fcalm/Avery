"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
// @ts-nocheck
const { app, BrowserWindow, Menu, session } = require('electron');
const crypto = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs');
const SmokeStartedAt = Date.now();
const WriteSmokeStage = (stage, extra = {}) => {
    if (process.env.OFFERGET_DESKTOP_SMOKE === '1' && process.env.OFFERGET_SMOKE_RESULT_PATH)
        fs.writeFileSync(process.env.OFFERGET_SMOKE_RESULT_PATH, JSON.stringify({ stage, electron: process.versions.electron, ...extra }), 'utf8');
};
WriteSmokeStage('main_loaded');
const { CreateBackendHost } = require('../../backend/dist/host.js');
WriteSmokeStage('backend_host_loaded');
const { RegisterGateway, RegisterWindowControls } = require('./gateway.js');
const { CreateDesktopAdapters } = require('./adapters.js');
WriteSmokeStage('desktop_modules_loaded');
let MainWindow;
let BackendHost;
let DesktopAdapters;
let RendererLoaded = false;
let LifecycleRunning = false;
let LifecycleStep = null;
const InstalledVisualConsoleErrors = [];
// 发布包冒烟使用隔离的临时 userData，避免启动验证写入真实用户目录。
if (process.env.OFFERGET_DESKTOP_SMOKE === '1' && process.env.OFFERGET_SMOKE_USER_DATA)
    app.setPath('userData', path.resolve(process.env.OFFERGET_SMOKE_USER_DATA));
/** 默认拒绝权限、弹窗和跨页面导航；桌面能力只允许走受限 preload/Gateway。 */
function ConfigureSecurityPolicies() {
    session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
    session.defaultSession.setPermissionCheckHandler(() => false);
    app.on('web-contents-created', (_event, contents) => {
        contents.setWindowOpenHandler(() => ({ action: 'deny' }));
        // Renderer 通过 IPC 驱动单页状态，不需要完整页面导航。尤其 file:// URL 的
        // origin 都是 null，不能以“同源”判断放行任意本地文件。
        contents.on('will-navigate', (navigationEvent) => navigationEvent.preventDefault());
    });
}
/** 创建并加载桌面端主窗口。 */
function CreateWindow() {
    MainWindow = new BrowserWindow({
        width: 1440,
        height: 960,
        minWidth: 1024,
        minHeight: 680,
        // Windows 对 titleBarOverlay 的支持会因系统/运行环境回退为原生标题栏。
        // 使用无边框窗口，由渲染层提供唯一的应用栏与安全代理的窗口控制。
        frame: false,
        autoHideMenuBar: true,
        backgroundColor: '#F6F1E6',
        webPreferences: {
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
            preload: path.join(__dirname, '..', '..', '..', 'electron', 'preload.cjs'),
        },
    });
    MainWindow.setMenuBarVisibility(false);
    if (app.isPackaged || process.env.OFFERGET_DESKTOP_SMOKE === '1') {
        MainWindow.loadFile(path.join(__dirname, '..', '..', '..', 'dist', 'index.html'));
    }
    else {
        MainWindow.loadURL(process.env.VITE_DEV_SERVER_URL || 'http://127.0.0.1:5173');
    }
    MainWindow.webContents.once('did-finish-load', () => { RendererLoaded = true; });
    MainWindow.webContents.on('console-message', (_event, level, message) => { if (level >= 3)
        InstalledVisualConsoleErrors.push(String(message).slice(0, 300)); });
}
/** 安装版本关键页面复验：使用真实 BrowserWindow、生产 Renderer 与 Backend，只注入确定性本地数据。 */
async function RunInstalledVisualScenario(outputDirectory) {
    fs.mkdirSync(outputDirectory, { recursive: true });
    MainWindow.setContentSize(1280, 800);
    const records = [];
    const Run = (source) => MainWindow.webContents.executeJavaScript(source, true);
    await Run(`new Promise((resolve) => { const deadline=Date.now()+5000; const wait=()=>{ if(document.querySelector('nav button')) return resolve(true); if(Date.now()>=deadline) return resolve(false); setTimeout(wait,50); }; wait(); })`);
    async function Capture(name, navigationScript) {
        const startedAt = Date.now();
        let navigationError = null;
        try {
            await Run(`(() => { ${navigationScript} })()`);
        }
        catch (error) {
            navigationError = error instanceof Error ? error.message : String(error);
        }
        await new Promise((resolve) => setTimeout(resolve, 80));
        const metrics = await Run(`(() => ({ heading: document.querySelector('h1,h2')?.textContent?.trim() || '', horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth || document.body.scrollWidth > document.body.clientWidth, width: innerWidth, height: innerHeight }))()`);
        const navigationMs = Date.now() - startedAt;
        fs.writeFileSync(path.join(outputDirectory, `installed-${name}-1280x800.png`), (await MainWindow.webContents.capturePage()).toPNG());
        records.push({ name, navigationMs, navigationError, ...metrics });
    }
    await Capture('assistant', `const button=[...document.querySelectorAll('nav button')].find((item)=>item.textContent.includes('求职助手')); if(!button) throw new Error('assistant navigation missing'); button.click();`);
    await Capture('jobs', `const button=[...document.querySelectorAll('nav button')].find((item)=>item.textContent.includes('岗位库')); if(!button) throw new Error('jobs navigation missing'); button.click();`);
    await Capture('settings', `const trigger=document.querySelector('.sidebar-user-trigger'); trigger?.focus(); const button=[...document.querySelectorAll('.user-flyout button')].find((item)=>item.textContent.includes('设置')); if(!button) throw new Error('settings navigation missing'); button.click();`);
    return { records, consoleErrors: InstalledVisualConsoleErrors, passed: records.every((item) => !item.navigationError && !item.horizontalOverflow && item.navigationMs <= 500 && item.width === 1280 && Math.abs(item.height - 800) <= 1) && InstalledVisualConsoleErrors.length === 0 };
}
/** 仅供安装生命周期 smoke：经真实 BackendHost/Gateway 边界写入并读取确定性业务数据。 */
async function RunLifecycleScenario(mode, userDataPath, workspacePath) {
    const Call = async (channel, ...args) => {
        LifecycleStep = channel;
        let result;
        try {
            result = await BackendHost.Command(channel, ...args);
        }
        catch (error) {
            const detail = error instanceof Error ? error.message : 'unknown execution error';
            throw Object.assign(new Error(`Lifecycle command threw: ${channel} (${detail})`), { code: 'INTERNAL_ERROR', lifecycleStep: channel });
        }
        if (!result?.ok) {
            const detail = typeof result?.error?.message === 'string' ? ` (${result.error.message})` : '';
            throw Object.assign(new Error(`Lifecycle command failed: ${channel}${detail}`), { code: result?.error?.code || 'INTERNAL_ERROR', lifecycleStep: channel });
        }
        return result.data;
    };
    if (mode === 'recovery') {
        const recovery = await Call('workspace:database-recovery-status');
        return { mode, recoveryReadOnly: recovery.readOnly === true, recoveryCanRestore: recovery.canRestore === true, recoveryMode: recovery.mode };
    }
    const fixturePath = process.env.OFFERGET_LIFECYCLE_ATTACHMENT;
    const apiKey = process.env.OFFERGET_LIFECYCLE_API_KEY;
    if (!apiKey)
        throw new Error('Lifecycle smoke credential is missing.');
    if (mode === 'seed') {
        if (!fixturePath || !fs.existsSync(fixturePath))
            throw new Error('Lifecycle attachment fixture is missing.');
        await Call('workspace:save-settings', { nickname: '生命周期验收用户', developerMode: true, onboardingCompleted: true });
        await Call('agent:configure', { provider: 'DeepSeek', model: 'deepseek-v4-flash', apiKey, contextLength: 64000, compressionThreshold: 80 });
        await Call('workspace:profiles-save', [{ id: 'lifecycle-profile', category: 'project', title: '生命周期档案', content: '确定性测试内容', updatedAt: Date.now() }]);
        await Call('workspace:resumes-upsert', { id: 'lifecycle-resume', name: '生命周期简历', targetRoles: ['前端工程师'], summary: '第一版', content: '第一版正文' });
        await Call('workspace:resumes-upsert', { id: 'lifecycle-resume', name: '生命周期简历', targetRoles: ['前端工程师'], summary: '第二版', content: '第二版正文' });
        await Call('workspace:jobs-upsert', { id: 'lifecycle-job', company: '验收公司', title: '前端工程师', city: '上海', experience: '3年', employmentType: 'full_time', channel: 'company_website', favorite: true, jd: '确定性 JD' });
        await Call('workspace:applications-upsert', { id: 'lifecycle-application', jobId: 'lifecycle-job', resumeId: 'lifecycle-resume', status: 'applied', note: '生命周期验收' });
        const largeAttachmentStartedAt = Date.now();
        await Call('workspace:import-attachment', fixturePath, 'text/plain');
        var largeAttachmentImportMs = Date.now() - largeAttachmentStartedAt;
        await Call('workspace:create-backup');
    }
    const status = await Call('workspace:status');
    const view = await Call('workspace:get-view-model');
    const storedSettings = await Call('workspace:get-settings');
    const profiles = await Call('workspace:get-profiles');
    const revisions = await Call('workspace:get-resume-revisions', 'lifecycle-resume');
    let provider = await Call('agent:status');
    if (!provider.configured && mode === 'verify') {
        await Call('agent:configure', { provider: 'DeepSeek', model: 'deepseek-v4-flash', apiKey, contextLength: 64000, compressionThreshold: 80 });
        provider = await Call('agent:status');
    }
    const resume = view.resumes.find((item) => item.id === 'lifecycle-resume');
    if (!resume)
        throw new Error('Lifecycle resume is unavailable.');
    const exported = {};
    const exportMs = {};
    for (const format of ['docx', 'pdf', 'png']) {
        const exportStartedAt = Date.now();
        exported[format] = await Call('workspace:export-resume', resume, format);
        exportMs[format] = Date.now() - exportStartedAt;
    }
    const attachmentSha256 = fixturePath && fs.existsSync(fixturePath)
        ? crypto.createHash('sha256').update(fs.readFileSync(fixturePath)).digest('hex')
        : null;
    const storedAttachment = attachmentSha256 ? path.join(workspacePath, 'attachments', attachmentSha256) : null;
    const credentialPath = path.join(userDataPath, 'agent-config.json');
    const credentialText = fs.existsSync(credentialPath) ? fs.readFileSync(credentialPath, 'utf8') : '';
    const backupNames = fs.existsSync(path.join(workspacePath, 'backups')) ? fs.readdirSync(path.join(workspacePath, 'backups')).filter((name) => name.startsWith('daily-')) : [];
    return {
        mode,
        schemaVersion: status.metadata?.schema_version,
        integrity: status.integrity,
        counts: { conversations: view.conversations.length, resumes: view.resumes.length, jobs: view.jobs.length, applications: view.applications.length, profiles: profiles.items.length },
        resumeRevision: resume.revision,
        resumeRevisionCount: revisions.length,
        profileHash: profiles.hash,
        onboardingCompleted: storedSettings.onboardingCompleted === true,
        attachmentSha256,
        attachmentPreserved: Boolean(storedAttachment && fs.existsSync(storedAttachment) && crypto.createHash('sha256').update(fs.readFileSync(storedAttachment)).digest('hex') === attachmentSha256),
        providerConfigured: provider.configured === true && provider.model === 'deepseek-v4-flash',
        credentialEncrypted: credentialText.includes('encryptedApiKey') && !credentialText.includes(apiKey),
        backups: backupNames.length,
        exports: Object.fromEntries(Object.entries(exported).map(([format, value]) => [format, value?.exported === true && typeof value?.fileName === 'string'])),
        performance: { largeAttachmentBytes: attachmentSha256 && fixturePath ? fs.statSync(fixturePath).size : 0, largeAttachmentImportMs: largeAttachmentImportMs ?? null, exportMs },
    };
}
app.whenReady().then(() => {
    WriteSmokeStage('electron_ready');
    ConfigureSecurityPolicies();
    const userDataPath = app.getPath('userData');
    const defaultWorkspacePath = path.join(userDataPath, 'OfferGet Workspace');
    DesktopAdapters = CreateDesktopAdapters({ getWindow: () => MainWindow, userDataPath });
    BackendHost = CreateBackendHost({
        appContext: { userDataPath, defaultWorkspacePath, workspacePath: defaultWorkspacePath },
        desktopCapabilities: DesktopAdapters,
    });
    RegisterGateway({ backendHost: BackendHost, webContentsGetter: () => MainWindow });
    RegisterWindowControls({ webContentsGetter: () => MainWindow });
    Menu.setApplicationMenu(null);
    CreateWindow();
    if (process.env.OFFERGET_DESKTOP_SMOKE === '1') {
        const deadline = Date.now() + 15000;
        const timer = setInterval(async () => {
            if (RendererLoaded && BackendHost?.state() === 'ready') {
                if (LifecycleRunning)
                    return;
                LifecycleRunning = true;
                clearInterval(timer);
                try {
                    const startupReadyMs = Date.now() - SmokeStartedAt;
                    const lifecycleMode = process.env.OFFERGET_LIFECYCLE_MODE;
                    LifecycleStep = lifecycleMode ? `starting:${lifecycleMode}` : 'lifecycle:skipped';
                    const lifecycle = lifecycleMode ? await RunLifecycleScenario(lifecycleMode, userDataPath, defaultWorkspacePath) : undefined;
                    LifecycleStep = process.env.OFFERGET_INSTALLED_VISUAL_OUTPUT ? 'installed-visual' : 'completed';
                    const installedVisual = process.env.OFFERGET_INSTALLED_VISUAL_OUTPUT ? await RunInstalledVisualScenario(path.resolve(process.env.OFFERGET_INSTALLED_VISUAL_OUTPUT)) : undefined;
                    const result = { rendererLoaded: true, backendReady: true, electron: process.versions.electron, startupReadyMs, ...(lifecycle ? { lifecycle } : {}), ...(installedVisual ? { installedVisual } : {}) };
                    WriteSmokeStage('ready', result);
                    console.log(JSON.stringify(result));
                    app.quit();
                }
                catch (error) {
                    const safeMessage = String(error?.message || 'Lifecycle smoke failed.').replaceAll(userDataPath, '[USER_DATA]').replace(/[A-Za-z]:\\[^\r\n]+/g, '[PATH]').slice(0, 240);
                    const result = { rendererLoaded: RendererLoaded, backendState: BackendHost?.state(), electron: process.versions.electron, lifecycleError: error?.code || 'INTERNAL_ERROR', lifecycleErrorMessage: safeMessage, lifecycleStep: LifecycleStep };
                    WriteSmokeStage('failed', result);
                    console.error(JSON.stringify(result));
                    app.exit(1);
                }
            }
            else if (Date.now() >= deadline) {
                clearInterval(timer);
                const result = { rendererLoaded: RendererLoaded, backendState: BackendHost?.state(), electron: process.versions.electron };
                WriteSmokeStage('failed', result);
                console.error(JSON.stringify(result));
                app.exit(1);
            }
        }, 100);
    }
    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0)
            CreateWindow();
    });
});
app.on('window-all-closed', () => {
    if (process.platform !== 'darwin')
        app.quit();
});
app.on('before-quit', () => {
    BackendHost?.Shutdown();
});
