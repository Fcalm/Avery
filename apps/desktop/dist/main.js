"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const electron_1 = require("electron");
const node_fs_1 = require("node:fs");
const node_crypto_1 = require("node:crypto");
const node_path_1 = require("node:path");
const host_1 = require("@offerget/backend/dist/host");
const adapters_1 = require("./adapters");
const gateway_1 = require("./gateway");
const smokeStartedAt = Date.now();
let mainWindow;
let backendHost;
let rendererLoaded = false;
let lifecycleRunning = false;
let lifecycleStep = null;
const consoleErrors = [];
function writeSmokeStage(stage, extra = {}) {
    const output = process.env.OFFERGET_SMOKE_RESULT_PATH;
    if (process.env.OFFERGET_DESKTOP_SMOKE === '1' && output)
        (0, node_fs_1.writeFileSync)(output, JSON.stringify({ stage, electron: process.versions.electron, ...extra }), 'utf8');
}
writeSmokeStage('main_loaded');
/** 默认拒绝权限、弹窗和导航；桌面能力只能经 preload/Gateway 调用。 */
function configureSecurityPolicies() {
    electron_1.session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    electron_1.session.defaultSession.setPermissionCheckHandler(() => false);
    electron_1.app.on('web-contents-created', (_event, contents) => {
        contents.setWindowOpenHandler(() => ({ action: 'deny' }));
        contents.on('will-navigate', (event) => event.preventDefault());
    });
}
/** 创建唯一主窗口，明确维持 Renderer 与 Node/Electron 能力隔离。 */
function createWindow() {
    const window = new electron_1.BrowserWindow({
        width: 1440, height: 960, minWidth: 1024, minHeight: 680, frame: false, autoHideMenuBar: true, backgroundColor: '#F6F1E6',
        webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, preload: (0, node_path_1.join)(__dirname, '..', '..', '..', 'electron', 'preload.cjs') },
    });
    mainWindow = window;
    window.setMenuBarVisibility(false);
    if (electron_1.app.isPackaged || process.env.OFFERGET_DESKTOP_SMOKE === '1')
        void window.loadFile((0, node_path_1.join)(__dirname, '..', '..', '..', 'dist', 'index.html'));
    else
        void window.loadURL(process.env.VITE_DEV_SERVER_URL || 'http://127.0.0.1:5173');
    window.webContents.once('did-finish-load', () => { rendererLoaded = true; });
    window.webContents.on('console-message', (_event, level, message) => { if (level >= 3)
        consoleErrors.push(String(message).slice(0, 300)); });
    return window;
}
async function callBackend(channel, ...args) {
    lifecycleStep = channel;
    if (!backendHost)
        throw new Error('Backend host is unavailable.');
    const result = await backendHost.Command(channel, undefined, ...args);
    if (!result.ok)
        throw Object.assign(new Error(`Lifecycle command failed: ${channel}${result.error?.message ? ` (${result.error.message})` : ''}`), { code: result.error?.code || 'INTERNAL_ERROR' });
    return result.data;
}
/** 安装生命周期冒烟：恢复模式无凭据，seed/verify 继续覆盖持久化的关键事实。 */
async function runLifecycleScenario(mode, userDataPath, workspacePath) {
    if (mode === 'recovery') {
        const recovery = await callBackend('workspace:database-recovery-status');
        return { mode, recoveryReadOnly: recovery.readOnly === true, recoveryCanRestore: recovery.canRestore === true, recoveryMode: recovery.mode };
    }
    const fixturePath = process.env.OFFERGET_LIFECYCLE_ATTACHMENT;
    const apiKey = process.env.OFFERGET_LIFECYCLE_API_KEY;
    if (!apiKey)
        throw new Error('Lifecycle smoke credential is missing.');
    if (mode === 'seed') {
        if (!fixturePath || !(0, node_fs_1.existsSync)(fixturePath))
            throw new Error('Lifecycle attachment fixture is missing.');
        await callBackend('workspace:save-settings', { nickname: '生命周期验收用户', developerMode: true, onboardingCompleted: true });
        await callBackend('agent:configure', { provider: 'DeepSeek', model: 'deepseek-v4-flash', apiKey, contextLength: 64000, compressionThreshold: 80 });
        await callBackend('workspace:profiles-save', [{ id: 'lifecycle-profile', category: 'project', title: '生命周期档案', content: '确定性测试内容', updatedAt: Date.now() }]);
        await callBackend('workspace:resumes-upsert', { id: 'lifecycle-resume', name: '生命周期简历', targetRoles: ['前端工程师'], summary: '第一版', content: '第一版正文' });
        await callBackend('workspace:resumes-upsert', { id: 'lifecycle-resume', name: '生命周期简历', targetRoles: ['前端工程师'], summary: '第二版', content: '第二版正文' });
        await callBackend('workspace:jobs-upsert', { id: 'lifecycle-job', company: '验收公司', title: '前端工程师', city: '上海', experience: '3年', employmentType: 'full_time', channel: 'company_website', favorite: true, jd: '确定性 JD' });
        await callBackend('workspace:applications-upsert', { id: 'lifecycle-application', jobId: 'lifecycle-job', resumeId: 'lifecycle-resume', status: 'applied', note: '生命周期验收' });
        await callBackend('workspace:import-attachment', fixturePath, 'text/plain');
        await callBackend('workspace:create-backup');
    }
    const status = await callBackend('workspace:status');
    const view = await callBackend('workspace:get-view-model');
    const profiles = await callBackend('workspace:get-profiles');
    const settings = await callBackend('workspace:get-settings');
    const revisions = await callBackend('workspace:get-resume-revisions', 'lifecycle-resume');
    let provider = await callBackend('agent:status');
    if (!provider.configured && mode === 'verify') {
        await callBackend('agent:configure', { provider: 'DeepSeek', model: 'deepseek-v4-flash', apiKey, contextLength: 64000, compressionThreshold: 80 });
        provider = await callBackend('agent:status');
    }
    const resume = (view.resumes ?? []).find((item) => typeof item === 'object' && item !== null && item.id === 'lifecycle-resume');
    if (!resume)
        throw new Error('Lifecycle resume is unavailable.');
    const exports = {};
    for (const format of ['docx', 'pdf', 'png']) {
        const exported = await callBackend('workspace:export-resume', resume, format);
        exports[format] = exported.exported === true && typeof exported.fileName === 'string';
    }
    const credentialPath = (0, node_path_1.join)(userDataPath, 'agent-config.json');
    const credentialText = (0, node_fs_1.existsSync)(credentialPath) ? (0, node_fs_1.readFileSync)(credentialPath, 'utf8') : '';
    const attachmentSha256 = fixturePath && (0, node_fs_1.existsSync)(fixturePath) ? (0, node_crypto_1.createHash)('sha256').update((0, node_fs_1.readFileSync)(fixturePath)).digest('hex') : null;
    const storedAttachment = attachmentSha256 ? (0, node_path_1.join)(workspacePath, 'attachments', attachmentSha256) : null;
    const backups = (0, node_fs_1.existsSync)((0, node_path_1.join)(workspacePath, 'backups')) ? (0, node_fs_1.readdirSync)((0, node_path_1.join)(workspacePath, 'backups')).filter((name) => name.startsWith('daily-')).length : 0;
    return { mode, schemaVersion: status.metadata?.schema_version, integrity: status.integrity, counts: { conversations: view.conversations?.length ?? 0, resumes: view.resumes?.length ?? 0, jobs: view.jobs?.length ?? 0, applications: view.applications?.length ?? 0, profiles: profiles.items?.length ?? 0 }, resumeRevision: resume.revision, resumeRevisionCount: revisions.length, onboardingCompleted: settings.onboardingCompleted === true, attachmentPreserved: Boolean(storedAttachment && (0, node_fs_1.existsSync)(storedAttachment)), providerConfigured: provider.configured === true && provider.model === 'deepseek-v4-flash', credentialEncrypted: credentialText.includes('encryptedApiKey') && !credentialText.includes(apiKey), backups, exports };
}
async function runInstalledVisualScenario(outputDirectory) {
    const window = mainWindow;
    if (!window)
        throw new Error('Main window is unavailable.');
    (0, node_fs_1.mkdirSync)(outputDirectory, { recursive: true });
    window.setContentSize(1280, 800);
    const ready = await window.webContents.executeJavaScript(`new Promise((resolve)=>{const end=Date.now()+5000;const wait=()=>document.querySelector('nav button')?resolve(true):Date.now()>=end?resolve(false):setTimeout(wait,50);wait();})`, true);
    const image = await window.webContents.capturePage();
    (0, node_fs_1.writeFileSync)((0, node_path_1.join)(outputDirectory, 'installed-home-1280x800.png'), image.toPNG());
    return { rendererNavigationReady: ready === true, consoleErrors, width: 1280, height: 800, passed: ready === true && consoleErrors.length === 0 };
}
if (process.env.OFFERGET_DESKTOP_SMOKE === '1' && process.env.OFFERGET_SMOKE_USER_DATA)
    electron_1.app.setPath('userData', (0, node_path_1.resolve)(process.env.OFFERGET_SMOKE_USER_DATA));
electron_1.app.whenReady().then(() => {
    writeSmokeStage('electron_ready');
    configureSecurityPolicies();
    const userDataPath = electron_1.app.getPath('userData');
    const workspacePath = (0, node_path_1.join)(userDataPath, 'OfferGet Workspace');
    const adapters = (0, adapters_1.CreateDesktopAdapters)({ getWindow: () => mainWindow, userDataPath });
    backendHost = (0, host_1.CreateBackendHost)({ appContext: { userDataPath, defaultWorkspacePath: workspacePath, workspacePath }, desktopCapabilities: adapters });
    (0, gateway_1.RegisterGateway)({ backendHost, webContentsGetter: () => mainWindow });
    (0, gateway_1.RegisterWindowControls)({ webContentsGetter: () => mainWindow });
    electron_1.Menu.setApplicationMenu(null);
    createWindow();
    if (process.env.OFFERGET_DESKTOP_SMOKE !== '1')
        return;
    const deadline = Date.now() + 15000;
    const timer = setInterval(async () => {
        if (rendererLoaded && backendHost?.state() === 'ready') {
            if (lifecycleRunning)
                return;
            lifecycleRunning = true;
            clearInterval(timer);
            try {
                const mode = process.env.OFFERGET_LIFECYCLE_MODE;
                lifecycleStep = mode ? `starting:${mode}` : 'completed';
                const lifecycle = mode ? await runLifecycleScenario(mode, userDataPath, workspacePath) : undefined;
                const visual = process.env.OFFERGET_INSTALLED_VISUAL_OUTPUT ? await runInstalledVisualScenario((0, node_path_1.resolve)(process.env.OFFERGET_INSTALLED_VISUAL_OUTPUT)) : undefined;
                const result = { rendererLoaded: true, backendReady: true, electron: process.versions.electron, startupReadyMs: Date.now() - smokeStartedAt, ...(lifecycle ? { lifecycle } : {}), ...(visual ? { installedVisual: visual } : {}) };
                writeSmokeStage('ready', result);
                console.log(JSON.stringify(result));
                electron_1.app.quit();
            }
            catch (error) {
                const message = String(error instanceof Error ? error.message : 'Lifecycle smoke failed.').replaceAll(userDataPath, '[USER_DATA]').replace(/[A-Za-z]:\\[^\r\n]+/g, '[PATH]').slice(0, 240);
                const result = { rendererLoaded, backendState: backendHost?.state(), electron: process.versions.electron, lifecycleError: error instanceof Error && 'code' in error ? String(error.code) : 'INTERNAL_ERROR', lifecycleErrorMessage: message, lifecycleStep };
                writeSmokeStage('failed', result);
                console.error(JSON.stringify(result));
                electron_1.app.exit(1);
            }
        }
        else if (Date.now() >= deadline) {
            clearInterval(timer);
            const result = { rendererLoaded, backendState: backendHost?.state(), electron: process.versions.electron };
            writeSmokeStage('failed', result);
            console.error(JSON.stringify(result));
            electron_1.app.exit(1);
        }
    }, 100);
});
electron_1.app.on('activate', () => { if (electron_1.BrowserWindow.getAllWindows().length === 0)
    createWindow(); });
electron_1.app.on('window-all-closed', () => { if (process.platform !== 'darwin')
    electron_1.app.quit(); });
electron_1.app.on('before-quit', () => { backendHost?.Shutdown(); });
