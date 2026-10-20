import { app, BrowserWindow, Menu, nativeImage, screen, session, Tray } from 'electron';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { CreateBackendHost } from '@avery/backend/dist/host';
import { CreateDesktopAdapters } from './adapters';
import { RegisterGateway, RegisterGeneralControls, RegisterWindowControls } from './gateway';
import { MigrateLegacyUserData } from './brand-migration';
import { CreateTrayImage } from './tray-image';

const smokeStartedAt = Date.now();
let mainWindow: BrowserWindow | undefined;
/** WM_SIZE 客户区尺寸使用物理像素，避免经 DIP/CSS 多次取整后把描边推到窗口外。 */
let nativeClientSize: { width: number; height: number; unit: 'physical' } | undefined;
let backendHost: ReturnType<typeof CreateBackendHost> | undefined;
let rendererLoaded = false;
let lifecycleRunning = false;
let lifecycleStep: string | null = null;
const consoleErrors: string[] = [];
let tray: Tray | undefined;
let forceCloseAfterTrayDecision = false;
let quitting = false;
/** 还原（普通）尺寸：默认 1440×960，工作区更小时留出边距，保证还原后窗口确实变小。 */
function ResolveWindowRestoreSize() {
  const workArea = screen.getPrimaryDisplay().workAreaSize;
  return { width: Math.max(1024, Math.min(1440, workArea.width - 64)), height: Math.max(680, Math.min(960, workArea.height - 64)) };
}

function NotifyWindowMaximized(maximized: boolean): void {
  const window = mainWindow;
  if (!window || window.isDestroyed() || window.webContents.isDestroyed()) return;
  window.webContents.send('window:maximized-change', maximized);
}

/** 只从各平台的标准安装位置发现真实浏览器，不执行注册表或 Shell 查询。 */
function resolveExternalBrowserPaths(): Partial<Record<'chrome' | 'edge', string>> {
  const localAppData = process.env.LOCALAPPDATA;
  const programFiles = process.env.PROGRAMFILES;
  const programFilesX86 = process.env['PROGRAMFILES(X86)'];
  const candidates: Record<'chrome' | 'edge', string[]> = process.platform === 'win32'
    ? {
      chrome: [
        ...(localAppData ? [join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe')] : []),
        ...(programFiles ? [join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe')] : []),
        ...(programFilesX86 ? [join(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe')] : []),
      ],
      edge: [
        ...(programFiles ? [join(programFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe')] : []),
        ...(programFilesX86 ? [join(programFilesX86, 'Microsoft', 'Edge', 'Application', 'msedge.exe')] : []),
        ...(localAppData ? [join(localAppData, 'Microsoft', 'Edge', 'Application', 'msedge.exe')] : []),
      ],
    }
    : process.platform === 'darwin'
      ? {
        chrome: ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'],
        edge: ['/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'],
      }
      : {
        chrome: ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'],
        edge: ['/usr/bin/microsoft-edge', '/usr/bin/microsoft-edge-stable'],
      };
  return Object.fromEntries(Object.entries(candidates).flatMap(([engine, paths]) => {
    const match = paths.find((candidate) => candidate && existsSync(candidate));
    return match ? [[engine, match]] : [];
  }));
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

/** 窗口、任务栏、托盘与通知共用应用图标；开发态取 dist，打包态取安装目录内资源。 */
function resolveAppIconPath(): string {
  const fileName = join('dist', 'assets', 'avery-icon.png');
  const candidates = app.isPackaged
    ? [join(process.resourcesPath, 'app.asar', fileName), join(process.resourcesPath, fileName)]
    : [join(__dirname, '..', '..', '..', fileName)];
  return candidates.find((candidate) => existsSync(candidate)) ?? '';
}

/** 关闭请求：托盘模式隐藏窗口并创建托盘图标，否则真正关闭；设置读取失败按直接关闭处理。 */
async function ResolveWindowClose(): Promise<void> {
  const window = mainWindow;
  if (!window || window.isDestroyed()) return;
  let closeToTray = false;
  try {
    const envelope = await backendHost?.Command('workspace:get-settings', undefined) as { ok?: boolean; data?: { closeToTray?: boolean } } | undefined;
    closeToTray = envelope?.ok === true && envelope.data?.closeToTray === true;
  } catch { closeToTray = false; }
  const iconPath = resolveAppIconPath();
  if (!closeToTray || !iconPath) {
    // 无图标资源时托盘无法创建，若已隐藏窗口用户将失去入口，因此退回直接关闭。
    forceCloseAfterTrayDecision = true;
    window.close();
    return;
  }
  if (!EnsureTray(iconPath)) {
    forceCloseAfterTrayDecision = true;
    window.close();
    return;
  }
  window.hide();
}

function EnsureTray(iconPath: string): boolean {
  if (tray) return true;
  if (!iconPath) {
    console.error('Avery 托盘图标资源路径为空。');
    return false;
  }
  const image = nativeImage.createFromPath(iconPath);
  if (image.isEmpty()) {
    console.error(`无法加载 Avery 托盘图标：${iconPath}`);
    return false;
  }
  let createdTray: Tray | undefined;
  try {
    createdTray = new Tray(CreateTrayImage(image));
    createdTray.setToolTip('Avery');
    createdTray.setContextMenu(Menu.buildFromTemplate([
      { label: '显示主窗口', click: () => ShowMainWindowFromTray() },
      { label: '退出', click: () => app.quit() },
    ]));
    createdTray.on('click', () => ShowMainWindowFromTray());
    tray = createdTray;
    return true;
  } catch (error) {
    createdTray?.destroy();
    tray = undefined;
    console.error('创建 Avery 托盘图标失败：', error);
    return false;
  }
}

function ShowMainWindowFromTray(): void {
  const window = mainWindow;
  if (!window || window.isDestroyed()) createWindow();
  else { if (window.isMinimized()) window.restore(); window.show(); window.focus(); }
}

function DestroyTray(): void {
  if (!tray) return;
  tray.destroy();
  tray = undefined;
}

/** 创建唯一主窗口，明确维持 Renderer 与 Node/Electron 能力隔离。 */
function createWindow(): BrowserWindow {
  if (mainWindow && !mainWindow.isDestroyed()) return mainWindow;
  const appIconPath = resolveAppIconPath();
  const appIcon = appIconPath ? nativeImage.createFromPath(appIconPath) : undefined;
  const validAppIcon = appIcon && !appIcon.isEmpty() ? appIcon : undefined;
  const restoreSize = ResolveWindowRestoreSize();
  const window = new BrowserWindow({
    width: restoreSize.width, height: restoreSize.height, minWidth: 1024, minHeight: 680, frame: false, autoHideMenuBar: true,
    // 无边框窗口也显式加入任务栏，并给 Windows 任务栏提供应用图标。
    skipTaskbar: false,
    ...(validAppIcon ? { icon: validAppIcon } : {}),
    // 透明窗口会被 Electron 强制移除 WS_THICKFRAME/WS_CAPTION，导致系统动画和最大化受限。
    // 使用不透明宿主承载页面；保留原生框架能力，让 Windows 管理动画、工作区和还原位置。
    transparent: false,
    backgroundColor: '#ffffff',
    ...(process.platform === 'win32' ? { thickFrame: true, roundedCorners: true } : {}),
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, preload: join(__dirname, '..', '..', '..', 'electron', 'preload.cjs') },
  });
  mainWindow = window;
  nativeClientSize = undefined;
  if (process.platform === 'win32') {
    const WmSize = 0x0005;
    const SizeMinimized = 1;
    // 只观察原生消息，不拦截系统的调整大小流程；最小化时保留最后的可见客户区尺寸。
    window.hookWindowMessage(WmSize, (wParam, lParam) => {
      if (wParam.length < 4 || lParam.length < 4 || wParam.readUInt32LE(0) === SizeMinimized) return;
      const packedSize = lParam.readUInt32LE(0);
      const width = packedSize & 0xffff;
      const height = packedSize >>> 16;
      if (!width || !height) return;
      nativeClientSize = { width, height, unit: 'physical' };
      // 原生宽高变化一个像素时，CSS 视口未必触发 resize，因此主动下发最新边界。
      if (!window.webContents.isDestroyed()) window.webContents.send('window:frame-size-change', nativeClientSize);
    });
  }
  window.setMenuBarVisibility(false);
  // 按钮、标题栏双击和系统快捷键共用原生状态，避免维护第二份状态与实际窗口脱节。
  window.on('maximize', () => NotifyWindowMaximized(true));
  window.on('unmaximize', () => NotifyWindowMaximized(false));
  window.on('restore', () => NotifyWindowMaximized(window.isMaximized()));
  // 首次启动仍默认最大化；工作区选择与还原尺寸由系统维护。冒烟校验保留固定视口。
  if (process.env.AVERY_DESKTOP_SMOKE !== '1') window.maximize();
  if (app.isPackaged || process.env.AVERY_DESKTOP_SMOKE === '1') void window.loadFile(join(__dirname, '..', '..', '..', 'dist', 'index.html'));
  else void window.loadURL(process.env.VITE_DEV_SERVER_URL || 'http://127.0.0.1:5173');
  window.webContents.once('did-finish-load', () => { rendererLoaded = true; });
  window.webContents.on('console-message', (_event, level, message) => { if (level >= 3) consoleErrors.push(String(message).slice(0, 300)); });
  // 托盘驻留是常规设置的默认行为：关闭窗口先读设置决定隐藏还是退出；冒烟与已决定退出的场景直接放行。
  window.on('close', (event) => {
    if (quitting || forceCloseAfterTrayDecision || process.env.AVERY_DESKTOP_SMOKE === '1' || !backendHost) return;
    event.preventDefault();
    void ResolveWindowClose();
  });
  // 最小化时保留任务栏窗口，并确保托盘入口仍在；托盘图标在整个应用生命周期内常驻。
  window.on('minimize', () => {
    if (process.env.AVERY_DESKTOP_SMOKE === '1') return;
    window.setSkipTaskbar(false);
    const iconPath = resolveAppIconPath();
    if (!iconPath || !EnsureTray(iconPath)) console.error('Avery 已最小化到任务栏，但托盘图标不可用。');
  });
  // 重新显示窗口时重置关闭决策；托盘图标保持常驻，直到应用真正退出。
  window.on('show', () => { forceCloseAfterTrayDecision = false; });
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
    await callBackend('workspace:jobs-upsert', { id: 'lifecycle-job', company: '验收公司', title: '前端工程师', city: '上海', experience: '3年', jobSeekingType: 'social_recruitment', channel: 'company_website', favorite: true, jd: '确定性 JD' });
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

  const pageLabels = ['对话', '岗位', '简历', '投递记录', '档案', '开发者工具'];
  const pages: Array<Record<string, unknown>> = [];
  // Windows 上隐藏或尚未获得可绘制表面的窗口会让 capturePage 抛出 UnknownVizError。
  window.show();
  window.focus();
  for (const [width, height] of [[1280, 800], [1024, 680]] as const) {
    window.setContentSize(width, height);
    for (const label of pageLabels) {
      const metrics = await window.webContents.executeJavaScript(`(async () => {
        const openDeveloperViaUserMenu = async () => {
          // 开发者工具不走侧栏导航：入口在账户菜单（原型 umDeveloper），点击后等待评估控制台挂载。
          const userCard = document.querySelector('button[data-menu-trigger="user"]');
          if (!userCard) return 'user_card_missing';
          userCard.click();
          const menuEnd = Date.now() + 1500;
          while (!document.querySelector('.user-menu') && Date.now() < menuEnd) await new Promise((resolve) => setTimeout(resolve, 25));
          const entry = [...document.querySelectorAll('.user-menu .menu-item')].find((item) => item.textContent?.trim() === '开发者工具');
          if (!entry) return 'developer_entry_missing';
          entry.click();
          const evaluationEnd = Date.now() + 1500;
          while (!document.querySelector('.evaluation-console') && Date.now() < evaluationEnd) await new Promise((resolve) => setTimeout(resolve, 25));
          return null;
        };
        let selected = false;
        if (${JSON.stringify(label)} === '开发者工具') {
          const failure = await openDeveloperViaUserMenu();
          if (failure) return { label: ${JSON.stringify(label)}, selected: false, reason: failure };
          selected = document.querySelector('.sidebar')?.getAttribute('aria-label') === '开发者工具';
        } else {
          const button = [...document.querySelectorAll('button[title]')].find((item) => item.getAttribute('title') === ${JSON.stringify(label)});
          if (!button) return { label: ${JSON.stringify(label)}, selected: false, reason: 'navigation_button_missing' };
          button.click();
          const end = Date.now() + 1500;
          while (button.getAttribute('aria-current') !== 'page' && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 25));
          selected = button.getAttribute('aria-current') === 'page';
        }
        const visible = (element) => { const style = getComputedStyle(element); const rect = element.getBoundingClientRect(); return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0; };
        const critical = [...document.querySelectorAll('.page-header-actions button, .onboarding-actions button, .composer-dock button, [role="dialog"] button')].filter(visible);
        const offscreenCritical = critical.filter((element) => { const rect = element.getBoundingClientRect(); return rect.left < 0 || rect.right > innerWidth || rect.top < 0 || rect.bottom > innerHeight; }).map((element) => element.textContent?.trim() || element.getAttribute('aria-label'));
        return {
          label: ${JSON.stringify(label)}, selected,
          horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth || document.body.scrollWidth > document.body.clientWidth,
          offscreenCritical,
          evaluationNavVisible: ${JSON.stringify(label)} !== '开发者工具' || [...document.querySelectorAll('.sidebar .nav-item')].some((item) => item.getAttribute('title') === '评估'),
          evaluationPanelVisible: ${JSON.stringify(label)} !== '开发者工具' || Boolean(document.querySelector('.evaluation-console')),
        };
      })()`, true) as Record<string, unknown>;
      const image = await window.webContents.capturePage();
      const safeLabel = label === '对话' ? 'assistant' : label === '岗位' ? 'jobs' : label === '投递记录' ? 'applications' : label === '简历' ? 'resumes' : label === '档案' ? 'profiles' : 'developer';
      writeFileSync(join(outputDirectory, `${safeLabel}-${width}x${height}.png`), image.toPNG());
      pages.push({ width, height, ...metrics });
    }
  }

  window.show();
  window.focus();
  const keyboardTargetFocused = await window.webContents.executeJavaScript(`(() => { const button = document.querySelector('button[title="岗位"]'); button?.focus(); return document.activeElement === button; })()`, true);
  window.webContents.debugger.attach('1.3');
  try {
    await window.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
    await window.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'char', key: 'Enter', code: 'Enter', text: '\r', unmodifiedText: '\r', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
    await window.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
  } finally {
    if (window.webContents.debugger.isAttached()) window.webContents.debugger.detach();
  }
  const keyboardNavigation = await window.webContents.executeJavaScript(`new Promise((resolve)=>{const end=Date.now()+1000;const wait=()=>document.querySelector('button[title="岗位"]')?.getAttribute('aria-current')==='page'?resolve(true):Date.now()>=end?resolve(false):setTimeout(wait,25);wait();})`, true);
  // 开发者工具入口位于账户菜单（菜单关闭时不在 DOM 中）：每次检查先打开菜单读取条目，再收起菜单。
  const TryDeveloperEntryVisible = async (): Promise<boolean> => {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const visible = await window.webContents.executeJavaScript(`(async () => {
        const card = document.querySelector('button[data-menu-trigger="user"]');
        if (!card) return false;
        card.click();
        const end = Date.now() + 1500;
        while (!document.querySelector('.user-menu') && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 25));
        const visible = [...document.querySelectorAll('.user-menu .menu-item')].some((item) => item.textContent?.trim() === '开发者工具');
        card.click();
        return visible;
      })()`, true) as boolean;
      if (visible) return true;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return false;
  };
  await callBackend('workspace:save-settings', { ...originalSettings, developerMode: false, onboardingCompleted: true });
  await ReloadRenderer();
  const hiddenWhenDisabled = !(await TryDeveloperEntryVisible());
  await callBackend('workspace:save-settings', { ...originalSettings, developerMode: true, onboardingCompleted: true });
  await ReloadRenderer();
  const visibleWhenEnabled = await TryDeveloperEntryVisible();
  const developerModeGate = hiddenWhenDisabled === true && visibleWhenEnabled === true;
  const pagesPassed = pages.every((page) => page.selected === true && page.horizontalOverflow !== true && Array.isArray(page.offscreenCritical) && page.offscreenCritical.length === 0 && page.evaluationNavVisible === true && page.evaluationPanelVisible === true);
  return { rendererNavigationReady: true, consoleErrors, pages, keyboardTargetFocused, keyboardNavigation, developerModeGate, passed: pagesPassed && keyboardTargetFocused === true && keyboardNavigation === true && developerModeGate && consoleErrors.length === 0 };
}

  const cronRunnerLaunch = process.argv.includes('--cron-runner');
  // Smoke 调试实例必须在申请单实例锁前切换隔离目录：
  // 一防被正在运行的正式应用误判为第二实例，二防调试写入落到用户真实工作区。
  if (process.env.AVERY_SMOKE_USER_DATA) app.setPath('userData', resolve(process.env.AVERY_SMOKE_USER_DATA));
  const ownsSingleInstance = app.requestSingleInstanceLock();
  if (!ownsSingleInstance) {
    app.quit();
  } else {
  writeSmokeStage('main_loaded');
  app.whenReady().then(async () => {
    writeSmokeStage('electron_ready');
    configureSecurityPolicies();
    // AppUserModelId 在创建托盘和窗口之前设置，确保 Windows 将两者归属于 Avery。
    app.setAppUserModelId('com.avery.app');
    const userDataPath = app.getPath('userData');
    if (process.env.AVERY_DESKTOP_SMOKE !== '1') await MigrateLegacyUserData(userDataPath);
    const workspacePath = join(userDataPath, 'Avery Workspace');
    // 冒烟实例使用独立数据目录，也不能读写用户机器上的真实计划任务。
    const adapters = CreateDesktopAdapters({ getWindow: () => mainWindow, userDataPath, executablePath: process.execPath, enableSystemCron: app.isPackaged && process.env.AVERY_DESKTOP_SMOKE !== '1' });
    backendHost = CreateBackendHost({
      appContext: {
        userDataPath,
        defaultWorkspacePath: workspacePath,
        workspacePath,
        externalBrowserPaths: resolveExternalBrowserPaths(),
      },
      desktopCapabilities: adapters,
    });
    RegisterGateway({ backendHost, webContentsGetter: () => mainWindow, notificationIconPath: resolveAppIconPath() || undefined });
    RegisterWindowControls({ webContentsGetter: () => mainWindow, frameSize: () => nativeClientSize });
    RegisterGeneralControls({ webContentsGetter: () => mainWindow, workspacePath });
    Menu.setApplicationMenu(null);
    if (!cronRunnerLaunch) {
      // 普通应用在首个窗口创建前注册托盘；后台 CronRunner 和自动化冒烟实例不暴露托盘。
      if (process.env.AVERY_DESKTOP_SMOKE !== '1') EnsureTray(resolveAppIconPath());
      createWindow();
    }
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
  // before-quit 先于窗口关闭事件：托盘「退出」触发的关闭必须放行，不再被托盘决策拦截。
  app.on('before-quit', () => { quitting = true; DestroyTray(); backendHost?.Shutdown(); });
}
