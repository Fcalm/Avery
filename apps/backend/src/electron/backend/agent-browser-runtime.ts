import { createHash, randomUUID } from 'node:crypto';
import { promises as dns } from 'node:dns';
import { existsSync, realpathSync, statSync } from 'node:fs';
import { mkdir, open, readFile, rm, unlink } from 'node:fs/promises';
import { isIP } from 'node:net';
import { basename, isAbsolute, join, resolve, sep } from 'node:path';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { setTimeout as Delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import type { BrowserActionProposal, BrowserAutomationPort, BrowserEngine, BrowserToolName } from '@avery/agent-sdk';
import {
  PersonalBrowserCdpError,
  PersonalBrowserCdpRuntime,
  type PersonalBrowserRuntimePort,
} from './personal-browser-cdp-runtime';
import {
  AgentBrowserError,
  BrowserFormService,
  FormFields,
  type FormField,
  type FormFillOperation,
  type FormFillPlan,
} from './browser-form-service';
import { BrowserFormDriver } from './browser-form-driver';

export { AgentBrowserError } from './browser-form-service';

const MaxStdoutBytes = 1024 * 1024;
const MaxStderrBytes = 64 * 1024;
// 浏览器命令和 BrowserFillForm 使用同一 120 秒上限；动态控件不能再被额外的短字段超时提前截断。
const DefaultCommandTimeoutMs = 120_000;
const FormFillCleanupReserveMs = 5_000;
const MaxUploadBytes = 25 * 1024 * 1024;
const MaxScreenshotBytes = 16 * 1024 * 1024;
const FixedSessionId = 'avery-default';
const BossActionIntervalMs = 2_000;
const BossActionTools = new Set<BrowserToolName>([
  'BrowserNavigate', 'BrowserClick', 'BrowserFill', 'BrowserFillForm', 'BrowserSelect', 'BrowserSetChecked', 'BrowserPressKey', 'BrowserUploadFile', 'BrowserSwitchTab', 'BrowserGoBack',
]);
const ExecFile = promisify(execFile);

type BrowserHandle = {
  port: number;
  cdpEndpoint?: string;
  close: () => Promise<void>;
  isAlive?: () => boolean;
  homeUrl?: string;
  internalUrls?: string[];
  targetId?: string;
  userAttached?: boolean;
};

export type AgentBrowserCliEnvelope = { success?: boolean; data?: any; error?: string; message?: string };
type CliEnvelope = AgentBrowserCliEnvelope;

/** BOSS 只匹配主域及其子域，避免相似域名获得站点特殊权限或策略。 */
export function IsBossBrowserUrl(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  try {
    const hostname = new URL(value).hostname.toLowerCase();
    return hostname === 'zhipin.com' || hostname.endsWith('.zhipin.com');
  } catch {
    return false;
  }
}

/** 只识别强特征风险信号；普通 JD 中孤立出现“验证码”等词不能触发熔断。 */
export function DetectBossRisk(value: { url?: unknown; pageText?: unknown }): 'verification' | 'rate_limit' | 'account_restriction' | null {
  const url = typeof value.url === 'string' ? value.url : '';
  if (!IsBossBrowserUrl(url)) return null;
  const normalizedUrl = url.toLowerCase();
  if (/\/web\/user\/safe|captcha|verify|security[-_]?check/.test(normalizedUrl)) return 'verification';
  const text = typeof value.pageText === 'string' ? value.pageText : '';
  if (/访问过于频繁|操作过于频繁|请求过于频繁|访问频率过高/.test(text)) return 'rate_limit';
  if (/请完成安全验证|检测到异常访问|当前访问存在风险|请拖动滑块完成验证|账号(?:存在)?异常|账号访问受限/.test(text)) {
    return /账号/.test(text) ? 'account_restriction' : 'verification';
  }
  return null;
}

/** 构造隔离伴随进程的固定参数数组；路径始终作为单个参数传递，禁止经过 Shell 解释。 */
export function BuildBrowserCompanionArgs(input: { appPath?: string; profilePath: string; parentPid: number; unattended?: boolean }): string[] {
  return [
    ...(input.appPath ? [input.appPath] : []),
    '--avery-browser-companion',
    `--avery-browser-profile=${input.profilePath}`,
    `--avery-browser-parent-pid=${input.parentPid}`,
    '--remote-debugging-address=127.0.0.1',
    '--remote-debugging-port=0',
    `--user-data-dir=${input.profilePath}`,
    ...(input.unattended ? ['--avery-browser-hidden'] : []),
  ];
}

function IsPrivateIpv4(address: string): boolean {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b] = parts;
  return a === 0 || a === 10 || a === 127 || a >= 224
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 198 && (b === 18 || b === 19));
}

function IsPrivateIp(address: string): boolean {
  const normalized = address.toLowerCase().split('%')[0];
  if (isIP(normalized) === 4) return IsPrivateIpv4(normalized);
  if (isIP(normalized) !== 6) return true;
  if (normalized === '::' || normalized === '::1' || normalized.startsWith('fc') || normalized.startsWith('fd') || normalized.startsWith('fe8') || normalized.startsWith('fe9') || normalized.startsWith('fea') || normalized.startsWith('feb')) return true;
  const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  return mapped ? IsPrivateIpv4(mapped) : false;
}

/** 只接受可公开解析的 http/https 地址；这是应用层校验，不等同于进程级网络隔离。 */
export async function NormalizePublicBrowserUrl(value: unknown, lookup: typeof dns.lookup = dns.lookup): Promise<string> {
  if (typeof value !== 'string' || !value.trim() || value.length > 2_048) throw new AgentBrowserError('BROWSER_NAVIGATION_DENIED', 'Browser URL is invalid.');
  const candidate = value.includes('://') ? value.trim() : `https://${value.trim()}`;
  let url: URL;
  try { url = new URL(candidate); } catch { throw new AgentBrowserError('BROWSER_NAVIGATION_DENIED', 'Browser URL is invalid.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || !url.hostname) {
    throw new AgentBrowserError('BROWSER_NAVIGATION_DENIED', 'Only public http/https URLs without embedded credentials are allowed.');
  }
  const hostname = url.hostname.replace(/^\[(.*)\]$/, '$1').toLowerCase();
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) throw new AgentBrowserError('BROWSER_NAVIGATION_DENIED', 'Local browser addresses are not allowed.');
  if (isIP(hostname)) {
    if (IsPrivateIp(hostname)) throw new AgentBrowserError('BROWSER_NAVIGATION_DENIED', 'Private browser addresses are not allowed.');
  } else {
    let records: Array<{ address: string }>;
    try { records = await lookup(hostname, { all: true, verbatim: true }); } catch { throw new AgentBrowserError('BROWSER_NAVIGATION_DENIED', 'Browser host could not be resolved.'); }
    if (!records.length || records.some((record) => IsPrivateIp(record.address))) throw new AgentBrowserError('BROWSER_NAVIGATION_DENIED', 'Browser host resolves to a private address.');
  }
  url.hash = '';
  return url.toString();
}

function StableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(StableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, child]) => [key, StableValue(child)]));
}

function HashProposal(toolName: BrowserToolName, args: Record<string, unknown>, pageRevision: number, url?: string): string {
  return createHash('sha256').update(JSON.stringify(StableValue({ toolName, args, pageRevision, url: url ?? null }))).digest('hex');
}

function RequireString(value: unknown, field: string, maxLength = 20_000): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maxLength) throw new AgentBrowserError('BROWSER_ARGUMENT_INVALID', `${field} is invalid.`);
  return value.trim();
}

function ExtractJson(stdout: string): CliEnvelope {
  const lines = stdout.trim().split(/\r?\n/).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const value = JSON.parse(lines[index]);
      if (Array.isArray(value)) {
        const failed = value.find((item) => item && typeof item === 'object' && item.success === false);
        return { success: !failed, data: { results: value }, ...(failed ? { error: String(failed.error ?? failed.message ?? 'Browser batch failed.') } : {}) };
      }
      if (value && typeof value === 'object') return value;
    } catch { /* 继续查找最后一个合法 JSON 行。 */ }
  }
  throw new AgentBrowserError('BROWSER_OUTPUT_INVALID', 'agent-browser returned invalid JSON.');
}

/** Electron CLI 的页面脚本经 stdin 传输，避免 Base64 脚本占用 Windows 进程命令行额度。 */
function PrepareCliTransport(command: string[], stdin?: string): { command: string[]; stdin?: string } {
  if (command[0] !== 'eval' || command[1] !== '-b') return { command, ...(stdin === undefined ? {} : { stdin }) };
  const encoded = command[2];
  if (command.length !== 3 || stdin !== undefined || typeof encoded !== 'string'
    || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
    throw new AgentBrowserError('BROWSER_ARGUMENT_INVALID', 'Browser eval payload is invalid.');
  }
  return { command: ['eval', '--stdin'], stdin: Buffer.from(encoded, 'base64').toString('utf8') };
}

export interface AgentBrowserRuntimeOptions {
  executablePath: string;
  companionExecutablePath: string;
  companionAppPath?: string;
  runtimeRoot: string;
  resolveUploadFile: (fileId: string) => Promise<string | null>;
  now?: () => number;
  /** 仅供宿主构造期注入更窄的导航策略；生产默认始终执行公开 URL 与 DNS 校验。 */
  normalizeNavigationUrl?: (value: unknown) => Promise<string>;
  /** 仅供契约测试注入受控子进程替身；生产路径始终使用 spawn + shell:false。 */
  runProcess?: (input: { args: string[]; cwd: string; env: NodeJS.ProcessEnv; signal?: AbortSignal; deadline: number; json: boolean; stdin?: string }) => Promise<CliEnvelope>;
  /** 仅供节流测试替换等待；生产始终使用可取消的异步定时器。 */
  delay?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  /** 仅供契约测试注入隔离 Electron 伴随进程；生产路径始终启动应用自身的 companion 模式。 */
  launchCompanion?: (input: { profilePath: string; runtimeRoot: string }) => Promise<{ port: number; close: () => Promise<void>; isAlive?: () => boolean; homeUrl?: string; internalUrls?: string[] }>;
  /** 仅供契约测试注入用户浏览器发现结果；生产路径只附着本机已有 CDP，不启动浏览器。 */
  attachExternalBrowser?: (input: { engine: 'chrome' | 'edge' }) => Promise<BrowserHandle>;
  /** 仅供契约测试替换个人浏览器的受限 CDP 驱动；生产路径不经过 agent-browser。 */
  createPersonalBrowserRuntime?: (input: { endpoint: string; anchorUrl?: string }) => PersonalBrowserRuntimePort;
  /** 已校验的浏览器安装路径，用于在动态端口文件丢失时限定进程级端口发现。 */
  externalBrowserPaths?: Partial<Record<'chrome' | 'edge', string>>;
  /** 仅供契约测试替换只读的本机监听端口发现。 */
  discoverExternalBrowserPorts?: (input: { engine: 'chrome' | 'edge'; executablePath?: string }) => Promise<number[]>;
  /** 仅记录表单字段阶段、耗时和错误码，不得包含填写值。 */
  recordLog?: (level: 'INFO' | 'WARN', event: string, detail: string) => void;
}

/** 单 Profile 串行 Runtime；所有 CLI 参数、页面引用、文件解析与进程取消均由此边界持有。 */
export class AgentBrowserRuntime implements BrowserAutomationPort {
  private readonly executablePath: string;
  private readonly companionExecutablePath: string;
  private readonly companionAppPath?: string;
  private readonly runtimeRoot: string;
  private readonly electronProfilePath: string;
  private readonly runtimeLockPath: string;
  private readonly resolveUploadFile: AgentBrowserRuntimeOptions['resolveUploadFile'];
  private readonly now: () => number;
  private readonly normalizeNavigationUrl: (value: unknown) => Promise<string>;
  private readonly runProcess?: AgentBrowserRuntimeOptions['runProcess'];
  private readonly delay: NonNullable<AgentBrowserRuntimeOptions['delay']>;
  private readonly formDriver: BrowserFormDriver;
  private readonly launchCompanion?: AgentBrowserRuntimeOptions['launchCompanion'];
  private readonly attachExternalBrowser?: AgentBrowserRuntimeOptions['attachExternalBrowser'];
  private readonly createPersonalBrowserRuntime: NonNullable<AgentBrowserRuntimeOptions['createPersonalBrowserRuntime']>;
  private readonly externalBrowserPaths: Partial<Record<'chrome' | 'edge', string>>;
  private readonly discoverExternalBrowserPorts: NonNullable<AgentBrowserRuntimeOptions['discoverExternalBrowserPorts']>;
  private readonly recordLog?: AgentBrowserRuntimeOptions['recordLog'];
  private commandTail: Promise<void> = Promise.resolve();
  private activeChild: ChildProcess | null = null;
  private companionHandle: BrowserHandle | null = null;
  private attachedEndpoint: string | null = null;
  private running = false;
  private ownsRuntimeLock = false;
  private pageRevision = 0;
  private currentUrl: string | undefined;
  private refs = new Map<string, Record<string, unknown>>();
  /** 表单服务独立保存短寿命计划；Runtime 不持有资料正文或语义匹配状态。 */
  private readonly formService = new BrowserFormService();
  private tabs = new Set<string>();
  // namespace 同时绑定 Backend 进程与 companion 代次；companion 换端口后绝不复用旧 daemon 的 CDP 会话。
  private namespaceGeneration = 0;
  private daemonNamespace = `avery-${process.pid}-0`;
  private daemonActive = false;
  private lastRuntimeError: { code: string; message: string } | null = null;
  private unattended = false;
  private browserEngine: BrowserEngine = 'electron';
  private lastBossActionAt = 0;
  private personalBrowserRuntime: PersonalBrowserRuntimePort | null = null;
  private scheduledCronTaskId: string | null = null;
  private scheduledBrowserAuthorized = false;

  constructor(options: AgentBrowserRuntimeOptions) {
    this.executablePath = resolve(options.executablePath);
    this.companionExecutablePath = resolve(options.companionExecutablePath);
    this.companionAppPath = options.companionAppPath ? resolve(options.companionAppPath) : undefined;
    this.runtimeRoot = resolve(options.runtimeRoot);
    this.electronProfilePath = resolve(this.runtimeRoot, 'profiles', 'default');
    this.runtimeLockPath = resolve(this.runtimeRoot, 'runtime.lock');
    this.resolveUploadFile = options.resolveUploadFile;
    this.now = options.now ?? Date.now;
    this.normalizeNavigationUrl = options.normalizeNavigationUrl ?? NormalizePublicBrowserUrl;
    this.runProcess = options.runProcess;
    this.delay = options.delay ?? ((milliseconds, signal) => Delay(milliseconds, undefined, signal ? { signal } : undefined));
    this.launchCompanion = options.launchCompanion;
    this.attachExternalBrowser = options.attachExternalBrowser;
    this.createPersonalBrowserRuntime = options.createPersonalBrowserRuntime
      ?? ((input) => new PersonalBrowserCdpRuntime({ endpoint: input.endpoint, anchorUrl: input.anchorUrl, now: this.now, delay: this.delay }));
    this.externalBrowserPaths = options.externalBrowserPaths ?? {};
    this.discoverExternalBrowserPorts = options.discoverExternalBrowserPorts ?? ((input) => this.DiscoverExternalBrowserPorts(input));
    this.recordLog = options.recordLog;
    this.formDriver = new BrowserFormDriver({
      runCommand: (command, commandOptions) => this.RunCommand(command, commandOptions),
      delay: this.delay,
      pageRevision: () => this.pageRevision,
    });
    if (!(this.electronProfilePath.startsWith(`${this.runtimeRoot}${sep}`))) throw new Error('Browser profile path escapes the runtime root.');
  }

  private FixedArgs(endpoint: string, pinTab = true): string[] {
    return [
      '--namespace', this.daemonNamespace,
      '--session', FixedSessionId,
      '--cdp', endpoint,
      ...(pinTab ? ['--pin-tab'] : []),
      '--no-auto-dialog',
      '--content-boundaries',
      '--max-output', '50000',
      '--idle-timeout', '1h',
    ];
  }

  /** Windows 上从浏览器主进程读取回环监听端口；固定脚本与安装路径双重约束，禁止扫描任意本机端口。 */
  private async DiscoverExternalBrowserPorts(input: { engine: 'chrome' | 'edge'; executablePath?: string }): Promise<number[]> {
    if (process.platform !== 'win32' || !input.executablePath) return [];
    const systemRoot = process.env.SystemRoot;
    if (!systemRoot) return [];
    const powershellPath = join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    if (!existsSync(powershellPath)) return [];
    const script = [
      "$expected = [IO.Path]::GetFullPath($env:AVERY_EXPECTED_BROWSER)",
      "Get-NetTCPConnection -State Listen -LocalAddress 127.0.0.1 -ErrorAction SilentlyContinue | ForEach-Object {",
      "  try { $p = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $_.OwningProcess); if ($p.ExecutablePath -and [IO.Path]::GetFullPath($p.ExecutablePath) -ieq $expected -and $p.CommandLine -notmatch '--type=') { [int]$_.LocalPort } } catch {}",
      "} | Sort-Object -Unique",
    ].join('\n');
    try {
      const { stdout } = await ExecFile(powershellPath, ['-NoProfile', '-NonInteractive', '-Command', script], {
        windowsHide: true,
        timeout: 5_000,
        maxBuffer: 16 * 1024,
        encoding: 'utf8',
        env: { ...this.SanitizedEnvironment(), AVERY_EXPECTED_BROWSER: resolve(input.executablePath) },
      });
      return String(stdout).split(/\r?\n/).map((line) => Number(line.trim()))
        .filter((port) => Number.isSafeInteger(port) && port > 0 && port <= 65_535);
    } catch {
      return [];
    }
  }

  /** 仅附着用户已打开的登录浏览器；不创建 Profile、不启动进程，也不接管非 BOSS 标签页。 */
  private async AttachExternalBrowser(): Promise<BrowserHandle> {
    const engine = this.browserEngine;
    if (engine === 'electron') throw new AgentBrowserError('BROWSER_START_FAILED', 'External browser engine was not selected.');
    if (this.unattended) throw new AgentBrowserError('BROWSER_USER_BROWSER_INTERACTIVE_ONLY', 'A logged-in personal browser can only be used in an interactive session.');
    if (this.attachExternalBrowser) return { ...(await this.attachExternalBrowser({ engine })), userAttached: true };

    const browserName = engine === 'chrome' ? 'Google Chrome' : 'Microsoft Edge';
    const localAppData = process.env.LOCALAPPDATA;
    const activePortPath = localAppData
      ? join(localAppData, engine === 'chrome' ? 'Google' : 'Microsoft', engine === 'chrome' ? 'Chrome' : 'Edge', 'User Data', 'DevToolsActivePort')
      : undefined;
    const candidatePorts = new Set<number>([9222, 9223, 9333]);
    const processDiscoveredPorts = new Set<number>();
    if (activePortPath) {
      try {
        const [portLine, websocketPath] = (await readFile(activePortPath, 'utf8')).split(/\r?\n/);
        const port = Number(portLine);
        if (Number.isSafeInteger(port) && port > 0 && port <= 65_535) {
          candidatePorts.add(port);
          // Chrome 144+ 的授权式远程调试不再暴露 /json 接口，只在文件第二行提供浏览器级 WebSocket。
          if (/^\/devtools\/browser\/[a-zA-Z0-9-]+$/.test(websocketPath ?? '')) {
            try {
              await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(750) });
              return { port, cdpEndpoint: `ws://127.0.0.1:${port}${websocketPath}`, userAttached: true, close: async () => undefined };
            } catch { /* 文件可能来自已退出的浏览器，继续尝试旧式 HTTP CDP。 */ }
          }
        }
      } catch { /* 固定端口启动的浏览器可能没有该文件，继续探测受控候选。 */ }
    }
    for (const port of await this.discoverExternalBrowserPorts({ engine, executablePath: this.externalBrowserPaths[engine] })) {
      candidatePorts.add(port);
      processDiscoveredPorts.add(port);
    }
    let matchingBrowserFound = false;
    for (const port of candidatePorts) {
      try {
        const versionResponse = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(750) });
        if (!versionResponse.ok) {
          // Chrome 144+ 的授权式调试只有 WebSocket，没有 /json 接口；端口已由选定浏览器主进程严格验证。
          if (processDiscoveredPorts.has(port)) return { port, cdpEndpoint: `ws://127.0.0.1:${port}/devtools/browser`, userAttached: true, close: async () => undefined };
          continue;
        }
        const version = await versionResponse.json() as { Browser?: string; webSocketDebuggerUrl?: string };
        const product = String(version.Browser ?? '').toLowerCase();
        const matches = engine === 'edge' ? product.includes('edg/') : (product.includes('chrome/') && !product.includes('edg/'));
        if (!matches) continue;
        matchingBrowserFound = true;
        const targetsResponse = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(750) });
        if (!targetsResponse.ok) continue;
        const targets = await targetsResponse.json() as Array<{ id?: string; type?: string; url?: string }>;
        const page = Array.isArray(targets)
          ? targets.find((target) => target?.type === 'page' && IsBossBrowserUrl(target.url) && typeof target.id === 'string')
          : undefined;
        if (!page?.url || !page.id) continue;
        const endpoint = typeof version.webSocketDebuggerUrl === 'string' ? version.webSocketDebuggerUrl : undefined;
        if (!endpoint) continue;
        return { port, cdpEndpoint: endpoint, homeUrl: page.url, targetId: page.id, userAttached: true, close: async () => undefined };
      } catch {
        if (processDiscoveredPorts.has(port)) return { port, cdpEndpoint: `ws://127.0.0.1:${port}/devtools/browser`, userAttached: true, close: async () => undefined };
        // 非本浏览器、端口未监听或端点未就绪，继续有限候选。
      }
    }
    if (matchingBrowserFound) throw new AgentBrowserError('BROWSER_BOSS_TAB_REQUIRED', `${browserName} is connected, but no open BOSS tab was found. Open and sign in to zhipin.com, then try again.`);
    throw new AgentBrowserError('BROWSER_EXISTING_BROWSER_UNAVAILABLE', `${browserName} is not available for attachment. Start your logged-in browser with local remote debugging enabled, keep a BOSS tab open, then try again.`);
  }

  private SanitizedEnvironment(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (/^(AGENT_BROWSER_|AI_GATEWAY_|KERNEL_)/i.test(key)) continue;
      env[key] = value;
    }
    env.NO_COLOR = '1';
    // 宿主与 agent-browser 使用同一超时，避免 CLI 先于用户完成 Chrome 授权而自行失败。
    env.AGENT_BROWSER_DEFAULT_TIMEOUT = String(DefaultCommandTimeoutMs);
    env.AGENT_BROWSER_AUTO_CONNECT_TIMEOUT = String(DefaultCommandTimeoutMs);
    delete env.ELECTRON_RUN_AS_NODE;
    return env;
  }

  /** 启动只包含招聘网页 target 的 Electron 伴随进程；随机 CDP 端口通过 Chromium 的 DevToolsActivePort 文件回传。 */
  private async LaunchIsolatedCompanion(): Promise<{ port: number; close: () => Promise<void>; isAlive?: () => boolean; homeUrl?: string; internalUrls?: string[] }> {
    if (this.launchCompanion) return this.launchCompanion({ profilePath: this.electronProfilePath, runtimeRoot: this.runtimeRoot });
    if (!existsSync(this.companionExecutablePath)) throw new AgentBrowserError('BROWSER_RUNTIME_UNAVAILABLE', `Browser companion ${basename(this.companionExecutablePath)} is unavailable.`);
    const portFile = join(this.electronProfilePath, 'DevToolsActivePort');
    await unlink(portFile).catch((error: any) => { if (error?.code !== 'ENOENT') throw error; });
    const args = BuildBrowserCompanionArgs({ appPath: this.companionAppPath, profilePath: this.electronProfilePath, parentPid: process.pid, unattended: this.unattended });
    const env = this.SanitizedEnvironment();
    for (const key of Object.keys(env)) if (/^AVERY_(DESKTOP_SMOKE|SMOKE_|LIFECYCLE_|INSTALLED_VISUAL_)/i.test(key)) delete env[key];
    const child = spawn(this.companionExecutablePath, args, { cwd: this.runtimeRoot, env, shell: false, windowsHide: false, stdio: 'ignore' });
    let startErrorMessage: string | undefined;
    child.once('error', (error) => { startErrorMessage = error.message; });
    let port = 0;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (startErrorMessage) throw new AgentBrowserError('BROWSER_START_FAILED', startErrorMessage);
      if (child.exitCode !== null) throw new AgentBrowserError('BROWSER_START_FAILED', `Browser companion exited with code ${child.exitCode}.`);
      try {
        const firstLine = (await readFile(portFile, 'utf8')).split(/\r?\n/, 1)[0];
        port = Number(firstLine);
        if (Number.isSafeInteger(port) && port > 0 && port <= 65_535) break;
      } catch (error: any) {
        if (error?.code !== 'ENOENT') throw error;
      }
      await Delay(100);
    }
    if (!port) {
      try { child.kill(); } catch { /* 启动失败后只终止本次伴随进程。 */ }
      throw new AgentBrowserError('BROWSER_START_FAILED', 'Browser companion did not publish a CDP port in time.');
    }
    let homeUrl: string | undefined;
    let internalUrls: string[] = [];
    for (let attempt = 0; attempt < 50; attempt += 1) {
      if (child.exitCode !== null) break;
      try {
        const response = await fetch(`http://127.0.0.1:${port}/json/list`);
        const targets = await response.json() as Array<{ type?: string; url?: string }>;
        const pages = Array.isArray(targets) ? targets.filter((target) => target?.type === 'page' && typeof target.url === 'string') : [];
        const page = pages.find((target) => target.url?.endsWith('/ready'));
        if (page?.url) { homeUrl = page.url; internalUrls = pages.map((target) => target.url!).filter(Boolean); break; }
      } catch { /* CDP 服务可能晚于端口文件短暂就绪，继续有限重试。 */ }
      await Delay(100);
    }
    if (!homeUrl) {
      try { child.kill(); } catch { /* 启动失败后只终止本次伴随进程。 */ }
      throw new AgentBrowserError('BROWSER_START_FAILED', 'Browser companion CDP endpoint did not become ready.');
    }
    const close = async (): Promise<void> => {
      if (child.exitCode !== null) return;
      const exited = new Promise<void>((resolveExit) => child.once('exit', () => resolveExit()));
      try { child.kill(); } catch { return; }
      await Promise.race([exited, Delay(5_000)]);
      if (child.exitCode === null) {
        try { child.kill('SIGKILL'); } catch { /* 已退出时无需重复终止。 */ }
      }
    };
    return { port, close, isAlive: () => child.exitCode === null, homeUrl, internalUrls };
  }

  /** 可见性是 companion 进程创建期属性；模式改变时淘汰旧实例，避免后台任务复用可见窗口或交互任务复用隐藏窗口。 */
  async SetUnattended(value: boolean, context: { cronTaskId?: string; browserAuthorized?: boolean } = {}): Promise<void> {
    const changed = this.unattended !== value;
    this.unattended = value;
    this.scheduledCronTaskId = value && typeof context.cronTaskId === 'string' ? context.cronTaskId : null;
    this.scheduledBrowserAuthorized = value && context.browserAuthorized === true;
    // Electron 的可见性是进程创建属性；个人浏览器必须保留已交互授权的同一条连接。
    if (changed && this.browserEngine === 'electron' && (this.companionHandle || this.daemonActive)) await this.RetireBrowserInstance();
  }

  /** 授权来自可信 Cron Runner 读取的任务持久字段；浏览器在线状态由实际连接阶段独立校验。 */
  private HasCronAccess(): boolean {
    return this.unattended && this.scheduledBrowserAuthorized && Boolean(this.scheduledCronTaskId);
  }

  /** 浏览器内核切换会关闭旧 daemon 并废弃全部 ref；不同内核永不共享 Profile。 */
  async SetEngine(value: BrowserEngine): Promise<void> {
    if (!['electron', 'chrome', 'edge'].includes(value)) throw new AgentBrowserError('BROWSER_ARGUMENT_INVALID', 'Browser engine is invalid.');
    if (this.browserEngine === value) return;
    if (this.companionHandle || this.daemonActive || this.personalBrowserRuntime) await this.RetireBrowserInstance();
    this.browserEngine = value;
    this.lastRuntimeError = null;
    this.InvalidateRefs();
  }

  private async EnsureCompanion(): Promise<BrowserHandle> {
    if (this.companionHandle && (this.companionHandle.isAlive?.() ?? true)) return this.companionHandle;
    if (this.companionHandle || this.daemonActive) await this.RetireBrowserInstance();
    await this.AcquireRuntimeLock();
    await mkdir(this.electronProfilePath, { recursive: true });
    this.namespaceGeneration += 1;
    this.daemonNamespace = `avery-${process.pid}-${this.namespaceGeneration}`;
    const handle = await this.LaunchIsolatedCompanion();
    if (!Number.isSafeInteger(handle.port) || handle.port <= 0 || handle.port > 65_535) {
      await handle.close().catch(() => undefined);
      throw new AgentBrowserError('BROWSER_START_FAILED', 'Browser companion returned an invalid CDP port.');
    }
    this.companionHandle = handle;
    this.running = true;
    this.lastRuntimeError = null;
    return this.companionHandle;
  }

  private async EnsureExternalBrowser(): Promise<BrowserHandle> {
    if (this.companionHandle && (this.companionHandle.isAlive?.() ?? true)) return this.companionHandle;
    if (this.companionHandle || this.daemonActive) await this.RetireBrowserInstance();
    await this.AcquireRuntimeLock();
    this.namespaceGeneration += 1;
    this.daemonNamespace = `avery-${process.pid}-${this.namespaceGeneration}`;
    const handle = await this.AttachExternalBrowser();
    let endpointValid = true;
    if (handle.cdpEndpoint) {
      try {
        const endpoint = new URL(handle.cdpEndpoint);
        const validBrowserPath = /^\/devtools\/browser\/[a-zA-Z0-9-]+$/.test(endpoint.pathname)
          || (handle.userAttached === true && endpoint.pathname === '/devtools/browser');
        endpointValid = endpoint.protocol === 'ws:' && endpoint.hostname === '127.0.0.1' && Number(endpoint.port) === handle.port
          && validBrowserPath && !endpoint.username && !endpoint.password;
      } catch { endpointValid = false; }
    }
    if (!Number.isSafeInteger(handle.port) || handle.port <= 0 || handle.port > 65_535 || !endpointValid || (!handle.userAttached && !handle.homeUrl)) {
      await handle.close().catch(() => undefined);
      throw new AgentBrowserError('BROWSER_START_FAILED', 'External browser returned an invalid CDP target.');
    }
    this.companionHandle = handle;
    this.running = true;
    this.lastRuntimeError = null;
    return handle;
  }

  /** 个人浏览器只建立浏览器级连接；任务标签页由首个页面工具按需创建。 */
  private async EnsurePersonalBrowserRuntime(options: { signal?: AbortSignal; deadline?: number } = {}): Promise<PersonalBrowserRuntimePort> {
    if (this.personalBrowserRuntime?.IsConnected()) return this.personalBrowserRuntime;
    if (this.personalBrowserRuntime) {
      // 连接状态不再承载任务授权；断线后可按任务持久授权重新建立受限连接。
      await this.personalBrowserRuntime.Close().catch(() => undefined);
      this.personalBrowserRuntime = null;
    }
    const browser = await this.EnsureExternalBrowser();
    if (!browser.cdpEndpoint) throw new AgentBrowserError('BROWSER_START_FAILED', 'External browser did not publish a usable browser-level CDP endpoint.');
    const runtime = this.createPersonalBrowserRuntime({ endpoint: browser.cdpEndpoint, anchorUrl: browser.homeUrl });
    try {
      const connected = await runtime.Connect(options);
      browser.homeUrl = connected.anchorUrl;
    } catch (error) {
      await runtime.Close().catch(() => undefined);
      if (error instanceof PersonalBrowserCdpError) {
        const code = ['BROWSER_CDP_CONNECTION_FAILED', 'BROWSER_COMMAND_FAILED', 'BROWSER_COMMAND_TIMEOUT'].includes(error.code)
          ? 'BROWSER_EXISTING_BROWSER_PERMISSION_REQUIRED'
          : error.code;
        const message = code === 'BROWSER_EXISTING_BROWSER_PERMISSION_REQUIRED'
          ? 'The selected browser did not authorize the debugging connection. Keep it open, approve its remote-debugging dialog, then try again.'
          : error.message;
        throw new AgentBrowserError(code, message, error.statusUnknown);
      }
      throw error;
    }
    this.personalBrowserRuntime = runtime;
    this.attachedEndpoint = browser.cdpEndpoint;
    this.running = true;
    this.lastRuntimeError = null;
    return runtime;
  }

  /** 同时淘汰 companion 与绑定它的 daemon；关闭失败不妨碍下一代 namespace 建立新会话。 */
  private async RetireBrowserInstance(): Promise<void> {
    const handle = this.companionHandle;
    const personalBrowserRuntime = this.personalBrowserRuntime;
    const namespace = this.daemonNamespace;
    const daemonActive = this.daemonActive;
    this.companionHandle = null;
    this.personalBrowserRuntime = null;
    this.attachedEndpoint = null;
    this.daemonActive = false;
    this.running = false;
    this.currentUrl = undefined;
    this.tabs.clear();
    this.InvalidateRefs();
    this.formService.Clear();
    // 锁定的 agent-browser >=0.33.1 会在 CDP 模式下只断开外部浏览器；必须关闭 daemon，避免个人浏览器会话残留后台进程。
    if (daemonActive && existsSync(this.executablePath)) {
      await this.InvokeCli([
        '--namespace', namespace, '--session', FixedSessionId, '--idle-timeout', '10s', 'close', '--json',
      ], { deadline: this.now() + 5_000 }).catch(() => undefined);
    }
    if (personalBrowserRuntime) await personalBrowserRuntime.Close().catch(() => undefined);
    if (handle) await handle.close().catch(() => undefined);
  }

  /** 以 PID 锁阻止多个应用进程同时驱动同一 Profile；崩溃遗留锁只在原 PID 已不存在时回收。 */
  private async AcquireRuntimeLock(): Promise<void> {
    if (this.ownsRuntimeLock) return;
    await mkdir(this.runtimeRoot, { recursive: true });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const handle = await open(this.runtimeLockPath, 'wx', 0o600);
        await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: new Date(this.now()).toISOString() }), 'utf8');
        await handle.close();
        this.ownsRuntimeLock = true;
        return;
      } catch (error: any) {
        if (error?.code !== 'EEXIST') throw error;
        let ownerPid = 0;
        try { ownerPid = Number(JSON.parse(await readFile(this.runtimeLockPath, 'utf8'))?.pid ?? 0); } catch { ownerPid = 0; }
        let ownerAlive = ownerPid > 0;
        if (ownerAlive) {
          try { process.kill(ownerPid, 0); } catch { ownerAlive = false; }
        }
        if (ownerAlive) throw new AgentBrowserError('BROWSER_PROFILE_BUSY', 'The browser profile is already controlled by another Avery process.');
        await unlink(this.runtimeLockPath).catch((unlinkError: any) => { if (unlinkError?.code !== 'ENOENT') throw unlinkError; });
      }
    }
    throw new AgentBrowserError('BROWSER_PROFILE_BUSY', 'The browser profile lock could not be acquired.');
  }

  private async InvokeCli(args: string[], options: { signal?: AbortSignal; deadline?: number; json?: boolean; stdin?: string } = {}): Promise<CliEnvelope> {
    if (options.signal?.aborted) throw new AgentBrowserError('CANCELLED', 'Browser command was cancelled.');
    const deadline = Math.min(options.deadline ?? Number.POSITIVE_INFINITY, this.now() + DefaultCommandTimeoutMs);
    const timeoutMs = Math.max(1, deadline - this.now());
    if (this.runProcess) return this.runProcess({ args, cwd: this.runtimeRoot, env: this.SanitizedEnvironment(), signal: options.signal, deadline, json: options.json !== false, ...(options.stdin === undefined ? {} : { stdin: options.stdin }) });
    return await new Promise<CliEnvelope>((resolvePromise, rejectPromise) => {
      let settled = false;
      let stdout = Buffer.alloc(0);
      let stderr = Buffer.alloc(0);
      // CLI 本身是后台控制进程；用户可见窗口由 companion 提供，隐藏控制台可避免 Windows PTY/控制台附着拖住命令退出。
      let child: ChildProcess;
      try {
        child = spawn(this.executablePath, args, { cwd: this.runtimeRoot, env: this.SanitizedEnvironment(), shell: false, windowsHide: true, stdio: [options.stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'agent-browser could not be started.';
        rejectPromise(new AgentBrowserError('BROWSER_START_FAILED', message));
        return;
      }
      this.activeChild = child;
      const Finish = (error?: Error, value?: CliEnvelope) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', Abort);
        if (this.activeChild === child) this.activeChild = null;
        if (error) rejectPromise(error); else resolvePromise(value ?? {});
      };
      const Abort = () => {
        try { child.kill(); } catch { /* 已退出时无需重复终止。 */ }
        Finish(new AgentBrowserError('CANCELLED', 'Browser command was cancelled.', true));
      };
      const timer = setTimeout(() => {
        try { child.kill(); } catch { /* 已退出时无需重复终止。 */ }
        Finish(new AgentBrowserError('BROWSER_COMMAND_TIMEOUT', 'Browser command timed out.', true));
      }, timeoutMs);
      options.signal?.addEventListener('abort', Abort, { once: true });
      child.stdout?.on('data', (chunk: Buffer) => {
        if (stdout.length >= MaxStdoutBytes) return;
        stdout = Buffer.concat([stdout, chunk.subarray(0, MaxStdoutBytes - stdout.length)]);
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        if (stderr.length >= MaxStderrBytes) return;
        stderr = Buffer.concat([stderr, chunk.subarray(0, MaxStderrBytes - stderr.length)]);
      });
      if (options.stdin !== undefined) child.stdin?.end(options.stdin, 'utf8');
      child.once('error', (error) => Finish(new AgentBrowserError('BROWSER_START_FAILED', error.message)));
      // agent-browser 会派生长寿命 daemon；Windows 上 daemon 可能暂时继承管道句柄，`close` 会等到所有句柄关闭而误报超时。
      // CLI 进程的 `exit` 才是单次命令终态，JSON 已在退出前写入 stdout。
      child.once('exit', (code) => {
        if (settled) return;
        const out = stdout.toString('utf8');
        if (options.json === false) {
          if (code === 0) Finish(undefined, { success: true, data: { output: out.trim() } });
          else Finish(new AgentBrowserError('BROWSER_COMMAND_FAILED', stderr.toString('utf8').trim().slice(0, 500) || `agent-browser exited with code ${code}.`));
          return;
        }
        let envelope: CliEnvelope;
        try { envelope = ExtractJson(out); } catch (error) { Finish(error as Error); return; }
        if (code !== 0 || envelope.success === false) {
          Finish(new AgentBrowserError('BROWSER_COMMAND_FAILED', String(envelope.error ?? envelope.message ?? stderr.toString('utf8') ?? 'Browser command failed.').slice(0, 500)));
          return;
        }
        Finish(undefined, envelope);
      });
    });
  }

  private async RunNow(command: string[], options: { signal?: AbortSignal; deadline?: number; json?: boolean; stdin?: string } = {}): Promise<CliEnvelope> {
    if (options.signal?.aborted) throw new AgentBrowserError('CANCELLED', 'Browser command was cancelled.');
    await mkdir(this.runtimeRoot, { recursive: true });
    if (this.browserEngine !== 'electron') {
      if (this.unattended && !this.HasCronAccess()) {
        throw new AgentBrowserError('BROWSER_CRON_ACCESS_REQUIRED', 'This CronTask was not authorized to use the personal browser when it was created. Create and confirm a new task.');
      }
      const runtime = await this.EnsurePersonalBrowserRuntime(options);
      try {
        return await runtime.Run(command, options);
      } catch (error) {
        if (error instanceof PersonalBrowserCdpError) throw new AgentBrowserError(error.code, error.message, error.statusUnknown);
        throw error;
      }
    }
    if (!existsSync(this.executablePath)) throw new AgentBrowserError('BROWSER_NOT_INSTALLED', `agent-browser ${basename(this.executablePath)} is unavailable.`);
    const browser = await this.EnsureCompanion();
    const endpoint = browser.cdpEndpoint ?? String(browser.port);
    if (this.attachedEndpoint !== endpoint) {
      this.daemonActive = true;
      const tabState = await this.InvokeCli([...this.FixedArgs(endpoint, false), 'tab', '--json'], { signal: options.signal, deadline: options.deadline });
      const tabs = Array.isArray(tabState.data?.tabs) ? tabState.data.tabs : [];
      const target = tabs.find((tab: any) => (browser.targetId && tab?.targetId === browser.targetId)
        || (typeof tab?.url === 'string' && tab.url === browser.homeUrl));
      if (!target?.tabId) {
        throw new AgentBrowserError('BROWSER_START_FAILED', 'Browser page target is unavailable.');
      }
      browser.homeUrl = String(target.url ?? browser.homeUrl ?? '');
      browser.targetId = typeof target.targetId === 'string' ? target.targetId : browser.targetId;
      if (target.active !== true) await this.InvokeCli([...this.FixedArgs(endpoint, false), 'tab', String(target.tabId), '--json'], { signal: options.signal, deadline: options.deadline });
      this.attachedEndpoint = endpoint;
    }
    const transport = PrepareCliTransport(command, options.stdin);
    const args = [...this.FixedArgs(endpoint), ...transport.command, ...(options.json === false ? [] : ['--json'])];
    return this.InvokeCli(args, { ...options, ...(transport.stdin === undefined ? {} : { stdin: transport.stdin }) });
  }

  private RunCommand(command: string[], options: { signal?: AbortSignal; deadline?: number; json?: boolean; stdin?: string } = {}): Promise<CliEnvelope> {
    const task = this.commandTail.then(() => this.RunNow(command, options));
    this.commandTail = task.then(() => undefined, () => undefined);
    return task;
  }

  private async ExecuteFormFillPlan(
    plan: FormFillPlan,
    options: { signal?: AbortSignal; deadline?: number },
  ): Promise<{ data: unknown; status: 'succeeded' }> {
    const completed: FormFillOperation[] = [];
    const skipped = [...plan.skipped];
    const hardDeadline = options.deadline ?? this.now() + 120_000;
    const softDeadline = Math.max(this.now(), hardDeadline - FormFillCleanupReserveMs);
    const LogField = (phase: string, operation: FormFillOperation, startedAt: number, code = '') => {
      const elapsedMs = Math.max(0, this.now() - startedAt);
      this.recordLog?.(code ? 'WARN' : 'INFO', 'browser.form_field',
        `phase=${phase} continuation=${plan.continuationId ?? 'none'} field=${operation.concept}:${operation.occurrence} kind=${operation.kind} elapsedMs=${elapsedMs}${code ? ` code=${code}` : ''}`);
    };
    const DismissSafely = async (operation?: FormFillOperation) => {
      if (this.now() >= hardDeadline) return;
      try {
        await this.formDriver.DismissTransientOverlay(
          { ...options, deadline: Math.min(hardDeadline, this.now() + 3_000) },
          operation,
        );
      } catch (error) {
        if (options.signal?.aborted || (error instanceof AgentBrowserError && error.code === 'CANCELLED')) throw error;
        this.recordLog?.('WARN', 'browser.form_cleanup',
          `continuation=${plan.continuationId ?? 'none'} code=${error instanceof AgentBrowserError ? error.code : 'cleanup_failed'}`);
      }
    };
    const ordinary = plan.operations.filter((operation) => operation.kind !== 'custom_select' && operation.kind !== 'custom_date');
    if (ordinary.length) {
      const successful: FormFillOperation[] = [];
      // 传输层每批最多处理 30 条命令，但填写计划不设总数上限，超出部分继续发送下一批。
      for (let offset = 0; offset < ordinary.length; offset += 30) {
        const batch = ordinary.slice(offset, offset + 30);
        if (this.now() >= softDeadline) {
          for (const operation of ordinary.slice(offset)) {
            skipped.push({ fieldId: `field-${operation.ref.replace(/^@/, '')}`, label: operation.label, reason: 'execution_budget_deferred' });
          }
          break;
        }
        const startedAt = this.now();
        for (const operation of batch) LogField('start', operation, startedAt);
        try {
          const stdin = JSON.stringify(batch.map((operation) => operation.kind === 'check'
            ? ['check', operation.ref]
            : [operation.kind, operation.ref, operation.value]));
          const response = await this.RunCommand(['batch'], {
            ...options,
            deadline: Math.min(softDeadline, this.now() + 30_000),
            stdin,
          });
          const results = Array.isArray(response.data?.results)
            ? response.data.results as Array<Record<string, unknown>>
            : Array.isArray(response.data) ? response.data as Array<Record<string, unknown>> : [];
          for (const [index, operation] of batch.entries()) {
            const result = results[index];
            if (result && result.success !== false && !result.error) {
              successful.push(operation);
              LogField('written', operation, startedAt);
            } else {
              skipped.push({ fieldId: `field-${operation.ref.replace(/^@/, '')}`, label: operation.label, reason: 'command_failed' });
              LogField('failed', operation, startedAt, 'command_failed');
            }
          }
        } catch (error) {
          if (options.signal?.aborted || (error instanceof AgentBrowserError && error.code === 'CANCELLED')) throw error;
          const reason = error instanceof AgentBrowserError && (error.statusUnknown || error.code === 'BROWSER_COMMAND_TIMEOUT')
            ? 'field_timeout'
            : 'batch_failed';
          for (const operation of batch) {
            skipped.push({ fieldId: `field-${operation.ref.replace(/^@/, '')}`, label: operation.label, reason });
            LogField(reason === 'field_timeout' ? 'timeout' : 'failed', operation, startedAt,
              error instanceof AgentBrowserError ? error.code : reason);
          }
          await DismissSafely();
        } finally {
          this.formService.RecordAttempted(plan, batch);
        }
      }
      if (successful.length) {
        let verifiedFields: FormField[] | undefined;
        try {
          const verificationOptions = { ...options, deadline: Math.min(hardDeadline, this.now() + 10_000) };
          const verification = this.browserEngine === 'electron'
            ? await this.formDriver.InspectForm(verificationOptions)
            : await this.RunCommand(['snapshot', '-i', '-c', '--urls'], verificationOptions);
          verifiedFields = FormFields(verification.data?.refs && typeof verification.data.refs === 'object' ? verification.data.refs : {}, this.pageRevision);
        } catch (error) {
          if (options.signal?.aborted || (error instanceof AgentBrowserError && error.code === 'CANCELLED')) throw error;
        }
        if (verifiedFields) {
          for (const operation of successful) {
            const exact = verifiedFields.find((field) => field.ref === operation.ref);
            const semantic = verifiedFields.filter((field) => field.semantic.concept === operation.concept)[operation.occurrence];
            const verified = exact ?? semantic;
            if (verified?.filled === true) {
              completed.push(operation);
              LogField('completed', operation, this.now());
            } else {
              skipped.push({ fieldId: `field-${operation.ref.replace(/^@/, '')}`, label: operation.label, reason: 'postcondition_failed' });
              LogField('failed', operation, this.now(), 'postcondition_failed');
            }
          }
        } else {
          for (const operation of successful) {
            skipped.push({ fieldId: `field-${operation.ref.replace(/^@/, '')}`, label: operation.label, reason: 'verification_timeout' });
            LogField('timeout', operation, this.now(), 'verification_timeout');
          }
        }
      }
    }
    const allDynamic = plan.operations.filter((candidate) => candidate.kind === 'custom_select' || candidate.kind === 'custom_date');
    for (const operation of allDynamic) {
      if (this.now() >= softDeadline) {
        skipped.push({ fieldId: `field-${operation.ref.replace(/^@/, '')}`, label: operation.label, reason: 'execution_budget_deferred' });
        continue;
      }
      const startedAt = this.now();
      LogField('start', operation, startedAt);
      // 单字段共享本次工具剩余预算。北森的日期和地区控件包含多次快照与级联交互，
      // 额外的 12 秒字段 deadline 会在控件即将提交时将其误判为超时。
      const fieldOptions = { ...options, deadline: softDeadline };
      try {
        await this.formDriver.DismissTransientOverlay(fieldOptions);
        const result = operation.kind === 'custom_date'
          ? await this.formDriver.ExecuteCustomDate(operation, fieldOptions)
          : await this.formDriver.ExecuteCustomSelect(operation, fieldOptions);
        if (result.filled) {
          completed.push(operation);
          LogField('completed', operation, startedAt);
        } else {
          const reason = result.reason ?? 'option_not_found';
          skipped.push({ fieldId: `field-${operation.ref.replace(/^@/, '')}`, label: operation.label, reason });
          LogField('skipped', operation, startedAt, reason);
        }
      } catch (error) {
        if (options.signal?.aborted || (error instanceof AgentBrowserError && error.code === 'CANCELLED')) throw error;
        if (error instanceof AgentBrowserError && (error.statusUnknown || error.code === 'BROWSER_COMMAND_TIMEOUT')) {
          skipped.push({ fieldId: `field-${operation.ref.replace(/^@/, '')}`, label: operation.label, reason: 'field_timeout' });
          LogField('timeout', operation, startedAt, error.code);
          await DismissSafely(operation);
          continue;
        }
        const reason = error instanceof AgentBrowserError && /covered by/i.test(error.message) ? 'element_covered' : 'dynamic_action_failed';
        skipped.push({ fieldId: `field-${operation.ref.replace(/^@/, '')}`, label: operation.label, reason });
        LogField('failed', operation, startedAt, error instanceof AgentBrowserError ? error.code : reason);
        await DismissSafely(operation);
      } finally {
        this.formService.RecordAttempted(plan, [operation]);
      }
    }
    // URL 刷新仅用于补充结果，不能让已完成的填写因收尾读取超时而变成整次工具失败。
    if (this.now() < hardDeadline) {
      try {
        await this.RefreshCurrentUrl(options.signal, Math.min(hardDeadline, this.now() + 5_000));
      } catch (error) {
        if (options.signal?.aborted || (error instanceof AgentBrowserError && error.code === 'CANCELLED')) throw error;
        this.recordLog?.('WARN', 'browser.form_finalize',
          `continuation=${plan.continuationId ?? 'none'} code=${error instanceof AgentBrowserError ? error.code : 'url_refresh_failed'}`);
      }
    }
    this.formService.RecordCompleted(plan, completed);
    if (plan.operations.some((operation) => operation.kind !== 'fill')) this.InvalidateRefs();
    const needsContinuation = plan.ambiguous.length > 0
      || plan.missingFields.length > 0
      || skipped.some((item) => item.reason === 'reinspect_after_selection' || item.reason === 'execution_budget_deferred');
    this.formService.Finish(plan, needsContinuation);
    return {
      data: {
        filledCount: completed.length,
        filled: completed.map((operation) => ({
          fieldId: `field-${operation.ref.replace(/^@/, '')}`,
          label: operation.label,
          concept: operation.concept,
          strategy: operation.strategy,
          control: operation.kind === 'fill' ? 'text' : operation.kind === 'check' ? 'radio' : 'select',
        })),
        skipped: skipped.slice(0, 100),
        missingFields: plan.missingFields,
        ambiguous: plan.publicAmbiguous ?? [],
        unmatched: plan.unmatched,
        remainingCount: skipped.filter((item) => item.reason === 'reinspect_after_selection' || item.reason === 'execution_budget_deferred').length,
        done: !needsContinuation,
        ...(needsContinuation && plan.continuationId ? { continuationId: plan.continuationId } : {}),
        pageRevision: this.pageRevision,
        currentUrl: this.currentUrl,
      },
      status: 'succeeded',
    };
  }

  private InvalidateRefs(): void {
    this.pageRevision += 1;
    this.refs.clear();
    this.formService.ClearPlans();
    this.personalBrowserRuntime?.ResetReferences();
  }

  private RefMetadata(value: unknown, expectedRevision: unknown): { ref: string; metadata: Record<string, unknown> } {
    const ref = RequireString(value, 'ref', 100).replace(/^@/, '');
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision !== this.pageRevision) throw new AgentBrowserError('BROWSER_STALE_PAGE_REF', 'The page changed after this element reference was observed. Take a new snapshot.');
    const metadata = this.refs.get(ref);
    if (!metadata) throw new AgentBrowserError('BROWSER_STALE_PAGE_REF', 'The browser element reference is unavailable. Take a new snapshot.');
    return { ref: `@${ref}`, metadata };
  }

  private async RefreshCurrentUrl(signal?: AbortSignal, deadline?: number): Promise<string | undefined> {
    const response = await this.RunCommand(['get', 'url'], { signal, deadline });
    const value = response.data?.url ?? response.data?.value ?? response.data;
    if (typeof value !== 'string' || !value) return this.currentUrl;
    if (value === this.companionHandle?.homeUrl && this.companionHandle?.userAttached !== true) {
      this.currentUrl = undefined;
      return undefined;
    }
    const nextUrl = await this.normalizeNavigationUrl(value);
    if (this.companionHandle?.userAttached === true && !IsBossBrowserUrl(nextUrl)) {
      throw new AgentBrowserError('BROWSER_NAVIGATION_DENIED', 'The attached personal-browser tab left zhipin.com. Avery stopped before reading or interacting with that page.');
    }
    if (this.currentUrl && this.currentUrl !== nextUrl) this.InvalidateRefs();
    this.currentUrl = nextUrl;
    this.ThrowIfBossRisk();
    return this.currentUrl;
  }

  private ThrowIfBossRisk(pageText?: unknown): void {
    const risk = DetectBossRisk({ url: this.currentUrl, pageText: typeof pageText === 'string' ? pageText : JSON.stringify(pageText ?? '') });
    if (!risk) return;
    const message = risk === 'rate_limit'
      ? 'BOSS reported excessive request frequency. Browser automation has stopped; wait before trying again.'
      : risk === 'account_restriction'
        ? 'BOSS reported an account restriction. Browser automation has stopped for manual review.'
        : 'BOSS requires security verification. Complete it in the visible browser before continuing.';
    this.lastRuntimeError = { code: 'BROWSER_SITE_RISK_DETECTED', message };
    throw new AgentBrowserError('BROWSER_SITE_RISK_DETECTED', message);
  }

  private async PaceBossAction(proposal: BrowserActionProposal, signal?: AbortSignal): Promise<void> {
    if (!BossActionTools.has(proposal.toolName)) return;
    const targetUrl = proposal.toolName === 'BrowserNavigate' ? proposal.canonicalArguments.url : proposal.url ?? this.currentUrl;
    if (!IsBossBrowserUrl(targetUrl)) return;
    const elapsed = this.lastBossActionAt ? this.now() - this.lastBossActionAt : BossActionIntervalMs;
    const waitMs = Math.max(0, BossActionIntervalMs - elapsed);
    if (waitMs) {
      try { await this.delay(waitMs, signal); }
      catch { throw new AgentBrowserError('CANCELLED', 'Browser action was cancelled while waiting for the BOSS safety interval.', true); }
    }
    this.lastBossActionAt = this.now();
  }

  /** FillForm 自行获取当前表单快照；DOM 引用和 pageRevision 不再由模型在两次工具间搬运。 */
  private async InspectCurrentFormForFill(): Promise<FormField[]> {
    const response = await this.formDriver.InspectForm({});
    this.ThrowIfBossRisk(response.data);
    this.pageRevision += 1;
    const rawRefs = response.data?.refs && typeof response.data.refs === 'object' ? response.data.refs as Record<string, unknown> : {};
    this.refs = new Map(Object.entries(rawRefs).map(([key, value]) => [key.replace(/^@/, ''), value && typeof value === 'object' ? value as Record<string, unknown> : {}]));
    await this.RefreshCurrentUrl();
    return FormFields(rawRefs, this.pageRevision);
  }

  async Prepare({ toolName, arguments: raw }: { toolName: BrowserToolName; arguments: Record<string, unknown> }): Promise<BrowserActionProposal> {
    const args: Record<string, unknown> = { ...raw };
    let metadata: Record<string, unknown> = {};
    if (toolName === 'BrowserNavigate') {
      args.url = await this.normalizeNavigationUrl(args.url);
      if (this.browserEngine !== 'electron' && !IsBossBrowserUrl(args.url)) {
        throw new AgentBrowserError('BROWSER_NAVIGATION_DENIED', 'The attached personal-browser mode is restricted to zhipin.com. Use the isolated browser for other sites.');
      }
    }
    else if (this.running) await this.RefreshCurrentUrl();
    const targetUrl = toolName === 'BrowserNavigate' ? args.url : this.currentUrl;
    if (this.unattended && IsBossBrowserUrl(targetUrl)) {
      const cronAccessAllowed = this.browserEngine !== 'electron' && this.HasCronAccess();
      if (!cronAccessAllowed) {
        const code = this.browserEngine === 'electron' ? 'BROWSER_SITE_VISIBLE_REQUIRED' : 'BROWSER_CRON_ACCESS_REQUIRED';
        throw new AgentBrowserError(code, this.browserEngine === 'electron'
          ? 'BOSS automation requires a visible personal browser authorized for this CronTask.'
          : 'This CronTask was not authorized to use the personal browser when it was created. Create and confirm a new task.');
      }
    }
    if (toolName === 'BrowserFillForm') {
      const existingPlanId = typeof args.planId === 'string' ? args.planId : '';
      if (existingPlanId) {
        const existing = this.formService.GetPlan(existingPlanId, this.pageRevision, this.now());
        metadata = { labels: existing.operations.map((operation) => operation.label), sourceTitles: existing.sourceTitles };
      } else {
        if (Number.isSafeInteger(args.pageRevision) && args.pageRevision !== this.pageRevision) throw new AgentBrowserError('BROWSER_STALE_PAGE_REF', 'The form changed after it was inspected.');
        const privateSources = args.__formSources;
        const fields = await this.InspectCurrentFormForFill();
        const prepared = this.formService.Prepare({
          fields,
          pageRevision: this.pageRevision,
          now: this.now(),
          ...(this.currentUrl ? { url: this.currentUrl } : {}),
          ...(privateSources && typeof privateSources === 'object' && !Array.isArray(privateSources) ? { sources: privateSources as Record<string, unknown> } : {}),
          ...(typeof args.continuationId === 'string' ? { continuationId: args.continuationId } : {}),
          resolutions: args.resolutions,
          decisions: args.__formDecisions,
          legacyMappings: args.mappings,
        });
        const { plan, planId, planHash, continuationId } = prepared;
        delete args.__formSources;
        delete args.__formDecisions;
        delete args.decisions;
        delete args.mappings;
        delete args.pageRevision;
        args.planId = planId;
        args.continuationId = continuationId;
        args.planHash = planHash;
        args.matchedRefs = plan.operations.slice(0, 30).map((operation) => operation.ref);
        args.operationCount = plan.operations.length;
        metadata = { labels: plan.operations.map((operation) => operation.label), sourceTitles: plan.sourceTitles };
      }
    }
    if (['BrowserClick', 'BrowserFill', 'BrowserSelect', 'BrowserSetChecked', 'BrowserUploadFile'].includes(toolName)) {
      const resolved = this.RefMetadata(args.ref, args.pageRevision);
      args.ref = resolved.ref;
      metadata = resolved.metadata;
    }
    if (toolName === 'BrowserFill') args.text = RequireString(args.text, 'text');
    if (toolName === 'BrowserSelect') args.value = RequireString(args.value, 'value', 2_000);
    if (toolName === 'BrowserSetChecked' && typeof args.checked !== 'boolean') throw new AgentBrowserError('BROWSER_ARGUMENT_INVALID', 'checked must be boolean.');
    if (toolName === 'BrowserPressKey') args.key = RequireString(args.key, 'key', 50);
    if (toolName === 'BrowserUploadFile') args.fileId = RequireString(args.fileId, 'fileId', 1_000);
    if (toolName === 'BrowserSwitchTab') {
      args.tabId = RequireString(args.tabId, 'tabId', 200);
      if (!this.tabs.has(args.tabId as string)) throw new AgentBrowserError('BROWSER_TAB_NOT_FOUND', 'The browser tab is not registered in this session.');
    }
    const targetText = toolName === 'BrowserFillForm'
      ? ((metadata.labels as string[] | undefined) ?? []).slice(0, 5).join('、')
      : [metadata.name, metadata.description, metadata.role, metadata.type].filter((value) => typeof value === 'string').join(' ');
    const strongAction = /submit|apply|send|authorize|delete|withdraw|agree|投递|提交|发送|授权|删除|撤回|同意/i.test(targetText);
    const agreement = toolName === 'BrowserSetChecked' && /terms|privacy|agreement|协议|隐私|条款/i.test(targetText);
    const enter = toolName === 'BrowserPressKey' && /^(enter|return)$/i.test(String(args.key));
    const forceConfirmation = toolName === 'BrowserUploadFile' || strongAction || agreement || enter;
    const risk: BrowserActionProposal['risk'] = forceConfirmation ? 'high'
      : ['BrowserFill', 'BrowserFillForm', 'BrowserSelect', 'BrowserSetChecked', 'BrowserClick'].includes(toolName) ? 'medium' : 'low';
    const summary = toolName === 'BrowserNavigate' ? `打开 ${String(args.url)}`
      : toolName === 'BrowserUploadFile' ? `向 ${targetText || String(args.ref)} 上传已授权文件`
        : toolName === 'BrowserFillForm' ? `使用 ${((metadata.sourceTitles as string[] | undefined) ?? []).join('、') || '已授权资料'} 填写 ${((metadata.labels as string[] | undefined) ?? []).length} 个表单字段${targetText ? `：${targetText}` : ''}`
        : `${toolName} ${targetText || String(args.ref ?? args.key ?? args.tabId ?? '')}`.trim();
    return {
      proposalHash: HashProposal(toolName, args, this.pageRevision, this.currentUrl),
      toolName,
      canonicalArguments: args,
      summary: summary.slice(0, 500),
      risk,
      forceConfirmation,
      pageRevision: this.pageRevision,
      ...(this.currentUrl ? { url: this.currentUrl } : {}),
      resourceIds: [`browser:${FixedSessionId}`],
    };
  }

  async Execute({ proposal, signal, deadline }: { proposal: BrowserActionProposal; signal?: AbortSignal; deadline?: number }): Promise<{ data: unknown; status: 'succeeded' | 'status_unknown' }> {
    const refreshed = await this.Prepare({ toolName: proposal.toolName, arguments: proposal.canonicalArguments });
    if (refreshed.proposalHash !== proposal.proposalHash) throw new AgentBrowserError('BROWSER_PROPOSAL_STALE', 'The browser page changed after the action was prepared.');
    await this.PaceBossAction(proposal, signal);
    const args = proposal.canonicalArguments;
    let command: string[];
    switch (proposal.toolName) {
      case 'BrowserNavigate': command = ['open', String(args.url)]; break;
      case 'BrowserSnapshot': command = ['snapshot', '-i', '-c', '--urls']; break;
      case 'BrowserScreenshot': command = ['screenshot', join(this.runtimeRoot, 'screenshots', `${randomUUID()}.png`)]; break;
      case 'BrowserReadPage': command = ['read']; break;
      case 'BrowserInspectForm': command = ['snapshot', '-i', '-c', '--urls']; break;
      case 'BrowserClick': command = ['click', String(args.ref)]; break;
      case 'BrowserFill': command = ['fill', String(args.ref), String(args.text)]; break;
      case 'BrowserFillForm': {
        this.formService.GetPlan(String(args.planId ?? ''), this.pageRevision, this.now());
        command = [];
        break;
      }
      case 'BrowserValidateForm': command = ['snapshot', '-i', '-c', '--urls']; break;
      case 'BrowserSelect': command = ['select', String(args.ref), String(args.value)]; break;
      case 'BrowserSetChecked': command = [args.checked ? 'check' : 'uncheck', String(args.ref)]; break;
      case 'BrowserPressKey': command = ['press', String(args.key)]; break;
      case 'BrowserUploadFile': {
        const filePath = await this.resolveUploadFile(String(args.fileId));
        if (!filePath || !isAbsolute(filePath) || !existsSync(filePath)) throw new AgentBrowserError('BROWSER_FILE_NOT_AUTHORIZED', 'The upload file is unavailable or not authorized.');
        const authorizedPath = realpathSync(filePath);
        const fileStat = statSync(authorizedPath);
        if (!fileStat.isFile() || fileStat.size > MaxUploadBytes) throw new AgentBrowserError('BROWSER_FILE_NOT_AUTHORIZED', 'The upload file is not a regular file or exceeds the 25 MB limit.');
        command = ['upload', String(args.ref), authorizedPath];
        break;
      }
      case 'BrowserWait': {
        const kind = String(args.kind ?? 'load');
        const value = RequireString(args.value, 'value', 2_000);
        if (kind === 'selector') command = ['wait', value];
        else if (kind === 'text') command = ['wait', '--text', value];
        else if (kind === 'url') command = ['wait', '--url', value];
        else if (kind === 'load' && ['load', 'domcontentloaded', 'networkidle'].includes(value)) command = ['wait', '--load', value];
        else throw new AgentBrowserError('BROWSER_ARGUMENT_INVALID', 'Browser wait condition is invalid.');
        break;
      }
      case 'BrowserSwitchTab': command = ['tab', String(args.tabId)]; break;
      case 'BrowserGoBack': command = ['back']; break;
      default: throw new AgentBrowserError('BROWSER_COMMAND_NOT_ALLOWED', 'Browser command is not allowed.');
    }
    if (proposal.toolName === 'BrowserNavigate') {
      let lastError: unknown;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          const response = await this.RunCommand(command, { signal, deadline });
          this.running = true;
          this.InvalidateRefs();
          await this.RefreshCurrentUrl(signal, deadline);
          this.lastRuntimeError = null;
          return { data: { ...response.data, pageRevision: this.pageRevision, currentUrl: this.currentUrl }, status: 'succeeded' };
        } catch (error) {
          lastError = error;
          const code = error instanceof AgentBrowserError ? error.code : 'BROWSER_COMMAND_FAILED';
          this.lastRuntimeError = { code, message: error instanceof Error ? error.message : 'Browser navigation failed.' };
          // 风控页面必须留在可见窗口供用户核对，不能关闭后换新实例自动重试。
          if (code !== 'BROWSER_SITE_RISK_DETECTED') await this.RetireBrowserInstance();
          // 导航不产生投递、上传或消息副作用；仅对传输/启动故障进行一次全新实例重试。
          const recoverable = error instanceof AgentBrowserError
            && ['BROWSER_COMMAND_FAILED', 'BROWSER_COMMAND_TIMEOUT', 'BROWSER_START_FAILED'].includes(error.code);
          if (attempt === 0 && recoverable && !signal?.aborted) continue;
          if (error instanceof AgentBrowserError && error.statusUnknown) return { data: { code: error.code, message: error.message }, status: 'status_unknown' };
          throw error;
        }
      }
      throw lastError;
    }
    const screenshotPath = proposal.toolName === 'BrowserScreenshot' ? command[1] : undefined;
    try {
      if (screenshotPath) await mkdir(join(this.runtimeRoot, 'screenshots'), { recursive: true });
      if (proposal.toolName === 'BrowserFillForm') {
        const plan = this.formService.GetPlan(String(args.planId ?? ''), this.pageRevision, this.now());
        return await this.ExecuteFormFillPlan(plan, { signal, deadline });
      }
      const response = this.browserEngine === 'electron' && ['BrowserInspectForm', 'BrowserValidateForm'].includes(proposal.toolName)
        ? await this.formDriver.InspectForm({ signal, deadline })
        : await this.RunCommand(command, { signal, deadline });
      this.running = true;
      if (['BrowserSnapshot', 'BrowserReadPage', 'BrowserInspectForm', 'BrowserValidateForm'].includes(proposal.toolName)) this.ThrowIfBossRisk(response.data);
      if (screenshotPath) {
        const image = await readFile(screenshotPath);
        const pngSignature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
        if (image.length === 0 || image.length > MaxScreenshotBytes || !pngSignature.every((value, index) => image[index] === value)) {
          throw new AgentBrowserError('BROWSER_OUTPUT_INVALID', 'BrowserScreenshot did not produce a valid PNG image within the 16 MiB limit.');
        }
        return {
          data: {
            imageDataUrl: `data:image/png;base64,${image.toString('base64')}`,
            byteSize: image.length,
            pageRevision: this.pageRevision,
            currentUrl: this.currentUrl,
          },
          status: 'succeeded',
        };
      }
      if (['BrowserSnapshot', 'BrowserInspectForm', 'BrowserValidateForm'].includes(proposal.toolName)) {
        this.pageRevision += 1;
        const rawRefs = response.data?.refs && typeof response.data.refs === 'object' ? response.data.refs : {};
        this.refs = new Map(Object.entries(rawRefs).map(([key, value]) => [key.replace(/^@/, ''), value && typeof value === 'object' ? value as Record<string, unknown> : {}]));
        const fields = FormFields(rawRefs, this.pageRevision);
        if (proposal.toolName === 'BrowserInspectForm') {
          return { data: { fields, fieldCount: fields.length, truncated: response.data?.truncated === true, pageRevision: this.pageRevision, currentUrl: this.currentUrl }, status: 'succeeded' };
        }
        if (proposal.toolName === 'BrowserValidateForm') {
          const validationMetadataAvailable = fields.some((field) => field.required !== undefined || field.valid !== undefined);
          const issues = fields.flatMap((field) => {
            if (field.disabled || field.readOnly) return [];
            if (field.required && field.filled === false) return [{ ref: field.ref, label: field.label, code: 'required' }];
            if (field.valid === false) return [{ ref: field.ref, label: field.label, code: 'invalid', ...(field.validationMessage ? { message: field.validationMessage } : {}) }];
            return [];
          });
          return {
            data: {
              valid: validationMetadataAvailable ? issues.length === 0 : null,
              issues,
              inspectedFieldCount: fields.length,
              validationMetadataAvailable,
              pageRevision: this.pageRevision,
              currentUrl: this.currentUrl,
            },
            status: 'succeeded',
          };
        }
        const tabsResponse = await this.RunCommand(['tab'], { signal, deadline });
        const allTabs = Array.isArray(tabsResponse.data?.tabs) ? tabsResponse.data.tabs : Array.isArray(tabsResponse.data) ? tabsResponse.data : [];
        const internalUrls = new Set(this.companionHandle?.internalUrls ?? []);
        const rawTabs = allTabs.filter((tab: any) => !internalUrls.has(String(tab?.url ?? ''))
          && (this.companionHandle?.userAttached !== true || IsBossBrowserUrl(tab?.url)));
        this.tabs = new Set(rawTabs.map((tab: any) => String(tab?.tabId ?? tab?.id ?? '')).filter(Boolean));
        return { data: { ...response.data, pageRevision: this.pageRevision, tabs: rawTabs, currentUrl: this.currentUrl }, status: 'succeeded' };
      }
      if (['BrowserClick', 'BrowserSelect', 'BrowserPressKey', 'BrowserSwitchTab', 'BrowserGoBack'].includes(proposal.toolName)) {
        this.InvalidateRefs();
      }
      this.lastRuntimeError = null;
      return { data: { ...response.data, pageRevision: this.pageRevision, currentUrl: this.currentUrl }, status: 'succeeded' };
    } catch (error) {
      const retireForFailure = error instanceof AgentBrowserError
        && (error.code === 'BROWSER_START_FAILED'
          || (error.code === 'BROWSER_COMMAND_TIMEOUT' && proposal.toolName !== 'BrowserFillForm'));
      if (retireForFailure && error instanceof AgentBrowserError) {
        this.lastRuntimeError = { code: error.code, message: error.message };
        await this.RetireBrowserInstance();
      }
      if (error instanceof AgentBrowserError && error.statusUnknown) return { data: { code: error.code, message: error.message }, status: 'status_unknown' };
      throw error;
    } finally {
      if (proposal.toolName === 'BrowserFillForm') this.formService.DeletePlan(String(args.planId ?? ''));
      if (screenshotPath) await unlink(screenshotPath).catch((error: any) => { if (error?.code !== 'ENOENT') throw error; });
    }
  }

  /**
   * 为 Host 内置站点适配器执行固定只读提取表达式。该入口不进入 Tool Registry，
   * 调用方只能是随应用发布的受信任代码，模型文本和网页内容不得构造 expression。
   */
  async EvaluateTrustedPage(input: { site: 'boss_zhipin'; expression: string; signal?: AbortSignal; deadline?: number }): Promise<unknown> {
    if (input.site !== 'boss_zhipin' || typeof input.expression !== 'string' || !input.expression.trim()
      || Buffer.byteLength(input.expression, 'utf8') > 256_000) {
      throw new AgentBrowserError('BROWSER_ARGUMENT_INVALID', 'Trusted page extraction input is invalid.');
    }
    const currentUrl = await this.RefreshCurrentUrl(input.signal, input.deadline);
    if (!IsBossBrowserUrl(currentUrl)) {
      throw new AgentBrowserError('BROWSER_NAVIGATION_DENIED', 'The BOSS collector can only inspect a zhipin.com page.');
    }
    const encoded = Buffer.from(input.expression, 'utf8').toString('base64');
    const response = await this.RunCommand(['eval', '-b', encoded], { signal: input.signal, deadline: input.deadline });
    this.running = true;
    this.ThrowIfBossRisk(response.data);
    return response.data?.result ?? response.data?.value ?? response.data;
  }

  async GetStatus(probeConnection = false): Promise<{ available: boolean; profileExists: boolean; running: boolean; pageRevision: number; state: 'not_installed' | 'stopped' | 'ready' | 'unhealthy'; engine: BrowserEngine; message?: string; currentUrl?: string }> {
    // 外部浏览器可能是便携安装；是否可附着只能在执行时通过本机 CDP 判断，不能用标准安装路径误判。
    const browserAvailable = this.browserEngine === 'electron' ? existsSync(this.companionExecutablePath) : true;
    const available = this.browserEngine === 'electron' ? existsSync(this.executablePath) && browserAvailable : browserAvailable;
    let running = this.browserEngine === 'electron'
      ? Boolean(this.companionHandle && (this.companionHandle.isAlive?.() ?? true))
      : Boolean(this.personalBrowserRuntime?.IsConnected());
    let attachable = false;
    let attachMessage: string | undefined;
    if (available && !running && this.browserEngine !== 'electron') {
      if (probeConnection) {
        try {
          // 只连接浏览器级 WebSocket 并读取 target 列表；不创建任务页、不启用 Runtime 域。
          await this.EnsurePersonalBrowserRuntime({ deadline: this.now() + DefaultCommandTimeoutMs });
          running = true;
          attachable = true;
          this.lastRuntimeError = null;
        } catch (error) {
          const code = error instanceof AgentBrowserError ? error.code : 'BROWSER_COMMAND_FAILED';
          const message = error instanceof Error ? error.message : 'The selected browser connection test failed.';
          await this.RetireBrowserInstance();
          this.lastRuntimeError = { code, message };
          attachMessage = message;
        }
      } else {
        try { await this.AttachExternalBrowser(); attachable = true; }
        catch (error) { attachMessage = error instanceof Error ? error.message : 'The selected browser is not ready for attachment.'; }
      }
    }
    const state = !available ? 'not_installed' : this.lastRuntimeError ? 'unhealthy' : running || attachable ? 'ready' : 'stopped';
    const message = this.lastRuntimeError?.message ?? attachMessage;
    return { available, profileExists: this.browserEngine === 'electron' && existsSync(this.electronProfilePath), running, pageRevision: this.pageRevision, state, engine: this.browserEngine, ...(message ? { message } : {}), ...(this.currentUrl ? { currentUrl: this.currentUrl } : {}) };
  }

  async ClearProfile(): Promise<{ cleared: boolean }> {
    if (this.browserEngine !== 'electron') throw new AgentBrowserError('BROWSER_PROFILE_NOT_MANAGED', 'Avery does not manage or clear personal browser data.');
    await this.Close();
    const profilePath = this.electronProfilePath;
    const resolvedTarget = resolve(profilePath);
    if (resolvedTarget !== profilePath || !resolvedTarget.startsWith(`${this.runtimeRoot}${sep}`)) throw new Error('Browser profile cleanup target is invalid.');
    await rm(resolvedTarget, { recursive: true, force: true });
    this.currentUrl = undefined;
    this.pageRevision = 0;
    this.refs.clear();
    this.tabs.clear();
    return { cleared: true };
  }

  ResetPageReferences(): void {
    this.InvalidateRefs();
    this.formService.Clear();
  }

  async Close(): Promise<void> {
    if (this.activeChild) {
      try { this.activeChild.kill(); } catch { /* 已退出时无需重复终止。 */ }
    }
    await this.RetireBrowserInstance();
    this.scheduledCronTaskId = null;
    this.scheduledBrowserAuthorized = false;
    this.unattended = false;
    this.lastRuntimeError = null;
    this.refs.clear();
    this.formService.Clear();
    this.tabs.clear();
    if (this.ownsRuntimeLock) {
      await unlink(this.runtimeLockPath).catch((error: any) => { if (error?.code !== 'ENOENT') throw error; });
      this.ownsRuntimeLock = false;
    }
  }
}
