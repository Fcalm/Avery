import { createServer, type Server, type ServerResponse } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { spawn } from 'node:child_process';

const DefaultBridgePort = 17653;
const MaxJsonBytes = 20 * 1024 * 1024;
const ExtensionOnlineWindowMs = 35_000;

/**
 * 扩展 Worker 与 Backend 的协议指纹。manifest version 只描述发布包，不能
 * 判断 Chrome 当前运行的 Service Worker 是否已经重载，因此连接必须携带这
 * 个稳定值；任何缺失或不匹配都按陈旧 Worker 处理。
 */
export const BrowserExtensionProtocolRevision = 'avery-browser-extension-bridge-v2';
/** 与 apps/browser-extension/manifest.json 保持一致；旧 Worker 必须按 stale 处理。 */
export const BrowserExtensionManifestVersion = '0.2.0';
type BrowserExtensionConnectionState = 'offline' | 'stale' | 'online';
type BrowserExtensionHandshakeSource = 'hello' | 'poll';

type CommandDeliveryState = 'queued' | 'delivered';

type BridgeCommand = {
  id: string;
  operation: string;
  payload: unknown;
  deadline: number;
  browserTaskId: string;
  runId?: string;
};

type PendingCommand = {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  abort?: () => void;
  command: BridgeCommand;
  delivery: CommandDeliveryState;
  connectionEpoch: number;
};

type SettledCommand = {
  command: BridgeCommand;
  delivery: CommandDeliveryState;
  code: string;
  statusUnknown: boolean;
  settledAt: number;
};

export type BrowserExtensionBridgeDiagnostic = {
  event: 'stale_revoke' | 'epoch_revoke' | 'late_result' | 'late_ack';
  commandId: string;
  browserTaskId: string;
  runId: string | null;
  operation: string;
  delivery: CommandDeliveryState | 'unknown';
  statusUnknown: boolean;
  workerInstanceId: string | null;
  activeWorkerInstanceId: string | null;
  actualVersion: string | null;
  expectedVersion: string;
  actualProtocolRevision: string | null;
  expectedProtocolRevision: string;
};

const SettledCommandRetentionMs = 60_000;

export type BrowserTaskCleanupOutcome = {
  status: 'confirmed' | 'status_unknown' | 'failed';
  browserTaskId: string | null;
  code?: string;
  message?: string;
  closedTabs: number;
  /** null means the extension could not report an exact count. */
  unknownTabs: number | null;
};

export type BrowserExtensionTargetInfo = {
  targetId: string;
  /** extension 原始 tabs.id；不得以 targetId 字符串替代。 */
  tabId: number;
  /** extension 原始 tabs.windowId；协议中始终显式返回。 */
  windowId: number;
  /** 原始 openerTabId；没有 opener 时明确返回 null。 */
  openerTabId: number | null;
  type?: string;
  title?: string;
  url?: string;
  active?: boolean;
  attached?: boolean;
};

export interface BrowserExtensionBridgeOptions {
  statePath: string;
  browserPaths?: Partial<Record<'chrome' | 'edge', string>>;
  port?: number;
  now?: () => number;
  launchBrowser?: (engine: 'chrome' | 'edge', url: string) => Promise<void> | void;
  expectedExtensionVersion?: string;
}

export class BrowserExtensionBridgeError extends Error {
  constructor(public readonly code: string, message: string, public readonly statusUnknown = false) {
    super(message);
    this.name = 'BrowserExtensionBridgeError';
  }
}

function Json(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'access-control-allow-origin': '*',
    'cache-control': 'no-store',
  });
  response.end(body);
}

function IsBrowserTaskId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value);
}

function DisplayProtocolRevision(value: unknown): string {
  if (typeof value !== 'string' || !value) return 'missing';
  return JSON.stringify(value.slice(0, 120));
}

async function ReadJson(request: import('node:http').IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += value.length;
    if (size > MaxJsonBytes) throw new BrowserExtensionBridgeError('BROWSER_OUTPUT_INVALID', 'Browser extension message is too large.');
    chunks.push(value);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); }
  catch { throw new BrowserExtensionBridgeError('BROWSER_OUTPUT_INVALID', 'Browser extension message is invalid JSON.'); }
}

/**
 * 浏览器扩展只连接回环 HTTP 端口，并使用用户数据目录中的随机令牌鉴权。
 * 页面无法取得令牌；任务页面和文件引用均由 Backend 创建并限时使用。
 */
export class BrowserExtensionBridge {
  private readonly statePath: string;
  private readonly browserPaths: Partial<Record<'chrome' | 'edge', string>>;
  private readonly requestedPort: number;
  private readonly now: () => number;
  private readonly launchBrowser?: BrowserExtensionBridgeOptions['launchBrowser'];
  private readonly expectedExtensionVersion: string;
  private readonly token: string;
  private server: Server | null = null;
  private startPromise: Promise<void> | null = null;
  private port = 0;
  private lastSeenAt = 0;
  private extensionVersion: string | null = null;
  private extensionProtocolRevision: string | null = null;
  private activeWorkerInstanceId: string | null = null;
  /**
   * A worker that was replaced in this Bridge lifetime can never re-activate
   * itself with a late hello.  The Bridge cannot order random IDs, so this
   * small retired set is the local evidence that distinguishes an old hello
   * from a genuinely new generation.
   */
  private retiredWorkerInstanceIds = new Set<string>();
  private handshakeReceived = false;
  private handshakeSource: BrowserExtensionHandshakeSource | null = null;
  private connectionState: BrowserExtensionConnectionState = 'offline';
  private connectionEpoch = 0;
  private commands: BridgeCommand[] = [];
  private pollResponse: ServerResponse | null = null;
  private pollConnectionEpoch = -1;
  private pollTimer: NodeJS.Timeout | null = null;
  private pending = new Map<string, PendingCommand>();
  /** 已终态命令短期留存，供 stale 后迟到 result/ack 对账而不是二次 settle。 */
  private settled = new Map<string, SettledCommand>();
  private diagnostics: BrowserExtensionBridgeDiagnostic[] = [];

  constructor(options: BrowserExtensionBridgeOptions) {
    this.statePath = resolve(options.statePath);
    this.browserPaths = options.browserPaths ?? {};
    this.requestedPort = options.port ?? DefaultBridgePort;
    this.now = options.now ?? Date.now;
    this.launchBrowser = options.launchBrowser;
    this.expectedExtensionVersion = options.expectedExtensionVersion ?? BrowserExtensionManifestVersion;
    mkdirSync(dirname(this.statePath), { recursive: true });
    let token = '';
    try { token = String(JSON.parse(readFileSync(this.statePath, 'utf8'))?.token ?? ''); } catch { token = ''; }
    if (!/^[a-f0-9]{64}$/.test(token)) {
      token = randomBytes(32).toString('hex');
      writeFileSync(this.statePath, JSON.stringify({ schemaVersion: 1, token }, null, 2), { encoding: 'utf8', mode: 0o600 });
    }
    this.token = token;
  }

  async Start(): Promise<void> {
    if (this.server?.listening) return;
    if (this.startPromise) return this.startPromise;
    this.startPromise = new Promise<void>((resolveStart, rejectStart) => {
      const server = createServer((request, response) => { void this.Handle(request, response); });
      this.server = server;
      server.once('error', (error: NodeJS.ErrnoException) => {
        this.startPromise = null;
        rejectStart(new BrowserExtensionBridgeError('BROWSER_EXTENSION_BRIDGE_UNAVAILABLE', error.code === 'EADDRINUSE'
          ? `Avery browser bridge port ${this.requestedPort} is already in use.`
          : error.message));
      });
      server.listen(this.requestedPort, '127.0.0.1', () => {
        const address = server.address();
        this.port = typeof address === 'object' && address ? address.port : this.requestedPort;
        resolveStart();
      });
    });
    return this.startPromise;
  }

  private Authorized(request: import('node:http').IncomingMessage): boolean {
    return request.headers.authorization === `Bearer ${this.token}`;
  }

  private PruneSettled(): void {
    const cutoff = this.now() - SettledCommandRetentionMs;
    for (const [id, command] of this.settled) if (command.settledAt < cutoff) this.settled.delete(id);
  }

  private RememberSettled(pending: PendingCommand, code: string, statusUnknown: boolean): void {
    this.PruneSettled();
    this.settled.set(pending.command.id, {
      command: pending.command,
      delivery: pending.delivery,
      code,
      statusUnknown,
      settledAt: this.now(),
    });
  }

  private RecordDiagnostic(
    event: BrowserExtensionBridgeDiagnostic['event'],
    command: Pick<BridgeCommand, 'id' | 'browserTaskId' | 'operation' | 'runId'>,
    delivery: CommandDeliveryState | 'unknown',
    statusUnknown: boolean,
  ): void {
    const diagnostic: BrowserExtensionBridgeDiagnostic = {
      event,
      commandId: command.id,
      browserTaskId: command.browserTaskId,
      runId: command.runId ?? null,
      operation: command.operation,
      delivery,
      statusUnknown,
      workerInstanceId: this.activeWorkerInstanceId,
      activeWorkerInstanceId: this.activeWorkerInstanceId,
      actualVersion: this.extensionVersion,
      expectedVersion: this.expectedExtensionVersion,
      actualProtocolRevision: this.extensionProtocolRevision,
      expectedProtocolRevision: BrowserExtensionProtocolRevision,
    };
    this.diagnostics.push(diagnostic);
    if (this.diagnostics.length > 100) this.diagnostics.splice(0, this.diagnostics.length - 100);
    try {
      console.warn('[Avery browser extension bridge]', JSON.stringify(diagnostic));
    } catch { /* 日志失败不能改变命令终态。 */ }
  }

  private SettlePending(
    id: string,
    pending: PendingCommand,
    outcome: { code: string; statusUnknown: boolean; error?: Error; value?: unknown },
  ): void {
    this.pending.delete(id);
    clearTimeout(pending.timer);
    pending.abort?.();
    this.RememberSettled(pending, outcome.code, outcome.statusUnknown);
    if (outcome.error) pending.reject(outcome.error);
    else pending.resolve(outcome.value);
  }

  private ProtocolReady(): boolean {
    return this.CurrentConnectionState() === 'online'
      && this.handshakeReceived
      && this.extensionVersion === this.expectedExtensionVersion
      && this.extensionProtocolRevision === BrowserExtensionProtocolRevision;
  }

  private ConnectionReadinessError(): BrowserExtensionBridgeError | null {
    const state = this.CurrentConnectionState();
    if (state === 'stale' || (state === 'online' && !this.ProtocolReady())) {
      return this.StaleProtocolError(false);
    }
    if (state !== 'online') return new BrowserExtensionBridgeError('BROWSER_EXTENSION_REQUIRED', 'The Avery browser extension is offline; reconnect or reload it before retrying.');
    return null;
  }

  private WorkerEpochError(statusUnknown: boolean): BrowserExtensionBridgeError {
    return new BrowserExtensionBridgeError(
      'BROWSER_EXTENSION_STALE',
      'The Avery browser extension Service Worker generation changed before this command completed. Open chrome://extensions and reload the Avery extension, then retry.',
      statusUnknown,
    );
  }

  private RevokePendingForConnectionChange(event: 'stale_revoke' | 'epoch_revoke', errorFor: (delivery: CommandDeliveryState) => BrowserExtensionBridgeError): void {
    this.commands = [];
    for (const [id, pending] of [...this.pending]) {
      const statusUnknown = pending.delivery === 'delivered';
      const error = errorFor(pending.delivery);
      this.SettlePending(id, pending, { code: error.code, statusUnknown, error });
      this.RecordDiagnostic(event, pending.command, pending.delivery, statusUnknown);
    }
  }

  private RevokeQueuedBeforeDelivery(error: BrowserExtensionBridgeError): void {
    const commands = this.commands.splice(0);
    for (const command of commands) {
      const pending = this.pending.get(command.id);
      if (!pending || pending.delivery !== 'queued') continue;
      this.SettlePending(command.id, pending, { code: error.code, statusUnknown: false, error });
    }
  }

  private InvalidatePoll(): void {
    const response = this.pollResponse;
    this.pollResponse = null;
    this.pollConnectionEpoch = -1;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = null;
    if (response) Json(response, 200, { commands: [] });
  }

  private ReadWorkerInstanceId(body: unknown): string | null {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
    const descriptor = Object.getOwnPropertyDescriptor(body, 'workerInstanceId');
    if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) return null;
    const value = descriptor.value;
    return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value) ? value : null;
  }

  private WorkerGenerationError(workerInstanceId: string | null): BrowserExtensionBridgeError {
    return new BrowserExtensionBridgeError(
      'BROWSER_EXTENSION_STALE',
      `The Avery browser extension Service Worker generation is not active: received workerInstanceId ${JSON.stringify(workerInstanceId ?? 'missing')}, active workerInstanceId ${JSON.stringify(this.activeWorkerInstanceId ?? 'missing')}. Reload the Avery extension and retry.`,
    );
  }

  private MarkProtocolStale(
    version: string | null,
    protocolRevision: string | null,
    body: { id?: unknown } = {},
    endpoint = 'bridge',
  ): void {
    this.extensionVersion = version;
    this.extensionProtocolRevision = protocolRevision;
    this.lastSeenAt = 0;
    this.connectionState = 'stale';
    this.handshakeReceived = false;
    this.handshakeSource = null;
    // queued 命令从未交给 Worker，结果确定；poll 已取走的命令可能已经执行，
    // 只能以 status_unknown 终止并保留对账元数据，禁止自动重试。
    this.connectionEpoch += 1;
    // stale 到达时，旧 Worker 的 long-poll 也必须结束；否则随后新的
    // hello 恢复在线后，FlushPoll 可能把新命令写入旧 Worker 的响应。
    this.InvalidatePoll();
    const pendingEntries = [...this.pending.entries()];
    this.RevokePendingForConnectionChange('stale_revoke', (delivery) => this.StaleProtocolError(delivery === 'delivered'));
    // An invalid request may be a late result/ack. Keep the old diagnostic
    // behavior when the command is already settled, without allowing it to
    // change the active generation.
    const commandId = typeof body.id === 'string' ? body.id : '';
    if (commandId && !pendingEntries.some(([id]) => id === commandId)) {
      const settled = this.settled.get(commandId);
      const command = settled?.command ?? { id: commandId, browserTaskId: 'unknown', operation: endpoint, payload: null, deadline: 0 };
      this.RecordDiagnostic(
        endpoint === 'result' ? 'late_result' : endpoint === 'command-status' ? 'late_ack' : 'stale_revoke',
        command,
        settled?.delivery ?? 'unknown',
        settled?.statusUnknown ?? true,
      );
    }
  }

  private ActivateWorker(workerInstanceId: string, incrementsEpoch: boolean): void {
    const previousWorkerInstanceId = this.activeWorkerInstanceId;
    if (previousWorkerInstanceId && previousWorkerInstanceId !== workerInstanceId) {
      this.retiredWorkerInstanceIds.add(previousWorkerInstanceId);
      if (this.retiredWorkerInstanceIds.size > 64) {
        const oldest = this.retiredWorkerInstanceIds.values().next().value;
        if (typeof oldest === 'string') this.retiredWorkerInstanceIds.delete(oldest);
      }
      this.connectionEpoch += 1;
      // A new Worker generation makes the old long-poll response unusable;
      // delivered commands are status_unknown and queued commands are certain
      // not to have reached the old worker.
      this.InvalidatePoll();
      this.RevokePendingForConnectionChange('epoch_revoke', (delivery) => this.WorkerEpochError(delivery === 'delivered'));
    } else if (!previousWorkerInstanceId && incrementsEpoch) {
      this.connectionEpoch += 1;
    }
    this.activeWorkerInstanceId = workerInstanceId;
  }

  private MarkSeen(body: { version?: unknown; protocolRevision?: unknown; workerInstanceId?: unknown; id?: unknown }, endpoint = 'bridge'): void {
    this.PruneSettled();
    const workerInstanceId = this.ReadWorkerInstanceId(body);
    const activeWorkerInstanceId = this.activeWorkerInstanceId;
    const version = typeof body.version === 'string' ? body.version.slice(0, 100) : null;
    const protocolRevision = typeof body.protocolRevision === 'string'
      ? body.protocolRevision.slice(0, 120)
      : null;
    const versionMatches = body.version === this.expectedExtensionVersion;
    const protocolMatches = body.protocolRevision === BrowserExtensionProtocolRevision;
    const handshakeEndpoint = endpoint === 'hello' || endpoint === 'poll';

    // A missing/forged identity must never be allowed to refresh the current
    // worker. If there is no active generation yet, retain the old stale
    // diagnostics; once one is active, leave all active state untouched.
    if (!workerInstanceId) {
      if (!activeWorkerInstanceId) this.MarkProtocolStale(version, protocolRevision, body, endpoint);
      throw this.WorkerGenerationError(null);
    }
    if (activeWorkerInstanceId && workerInstanceId !== activeWorkerInstanceId && endpoint !== 'hello') {
      // Late poll/status/result from a retired worker: reject before changing
      // version, heartbeat, pending commands, or settled-command state.
      throw this.WorkerGenerationError(workerInstanceId);
    }
    if (endpoint === 'hello' && activeWorkerInstanceId && workerInstanceId !== activeWorkerInstanceId
      && this.retiredWorkerInstanceIds.has(workerInstanceId)) {
      // A retired worker may still finish an in-flight hello after a newer
      // generation has taken over.  It must not roll the Bridge backwards.
      throw this.WorkerGenerationError(workerInstanceId);
    }
    if (!versionMatches || !protocolMatches) {
      if (!activeWorkerInstanceId || workerInstanceId === activeWorkerInstanceId) {
        this.MarkProtocolStale(version, protocolRevision, body, endpoint);
      }
      throw this.StaleProtocolError(false);
    }

    if (endpoint === 'hello') {
      if (!activeWorkerInstanceId) this.ActivateWorker(workerInstanceId, true);
      else if (workerInstanceId !== activeWorkerInstanceId) this.ActivateWorker(workerInstanceId, true);
      // A repeated hello from the same in-memory worker is an idempotent
      // reconnect heartbeat; only a new identity changes connectionEpoch.
    } else if (!activeWorkerInstanceId && endpoint === 'poll') {
      // Bridge restart loses its in-memory active identity. A complete poll is
      // allowed to re-establish an honest poll-only handshake for the worker.
      this.ActivateWorker(workerInstanceId, false);
    } else if (!activeWorkerInstanceId || workerInstanceId !== activeWorkerInstanceId) {
      throw this.WorkerGenerationError(workerInstanceId);
    }

    this.extensionVersion = version;
    this.extensionProtocolRevision = protocolRevision;
    if (handshakeEndpoint) {
      this.handshakeReceived = true;
      this.handshakeSource = endpoint;
    }
    // command-status/result 只能在已有 hello/poll 握手后刷新在线时间；不能
    // 伪造握手证据，否则旧 Worker 的迟到请求会把 Bridge 错判为 online。
    if (!this.handshakeReceived) {
      this.lastSeenAt = 0;
      if (this.connectionState !== 'stale') this.connectionState = 'offline';
      return;
    }
    this.lastSeenAt = this.now();
    this.connectionState = 'online';
  }

  private CurrentConnectionState(): BrowserExtensionConnectionState {
    if (this.connectionState === 'stale') return 'stale';
    if (this.lastSeenAt <= 0 || this.now() - this.lastSeenAt > ExtensionOnlineWindowMs) return 'offline';
    return 'online';
  }

  IsConnected(): boolean { return this.ProtocolReady(); }

  private FlushPoll(): void {
    if (!this.pollResponse || !this.commands.length) return;
    const response = this.pollResponse;
    const pollEpoch = this.pollConnectionEpoch;
    this.pollResponse = null;
    this.pollConnectionEpoch = -1;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = null;
    if (pollEpoch !== this.connectionEpoch || !this.ProtocolReady()) {
      this.RevokeQueuedBeforeDelivery(this.ConnectionReadinessError() ?? this.WorkerEpochError(false));
      Json(response, 200, { commands: [] });
      return;
    }
    const deliveryEpoch = this.connectionEpoch;
    const commands = this.commands.splice(0, 10).filter((command) => {
      const pending = this.pending.get(command.id);
      if (!pending) return false;
      if (pending.connectionEpoch !== deliveryEpoch || !this.ProtocolReady()) {
        const error = pending.connectionEpoch === deliveryEpoch
          ? this.ConnectionReadinessError() ?? this.WorkerEpochError(false)
          : this.WorkerEpochError(false);
        this.SettlePending(command.id, pending, { code: error.code, statusUnknown: false, error });
        return false;
      }
      // 从这里开始 Worker 已经可以执行该命令；之后的协议失配必须按
      // status_unknown 处理，即使 result 尚未返回。
      pending.delivery = 'delivered';
      return true;
    });
    Json(response, 200, { commands });
  }

  private async Handle(request: import('node:http').IncomingMessage, response: ServerResponse): Promise<void> {
    response.setHeader('access-control-allow-origin', '*');
    response.setHeader('access-control-allow-headers', 'authorization,content-type');
    if (request.method === 'OPTIONS') { response.writeHead(204); response.end(); return; }
    const url = new URL(request.url ?? '/', `http://127.0.0.1:${this.port || this.requestedPort}`);
    try {
      if (request.method === 'GET' && url.pathname === '/pair') {
        const body = '<!doctype html><meta charset="utf-8"><title>Avery Browser</title><style>body{font:16px system-ui;margin:48px;max-width:680px}h1{font-size:24px}</style><h1>正在连接 Avery 浏览器扩展</h1><p>扩展安装后，此页面会自动完成配对。你可以返回 Avery 查看连接状态。</p>';
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': Buffer.byteLength(body), 'cache-control': 'no-store' });
        response.end(body);
        return;
      }
      if (!this.Authorized(request)) { Json(response, 401, { error: 'unauthorized' }); return; }
      if (request.method === 'POST' && url.pathname === '/bridge/hello') {
        const body = await ReadJson(request);
        this.MarkSeen(body ?? {}, 'hello');
        Json(response, 200, { ok: true });
        return;
      }
      if (request.method === 'POST' && url.pathname === '/bridge/poll') {
        const body = await ReadJson(request);
        this.MarkSeen(body ?? {}, 'poll');
        this.InvalidatePoll();
        this.pollResponse = response;
        this.pollConnectionEpoch = this.connectionEpoch;
        this.pollTimer = setTimeout(() => {
          if (this.pollResponse !== response) return;
          this.pollResponse = null;
          this.pollConnectionEpoch = -1;
          this.pollTimer = null;
          Json(response, 200, { commands: [] });
        }, 20_000);
        this.FlushPoll();
        return;
      }
      if (request.method === 'POST' && url.pathname === '/bridge/command-status') {
        const body = await ReadJson(request);
        this.MarkSeen(body ?? {}, 'command-status');
        const id = typeof body?.id === 'string' ? body.id : '';
        // 扩展可能已经取走命令；此查询用于在串行闸门前传播 Host 的取消/超时。
        // 未知 ID 也按非活动处理，避免伪造或迟到命令获得执行机会。
        const settled = id ? this.settled.get(id) : undefined;
        if (!this.pending.has(id) && settled) this.RecordDiagnostic('late_ack', settled.command, settled.delivery, settled.statusUnknown);
        Json(response, 200, { active: Boolean(id && this.pending.has(id)) });
        return;
      }
      if (request.method === 'POST' && url.pathname === '/bridge/result') {
        const body = await ReadJson(request);
        this.MarkSeen(body ?? {}, 'result');
        const id = typeof body?.id === 'string' ? body.id : '';
        const pending = this.pending.get(id);
        if (!pending) {
          const settled = id ? this.settled.get(id) : undefined;
          if (settled) this.RecordDiagnostic('late_result', settled.command, settled.delivery, settled.statusUnknown);
          Json(response, 200, { ok: true });
          return;
        }
        if (body.ok === true) {
          this.SettlePending(id, pending, { code: 'OK', statusUnknown: false, value: body.data });
        } else {
          const error = new BrowserExtensionBridgeError(
            typeof body?.error?.code === 'string' ? body.error.code : 'BROWSER_COMMAND_FAILED',
            typeof body?.error?.message === 'string' ? body.error.message.slice(0, 500) : 'Browser extension command failed.',
            body?.error?.statusUnknown === true,
          );
          this.SettlePending(id, pending, { code: error.code, statusUnknown: error.statusUnknown, error });
        }
        Json(response, 200, { ok: true });
        return;
      }
      response.writeHead(404); response.end();
    } catch (error) {
      if (error instanceof BrowserExtensionBridgeError) {
        const status = error.code === 'BROWSER_EXTENSION_STALE' ? 409 : 400;
        Json(response, status, {
          ok: false,
          error: error.code,
          code: error.code,
          message: error.message.slice(0, 500),
          ...(error.code === 'BROWSER_EXTENSION_STALE' ? {
            activeWorkerInstanceId: this.activeWorkerInstanceId,
            expectedVersion: this.expectedExtensionVersion,
            actualVersion: this.extensionVersion,
            expectedProtocolRevision: BrowserExtensionProtocolRevision,
            actualProtocolRevision: this.extensionProtocolRevision,
          } : {}),
        });
        return;
      }
      Json(response, 400, { error: error instanceof Error ? error.message.slice(0, 300) : 'request_failed' });
    }
  }

  private PairUrl(): string {
    return `http://127.0.0.1:${this.port}/pair#token=${this.token}&port=${this.port}`;
  }

  private async Launch(engine: 'chrome' | 'edge'): Promise<void> {
    const executable = this.browserPaths[engine];
    if (!executable || !existsSync(executable)) throw new BrowserExtensionBridgeError('BROWSER_NOT_INSTALLED', `${engine === 'chrome' ? 'Google Chrome' : 'Microsoft Edge'} is not installed.`);
    const url = this.PairUrl();
    if (this.launchBrowser) { await this.launchBrowser(engine, url); return; }
    const child = spawn(executable, [url], { shell: false, detached: true, stdio: 'ignore', windowsHide: false });
    child.unref();
  }

  async EnsureConnected(engine: 'chrome' | 'edge', options: { launch?: boolean; signal?: AbortSignal; deadline?: number } = {}): Promise<void> {
    const end = Math.min(options.deadline ?? this.now() + 20_000, this.now() + 20_000);
    if (options.signal?.aborted) throw new BrowserExtensionBridgeError('CANCELLED', 'Browser extension connection was cancelled.');
    if (this.now() >= end) throw new BrowserExtensionBridgeError('BROWSER_COMMAND_TIMEOUT', 'Browser extension connection timed out.');
    await this.Start();
    if (this.now() >= end) throw new BrowserExtensionBridgeError('BROWSER_COMMAND_TIMEOUT', 'Browser extension connection timed out.');
    if (this.CurrentConnectionState() === 'stale') throw this.StaleProtocolError();
    if (this.ProtocolReady()) return;
    if (options.launch !== false) {
      if (options.signal?.aborted) throw new BrowserExtensionBridgeError('CANCELLED', 'Browser extension connection was cancelled.');
      if (this.now() >= end) throw new BrowserExtensionBridgeError('BROWSER_COMMAND_TIMEOUT', 'Browser extension connection timed out.');
      await this.Launch(engine);
    }
    while (!this.ProtocolReady() && this.now() < end) {
      if (options.signal?.aborted) throw new BrowserExtensionBridgeError('CANCELLED', 'Browser extension connection was cancelled.');
      if (this.CurrentConnectionState() === 'stale') throw this.StaleProtocolError();
      const waitMs = Math.max(1, Math.min(100, end - this.now()));
      await new Promise<void>((resolveWait, rejectWait) => {
        let timer: NodeJS.Timeout | null = null;
        const abort = () => {
          if (timer) clearTimeout(timer);
          timer = null;
          options.signal?.removeEventListener('abort', abort);
          rejectWait(new BrowserExtensionBridgeError('CANCELLED', 'Browser extension connection was cancelled.'));
        };
        timer = setTimeout(() => {
          timer = null;
          options.signal?.removeEventListener('abort', abort);
          resolveWait();
        }, waitMs);
        options.signal?.addEventListener('abort', abort, { once: true });
        if (options.signal?.aborted) abort();
      });
    }
    if (this.CurrentConnectionState() === 'stale') throw this.StaleProtocolError();
    if (!this.ProtocolReady()) throw new BrowserExtensionBridgeError('BROWSER_EXTENSION_REQUIRED', 'Install or enable the Avery browser extension, then try again.');
  }

  private StaleProtocolError(statusUnknown = false): BrowserExtensionBridgeError {
    return new BrowserExtensionBridgeError(
      'BROWSER_EXTENSION_STALE',
      `The Avery browser extension Service Worker is stale: expected version ${JSON.stringify(this.expectedExtensionVersion)} / protocolRevision ${JSON.stringify(BrowserExtensionProtocolRevision)}, received version ${JSON.stringify(this.extensionVersion ?? 'missing')} / protocolRevision ${DisplayProtocolRevision(this.extensionProtocolRevision)}. Open chrome://extensions and reload the Avery extension, then retry.`,
      statusUnknown,
    );
  }

  async Request(engine: 'chrome' | 'edge', operation: string, payload: unknown, options: { signal?: AbortSignal; deadline?: number; responseDeadline?: number; browserTaskId?: string; runId?: string } = {}): Promise<any> {
    if (!Number.isSafeInteger(options.deadline) || (options.deadline as number) <= 0) {
      throw new BrowserExtensionBridgeError('BROWSER_COMMAND_DEADLINE_REQUIRED', 'A browser command deadline is required.');
    }
    const browserTaskId = options.browserTaskId;
    if (!IsBrowserTaskId(browserTaskId)) {
      throw new BrowserExtensionBridgeError('BROWSER_TASK_ID_REQUIRED', 'A browserTaskId is required for browser operations.');
    }
    const deadline = options.deadline as number;
    if (options.signal?.aborted) throw new BrowserExtensionBridgeError('CANCELLED', 'Browser extension command was cancelled.');
    if (Number.isFinite(deadline) && this.now() >= deadline) {
      throw new BrowserExtensionBridgeError('BROWSER_COMMAND_TIMEOUT', 'Browser extension command expired before it was queued.');
    }
    await this.EnsureConnected(engine, { ...options, deadline, launch: true });
    const ensuredEpoch = this.connectionEpoch;
    const readinessAfterConnect = this.ConnectionReadinessError();
    if (readinessAfterConnect) throw readinessAfterConnect;
    if (options.signal?.aborted) throw new BrowserExtensionBridgeError('CANCELLED', 'Browser extension command was cancelled.');
    if (Number.isFinite(deadline) && this.now() >= deadline) {
      throw new BrowserExtensionBridgeError('BROWSER_COMMAND_TIMEOUT', 'Browser extension command expired before it was queued.');
    }
    const responseDeadline = options.responseDeadline ?? deadline;
    const timeout = Math.min(120_000, responseDeadline - this.now());
    if (timeout <= 0) throw new BrowserExtensionBridgeError('BROWSER_COMMAND_TIMEOUT', 'Browser extension command expired before it was queued.');
    return new Promise((resolveCommand, rejectCommand) => {
      if (this.connectionEpoch !== ensuredEpoch) {
        rejectCommand(this.WorkerEpochError(false));
        return;
      }
      const readinessBeforeQueue = this.ConnectionReadinessError();
      if (readinessBeforeQueue) {
        rejectCommand(readinessBeforeQueue);
        return;
      }
      const id = randomUUID();
      const Abort = () => {
        const pending = this.pending.get(id);
        if (!pending) return;
        this.commands = this.commands.filter((command) => command.id !== id);
        const error = new BrowserExtensionBridgeError('CANCELLED', 'Browser extension command was cancelled.', true);
        this.SettlePending(id, pending, { code: error.code, statusUnknown: true, error });
      };
      const timer = setTimeout(() => {
        const pending = this.pending.get(id);
        if (!pending) return;
        // 超时发生在命令尚未被长轮询取走时，必须一并撤销队列项；否则扩展
        // 可能在调用方已收到 status_unknown 后才执行这个写操作。
        this.commands = this.commands.filter((command) => command.id !== id);
        const error = new BrowserExtensionBridgeError('BROWSER_COMMAND_TIMEOUT', 'Browser extension command timed out.', true);
        this.SettlePending(id, pending, { code: error.code, statusUnknown: true, error });
      }, timeout);
      options.signal?.addEventListener('abort', Abort, { once: true });
      const command: BridgeCommand = { id, operation, payload, deadline, browserTaskId, ...(options.runId ? { runId: options.runId } : {}) };
      this.pending.set(id, {
        resolve: resolveCommand,
        reject: rejectCommand,
        timer,
        abort: options.signal ? () => options.signal?.removeEventListener('abort', Abort) : undefined,
        command,
        delivery: 'queued',
        connectionEpoch: ensuredEpoch,
      });
      this.commands.push(command);
      this.FlushPoll();
    });
  }

  GetDiagnostics(): BrowserExtensionBridgeDiagnostic[] {
    this.PruneSettled();
    return this.diagnostics.map((diagnostic) => ({ ...diagnostic }));
  }

  Status(): {
    connected: boolean;
    state: BrowserExtensionConnectionState;
    version?: string;
    actualVersion: string | null;
    expectedVersion: string;
    protocolRevision: string | null;
    actualProtocolRevision: string | null;
    expectedProtocolRevision: string;
    handshakeReceived: boolean;
    handshakeSource: BrowserExtensionHandshakeSource | null;
    source: BrowserExtensionHandshakeSource | null;
    activeWorkerInstanceId: string | null;
    port: number;
    message?: string;
  } {
    const state = this.CurrentConnectionState();
    return {
      connected: state === 'online',
      state,
      ...(this.extensionVersion ? { version: this.extensionVersion } : {}),
      actualVersion: this.extensionVersion,
      expectedVersion: this.expectedExtensionVersion,
      protocolRevision: this.extensionProtocolRevision,
      actualProtocolRevision: this.extensionProtocolRevision,
      expectedProtocolRevision: BrowserExtensionProtocolRevision,
      handshakeReceived: this.handshakeReceived,
      handshakeSource: this.handshakeSource,
      source: this.handshakeSource,
      activeWorkerInstanceId: this.activeWorkerInstanceId,
      port: this.port || this.requestedPort,
      ...(state === 'stale' ? { message: this.StaleProtocolError().message } : {}),
    };
  }

  async CloseTask(engine: 'chrome' | 'edge', browserTaskId?: string, options: { deadline?: number } = {}): Promise<BrowserTaskCleanupOutcome> {
    if (!IsBrowserTaskId(browserTaskId)) throw new BrowserExtensionBridgeError('BROWSER_TASK_ID_REQUIRED', 'A browserTaskId is required to close a browser task.');
    const responseDeadline = options.deadline ?? this.now() + 5_000;
    // 给 worker 留出一个共同清理 deadline，并为扩展回传逐标签页结果保留余量。
    const deadline = Math.min(responseDeadline, this.now() + 4_500);
    if (!this.IsConnected()) {
      const stale = this.CurrentConnectionState() === 'stale';
      return {
        status: 'status_unknown',
        browserTaskId,
        code: stale ? 'BROWSER_EXTENSION_STALE' : 'BROWSER_EXTENSION_DISCONNECTED',
        message: stale ? this.StaleProtocolError().message : 'The browser extension disconnected before task cleanup could be confirmed.',
        closedTabs: 0,
        unknownTabs: null,
      };
    }
    try {
      const response = await this.Request(engine, 'close_task', {}, { deadline, responseDeadline, browserTaskId });
      // close_task's worker payload is the cleanup outcome itself; unlike CDP commands,
      // it is not wrapped in { id, result } before EnqueueCommand puts it in body.data.
      const result = response && typeof response === 'object' ? response : {};
      const status = result.status === 'confirmed' || result.status === 'status_unknown' || result.status === 'failed'
        ? result.status
        : result.closed === true ? 'confirmed' : 'status_unknown';
      return {
        status,
        browserTaskId,
        ...(typeof result.code === 'string' ? { code: result.code } : {}),
        ...(typeof result.message === 'string' ? { message: result.message.slice(0, 300) } : {}),
        closedTabs: Number.isSafeInteger(result.closedTabs) && result.closedTabs >= 0 ? result.closedTabs : 0,
        unknownTabs: Number.isSafeInteger(result.unknownTabs) && result.unknownTabs >= 0
          ? result.unknownTabs
          : status === 'confirmed' ? 0 : null,
      };
    } catch (error) {
      const code = error instanceof BrowserExtensionBridgeError ? error.code : 'BROWSER_COMMAND_FAILED';
      const statusUnknown = error instanceof BrowserExtensionBridgeError && error.statusUnknown;
      return {
        status: statusUnknown ? 'status_unknown' : 'failed', browserTaskId, code,
        message: error instanceof Error ? error.message.slice(0, 300) : 'Browser task cleanup failed.',
        closedTabs: 0, unknownTabs: statusUnknown ? null : 0,
      };
    }
  }

  async Close(): Promise<void> {
    this.InvalidatePoll();
    for (const [id, pending] of [...this.pending]) {
      const error = new BrowserExtensionBridgeError('CANCELLED', 'Browser extension bridge closed.');
      this.SettlePending(id, pending, { code: error.code, statusUnknown: false, error });
    }
    this.commands = [];
    this.settled.clear();
    this.diagnostics = [];
    this.lastSeenAt = 0;
    this.connectionState = 'offline';
    this.connectionEpoch = 0;
    this.activeWorkerInstanceId = null;
    this.retiredWorkerInstanceIds.clear();
    this.extensionVersion = null;
    this.extensionProtocolRevision = null;
    this.handshakeReceived = false;
    this.handshakeSource = null;
    const server = this.server;
    this.server = null;
    this.startPromise = null;
    if (server) {
      await new Promise<void>((resolveClose) => {
        server.close(() => resolveClose());
        // 扩展会在长轮询结束后立即重连；停止监听后主动关闭现有 HTTP 连接，避免 Backend 退出被 keep-alive 拖住。
        server.closeAllConnections();
      });
    }
  }
}
