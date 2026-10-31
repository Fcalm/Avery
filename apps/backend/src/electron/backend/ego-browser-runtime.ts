import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { access } from 'node:fs/promises';
import { createServer, type Server, type Socket } from 'node:net';
import { delimiter, join } from 'node:path';
import { EventEmitter } from 'node:events';
import { promisify } from 'node:util';
import { EgoBrowserBootstrap } from './ego-browser-bootstrap';
import { BuildEgoNativeLaunch, IsEgoHostElevated } from './ego-browser-launcher';
import { PersonalBrowserCdpError, PersonalBrowserCdpRuntime, type PersonalBrowserCommandOptions, type PersonalBrowserRuntimePort } from './personal-browser-cdp-runtime';
import type { BrowserTaskCleanupOutcome } from './browser-extension-bridge';

const ExecuteFile = promisify(execFile);
const MaxFrameBytes = 24 * 1024 * 1024;

/** 原生进程错误只保留摘要；脚本内的连接令牌和本地路径不得进入模型或轨迹。 */
export function DescribeEgoCliExit(output: string, code: number | null, signal: string | null): string {
  const line = output.split(/\r?\n/).map((value) => value.trim()).find((value) => /^(?:[\w.]*Error(?: \[[A-Z0-9_]+\])?:|Failed to |Cannot |Error \[)/.test(value));
  const detail = line?.replace(/[a-f0-9]{64}/gi, '[TOKEN]')
    .replace(/[A-Za-z]:[\\/][^\r\n'"<>]+/g, '[PATH]')
    .replace(/file:\/\/[^\s'"<>]+/g, '[PATH]')
    .replace(/(^|[\s'"])(\/[^\s'"<>]+)/g, '$1[PATH]').slice(0, 400);
  return `ego native task process exited before handshake (exit=${code ?? 'unknown'}, signal=${signal ?? 'none'})${detail ? `: ${detail}` : '.'}`;
}

/** 只寻找已安装的 CLI；不安装软件、不修改 PATH、不启动新的浏览器配置文件。 */
export async function ResolveEgoBrowserExecutable(): Promise<string | null> {
  const name = process.platform === 'win32' ? 'ego-browser.exe' : 'ego-browser';
  const candidates = [
    ...String(process.env.PATH ?? '').split(delimiter).filter(Boolean).map((directory) => join(directory.replace(/^"|"$/g, ''), name)),
    ...(process.env.USERPROFILE ? [join(process.env.USERPROFILE, '.local', 'share', 'ego', 'active_version_dir', name)] : []),
    ...(process.env.ProgramFiles ? [join(process.env.ProgramFiles, 'Citro Labs', 'ego lite', 'Application', name)] : []),
  ];
  for (const candidate of candidates) { try { await access(candidate); return candidate; } catch { /* 继续检查标准安装位置。 */ } }
  return null;
}

type SocketEvent = { data?: string; error?: Error; code?: number; reason?: string };

/** 随机端口、随机令牌的本机专用通道，只有固定 ego 引导进程可成为 CDP 传输端。 */
class EgoBrowserSocket {
  readyState = 0;
  private readonly events = new EventEmitter();
  private server?: Server;
  private socket?: Socket;
  private child?: ChildProcess;
  private startupTimer?: NodeJS.Timeout;
  private startupOutput = '';
  private closing = false;
  private cleanup?: { resolve(value: BrowserTaskCleanupOutcome): void; reject(error: Error): void };

  constructor(private readonly executable: string, private readonly taskId: string, private readonly options: PersonalBrowserCommandOptions, private readonly closeTabs: boolean) {
    void this.Open().catch((error: unknown) => {
      if (!this.closing) this.events.emit('error', { error: error instanceof Error ? error : new Error('ego connection failed.') });
      this.close();
    });
    // EventEmitter 的 error 无监听器会抛异常；异步连接失败仍交给 Runtime 的监听器处理。
    this.events.on('error', () => undefined);
  }

  addEventListener(type: string, listener: (event: SocketEvent) => void, options?: { once?: boolean }): void {
    if (options?.once) this.events.once(type, listener); else this.events.on(type, listener);
  }
  removeEventListener(type: string, listener: (event: SocketEvent) => void): void { this.events.off(type, listener); }

  private async Open(): Promise<void> {
    const token = randomBytes(32).toString('hex');
    this.server = createServer((socket) => {
      let authenticated = false;
      let buffer = '';
      socket.setEncoding('utf8');
      const authTimer = setTimeout(() => { if (!authenticated) socket.destroy(); }, 2_000);
      socket.on('close', () => {
        clearTimeout(authTimer);
        if (this.socket !== socket) return;
        if (!this.closing && this.readyState === 0) this.events.emit('error', { error: new PersonalBrowserCdpError('BROWSER_EGO_UNAVAILABLE', 'ego disconnected before the task space was ready.') });
        this.close();
      });
      socket.on('error', () => socket.destroy());
      socket.on('data', (chunk: string) => {
        buffer += chunk;
        if (Buffer.byteLength(buffer) > MaxFrameBytes) { socket.destroy(); return; }
        let newline: number;
        while ((newline = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
          let message: Record<string, unknown>;
          try { message = JSON.parse(line) as Record<string, unknown>; } catch { socket.destroy(); return; }
          if (!authenticated) {
            if (this.socket || message.token !== token || this.closing) { socket.destroy(); return; }
            authenticated = true; clearTimeout(authTimer); this.socket = socket;
            socket.write('accepted\n');
            // 第一个合法客户端建立后停止接受其他连接。
            this.server?.close();
            continue;
          }
          if (message.ready === true && Number.isSafeInteger(message.spaceId) && Number(message.spaceId) > 0) {
            if (this.closing) return;
            clearTimeout(this.startupTimer);
            this.startupOutput = '';
            this.readyState = 1; this.events.emit('open', {});
          } else if (message.closed === true) {
            this.cleanup?.resolve({ status: 'confirmed', browserTaskId: this.taskId, closedTabs: Number(message.closedTabs) || 0, unknownTabs: 0,
              ...(Number.isSafeInteger(message.retainedTabs) && Number(message.retainedTabs) >= 0 ? { retainedTabs: Number(message.retainedTabs) } : {}) });
            this.cleanup = undefined;
          } else if (message.failure === true) {
            const error = new PersonalBrowserCdpError(String(message.code ?? 'BROWSER_EGO_UNAVAILABLE'), String(message.message ?? 'ego connection failed.'));
            this.cleanup?.reject(error); this.cleanup = undefined;
            this.events.emit('error', { error }); this.close();
          } else if (Number.isSafeInteger(message.id)) {
            this.events.emit('message', { data: line });
          } else { socket.destroy(); return; }
        }
      });
    });
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(0, '127.0.0.1', resolve);
    });
    if (this.closing || this.options.signal?.aborted) { this.close(); return; }
    const address = this.server.address();
    if (!address || typeof address === 'string') throw new Error('ego bridge has no local address.');
    const script = `(${EgoBrowserBootstrap.toString()})(${JSON.stringify({ port: address.port, token, name: `Avery ${this.taskId}`, closeTabs: this.closeTabs })})`;
    const launch = BuildEgoNativeLaunch(this.executable, script, await IsEgoHostElevated());
    if (this.closing || this.options.signal?.aborted) { this.close(); return; }
    this.startupTimer = setTimeout(() => {
      this.events.emit('error', { error: new PersonalBrowserCdpError('BROWSER_EGO_UNAVAILABLE', 'ego lite did not connect. Open ego lite and continue the task.') });
      this.close();
    }, Math.max(1, Math.min(8_000, (this.options.deadline ?? Number.POSITIVE_INFINITY) - Date.now())));
    // 无 shell、不接收模型提供的脚本。令牌只存在于本机进程与内存，不进入轨迹或 Renderer。
    this.child = spawn(launch.executable, launch.args, { windowsHide: true, stdio: [launch.input ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
    if (launch.input) {
      this.child.stdin?.on('error', () => { /* 子进程退出由 close 统一报告，不让 EPIPE 变成宿主未捕获异常。 */ });
      this.child.stdin?.write(launch.input);
    }
    const collectStartupOutput = (chunk: Buffer) => {
      if (this.readyState === 0 && !this.closing) this.startupOutput = `${this.startupOutput}${chunk.toString('utf8')}`.slice(-8_192);
    };
    this.child.stdout?.on('data', collectStartupOutput);
    this.child.stderr?.on('data', collectStartupOutput);
    this.child.once('error', (error) => { this.events.emit('error', { error: new PersonalBrowserCdpError('BROWSER_EGO_UNAVAILABLE', error.message) }); this.close(); });
    // close 在输出管道读尽后触发；exit 可能早于最后一段 stderr，不能丢失真正的启动错误。
    this.child.once('close', (code, signal) => {
      if (!this.closing && this.readyState === 0) this.events.emit('error', { error: new PersonalBrowserCdpError('BROWSER_EGO_UNAVAILABLE', DescribeEgoCliExit(this.startupOutput, code, signal)) });
      this.close();
    });
  }

  send(data: string): void {
    if (this.readyState !== 1 || !this.socket) throw new Error('ego task connection is not open.');
    this.socket.write(`${data}\n`);
  }

  async CloseTask(deadline: number, closeTabs: boolean): Promise<BrowserTaskCleanupOutcome> {
    if (this.readyState !== 1 || !this.socket) throw new PersonalBrowserCdpError('BROWSER_EGO_UNAVAILABLE', 'ego task cleanup could not be confirmed.', true);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.cleanup = undefined; reject(new PersonalBrowserCdpError('BROWSER_COMMAND_TIMEOUT', 'ego task cleanup timed out.', true)); }, Math.max(1, deadline - Date.now()));
      this.cleanup = { resolve: (value) => { clearTimeout(timer); resolve(value); }, reject: (error) => { clearTimeout(timer); reject(error); } };
      this.socket!.write(`${JSON.stringify({ close: true, closeTabs })}\n`);
    });
  }

  close(): void {
    if (this.closing) return;
    this.closing = true; this.readyState = 3;
    clearTimeout(this.startupTimer);
    this.cleanup?.reject(new PersonalBrowserCdpError('BROWSER_EGO_UNAVAILABLE', 'ego task connection was lost during cleanup.', true)); this.cleanup = undefined;
    this.socket?.destroy();
    this.server?.close();
    this.child?.stdin?.end();
    // 断开后留少量时间让固定引导进程清理自己的空间；不得杀掉用户的 ego 浏览器进程。
    if (this.child && this.child.exitCode === null) {
      const child = this.child;
      const timer = setTimeout(() => { if (child.exitCode === null) child.kill(); }, 3_000);
      timer.unref(); child.once('exit', () => clearTimeout(timer));
    }
    this.events.emit('close', { code: 1000, reason: 'Avery ego task closed.' });
  }
}

export interface EgoBrowserProvider {
  GetStatus(probe: boolean): Promise<{ available: boolean; connected: boolean; message?: string }>;
  CreateRuntime(options?: { closeTabs?: boolean }): Promise<PersonalBrowserRuntimePort>;
}

/** ego 只提供新空间与原生传输；填写、快照、校验仍执行 Avery 的生产 Runtime。 */
export class EgoBrowserRuntimeProvider implements EgoBrowserProvider {
  private lastProbe?: { at: number; connected: boolean; message?: string };
  private probeFlight?: Promise<void>;

  constructor(private readonly resolveExecutable: () => Promise<string | null> = ResolveEgoBrowserExecutable) {}

  async GetStatus(probe: boolean): Promise<{ available: boolean; connected: boolean; message?: string }> {
    const executable = await this.resolveExecutable();
    if (!executable) return { available: false, connected: false, message: '未找到 ego lite，请先安装后重新检测。' };
    if (probe || !this.lastProbe || Date.now() - this.lastProbe.at >= 10_000) {
      // CLI 只连接已运行的 ego 原生服务；普通状态读取也可刷新事实，但绝不创建空间或启动浏览器。
      this.probeFlight ??= (async () => {
        try {
          const script = "for (const key of ['getBrowserVersion','createTaskSpace','useTaskSpace','listTaskSpaces','listTabs','createTab','sendCDPMessage','closeTaskSpace','completeTaskSpace']) if(typeof ego[key]!=='function') throw new Error('ego API unavailable'); const v=await ego.getBrowserVersion(); if(!v||typeof v.currentVersion!=='string') throw new Error('ego handshake failed'); console.log('AVERY_EGO_CONNECTED');";
          const result = await ExecuteFile(executable, ['nodejs', '-e', script], { timeout: 5_000, windowsHide: true, maxBuffer: 64_000 });
          // Windows 的 ego CLI 在管道模式可能把内置 Node 输出转发到 stderr；只认固定握手标记。
          if (!`${result.stdout}\n${result.stderr}`.split(/\r?\n/).includes('AVERY_EGO_CONNECTED')) throw new Error('ego handshake failed.');
          this.lastProbe = { at: Date.now(), connected: true };
        } catch {
          this.lastProbe = { at: Date.now(), connected: false, message: '无法连接 ego lite，请打开 ego lite 后重新检测。' };
        }
      })().finally(() => { this.probeFlight = undefined; });
      await this.probeFlight;
    }
    return { available: true, connected: this.lastProbe?.connected === true, ...(this.lastProbe?.message ? { message: this.lastProbe.message } : {}) };
  }

  async CreateRuntime(options: { closeTabs?: boolean } = {}): Promise<PersonalBrowserRuntimePort> {
    const executable = await this.resolveExecutable();
    if (!executable) throw new PersonalBrowserCdpError('BROWSER_EGO_UNAVAILABLE', 'ego lite is not installed. Open ego lite before continuing.');
    const taskId = `ego-${randomUUID()}`;
    let transport: EgoBrowserSocket | undefined;
    const runtime = new PersonalBrowserCdpRuntime({
      endpoint: 'ws://127.0.0.1:1/devtools/browser/ego', browserTaskId: taskId, taskTargetIdentity: 'cdp_target',
      webSocketFactory: (_endpoint, connectionOptions) => transport = new EgoBrowserSocket(executable, taskId, connectionOptions ?? {}, options.closeTabs !== false),
    });
    return Object.assign(runtime, { CloseTask: async (cleanupOptions: { deadline: number; closeTabs?: boolean }) => {
      if (!transport) return { status: 'confirmed' as const, browserTaskId: taskId, closedTabs: 0, unknownTabs: 0 };
      return transport.CloseTask(cleanupOptions.deadline, cleanupOptions.closeTabs ?? (options.closeTabs !== false));
    } });
  }
}
