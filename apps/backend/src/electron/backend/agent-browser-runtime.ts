import { createHash, randomUUID } from 'node:crypto';
import { promises as dns } from 'node:dns';
import { existsSync, realpathSync, statSync } from 'node:fs';
import { mkdir, readFile, unlink } from 'node:fs/promises';
import { isIP } from 'node:net';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { setTimeout as Delay } from 'node:timers/promises';
import type { BrowserActionProposal, BrowserAutomationPort, BrowserEngine, BrowserTaskGrantSnapshot, BrowserToolName } from '@avery/agent-sdk';
import {
  PersonalBrowserCdpError,
  type PersonalBrowserRuntimePort,
} from './personal-browser-cdp-runtime';
import { BrowserExtensionBridge, BrowserExtensionBridgeError, type BrowserTaskCleanupOutcome } from './browser-extension-bridge';
import { CreatePersonalBrowserExtensionRuntime } from './personal-browser-extension-runtime';
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

// 浏览器命令和 BrowserFillForm 使用同一 120 秒上限；动态控件不能再被额外的短字段超时提前截断。
const DefaultCommandTimeoutMs = 120_000;
const BrowserTaskCleanupTimeoutMs = 5_000;
const FormFillCleanupReserveMs = 5_000;
const MaxUploadBytes = 25 * 1024 * 1024;
const MaxScreenshotBytes = 16 * 1024 * 1024;
const FixedSessionId = 'avery-default';
const BossActionIntervalMs = 2_000;
const BossActionTools = new Set<BrowserToolName>([
  'BrowserNavigate', 'BrowserClick', 'BrowserFill', 'BrowserFillForm', 'BrowserSelect', 'BrowserSetChecked', 'BrowserPressKey', 'BrowserUploadFile', 'BrowserSwitchTab', 'BrowserGoBack',
]);

async function AwaitBeforeDeadline<T>(work: Promise<T>, deadline: number, now: () => number): Promise<T> {
  const remaining = deadline - now();
  if (remaining <= 0) throw new AgentBrowserError('BROWSER_COMMAND_TIMEOUT', 'Browser task cleanup exceeded its deadline.', true);
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new AgentBrowserError('BROWSER_COMMAND_TIMEOUT', 'Browser task cleanup exceeded its deadline.', true)), remaining);
  });
  try { return await Promise.race([work, timeout]); }
  finally { if (timer) clearTimeout(timer); }
}

function MergeCleanupOutcome(left: BrowserTaskCleanupOutcome, right: BrowserTaskCleanupOutcome): BrowserTaskCleanupOutcome {
  const status = left.status === 'status_unknown' || right.status === 'status_unknown'
    ? 'status_unknown'
    : left.status === 'failed' || right.status === 'failed' ? 'failed' : 'confirmed';
  return {
    ...left,
    status,
    ...(left.code || right.code ? { code: left.code ?? right.code } : {}),
    ...(left.message || right.message ? { message: left.message ?? right.message } : {}),
    closedTabs: left.closedTabs + right.closedTabs,
    unknownTabs: left.unknownTabs === null || right.unknownTabs === null ? null : left.unknownTabs + right.unknownTabs,
  };
}

type BrowserCommandEnvelope = { success?: boolean; data?: any; error?: string; message?: string };

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

/** 个人浏览器允许访问用户可达的内网招聘站，但仍拒绝特殊协议与地址内嵌凭据。 */
export async function NormalizePersonalBrowserUrl(value: unknown): Promise<string> {
  if (typeof value !== 'string' || !value.trim() || value.length > 2_048) throw new AgentBrowserError('BROWSER_NAVIGATION_DENIED', 'Browser URL is invalid.');
  const candidate = value.includes('://') ? value.trim() : `https://${value.trim()}`;
  let url: URL;
  try { url = new URL(candidate); } catch { throw new AgentBrowserError('BROWSER_NAVIGATION_DENIED', 'Browser URL is invalid.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || !url.hostname) {
    throw new AgentBrowserError('BROWSER_NAVIGATION_DENIED', 'Only http/https URLs without embedded credentials are allowed.');
  }
  // Moka 等招聘站通过 hash 路由定位申请表；删除片段会把用户带回招聘首页。
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

export interface AgentBrowserRuntimeOptions {
  runtimeRoot: string;
  resolveUploadFile: (fileId: string) => Promise<string | null>;
  now?: () => number;
  /** 测评可注入精确 origin；生产允许用户浏览器访问 http/https 招聘站。 */
  normalizeNavigationUrl?: (value: unknown) => Promise<string>;
  /** 仅供节流测试替换等待；生产始终使用可取消的异步定时器。 */
  delay?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  browserExtensionBridge: BrowserExtensionBridge;
  /** 评测复用生产 Bridge 时仅释放自己的任务页。 */
  closeBridgeOnClose?: boolean;
  externalBrowserPaths?: Partial<Record<'chrome' | 'edge', string>>;
  /** 仅供契约测试替换扩展任务驱动。 */
  createExtensionRuntime?: (input: { bridge: BrowserExtensionBridge; engine: 'chrome' | 'edge'; now: () => number; delay: NonNullable<AgentBrowserRuntimeOptions['delay']> }) => PersonalBrowserRuntimePort;
  /** 仅记录表单字段阶段、耗时和错误码，不得包含填写值。 */
  recordLog?: (level: 'INFO' | 'WARN', event: string, detail: string) => void;
}

/** 扩展任务页串行 Runtime；页面引用、文件解析与取消均由此边界持有。 */
export class AgentBrowserRuntime implements BrowserAutomationPort {
  private readonly runtimeRoot: string;
  private readonly resolveUploadFile: AgentBrowserRuntimeOptions['resolveUploadFile'];
  private readonly now: () => number;
  private readonly normalizeNavigationUrl: (value: unknown) => Promise<string>;
  private readonly delay: NonNullable<AgentBrowserRuntimeOptions['delay']>;
  private readonly formDriver: BrowserFormDriver;
  private readonly createExtensionRuntime: NonNullable<AgentBrowserRuntimeOptions['createExtensionRuntime']>;
  private readonly browserExtensionBridge: BrowserExtensionBridge;
  private readonly closeBridgeOnClose: boolean;
  private readonly externalBrowserPaths: Partial<Record<'chrome' | 'edge', string>>;
  private readonly recordLog?: AgentBrowserRuntimeOptions['recordLog'];
  private commandTail: Promise<void> = Promise.resolve();
  private running = false;
  private pageRevision = 0;
  private currentUrl: string | undefined;
  private refs = new Map<string, Record<string, unknown>>();
  /** 表单服务独立保存短寿命计划；Runtime 不持有资料正文或语义匹配状态。 */
  private readonly formService = new BrowserFormService();
  private tabs = new Set<string>();
  private lastRuntimeError: { code: string; message: string } | null = null;
  private unattended = false;
  private browserEngine: 'chrome' | 'edge' = 'edge';
  private lastBossActionAt = 0;
  private personalBrowserRuntime: PersonalBrowserRuntimePort | null = null;
  private readonly retiredBrowserTaskIds = new Set<string>();
  private scheduledCronTaskId: string | null = null;
  private scheduledBrowserTaskGrant: BrowserTaskGrantSnapshot | null = null;

  constructor(options: AgentBrowserRuntimeOptions) {
    this.runtimeRoot = resolve(options.runtimeRoot);
    this.resolveUploadFile = options.resolveUploadFile;
    this.now = options.now ?? Date.now;
    this.normalizeNavigationUrl = options.normalizeNavigationUrl ?? NormalizePersonalBrowserUrl;
    this.delay = options.delay ?? ((milliseconds, signal) => Delay(milliseconds, undefined, signal ? { signal } : undefined));
    this.createExtensionRuntime = options.createExtensionRuntime ?? CreatePersonalBrowserExtensionRuntime;
    this.browserExtensionBridge = options.browserExtensionBridge;
    this.closeBridgeOnClose = options.closeBridgeOnClose !== false;
    this.externalBrowserPaths = options.externalBrowserPaths ?? {};
    this.recordLog = options.recordLog;
    this.formDriver = new BrowserFormDriver({
      runCommand: (command, commandOptions) => this.RunCommand(command, commandOptions),
      delay: this.delay,
      pageRevision: () => this.pageRevision,
    });
  }

  /** 后台任务只接受持久 BrowserTaskGrant，不改变共享浏览器的可见性。 */
  async SetUnattended(value: boolean, context: { cronTaskId?: string; browserTaskGrant?: BrowserTaskGrantSnapshot } = {}): Promise<void> {
    this.unattended = value;
    this.scheduledCronTaskId = value && typeof context.cronTaskId === 'string' ? context.cronTaskId : null;
    this.scheduledBrowserTaskGrant = value && context.browserTaskGrant?.mode === 'personal_browser_extension' && !context.browserTaskGrant.revokedAt
      ? structuredClone(context.browserTaskGrant)
      : null;
  }

  /** 授权来自可信 Cron Runner 读取的任务持久字段；浏览器在线状态由实际连接阶段独立校验。 */
  private HasCronAccess(): boolean {
    return this.unattended && Boolean(this.scheduledCronTaskId) && Boolean(this.scheduledBrowserTaskGrant);
  }

  /** 所有后台浏览器动作均由持久 Grant 二次校验；工具白名单和 fully_trusted 不能代替此门禁。 */
  private AssertCronGrant(toolName: BrowserToolName, args: Record<string, unknown>, externalEffect = false): void {
    if (!this.unattended) return;
    const grant = this.scheduledBrowserTaskGrant;
    if (!this.HasCronAccess() || !grant) {
      throw new AgentBrowserError('BROWSER_CRON_ACCESS_REQUIRED', 'This CronTask has no active BrowserTaskGrant. Create and confirm a new task.');
    }
    const Deny = (capability: string): never => {
      throw new AgentBrowserError('BROWSER_CRON_SCOPE_DENIED', `This CronTask BrowserTaskGrant does not allow ${capability}.`);
    };
    if (['BrowserNavigate', 'BrowserSwitchTab', 'BrowserGoBack'].includes(toolName) && !grant.allowNavigation) Deny('browser navigation');
    if (['BrowserFill', 'BrowserFillForm', 'BrowserSelect', 'BrowserSetChecked'].includes(toolName) && !grant.allowFormFill) Deny('form filling');
    if (toolName === 'BrowserUploadFile') {
      if (!grant.allowFileUpload) Deny('file upload');
      const fileId = String(args.fileId ?? '');
      if (!fileId || !grant.resourceIds.includes(`file:${fileId}`)) Deny('this file resource');
    }
    if (toolName === 'BrowserClick' && !externalEffect && !grant.allowNavigation && !grant.allowFormFill) Deny('page interaction');
    if (toolName === 'BrowserPressKey' && !externalEffect && !grant.allowNavigation && !grant.allowFormFill) Deny('keyboard interaction');
    if (externalEffect && !grant.allowExternalSend) Deny('external sending or submission');
  }

  /** 切换 Chrome/Edge 时收回旧任务页和引用。 */
  async SetEngine(value: BrowserEngine): Promise<void> {
    if (value !== 'chrome' && value !== 'edge') throw new AgentBrowserError('BROWSER_ARGUMENT_INVALID', 'Browser engine is invalid.');
    if (this.browserEngine === value) return;
    if (this.personalBrowserRuntime) await this.RetireBrowserInstance();
    this.browserEngine = value;
    this.lastRuntimeError = null;
    this.InvalidateRefs();
  }

  /** 个人浏览器只建立浏览器级连接；任务标签页由首个页面工具按需创建。 */
  private async EnsurePersonalBrowserRuntime(options: { signal?: AbortSignal; deadline?: number } = {}): Promise<PersonalBrowserRuntimePort> {
    if (this.personalBrowserRuntime?.IsConnected()) return this.personalBrowserRuntime;
    if (this.personalBrowserRuntime) {
      // 连接状态不再承载任务授权；断线后可按任务持久授权重新建立受限连接。
      const cleanup = await this.ReleasePersonalBrowserRuntime(this.personalBrowserRuntime, this.now() + BrowserTaskCleanupTimeoutMs);
      if (cleanup.status !== 'confirmed') {
        this.recordLog?.('WARN', 'browser.task_cleanup', `status=${cleanup.status} task=${cleanup.browserTaskId ?? 'none'} code=${cleanup.code ?? 'none'} closedTabs=${cleanup.closedTabs} unknownTabs=${cleanup.unknownTabs ?? 'unknown'}`);
      }
      this.personalBrowserRuntime = null;
    }
    try {
      await this.browserExtensionBridge.EnsureConnected(this.browserEngine, options);
      const runtime = this.createExtensionRuntime({ bridge: this.browserExtensionBridge, engine: this.browserEngine, now: this.now, delay: this.delay });
      const browserTaskId = runtime.GetBrowserTaskId?.();
      if (browserTaskId && this.retiredBrowserTaskIds.has(browserTaskId)) {
        await runtime.Close();
        throw new AgentBrowserError('BROWSER_TASK_RETIRED', 'A retired browserTaskId cannot be reused.');
      }
      await runtime.Connect(options);
      this.personalBrowserRuntime = runtime;
      this.running = true;
      this.lastRuntimeError = null;
      return runtime;
    } catch (error) {
      if (error instanceof BrowserExtensionBridgeError) throw new AgentBrowserError(error.code, error.message, error.statusUnknown);
      if (error instanceof PersonalBrowserCdpError) throw new AgentBrowserError(error.code, error.message, error.statusUnknown);
      throw error;
    }
  }

  /** 只关闭当前扩展 Runtime 生成的 browserTaskId；Bridge 服务本身继续在线供后续任务复用。 */
  private async ReleasePersonalBrowserRuntime(runtime: PersonalBrowserRuntimePort, deadline: number): Promise<BrowserTaskCleanupOutcome> {
    const browserTaskId = runtime.GetBrowserTaskId?.() ?? null;
    if (browserTaskId) this.retiredBrowserTaskIds.add(browserTaskId);
    let outcome: BrowserTaskCleanupOutcome = { status: 'confirmed', browserTaskId, closedTabs: 0, unknownTabs: 0 };
    if (browserTaskId) {
      outcome = await this.browserExtensionBridge.CloseTask(this.browserEngine, browserTaskId, { deadline });
    }
    try { await AwaitBeforeDeadline(runtime.Close(), deadline, this.now); }
    catch (error) {
      const cleanupError = error instanceof Error ? error : new Error('Personal browser runtime close failed.');
      const statusUnknown = error instanceof AgentBrowserError && error.statusUnknown
        || error instanceof BrowserExtensionBridgeError && error.statusUnknown;
      outcome = MergeCleanupOutcome(outcome, {
        status: statusUnknown ? 'status_unknown' : 'failed', browserTaskId,
        code: error && typeof error === 'object' && 'code' in error ? String(error.code) : 'BROWSER_RUNTIME_CLOSE_FAILED',
        message: cleanupError.message.slice(0, 300), closedTabs: 0, unknownTabs: statusUnknown ? null : 0,
      });
    }
    return outcome;
  }

  GetBrowserTaskId(): string | undefined {
    return this.personalBrowserRuntime?.GetBrowserTaskId?.();
  }

  /** 只释放当前任务页；Bridge 的归属由构造期决定。 */
  private async RetireBrowserInstance(deadline = this.now() + BrowserTaskCleanupTimeoutMs): Promise<BrowserTaskCleanupOutcome> {
    const runtime = this.personalBrowserRuntime;
    const browserTaskId = runtime?.GetBrowserTaskId?.() ?? null;
    this.personalBrowserRuntime = null;
    this.running = false;
    this.currentUrl = undefined;
    this.tabs.clear();
    this.InvalidateRefs();
    this.formService.Clear();
    const outcome = runtime
      ? await this.ReleasePersonalBrowserRuntime(runtime, deadline)
      : { status: 'confirmed' as const, browserTaskId, closedTabs: 0, unknownTabs: 0 };
    if (outcome.status !== 'confirmed') {
      this.recordLog?.('WARN', 'browser.task_cleanup', `status=${outcome.status} task=${browserTaskId ?? 'none'} code=${outcome.code ?? 'none'} closedTabs=${outcome.closedTabs} unknownTabs=${outcome.unknownTabs ?? 'unknown'}`);
    }
    return outcome;
  }

  private async RunNow(command: string[], options: { signal?: AbortSignal; deadline?: number; json?: boolean; stdin?: string } = {}): Promise<BrowserCommandEnvelope> {
    if (options.signal?.aborted) throw new AgentBrowserError('CANCELLED', 'Browser command was cancelled.');
    if (this.unattended && !this.HasCronAccess()) {
      throw new AgentBrowserError('BROWSER_CRON_ACCESS_REQUIRED', 'This CronTask was not authorized to use the personal browser when it was created. Create and confirm a new task.');
    }
    const runtime = await this.EnsurePersonalBrowserRuntime(options);
    try { return await runtime.Run(command, options); }
    catch (error) {
      if (error instanceof PersonalBrowserCdpError) throw new AgentBrowserError(error.code, error.message, error.statusUnknown);
      throw error;
    }
  }
  private RunCommand(command: string[], options: { signal?: AbortSignal; deadline?: number; json?: boolean; stdin?: string } = {}): Promise<BrowserCommandEnvelope> {
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
        `phase=${phase} continuation=${plan.continuationId ?? 'none'} field=${operation.concept}:${operation.occurrence} kind=${operation.kind} ref=${operation.ref} elapsedMs=${elapsedMs}${code ? ` code=${code}` : ''}`);
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
          // 所有浏览器都必须使用与规划阶段相同的字段语义快照验证；普通快照无法稳定恢复
          // ATS 中相邻标签与自定义输入框的对应关系，会把已写入字段误报为失败。
          const verification = await this.formDriver.InspectForm(verificationOptions);
          verifiedFields = FormFields(verification.data?.refs && typeof verification.data.refs === 'object' ? verification.data.refs : {}, this.pageRevision);
        } catch (error) {
          if (options.signal?.aborted || (error instanceof AgentBrowserError && error.code === 'CANCELLED')) throw error;
        }
        if (verifiedFields) {
          for (const operation of successful) {
            const exact = verifiedFields.find((field) => field.ref === operation.ref);
            const semantic = verifiedFields.filter((field) => field.semantic.concept === operation.concept)[operation.occurrence];
            // ref 序号可能因临时语义节点改变而漂移：同 ref 已明确非空时可直接确认，
            // 否则优先使用重新识别出的同语义字段，避免把另一个空字段当成后置条件。
            const verified = exact?.filled === true ? exact : semantic ?? exact;
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
        const code = error instanceof AgentBrowserError ? error.code : reason;
        LogField('failed', operation, startedAt, code);
        const message = error instanceof Error ? error.message.replace(/\s+/g, ' ').slice(0, 180) : '';
        this.recordLog?.('WARN', 'browser.form_dynamic_error',
          `continuation=${plan.continuationId ?? 'none'} field=${operation.concept}:${operation.occurrence} kind=${operation.kind} code=${code}${message ? ` message=${message}` : ''}`);
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
    const nextUrl = await this.normalizeNavigationUrl(value);
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
    this.AssertCronGrant(toolName, args);
    let metadata: Record<string, unknown> = {};
    if (toolName === 'BrowserNavigate') {
      args.url = await this.normalizeNavigationUrl(args.url);
    }
    else if (this.running) await this.RefreshCurrentUrl();
    const targetUrl = toolName === 'BrowserNavigate' ? args.url : this.currentUrl;
    if (this.unattended && IsBossBrowserUrl(targetUrl) && !this.HasCronAccess()) {
      throw new AgentBrowserError('BROWSER_CRON_ACCESS_REQUIRED', 'This CronTask was not authorized to use the personal browser when it was created. Create and confirm a new task.');
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
      if (Object.keys(args).some((key) => key !== 'tabId')) throw new AgentBrowserError('BROWSER_ARGUMENT_INVALID', 'BrowserSwitchTab accepts only a task-owned tabId.');
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
    this.AssertCronGrant(toolName, args, forceConfirmation && toolName !== 'BrowserUploadFile');
    const risk: BrowserActionProposal['risk'] = forceConfirmation ? 'high'
      : ['BrowserFill', 'BrowserFillForm', 'BrowserSelect', 'BrowserSetChecked', 'BrowserClick'].includes(toolName) ? 'medium' : 'low';
    const summary = toolName === 'BrowserNavigate' ? `打开 ${String(args.url)}`
      : toolName === 'BrowserUploadFile' ? `向 ${targetText || String(args.ref)} 上传已授权文件`
        : toolName === 'BrowserFillForm' ? `使用 ${((metadata.sourceTitles as string[] | undefined) ?? []).join('、') || '已授权资料'} 填写 ${((metadata.labels as string[] | undefined) ?? []).length} 个表单字段${targetText ? `：${targetText}` : ''}`
        : `${toolName} ${targetText || String(args.ref ?? args.key ?? args.tabId ?? '')}`.trim();
    const proposalHash = HashProposal(toolName, args, this.pageRevision, this.currentUrl);
    return {
      // 该 ID 与规范化参数/页面 revision 一一对应，Execute 的重新 Prepare
      // 可以复核 hash，同时 Confirm 仍绑定明确的 proposalId。
      proposalId: `proposal-${proposalHash}`,
      proposalHash,
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
    if (refreshed.proposalHash !== proposal.proposalHash) {
      // SPA 可能在只读观察的准备与执行之间规范化 URL；重新冻结只读提案即可，写操作仍严格拒绝旧页面。
      if (['BrowserSnapshot', 'BrowserScreenshot', 'BrowserReadPage', 'BrowserInspectForm', 'BrowserValidateForm'].includes(proposal.toolName)) proposal = refreshed;
      else throw new AgentBrowserError('BROWSER_PROPOSAL_STALE', 'The browser page changed after the action was prepared.');
    }
    await this.PaceBossAction(proposal, signal);
    const args = proposal.canonicalArguments;
    let command: string[];
    let uploadMetadata: { fileId: string; fileName: string; fileSize: number; fileSha256: string } | undefined;
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
        uploadMetadata = {
          fileId: String(args.fileId),
          fileName: basename(authorizedPath),
          fileSize: fileStat.size,
          fileSha256: createHash('sha256').update(await readFile(authorizedPath)).digest('hex'),
        };
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
          const recoverable = error instanceof AgentBrowserError && !error.statusUnknown
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
      const response = ['BrowserInspectForm', 'BrowserValidateForm'].includes(proposal.toolName)
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
      if (proposal.toolName === 'BrowserUploadFile') {
        const upload = response.data && typeof response.data === 'object' ? response.data as Record<string, unknown> : null;
        if (!upload || upload.uploaded !== true || !uploadMetadata) {
          throw new AgentBrowserError('BROWSER_OUTPUT_INVALID', 'BrowserUploadFile did not confirm the uploaded file.');
        }
        return {
          data: {
            ...upload,
            ...uploadMetadata,
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
        const rawTabs = allTabs;
        this.tabs = new Set(rawTabs.map((tab: any) => String(tab?.tabId ?? tab?.id ?? '')).filter(Boolean));
        return { data: { ...response.data, pageRevision: this.pageRevision, tabs: rawTabs, currentUrl: this.currentUrl }, status: 'succeeded' };
      }
      if (['BrowserClick', 'BrowserSelect', 'BrowserPressKey', 'BrowserSwitchTab', 'BrowserGoBack'].includes(proposal.toolName)) {
        this.InvalidateRefs();
      }
      if (proposal.toolName === 'BrowserSwitchTab') await this.RefreshCurrentUrl(signal, deadline);
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

  async GetStatus(probeConnection = false): Promise<{
    available: boolean;
    running: boolean;
    pageRevision: number;
    state: 'not_installed' | 'stopped' | 'ready' | 'unhealthy';
    engine: 'chrome' | 'edge';
    message?: string;
    currentUrl?: string;
    extension: ReturnType<BrowserExtensionBridge['Status']>;
  }> {
    const browserPath = this.externalBrowserPaths[this.browserEngine];
    const available = Boolean(browserPath && existsSync(browserPath));
    try {
      await this.browserExtensionBridge.Start();
      if (probeConnection && !this.browserExtensionBridge.IsConnected()) {
        await this.browserExtensionBridge.EnsureConnected(this.browserEngine, { deadline: this.now() + DefaultCommandTimeoutMs });
      }
      if (this.browserExtensionBridge.IsConnected() && this.lastRuntimeError?.code !== 'BROWSER_SITE_RISK_DETECTED') this.lastRuntimeError = null;
    } catch (error) {
      this.lastRuntimeError = {
        code: error instanceof BrowserExtensionBridgeError ? error.code : 'BROWSER_EXTENSION_BRIDGE_UNAVAILABLE',
        message: error instanceof Error ? error.message : 'Avery browser bridge could not start.',
      };
    }
    const extension = this.browserExtensionBridge.Status();
    const running = extension.connected;
    const state = !available ? 'not_installed' : this.lastRuntimeError ? 'unhealthy' : running ? 'ready' : 'stopped';
    return {
      available, running, pageRevision: this.pageRevision, state, engine: this.browserEngine, extension,
      ...(this.lastRuntimeError ? { message: this.lastRuntimeError.message } : {}),
      ...(this.currentUrl ? { currentUrl: this.currentUrl } : {}),
    };
  }
  ResetPageReferences(): void {
    this.InvalidateRefs();
    this.formService.Clear();
  }

  /** Host 在一次交互任务结束时调用；仅收回任务页，不关闭共享扩展 Bridge。 */
  async CloseTask(options: { deadline?: number } = {}): Promise<BrowserTaskCleanupOutcome> {
    return await this.RetireBrowserInstance(options.deadline ?? this.now() + BrowserTaskCleanupTimeoutMs);
  }

  async Close(): Promise<void> {
    await this.RetireBrowserInstance();
    if (this.closeBridgeOnClose) await this.browserExtensionBridge.Close().catch(() => undefined);
    this.scheduledCronTaskId = null;
    this.scheduledBrowserTaskGrant = null;
    this.unattended = false;
    this.lastRuntimeError = null;
    this.refs.clear();
    this.formService.Clear();
    this.tabs.clear();
  }
}
