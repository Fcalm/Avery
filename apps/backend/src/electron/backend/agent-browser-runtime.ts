import { createHash } from 'node:crypto';
import { promises as dns } from 'node:dns';
import { existsSync, realpathSync, statSync } from 'node:fs';
import { mkdir, open, readFile, rm, unlink } from 'node:fs/promises';
import { isIP } from 'node:net';
import { basename, isAbsolute, join, resolve, sep } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { setTimeout as Delay } from 'node:timers/promises';
import type { BrowserActionProposal, BrowserAutomationPort, BrowserToolName } from '@offerget/agent-sdk';

const MaxStdoutBytes = 1024 * 1024;
const MaxStderrBytes = 64 * 1024;
// 冷启动时首次 CDP 导航在低性能 Windows 环境可接近 30 秒；具体工具仍会用更短 deadline 收窄普通动作。
const DefaultCommandTimeoutMs = 60_000;
const MaxUploadBytes = 25 * 1024 * 1024;
const FixedSessionId = 'offerget-default';

export type AgentBrowserCliEnvelope = { success?: boolean; data?: any; error?: string; message?: string };
type CliEnvelope = AgentBrowserCliEnvelope;

export class AgentBrowserError extends Error {
  constructor(public readonly code: string, message: string, public readonly statusUnknown = false) {
    super(message);
    this.name = 'AgentBrowserError';
  }
}

/** 构造隔离伴随进程的固定参数数组；路径始终作为单个参数传递，禁止经过 Shell 解释。 */
export function BuildBrowserCompanionArgs(input: { appPath?: string; profilePath: string; parentPid: number }): string[] {
  return [
    ...(input.appPath ? [input.appPath] : []),
    '--offerget-browser-companion',
    `--offerget-browser-profile=${input.profilePath}`,
    `--offerget-browser-parent-pid=${input.parentPid}`,
    '--remote-debugging-address=127.0.0.1',
    '--remote-debugging-port=0',
    `--user-data-dir=${input.profilePath}`,
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
  /** 仅供契约测试注入隔离 Electron 伴随进程；生产路径始终启动应用自身的 companion 模式。 */
  launchCompanion?: (input: { profilePath: string; runtimeRoot: string }) => Promise<{ port: number; close: () => Promise<void>; isAlive?: () => boolean; homeUrl?: string; internalUrls?: string[] }>;
}

/** 单 Profile 串行 Runtime；所有 CLI 参数、页面引用、文件解析与进程取消均由此边界持有。 */
export class AgentBrowserRuntime implements BrowserAutomationPort {
  private readonly executablePath: string;
  private readonly companionExecutablePath: string;
  private readonly companionAppPath?: string;
  private readonly runtimeRoot: string;
  private readonly profilePath: string;
  private readonly runtimeLockPath: string;
  private readonly resolveUploadFile: AgentBrowserRuntimeOptions['resolveUploadFile'];
  private readonly now: () => number;
  private readonly normalizeNavigationUrl: (value: unknown) => Promise<string>;
  private readonly runProcess?: AgentBrowserRuntimeOptions['runProcess'];
  private readonly launchCompanion?: AgentBrowserRuntimeOptions['launchCompanion'];
  private commandTail: Promise<void> = Promise.resolve();
  private activeChild: ChildProcess | null = null;
  private companionHandle: { port: number; close: () => Promise<void>; isAlive?: () => boolean; homeUrl?: string; internalUrls?: string[] } | null = null;
  private attachedPort: number | null = null;
  private running = false;
  private ownsRuntimeLock = false;
  private pageRevision = 0;
  private currentUrl: string | undefined;
  private refs = new Map<string, Record<string, unknown>>();
  private tabs = new Set<string>();
  // namespace 同时绑定 Backend 进程与 companion 代次；companion 换端口后绝不复用旧 daemon 的 CDP 会话。
  private namespaceGeneration = 0;
  private daemonNamespace = `offerget-${process.pid}-0`;
  private daemonActive = false;
  private lastRuntimeError: { code: string; message: string } | null = null;

  constructor(options: AgentBrowserRuntimeOptions) {
    this.executablePath = resolve(options.executablePath);
    this.companionExecutablePath = resolve(options.companionExecutablePath);
    this.companionAppPath = options.companionAppPath ? resolve(options.companionAppPath) : undefined;
    this.runtimeRoot = resolve(options.runtimeRoot);
    this.profilePath = resolve(this.runtimeRoot, 'profiles', 'default');
    this.runtimeLockPath = resolve(this.runtimeRoot, 'runtime.lock');
    this.resolveUploadFile = options.resolveUploadFile;
    this.now = options.now ?? Date.now;
    this.normalizeNavigationUrl = options.normalizeNavigationUrl ?? NormalizePublicBrowserUrl;
    this.runProcess = options.runProcess;
    this.launchCompanion = options.launchCompanion;
    if (!(this.profilePath.startsWith(`${this.runtimeRoot}${sep}`))) throw new Error('Browser profile path escapes the runtime root.');
  }

  private FixedArgs(port: number, pinTab = true): string[] {
    return [
      '--namespace', this.daemonNamespace,
      '--session', FixedSessionId,
      '--cdp', String(port),
      ...(pinTab ? ['--pin-tab'] : []),
      '--no-auto-dialog',
      '--content-boundaries',
      '--max-output', '50000',
      '--idle-timeout', '1h',
    ];
  }

  private SanitizedEnvironment(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (/^(AGENT_BROWSER_|AI_GATEWAY_|KERNEL_)/i.test(key)) continue;
      env[key] = value;
    }
    env.NO_COLOR = '1';
    delete env.ELECTRON_RUN_AS_NODE;
    return env;
  }

  /** 启动只包含招聘网页 target 的 Electron 伴随进程；随机 CDP 端口通过 Chromium 的 DevToolsActivePort 文件回传。 */
  private async LaunchIsolatedCompanion(): Promise<{ port: number; close: () => Promise<void>; isAlive?: () => boolean; homeUrl?: string; internalUrls?: string[] }> {
    if (this.launchCompanion) return this.launchCompanion({ profilePath: this.profilePath, runtimeRoot: this.runtimeRoot });
    if (!existsSync(this.companionExecutablePath)) throw new AgentBrowserError('BROWSER_RUNTIME_UNAVAILABLE', `Browser companion ${basename(this.companionExecutablePath)} is unavailable.`);
    const portFile = join(this.profilePath, 'DevToolsActivePort');
    await unlink(portFile).catch((error: any) => { if (error?.code !== 'ENOENT') throw error; });
    const args = BuildBrowserCompanionArgs({ appPath: this.companionAppPath, profilePath: this.profilePath, parentPid: process.pid });
    const env = this.SanitizedEnvironment();
    for (const key of Object.keys(env)) if (/^OFFERGET_(DESKTOP_SMOKE|SMOKE_|LIFECYCLE_|INSTALLED_VISUAL_)/i.test(key)) delete env[key];
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

  private async EnsureCompanion(): Promise<{ port: number; close: () => Promise<void>; isAlive?: () => boolean; homeUrl?: string; internalUrls?: string[] }> {
    if (this.companionHandle && (this.companionHandle.isAlive?.() ?? true)) return this.companionHandle;
    if (this.companionHandle || this.daemonActive) await this.RetireBrowserInstance();
    await this.AcquireRuntimeLock();
    await mkdir(this.profilePath, { recursive: true });
    this.namespaceGeneration += 1;
    this.daemonNamespace = `offerget-${process.pid}-${this.namespaceGeneration}`;
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

  /** 同时淘汰 companion 与绑定它的 daemon；关闭失败不妨碍下一代 namespace 建立新会话。 */
  private async RetireBrowserInstance(): Promise<void> {
    const handle = this.companionHandle;
    const namespace = this.daemonNamespace;
    const daemonActive = this.daemonActive;
    this.companionHandle = null;
    this.attachedPort = null;
    this.daemonActive = false;
    this.running = false;
    this.currentUrl = undefined;
    this.tabs.clear();
    this.InvalidateRefs();
    if (daemonActive && existsSync(this.executablePath)) {
      await this.InvokeCli([
        '--namespace', namespace, '--session', FixedSessionId, '--idle-timeout', '10s', 'close', '--json',
      ], { deadline: this.now() + 5_000 }).catch(() => undefined);
    }
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
        if (ownerAlive) throw new AgentBrowserError('BROWSER_PROFILE_BUSY', 'The browser profile is already controlled by another OfferGet process.');
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
      const child = spawn(this.executablePath, args, { cwd: this.runtimeRoot, env: this.SanitizedEnvironment(), shell: false, windowsHide: true, stdio: [options.stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
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
    if (!existsSync(this.executablePath)) throw new AgentBrowserError('BROWSER_NOT_INSTALLED', `agent-browser ${basename(this.executablePath)} is unavailable.`);
    if (options.signal?.aborted) throw new AgentBrowserError('CANCELLED', 'Browser command was cancelled.');
    await mkdir(this.runtimeRoot, { recursive: true });
    const companion = await this.EnsureCompanion();
    if (this.attachedPort !== companion.port) {
      this.daemonActive = true;
      const tabState = await this.InvokeCli([...this.FixedArgs(companion.port, false), 'tab', '--json'], { signal: options.signal, deadline: options.deadline });
      const tabs = Array.isArray(tabState.data?.tabs) ? tabState.data.tabs : [];
      const target = tabs.find((tab: any) => typeof tab?.url === 'string' && tab.url === companion.homeUrl);
      if (!target?.tabId) throw new AgentBrowserError('BROWSER_START_FAILED', 'Browser companion page target is unavailable.');
      if (target.active !== true) await this.InvokeCli([...this.FixedArgs(companion.port, false), 'tab', String(target.tabId), '--json'], { signal: options.signal, deadline: options.deadline });
      this.attachedPort = companion.port;
    }
    const args = [...this.FixedArgs(companion.port), ...command, ...(options.json === false ? [] : ['--json'])];
    return this.InvokeCli(args, options);
  }

  private RunCommand(command: string[], options: { signal?: AbortSignal; deadline?: number; json?: boolean; stdin?: string } = {}): Promise<CliEnvelope> {
    const task = this.commandTail.then(() => this.RunNow(command, options));
    this.commandTail = task.then(() => undefined, () => undefined);
    return task;
  }

  private InvalidateRefs(): void {
    this.pageRevision += 1;
    this.refs.clear();
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
    if (value === this.companionHandle?.homeUrl) {
      this.currentUrl = undefined;
      return undefined;
    }
    const nextUrl = await this.normalizeNavigationUrl(value);
    if (this.currentUrl && this.currentUrl !== nextUrl) this.InvalidateRefs();
    this.currentUrl = nextUrl;
    return this.currentUrl;
  }

  async Prepare({ toolName, arguments: raw }: { toolName: BrowserToolName; arguments: Record<string, unknown> }): Promise<BrowserActionProposal> {
    const args: Record<string, unknown> = { ...raw };
    let metadata: Record<string, unknown> = {};
    if (toolName === 'BrowserNavigate') args.url = await this.normalizeNavigationUrl(args.url);
    else if (this.running) await this.RefreshCurrentUrl();
    if (toolName === 'BrowserFillForm') {
      if (!Array.isArray(args.fields) || args.fields.length < 1 || args.fields.length > 30) throw new AgentBrowserError('BROWSER_ARGUMENT_INVALID', 'BrowserFillForm requires one to thirty fields.');
      const seen = new Set<string>();
      let totalTextLength = 0;
      const labels: string[] = [];
      args.fields = args.fields.map((value) => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AgentBrowserError('BROWSER_ARGUMENT_INVALID', 'Each BrowserFillForm field must be an object.');
        const field = value as Record<string, unknown>;
        const resolved = this.RefMetadata(field.ref, args.pageRevision);
        if (seen.has(resolved.ref)) throw new AgentBrowserError('BROWSER_ARGUMENT_INVALID', 'BrowserFillForm field refs must be unique.');
        seen.add(resolved.ref);
        const role = String(resolved.metadata.role ?? '').toLowerCase();
        const type = String(resolved.metadata.type ?? '').toLowerCase();
        if (!['textbox', 'searchbox', 'spinbutton'].includes(role) || type === 'password') {
          throw new AgentBrowserError('BROWSER_ARGUMENT_INVALID', 'BrowserFillForm only accepts ordinary non-password input fields.');
        }
        const text = typeof field.text === 'string' && field.text.length <= 20_000 ? field.text : null;
        if (text === null) throw new AgentBrowserError('BROWSER_ARGUMENT_INVALID', 'BrowserFillForm field text is invalid.');
        totalTextLength += text.length;
        if (totalTextLength > 100_000) throw new AgentBrowserError('BROWSER_ARGUMENT_INVALID', 'BrowserFillForm total text exceeds 100000 characters.');
        if (typeof resolved.metadata.name === 'string' && resolved.metadata.name) labels.push(resolved.metadata.name.slice(0, 80));
        return { ref: resolved.ref, text };
      });
      metadata = { labels };
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
        : toolName === 'BrowserFillForm' ? `填写 ${(args.fields as unknown[]).length} 个输入框${targetText ? `：${targetText}` : ''}`
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
    const args = proposal.canonicalArguments;
    let command: string[];
    let stdin: string | undefined;
    switch (proposal.toolName) {
      case 'BrowserNavigate': command = ['open', String(args.url)]; break;
      case 'BrowserSnapshot': command = ['snapshot', '-i', '-c', '--urls']; break;
      case 'BrowserReadPage': command = ['read']; break;
      case 'BrowserClick': command = ['click', String(args.ref)]; break;
      case 'BrowserFill': command = ['fill', String(args.ref), String(args.text)]; break;
      case 'BrowserFillForm': {
        const fields = args.fields as Array<{ ref: string; text: string }>;
        command = ['batch', '--bail'];
        stdin = JSON.stringify(fields.map((field) => ['fill', field.ref, field.text]));
        break;
      }
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
          await this.RetireBrowserInstance();
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
    try {
      const response = await this.RunCommand(command, { signal, deadline, ...(stdin === undefined ? {} : { stdin }) });
      this.running = true;
      if (proposal.toolName === 'BrowserFillForm') {
        await this.RefreshCurrentUrl(signal, deadline);
        return { data: { filledCount: (args.fields as unknown[]).length, pageRevision: this.pageRevision, currentUrl: this.currentUrl }, status: 'succeeded' };
      }
      if (proposal.toolName === 'BrowserSnapshot') {
        this.pageRevision += 1;
        const rawRefs = response.data?.refs && typeof response.data.refs === 'object' ? response.data.refs : {};
        this.refs = new Map(Object.entries(rawRefs).map(([key, value]) => [key.replace(/^@/, ''), value && typeof value === 'object' ? value as Record<string, unknown> : {}]));
        const tabsResponse = await this.RunCommand(['tab'], { signal, deadline });
        const allTabs = Array.isArray(tabsResponse.data?.tabs) ? tabsResponse.data.tabs : Array.isArray(tabsResponse.data) ? tabsResponse.data : [];
        const internalUrls = new Set(this.companionHandle?.internalUrls ?? []);
        const rawTabs = allTabs.filter((tab: any) => !internalUrls.has(String(tab?.url ?? '')));
        this.tabs = new Set(rawTabs.map((tab: any) => String(tab?.tabId ?? tab?.id ?? '')).filter(Boolean));
        return { data: { ...response.data, pageRevision: this.pageRevision, tabs: rawTabs, currentUrl: this.currentUrl }, status: 'succeeded' };
      }
      if (['BrowserClick', 'BrowserSelect', 'BrowserPressKey', 'BrowserSwitchTab', 'BrowserGoBack'].includes(proposal.toolName)) {
        this.InvalidateRefs();
      }
      this.lastRuntimeError = null;
      return { data: { ...response.data, pageRevision: this.pageRevision, currentUrl: this.currentUrl }, status: 'succeeded' };
    } catch (error) {
      if (error instanceof AgentBrowserError && ['BROWSER_COMMAND_TIMEOUT', 'BROWSER_START_FAILED'].includes(error.code)) {
        this.lastRuntimeError = { code: error.code, message: error.message };
        await this.RetireBrowserInstance();
      }
      if (error instanceof AgentBrowserError && error.statusUnknown) return { data: { code: error.code, message: error.message }, status: 'status_unknown' };
      throw error;
    }
  }

  async GetStatus(): Promise<{ available: boolean; profileExists: boolean; running: boolean; pageRevision: number; state: 'not_installed' | 'stopped' | 'ready' | 'unhealthy'; message?: string; currentUrl?: string }> {
    const available = existsSync(this.executablePath) && existsSync(this.companionExecutablePath);
    const companionAlive = Boolean(this.companionHandle && (this.companionHandle.isAlive?.() ?? true));
    const state = !available ? 'not_installed' : this.lastRuntimeError ? 'unhealthy' : companionAlive ? 'ready' : 'stopped';
    return { available, profileExists: existsSync(this.profilePath), running: companionAlive, pageRevision: this.pageRevision, state, ...(this.lastRuntimeError ? { message: this.lastRuntimeError.message } : {}), ...(this.currentUrl ? { currentUrl: this.currentUrl } : {}) };
  }

  async ClearProfile(): Promise<{ cleared: boolean }> {
    await this.Close();
    const resolvedTarget = resolve(this.profilePath);
    if (resolvedTarget !== this.profilePath || !resolvedTarget.startsWith(`${this.runtimeRoot}${sep}`)) throw new Error('Browser profile cleanup target is invalid.');
    await rm(resolvedTarget, { recursive: true, force: true });
    this.currentUrl = undefined;
    this.pageRevision = 0;
    this.refs.clear();
    this.tabs.clear();
    return { cleared: true };
  }

  ResetPageReferences(): void { this.InvalidateRefs(); }

  async Close(): Promise<void> {
    if (this.activeChild) {
      try { this.activeChild.kill(); } catch { /* 已退出时无需重复终止。 */ }
    }
    await this.RetireBrowserInstance();
    this.lastRuntimeError = null;
    this.refs.clear();
    this.tabs.clear();
    if (this.ownsRuntimeLock) {
      await unlink(this.runtimeLockPath).catch((error: any) => { if (error?.code !== 'ENOENT') throw error; });
      this.ownsRuntimeLock = false;
    }
  }
}
