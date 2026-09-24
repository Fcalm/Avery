import { randomUUID } from 'node:crypto';
import { BrowserExtensionBridge, BrowserExtensionBridgeError, BrowserExtensionManifestVersion, BrowserExtensionProtocolRevision } from './browser-extension-bridge';
import { PersonalBrowserCdpError, PersonalBrowserCdpRuntime, type PersonalBrowserRuntimePort } from './personal-browser-cdp-runtime';

const SocketConnecting = 0;
const SocketOpen = 1;
const SocketClosed = 3;

type BrowserSocketEvent = { data?: string; code?: number; reason?: string; error?: Error };

/**
 * 将扩展 Bridge 暴露为 PersonalBrowserCdpRuntime 所需的最小消息通道。
 * Bridge 只转发白名单 CDP 消息，扩展只把命令应用到 Avery 创建的任务标签页。
 */
class BrowserExtensionSocket {
  readyState = SocketConnecting;
  private readonly listeners = new Map<string, Set<(event: BrowserSocketEvent) => void>>();
  private readonly requests = new Set<AbortController>();
  private readonly openController = new AbortController();
  private closed = false;

  constructor(
    private readonly bridge: BrowserExtensionBridge,
    private readonly engine: 'chrome' | 'edge',
    private readonly browserTaskId: string,
    options: { signal?: AbortSignal; deadline?: number } = {},
  ) {
    const signal = options.signal ? AbortSignal.any([options.signal, this.openController.signal]) : this.openController.signal;
    void this.Open({ ...options, signal });
  }

  private Emit(type: string, event: BrowserSocketEvent = {}): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  private async Open(options: { signal?: AbortSignal; deadline?: number }): Promise<void> {
    try {
      await this.bridge.EnsureConnected(this.engine, options);
      const status = this.bridge.Status();
      const actualVersion = status.actualVersion ?? status.version;
      const actualProtocolRevision = status.actualProtocolRevision ?? status.protocolRevision;
      const expectedVersion = status.expectedVersion ?? BrowserExtensionManifestVersion;
      if (status.state !== 'online'
        || expectedVersion !== BrowserExtensionManifestVersion
        || actualVersion !== BrowserExtensionManifestVersion
        || status.expectedProtocolRevision !== BrowserExtensionProtocolRevision
        || actualProtocolRevision !== BrowserExtensionProtocolRevision) {
        throw new BrowserExtensionBridgeError(
          'BROWSER_EXTENSION_STALE',
          `The Avery browser extension Service Worker is stale: expected version ${JSON.stringify(BrowserExtensionManifestVersion)} / protocolRevision ${JSON.stringify(BrowserExtensionProtocolRevision)}, received version ${JSON.stringify(actualVersion ?? 'missing')} / protocolRevision ${JSON.stringify(actualProtocolRevision ?? 'missing')}. Open chrome://extensions and reload the Avery extension, then retry.`,
        );
      }
      if (this.closed) return;
      this.readyState = SocketOpen;
      this.Emit('open');
    } catch (error) {
      if (this.closed) return;
      const normalized = error instanceof BrowserExtensionBridgeError
        ? new PersonalBrowserCdpError(error.code, error.message, error.statusUnknown)
        : error instanceof Error ? error : new Error('Browser extension connection failed.');
      this.readyState = SocketClosed;
      this.Emit('error', { error: normalized });
      this.Emit('close', { code: 1006, reason: normalized.message });
    }
  }

  send(data: string, options: { signal?: AbortSignal; deadline?: number } = {}): void {
    if (this.readyState !== SocketOpen) throw new Error('Browser extension connection is not open.');
    let message: { id?: unknown };
    try { message = JSON.parse(data); }
    catch { throw new Error('Browser extension request is invalid JSON.'); }
    if (!Number.isSafeInteger(message.id)) throw new Error('Browser extension request id is invalid.');
    const controller = new AbortController();
    this.requests.add(controller);
    const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
    void this.bridge.Request(this.engine, 'cdp', message, { signal, deadline: options.deadline, browserTaskId: this.browserTaskId }).then((response) => {
      if (!this.closed) this.Emit('message', { data: JSON.stringify(response) });
    }).catch((error) => {
      if (this.closed) return;
      const normalized = error instanceof BrowserExtensionBridgeError
        ? error
        : new BrowserExtensionBridgeError('BROWSER_COMMAND_FAILED', error instanceof Error ? error.message : 'Browser extension command failed.');
      this.Emit('message', {
        data: JSON.stringify({
          id: message.id,
          error: { code: normalized.code, message: normalized.message, statusUnknown: normalized.statusUnknown },
        }),
      });
    }).finally(() => this.requests.delete(controller));
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.readyState = SocketClosed;
    this.openController.abort();
    for (const controller of this.requests) controller.abort();
    this.requests.clear();
    this.Emit('close', { code: 1000, reason: 'Avery task closed.' });
    this.listeners.clear();
  }

  addEventListener(type: string, listener: (event: BrowserSocketEvent) => void, options?: { once?: boolean }): void {
    const listeners = this.listeners.get(type) ?? new Set();
    if (options?.once) {
      const wrapper = (event: BrowserSocketEvent) => {
        this.removeEventListener(type, wrapper);
        listener(event);
      };
      listeners.add(wrapper);
    } else listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: (event: BrowserSocketEvent) => void): void {
    this.listeners.get(type)?.delete(listener);
  }
}

export function CreatePersonalBrowserExtensionRuntime(input: {
  bridge: BrowserExtensionBridge;
  engine: 'chrome' | 'edge';
  now?: () => number;
  delay?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
}): PersonalBrowserRuntimePort {
  // 一个 Runtime 对应一个不可复用的浏览器任务；runId 只代表一次 Host
  // 投递，不能用来决定扩展侧标签页归属。
  const browserTaskId = randomUUID();
  return new PersonalBrowserCdpRuntime({
    endpoint: `ws://127.0.0.1:${input.bridge.Status().port}/devtools/browser/extension`,
    now: input.now,
    delay: input.delay,
    browserTaskId,
    webSocketFactory: (_url, options) => new BrowserExtensionSocket(input.bridge, input.engine, browserTaskId, options),
  });
}
