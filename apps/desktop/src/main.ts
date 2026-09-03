import { app, BrowserWindow, Menu, session } from 'electron';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { CreateBackendHost } from '@avery/backend/dist/host';
import { CreateDesktopAdapters } from './adapters';
import { RegisterGateway, RegisterWindowControls } from './gateway';
import { IsBrowserCompanionProcess, StartBrowserCompanion } from './browser-companion';
import { MigrateLegacyUserData } from './brand-migration';

const smokeStartedAt = Date.now();
let mainWindow: BrowserWindow | undefined;
let backendHost: ReturnType<typeof CreateBackendHost> | undefined;
let rendererLoaded = false;
let lifecycleRunning = false;
let lifecycleStep: string | null = null;
const consoleErrors: string[] = [];

/** 仅解析应用固定依赖中的原生 CLI，不回退到 PATH 或用户全局安装。 */
function resolveAgentBrowserExecutablePath(): string {
  const binaryName = process.platform === 'win32'
    ? `agent-browser-win32-${process.arch}.exe`
    : `agent-browser-${process.platform === 'darwin' ? 'darwin' : 'linux'}-${process.arch}`;
  const candidates = app.isPackaged
    ? [join(process.resourcesPath, 'app.asar.unpacked', 'node_modules', 'agent-browser', 'bin', binaryName)]
    : [join(__dirname, '..', '..', '..', 'node_modules', 'agent-browser', 'bin', binaryName)];
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0];
}

function writeSmokeStage(stage: string, extra: Record<string, unknown> = {}): void {
  const output = process.env.AVERY_SMOKE_RESULT_PATH;
  if (process.env.AVERY_DESKTOP_SMOKE === '1' && output) writeFileSync(output, JSON.stringify({ stage, electron: process.versions.electron, ...extra }), 'utf8');
}
/** 默认拒绝权限、弹窗和导航；桌面能力只能经 preload/Gateway 调用。 */
function configureSecurityPolicies(): void {
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  app.on('web-contents-created', (_event, contents) => {
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    contents.on('will-navigate', (event) => event.preventDefault());
  });
}

/** 创建唯一主窗口，明确维持 Renderer 与 Node/Electron 能力隔离。 */
function createWindow(): BrowserWindow {
  // Acrylic 负责模糊桌面，Renderer 只提供半透明浅绿染色层。
  const useWindowsTransparency = process.platform === 'win32';
  const window = new BrowserWindow({
    width: 1440, height: 960, minWidth: 1024, minHeight: 680, frame: false, autoHideMenuBar: true,
    backgroundColor: useWindowsTransparency ? '#00000000' : '#F6F1E6',
    ...(useWindowsTransparency ? { transparent: true, backgroundMaterial: 'acrylic' as const } : {}),
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, preload: join(__dirname, '..', '..', '..', 'electron', 'preload.cjs') },
  });
  mainWindow = window;
  window.setMenuBarVisibility(false);
  if (app.isPackaged || process.env.AVERY_DESKTOP_SMOKE === '1') void window.loadFile(join(__dirname, '..', '..', '..', 'dist', 'index.html'));
  else void window.loadURL(process.env.VITE_DEV_SERVER_URL || 'http://127.0.0.1:5173');
  window.webContents.once('did-finish-load', () => { rendererLoaded = true; });
  window.webContents.on('console-message', (_event, level, message) => { if (level >= 3) consoleErrors.push(String(message).slice(0, 300)); });
  window.on('closed', () => { if (mainWindow === window) mainWindow = undefined; });
  return window;
}

type CommandFailure = { ok: false; error?: { code?: string; message?: string } };
type CommandSuccess = { ok: true; data?: unknown };
async function callBackend(channel: string, ...args: unknown[]): Promise<unknown> {
  lifecycleStep = channel;
  if (!backendHost) throw new Error('Backend host is unavailable.');
  const result = await backendHost.Command(channel, undefined, ...args) as CommandFailure | CommandSuccess;
  if (!result.ok) throw Object.assign(new Error(`Lifecycle command failed: ${channel}${result.error?.message ? ` (${result.error.message})` : ''}`), { code: result.error?.code || 'INTERNAL_ERROR' });
  return result.data;
}

/** 等待 Utility Process 就绪后执行到期任务；后台启动路径不创建/聚焦窗口。 */
async function runDueCronTasksWhenReady(quitAfter: boolean): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (backendHost?.state() !== 'ready') {
    if (Date.now() >= deadline) throw new Error('Backend was not ready for CronTask execution.');
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  await callBackend('cron:run-due');
  if (quitAfter) app.quit();
}

/** 从隔离 Renderer 经 preload/IPC 读取 AgentHost 状态，避免桌面冒烟只验证 Main 直连 Backend。 */
async function probeRendererAgentIpc(): Promise<{ agentStatus: boolean; browserRuntimeStatus: boolean }> {
  const window = mainWindow;
  if (!window || window.isDestroyed()) throw new Error('Main window is unavailable for Renderer Agent IPC probe.');
  return window.webContents.executeJavaScript(`(async () => {
    const agent = globalThis.averyAgent;
    if (!agent) return { agentStatus: false, browserRuntimeStatus: false };
    const [status, browser] = await Promise.all([agent.GetStatus(), agent.GetBrowserRuntimeStatus()]);
    return {
      agentStatus: Boolean(status && status.ok === true && status.data && typeof status.data.configured === 'boolean'),
      browserRuntimeStatus: Boolean(browser && browser.ok === true && browser.data && typeof browser.data.available === 'boolean'),
    };
  })()`, true) as Promise<{ agentStatus: boolean; browserRuntimeStatus: boolean }>;
}

/** 安装生命周期冒烟：恢复模式无凭据，seed/verify 继续覆盖持久化的关键事实。 */
async function runLifecycleScenario(mode: string, userDataPath: string, workspacePath: string): Promise<Record<string, unknown>> {
  if (mode === 'recovery') {
    const recovery = await callBackend('workspace:database-recovery-status') as { readOnly?: boolean; canRestore?: boolean; mode?: string };
    return { mode, recoveryReadOnly: recovery.readOnly === true, recoveryCanRestore: recovery.canRestore === true, recoveryMode: recovery.mode };
  }
  const fixturePath = process.env.AVERY_LIFECYCLE_ATTACHMENT;
  const apiKey = process.env.AVERY_LIFECYCLE_API_KEY;
  if (!apiKey) throw new Error('Lifecycle smoke credential is missing.');
  if (mode === 'seed') {
    if (!fixturePath || !existsSync(fixturePath)) throw new Error('Lifecycle attachment fixture is missing.');
    await callBackend('workspace:save-settings', { nickname: '生命周期验收用户', developerMode: true, onboardingCompleted: true });
    await callBackend('agent:configure', { provider: 'DeepSeek', model: 'deepseek-v4-flash', apiKey, contextLength: '256K', contextLimitMode: 'default', compressionThreshold: 80 });
    await callBackend('workspace:profiles-save', [{ id: 'lifecycle-profile', category: 'project', title: '生命周期档案', content: '确定性测试内容', updatedAt: Date.now() }]);
    await callBackend('workspace:resumes-upsert', { id: 'lifecycle-resume', name: '生命周期简历', targetRoles: ['前端工程师'], summary: '第一版', content: '第一版正文' });
    await callBackend('workspace:resumes-upsert', { id: 'lifecycle-resume', name: '生命周期简历', targetRoles: ['前端工程师'], summary: '第二版', content: '第二版正文' });
    await callBackend('workspace:jobs-upsert', { id: 'lifecycle-job', company: '验收公司', title: '前端工程师', city: '上海', experience: '3年', employmentType: 'full_time', channel: 'company_website', favorite: true, jd: '确定性 JD' });
    await callBackend('workspace:applications-upsert', { id: 'lifecycle-application', jobId: 'lifecycle-job', resumeId: 'lifecycle-resume', status: 'applied', note: '生命周期验收' });
    await callBackend('workspace:import-attachment', fixturePath, 'text/plain');
    await callBackend('workspace:create-backup');
  }
  const status = await callBackend('workspace:status') as { metadata?: { schema_version?: number }; integrity?: string };
  const view = await callBackend('workspace:get-view-model') as { conversations?: unknown[]; resumes?: unknown[]; jobs?: unknown[]; applications?: unknown[] };
  const profiles = await callBackend('workspace:get-profiles') as { items?: unknown[] };
  const settings = await callBackend('workspace:get-settings') as { onboardingCompleted?: boolean };
  const revisions = await callBackend('workspace:get-resume-revisions', 'lifecycle-resume') as unknown[];
  let provider = await callBackend('agent:status') as { configured?: boolean; model?: string };
  if (!provider.configured && mode === 'verify') {
    await callBackend('agent:configure', { provider: 'DeepSeek', model: 'deepseek-v4-flash', apiKey, contextLength: '256K', contextLimitMode: 'default', compressionThreshold: 80 });
    provider = await callBackend('agent:status') as { configured?: boolean; model?: string };
  }
  const resume = (view.resumes ?? []).find((item): item is { id: string; name: string; summary: string; content: string; revision?: number } => typeof item === 'object' && item !== null && (item as { id?: unknown }).id === 'lifecycle-resume');
  if (!resume) throw new Error('Lifecycle resume is unavailable.');
  const exports: Record<string, boolean> = {};
  for (const format of ['docx', 'pdf', 'png'] as const) {
    const exported = await callBackend('workspace:export-resume', resume, format) as { exported?: boolean; fileName?: string };
    exports[format] = exported.exported === true && typeof exported.fileName === 'string';
  }
  const credentialPath = join(userDataPath, 'agent-config.json');
  const credentialText = existsSync(credentialPath) ? readFileSync(credentialPath, 'utf8') : '';
  const attachmentSha256 = fixturePath && existsSync(fixturePath) ? createHash('sha256').update(readFileSync(fixturePath)).digest('hex') : null;
  const storedAttachment = attachmentSha256 ? join(workspacePath, 'attachments', attachmentSha256) : null;
  const backups = existsSync(join(workspacePath, 'backups')) ? readdirSync(join(workspacePath, 'backups')).filter((name) => name.startsWith('daily-')).length : 0;
  return { mode, schemaVersion: status.metadata?.schema_version, integrity: status.integrity, counts: { conversations: view.conversations?.length ?? 0, resumes: view.resumes?.length ?? 0, jobs: view.jobs?.length ?? 0, applications: view.applications?.length ?? 0, profiles: profiles.items?.length ?? 0 }, resumeRevision: resume.revision, resumeRevisionCount: revisions.length, onboardingCompleted: settings.onboardingCompleted === true, attachmentPreserved: Boolean(storedAttachment && existsSync(storedAttachment)), providerConfigured: provider.configured === true && provider.model === 'deepseek-v4-flash', credentialEncrypted: credentialText.includes('encryptedApiKey') && !credentialText.includes(apiKey), backups, exports };
}

async function runInstalledVisualScenario(outputDirectory: string): Promise<Record<string, unknown>> {
  const window = mainWindow;
  if (!window) throw new Error('Main window is unavailable.');
  mkdirSync(outputDirectory, { recursive: true });
  const ReloadRenderer = async (): Promise<void> => {
    const loaded = new Promise<void>((resolveLoaded) => window.webContents.once('did-finish-load', () => resolveLoaded()));
    window.webContents.reload();
    await loaded;
  };
  const originalSettings = await callBackend('workspace:get-settings') as Record<string, unknown>;
  await callBackend('workspace:save-settings', { ...originalSettings, developerMode: true, onboardingCompleted: true });
  await ReloadRenderer();
  const ready = await window.webContents.executeJavaScript(`new Promise((resolve)=>{const end=Date.now()+5000;const wait=()=>document.querySelector('nav button')?resolve(true):Date.now()>=end?resolve(false):setTimeout(wait,50);wait();})`, true);
  if (ready !== true) return { rendererNavigationReady: false, consoleErrors, pages: [], passed: false };

  const pageLabels = ['求职助手', '岗位库', '投递管理', '简历库', '档案库', '开发者工具'];
  const pages: Array<Record<string, unknown>> = [];
  // Windows 上隐藏或尚未获得可绘制表面的窗口会让 capturePage 抛出 UnknownVizError。
  window.show();
  window.focus();
  for (const [width, height] of [[1280, 800], [1024, 680]] as const) {
    window.setContentSize(width, height);
    for (const label of pageLabels) {
      const metrics = await window.webContents.executeJavaScript(`(async () => {
        const button = [...document.querySelectorAll('button[title]')].find((item) => item.getAttribute('title') === ${JSON.stringify(label)});
        if (!button) return { label: ${JSON.stringify(label)}, selected: false, reason: 'navigation_button_missing' };
        button.click();
        const end = Date.now() + 1500;
        while (button.getAttribute('aria-current') !== 'page' && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 25));
        if (${JSON.stringify(label)} === '开发者工具') {
          const evaluationTab = [...document.querySelectorAll('button[role="tab"]')].find((item) => item.getAttribute('aria-label') === 'Agent 测评' || item.getAttribute('title') === 'Agent 测评');
          evaluationTab?.click();
          const evaluationEnd = Date.now() + 1500;
          while (!document.querySelector('.evaluation-console') && Date.now() < evaluationEnd) await new Promise((resolve) => setTimeout(resolve, 25));
        }
        const visible = (element) => { const style = getComputedStyle(element); const rect = element.getBoundingClientRect(); return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0; };
        const critical = [...document.querySelectorAll('.page-header-actions button, .onboarding-actions button, .composer-dock button, [role="dialog"] button')].filter(visible);
        const offscreenCritical = critical.filter((element) => { const rect = element.getBoundingClientRect(); return rect.left < 0 || rect.right > innerWidth || rect.top < 0 || rect.bottom > innerHeight; }).map((element) => element.textContent?.trim() || element.getAttribute('aria-label'));
        return {
          label: ${JSON.stringify(label)}, selected: button.getAttribute('aria-current') === 'page',
          horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth || document.body.scrollWidth > document.body.clientWidth,
          offscreenCritical,
          evaluationTabVisible: ${JSON.stringify(label)} !== '开发者工具' || [...document.querySelectorAll('button[role="tab"]')].some((item) => item.getAttribute('aria-label') === 'Agent 测评' || item.getAttribute('title') === 'Agent 测评'),
          evaluationPanelVisible: ${JSON.stringify(label)} !== '开发者工具' || Boolean(document.querySelector('.evaluation-console')),
        };
      })()`, true) as Record<string, unknown>;
      const image = await window.webContents.capturePage();
      const safeLabel = label === '求职助手' ? 'assistant' : label === '岗位库' ? 'jobs' : label === '投递管理' ? 'applications' : label === '简历库' ? 'resumes' : label === '档案库' ? 'profiles' : 'developer';
      writeFileSync(join(outputDirectory, `${safeLabel}-${width}x${height}.png`), image.toPNG());
      pages.push({ width, height, ...metrics });
    }
  }

  window.show();
  window.focus();
  const keyboardTargetFocused = await window.webContents.executeJavaScript(`(() => { const button = document.querySelector('button[title="岗位库"]'); button?.focus(); return document.activeElement === button; })()`, true);
  window.webContents.debugger.attach('1.3');
  try {
    await window.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
    await window.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'char', key: 'Enter', code: 'Enter', text: '\r', unmodifiedText: '\r', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
    await window.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
  } finally {
    if (window.webContents.debugger.isAttached()) window.webContents.debugger.detach();
  }
  const keyboardNavigation = await window.webContents.executeJavaScript(`new Promise((resolve)=>{const end=Date.now()+1000;const wait=()=>document.querySelector('button[title="岗位库"]')?.getAttribute('aria-current')==='page'?resolve(true):Date.now()>=end?resolve(false):setTimeout(wait,25);wait();})`, true);
  await callBackend('workspace:save-settings', { ...originalSettings, developerMode: false, onboardingCompleted: true });
  await ReloadRenderer();
  const hiddenWhenDisabled = await window.webContents.executeJavaScript(`new Promise((resolve)=>{const end=Date.now()+5000;const wait=()=>{const hidden=![...document.querySelectorAll('button[title]')].some((item)=>item.getAttribute('title')==='开发者工具');hidden?resolve(true):Date.now()>=end?resolve(false):setTimeout(wait,25)};wait();})`, true);
  await callBackend('workspace:save-settings', { ...originalSettings, developerMode: true, onboardingCompleted: true });
  await ReloadRenderer();
  const visibleWhenEnabled = await window.webContents.executeJavaScript(`new Promise((resolve)=>{const end=Date.now()+5000;const wait=()=>{const visible=[...document.querySelectorAll('button[title]')].some((item)=>item.getAttribute('title')==='开发者工具');visible?resolve(true):Date.now()>=end?resolve(false):setTimeout(wait,25)};wait();})`, true);
  const developerModeGate = hiddenWhenDisabled === true && visibleWhenEnabled === true;
  const pagesPassed = pages.every((page) => page.selected === true && page.horizontalOverflow !== true && Array.isArray(page.offscreenCritical) && page.offscreenCritical.length === 0 && page.evaluationTabVisible === true && page.evaluationPanelVisible === true);
  return { rendererNavigationReady: true, consoleErrors, pages, keyboardTargetFocused, keyboardNavigation, developerModeGate, passed: pagesPassed && keyboardTargetFocused === true && keyboardNavigation === true && developerModeGate && consoleErrors.length === 0 };
}

if (IsBrowserCompanionProcess()) {
  StartBrowserCompanion();
} else {
  const cronRunnerLaunch = process.argv.includes('--cron-runner');
  // Smoke 必须在申请单实例锁前切换隔离目录，否则会被正在运行的正式应用误判为第二实例并立即退出。
  if (process.env.AVERY_DESKTOP_SMOKE === '1' && process.env.AVERY_SMOKE_USER_DATA) app.setPath('userData', resolve(process.env.AVERY_SMOKE_USER_DATA));
  const ownsSingleInstance = app.requestSingleInstanceLock();
  if (!ownsSingleInstance) {
    app.quit();
  } else {
  writeSmokeStage('main_loaded');
  app.whenReady().then(async () => {
    writeSmokeStage('electron_ready');
    configureSecurityPolicies();
    const userDataPath = app.getPath('userData');
    if (process.env.AVERY_DESKTOP_SMOKE !== '1') await MigrateLegacyUserData(userDataPath);
    const workspacePath = join(userDataPath, 'Avery Workspace');
    const adapters = CreateDesktopAdapters({ getWindow: () => mainWindow, userDataPath, executablePath: process.execPath, enableSystemCron: app.isPackaged });
    backendHost = CreateBackendHost({
      appContext: {
        userDataPath,
        defaultWorkspacePath: workspacePath,
        workspacePath,
        agentBrowserExecutablePath: resolveAgentBrowserExecutablePath(),
        browserCompanionExecutablePath: process.execPath,
        browserCompanionAppPath: process.defaultApp ? app.getAppPath() : undefined,
      },
      desktopCapabilities: adapters,
    });
    RegisterGateway({ backendHost, webContentsGetter: () => mainWindow });
    RegisterWindowControls({ webContentsGetter: () => mainWindow });
    Menu.setApplicationMenu(null);
    if (!cronRunnerLaunch) createWindow();
    else void runDueCronTasksWhenReady(true).catch((error) => { console.error('CronTask runner failed:', error); app.exit(1); });
    if (process.env.AVERY_DESKTOP_SMOKE !== '1') return;
    const deadline = Date.now() + 15000;
    const timer = setInterval(async () => {
      if (rendererLoaded && backendHost?.state() === 'ready') {
        if (lifecycleRunning) return;
        lifecycleRunning = true;
        clearInterval(timer);
        try {
          const mode = process.env.AVERY_LIFECYCLE_MODE;
          lifecycleStep = mode ? `starting:${mode}` : 'completed';
          const lifecycle = mode ? await runLifecycleScenario(mode, userDataPath, workspacePath) : undefined;
          const visual = process.env.AVERY_INSTALLED_VISUAL_OUTPUT ? await runInstalledVisualScenario(resolve(process.env.AVERY_INSTALLED_VISUAL_OUTPUT)) : undefined;
          const rendererAgentIpc = await probeRendererAgentIpc();
          if (!rendererAgentIpc.agentStatus || !rendererAgentIpc.browserRuntimeStatus) throw new Error('Renderer Agent IPC probe failed.');
          const result = { rendererLoaded: true, backendReady: true, rendererAgentIpc, electron: process.versions.electron, startupReadyMs: Date.now() - smokeStartedAt, ...(lifecycle ? { lifecycle } : {}), ...(visual ? { installedVisual: visual } : {}) };
          writeSmokeStage('ready', result); console.log(JSON.stringify(result)); app.quit();
        } catch (error) {
          const message = String(error instanceof Error ? error.message : 'Lifecycle smoke failed.').replaceAll(userDataPath, '[USER_DATA]').replace(/[A-Za-z]:\\[^\r\n]+/g, '[PATH]').slice(0, 240);
          const result = { rendererLoaded, backendState: backendHost?.state(), electron: process.versions.electron, lifecycleError: error instanceof Error && 'code' in error ? String(error.code) : 'INTERNAL_ERROR', lifecycleErrorMessage: message, lifecycleStep };
          writeSmokeStage('failed', result); console.error(JSON.stringify(result)); app.exit(1);
        }
      } else if (Date.now() >= deadline) {
        clearInterval(timer); const result = { rendererLoaded, backendState: backendHost?.state(), electron: process.versions.electron }; writeSmokeStage('failed', result); console.error(JSON.stringify(result)); app.exit(1);
      }
    }, 100);
  });
  app.on('second-instance', (_event, commandLine) => {
    if (commandLine.includes('--cron-runner')) { void runDueCronTasksWhenReady(false).catch((error) => console.error('CronTask wake failed:', error)); return; }
    if (!mainWindow || mainWindow.isDestroyed()) createWindow();
    else { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.show(); mainWindow.focus(); }
  });
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
  app.on('before-quit', () => { backendHost?.Shutdown(); });
  }
}
