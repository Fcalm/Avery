import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createContext, runInContext, runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

type MessageListener = (message: unknown, sender: unknown, sendResponse: (response: unknown) => void) => boolean | void;

function StorageArea(values: Record<string, unknown>) {
  return {
    get: async (keys: string | string[] | null) => {
      if (keys === null) return { ...values };
      if (Array.isArray(keys)) return Object.fromEntries(keys.map((key) => [key, values[key]]));
      return { [keys]: values[keys] };
    },
    set: async (value: Record<string, unknown>) => { Object.assign(values, value); },
    remove: async (keys: string | string[]) => { for (const key of Array.isArray(keys) ? keys : [keys]) delete values[key]; },
  };
}

function SeedTaskRegistry(registry: Record<string, unknown>, epoch = 1, revision = 1): Record<string, unknown> {
  const writerId = 'seed';
  return {
    [`averyTaskTabs.${epoch}.${revision}.${writerId}`]: {
      schemaVersion: 1, epoch, revision, writerId, registry,
    },
  };
}

function LatestTaskRegistry(values: Record<string, unknown>): Record<string, any> | undefined {
  const snapshots = Object.values(values).filter((value: any) => value?.schemaVersion === 1 && Number.isSafeInteger(value.epoch) && Number.isSafeInteger(value.revision)) as any[];
  return snapshots.sort((left, right) => right.epoch - left.epoch || right.revision - left.revision || right.writerId.localeCompare(left.writerId))[0]?.registry;
}

function StartWorker(chrome: any, fetch: (...args: any[]) => any, timeOrigin = Date.now(), shortTimeouts = false) {
  const source = readFileSync(resolve('apps/browser-extension/service-worker.js'), 'utf8');
  const timer = shortTimeouts
    ? (callback: (...args: any[]) => void, milliseconds: number, ...args: any[]) => setTimeout(callback, Math.min(milliseconds, 40), ...args)
    : setTimeout;
  const context = createContext({
    chrome, fetch, URL, URLSearchParams, AbortController, AbortSignal, setTimeout: timer, clearTimeout,
    // Chrome mocks live in the test's host realm; expose the same realm intrinsics
    // so the worker's strict plain-object boundary remains strict in this VM.
    Object, Array,
    performance: { timeOrigin }, crypto: { randomUUID: () => `worker-${timeOrigin}` },
  });
  runInContext(source, context);
  return context;
}

async function WaitUntil(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < end) await new Promise((done) => setTimeout(done, 5));
  if (!predicate()) throw new Error('condition not reached before test deadline');
}

async function CallMessage(listener: MessageListener, message: unknown, timeoutMs = 4000, sender: unknown = {}) {
  let returnValue: boolean | void;
  const responses: unknown[] = [];
  const response = new Promise<unknown>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('message listener did not respond')), timeoutMs);
    returnValue = listener(message, sender, (value) => {
      responses.push(value);
      if (responses.length === 1) { clearTimeout(timer); resolve(value); }
    });
  });
  const value = await response;
  await new Promise((done) => setTimeout(done, 0));
  return { returnValue: returnValue!, responses, value };
}

describe('Avery pairing page cleanup', () => {
  const token = 'd'.repeat(64);
  const pairUrl = `http://127.0.0.1:17653/pair#token=${token}&port=17653`;

  function Fixture(options: { failHello?: boolean; currentUrl?: string; pendingUrl?: string } = {}) {
    let listener: MessageListener | undefined;
    const removed: number[] = [];
    const queried: number[] = [];
    StartWorker({
      storage: { local: StorageArea({}), session: StorageArea({}) },
      runtime: {
        onMessage: { addListener: (value: MessageListener) => { listener = value; } },
        onStartup: { addListener() {} }, onInstalled: { addListener() {} },
        getManifest: () => ({ version: '0.2.0' }),
      },
      alarms: { create() {}, onAlarm: { addListener() {} } },
      tabs: {
        get: async (id: number) => { queried.push(id); return { id, url: options.currentUrl ?? pairUrl, pendingUrl: options.pendingUrl }; },
        remove: async (id: number) => { removed.push(id); },
      },
      debugger: {},
    }, async (url: string) => new URL(url).pathname === '/bridge/hello'
      ? { ok: !options.failHello, status: options.failHello ? 503 : 200, json: async () => ({ ok: true }) }
      : { ok: false, status: 409, json: async () => ({ code: 'BROWSER_EXTENSION_STALE' }) });
    return {
      removed, queried,
      pair: (sender: unknown = { tab: { id: 42 }, frameId: 0, url: pairUrl }) => CallMessage(listener!, { type: 'avery_pair', token, port: 17653 }, 4000, sender),
    };
  }

  it('握手成功后关闭发起配对的顶层标签页', async () => {
    const fixture = Fixture();
    expect((await fixture.pair()).value).toEqual({ ok: true });
    expect(fixture.queried).toEqual([42]);
    expect(fixture.removed).toEqual([42]);
  });

  it('握手失败时保留页面且不尝试关闭标签页', async () => {
    const fixture = Fixture({ failHello: true });
    expect((await fixture.pair()).value).toMatchObject({ ok: false });
    expect(fixture.queried).toEqual([]);
    expect(fixture.removed).toEqual([]);
  });

  it.each([
    { currentUrl: 'https://example.com/user-page' },
    { pendingUrl: 'https://example.com/user-page' },
  ])('用户已经导航或正在导航时保留标签页：%j', async (options) => {
    const fixture = Fixture(options);
    expect((await fixture.pair()).value).toEqual({ ok: true });
    expect(fixture.removed).toEqual([]);
  });

  it.each([
    { tab: { id: 42 }, frameId: 1, url: pairUrl },
    { tab: { id: 42 }, frameId: 0, url: 'https://example.com/pair' },
    { tab: { id: 42 }, frameId: 0, url: pairUrl.replace(token, 'e'.repeat(64)) },
  ])('不关闭子框架或与本次配对不符的页面：%j', async (sender) => {
    const fixture = Fixture();
    expect((await fixture.pair(sender)).value).toEqual({ ok: true });
    expect(fixture.queried).toEqual([]);
    expect(fixture.removed).toEqual([]);
  });
});

function AbortableWait(signal?: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    let timer: NodeJS.Timeout;
    const finish = (error: Error) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      reject(error);
    };
    const abort = () => finish(new Error('test poll ended'));
    timer = setTimeout(() => finish(new Error('test poll timed out')), 100);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
}

describe('Avery browser extension worker', () => {
  it('hello 与全部 Bridge 心跳携带 exact protocolRevision，而不是只依赖 manifest version', async () => {
    let onMessage: MessageListener | undefined;
    const requests: Array<{ path: string; body: any }> = [];
    const chrome = {
      storage: { local: StorageArea({}), session: StorageArea({}) },
      runtime: {
        onMessage: { addListener: (listener: MessageListener) => { onMessage = listener; } },
        onStartup: { addListener: () => undefined }, onInstalled: { addListener: () => undefined },
        getManifest: () => ({ version: '0.2.0' }),
      },
      alarms: { create: () => undefined, onAlarm: { addListener: () => undefined } },
      tabs: {}, debugger: {},
    };
    const fetch = async (url: string, options: { body?: string } = {}) => {
      const parsed = new URL(url);
      if (parsed.pathname === '/bridge/hello' || parsed.pathname === '/bridge/poll'
        || parsed.pathname === '/bridge/command-status' || parsed.pathname === '/bridge/result') {
        requests.push({ path: parsed.pathname, body: JSON.parse(options.body ?? '{}') });
      }
      if (parsed.pathname === '/bridge/hello') return { ok: true, json: async () => ({ ok: true }) };
      if (parsed.pathname === '/bridge/poll') return { ok: false, status: 409, json: async () => ({ code: 'BROWSER_EXTENSION_STALE' }) };
      return { ok: true, json: async () => ({}) };
    };
    StartWorker(chrome, fetch, 19_500, true);
    await WaitUntil(() => onMessage !== undefined);
    await expect(CallMessage(onMessage!, { type: 'avery_pair', token: 'a'.repeat(64), port: 17653 })).resolves.toMatchObject({ value: { ok: true } });
    await WaitUntil(() => requests.some((request) => request.path === '/bridge/hello'));
    const hello = requests.find((request) => request.path === '/bridge/hello');
    expect(hello?.body).toMatchObject({ version: '0.2.0', protocolRevision: 'avery-browser-extension-bridge-v2' });
    expect(hello?.body.workerInstanceId).toEqual(expect.any(String));
    await WaitUntil(() => requests.some((request) => request.path === '/bridge/poll'));
    const poll = requests.find((request) => request.path === '/bridge/poll');
    expect(poll?.body).toMatchObject({ version: '0.2.0', protocolRevision: 'avery-browser-extension-bridge-v2', workerInstanceId: hello?.body.workerInstanceId });
  });

  it('TargetInfo only consumes own raw tab identity data and ignores unrelated Chrome fields', () => {
    const chrome = {
      storage: { local: StorageArea({}), session: StorageArea({}) },
      runtime: {
        onMessage: { addListener: () => undefined }, onStartup: { addListener: () => undefined },
        onInstalled: { addListener: () => undefined }, getManifest: () => ({ version: '0.2.0' }),
      },
      alarms: { create: () => undefined, onAlarm: { addListener: () => undefined } },
      tabs: { onCreated: { addListener: () => undefined }, onActivated: { addListener: () => undefined }, onRemoved: { addListener: () => undefined } },
      debugger: { onDetach: { addListener: () => undefined } },
    };
    const worker = StartWorker(chrome, async () => ({ ok: true, json: async () => ({}) }), 19_000);
    const target = worker.TargetInfo({ id: 10, windowId: 2, openerTabId: null, url: 'https://example.test/', title: 'task', unrelated: 'ignored' }, 'task', 10);
    expect(target).toMatchObject({ targetId: '10', tabId: 10, windowId: 2, openerTabId: null, type: 'page', active: true });

    expect(() => worker.TargetInfo(Object.assign(Object.create({ inherited: true }), {
      id: 10, windowId: 2, openerTabId: null, url: 'https://example.test/', title: 'task',
    }), 'task', 10)).toThrow();

    Object.defineProperty(Object.prototype, 'id', { configurable: true, value: 99 });
    try {
      expect(() => worker.TargetInfo({ windowId: 2, openerTabId: null, url: 'https://example.test/', title: 'task' }, 'task', 10)).toThrow();
    } finally {
      delete (Object.prototype as Record<string, unknown>).id;
    }

    let getterReads = 0;
    const accessorTab = { windowId: 2, openerTabId: null, url: 'https://example.test/', title: 'task' } as Record<string, unknown>;
    Object.defineProperty(accessorTab, 'id', {
      configurable: true,
      get() { getterReads += 1; throw new Error('unexpected getter execution'); },
    });
    expect(() => worker.TargetInfo(accessorTab, 'task', 10)).toThrow();
    expect(getterReads).toBe(0);
  });

  it('strict plain-record checks reject a forged native-shaped prototype from another VM realm', async () => {
    const forgedContext = createContext({});
    runInContext(`
      const forgedPrototype = Object.create(null);
      Object.defineProperties(forgedPrototype, {
        constructor: { configurable: true, value: Object },
        hasOwnProperty: { configurable: true, value: Object.prototype.hasOwnProperty },
        toString: { configurable: true, value: Object.prototype.toString },
      });
      const forgedTab = Object.create(forgedPrototype);
      let getterReads = 0;
      Object.defineProperties(forgedTab, {
        windowId: { configurable: true, value: 2 },
        openerTabId: { configurable: true, value: null },
        status: { configurable: true, value: 'complete' },
        url: { configurable: true, value: 'https://example.test/forged' },
        title: { configurable: true, value: 'forged' },
      });
      Object.defineProperty(forgedTab, 'id', {
        configurable: true,
        get() { getterReads += 1; throw new Error('forged getter executed'); },
      });
      globalThis.forgedTab = forgedTab;
      globalThis.getterReads = () => getterReads;
    `, forgedContext);
    const chrome = {
      storage: { local: StorageArea({}), session: StorageArea({}) },
      runtime: {
        onMessage: { addListener: () => undefined }, onStartup: { addListener: () => undefined },
        onInstalled: { addListener: () => undefined }, getManifest: () => ({ version: '0.2.0' }),
      },
      alarms: { create: () => undefined, onAlarm: { addListener: () => undefined } },
      tabs: {
        create: async () => forgedContext.forgedTab,
        get: async () => forgedContext.forgedTab,
        remove: async () => undefined,
        onRemoved: { addListener: () => undefined },
      },
      debugger: { onDetach: { addListener: () => undefined } },
    };
    const worker = StartWorker(chrome, async () => ({ ok: true, json: async () => ({}) }), 19_250);
    expect(() => worker.NormalizeTab(forgedContext.forgedTab)).toThrow();
    expect(() => worker.TargetInfo(forgedContext.forgedTab, 'forged-task', 1)).toThrow();
    await expect(worker.HandleCdp('forged-task', {
      id: 1, method: 'Target.createTarget', params: { url: 'https://example.test/' },
    }, undefined, Date.now() + 1000)).rejects.toMatchObject({ code: 'BROWSER_START_FAILED' });
    expect(forgedContext.getterReads()).toBe(0);
  });

  it('Target.createTarget accessor identity is rejected without reading the getter, including its late cleanup path', async () => {
    // 该用例只验证 worker 内部的 tabs.create/late-cleanup 路径；不启动桥接轮询，
    // 避免把轮询生命周期混入 rejection-sink 断言。
    const local: Record<string, unknown> = {};
    const session: Record<string, unknown> = {};
    let getterReads = 0;
    const accessorTab = { windowId: 2, openerTabId: null, status: 'complete', url: 'https://example.test/', title: 'task' } as Record<string, unknown>;
    Object.defineProperty(accessorTab, 'id', {
      configurable: true,
      get() { getterReads += 1; throw new Error('unexpected getter execution'); },
    });
    const chrome = {
      storage: { local: StorageArea(local), session: StorageArea(session) },
      runtime: { onMessage: { addListener: () => undefined }, onStartup: { addListener: () => undefined }, onInstalled: { addListener: () => undefined }, getManifest: () => ({ version: '0.2.0' }) },
      alarms: { create: () => undefined, onAlarm: { addListener: () => undefined } },
      tabs: {
        create: async () => accessorTab,
        get: async () => accessorTab,
        remove: async () => undefined,
        onRemoved: { addListener: () => undefined },
      },
      debugger: { onDetach: { addListener: () => undefined } },
    };
    const worker = StartWorker(chrome, async () => ({ ok: true, json: async () => ({}) }), 19_500);
    await expect(worker.HandleCdp('accessor-task', {
      id: 1, method: 'Target.createTarget', params: { url: 'https://example.test/' },
    }, undefined, Date.now() + 1000)).rejects.toMatchObject({ code: 'BROWSER_START_FAILED' });
    expect(getterReads).toBe(0);

    const inheritedIdentity = Object.assign(Object.create({ inherited: true }), {
      id: 21, windowId: 2, openerTabId: null, status: 'complete',
      url: 'https://example.test/inherited-prototype', title: 'task',
    });
    const prototypeChrome = {
      ...chrome,
      tabs: { ...chrome.tabs, create: async () => inheritedIdentity, get: async () => inheritedIdentity },
    };
    const prototypeWorker = StartWorker(prototypeChrome, async () => ({ ok: true, json: async () => ({}) }), 19_550);
    await expect(prototypeWorker.HandleCdp('prototype-task', {
      id: 2, method: 'Target.createTarget', params: { url: 'https://example.test/' },
    }, undefined, Date.now() + 1000)).rejects.toMatchObject({ code: 'BROWSER_START_FAILED' });

    let openerGetterReads = 0;
    const accessorOpenerTab = {
      id: 22, windowId: 2, status: 'complete', url: 'https://example.test/accessor-opener', title: 'task',
    } as Record<string, unknown>;
    Object.defineProperty(accessorOpenerTab, 'openerTabId', {
      configurable: true,
      get() { openerGetterReads += 1; throw new Error('unexpected opener getter execution'); },
    });
    const openerChrome = {
      ...chrome,
      tabs: { ...chrome.tabs, create: async () => accessorOpenerTab, get: async () => accessorOpenerTab },
    };
    const openerWorker = StartWorker(openerChrome, async () => ({ ok: true, json: async () => ({}) }), 19_575);
    await expect(openerWorker.HandleCdp('accessor-opener-task', {
      id: 3, method: 'Target.createTarget', params: { url: 'https://example.test/' },
    }, undefined, Date.now() + 1000)).rejects.toMatchObject({ code: 'BROWSER_START_FAILED' });
    expect(openerGetterReads).toBe(0);

    const delayedChrome = {
      ...chrome,
      tabs: {
        ...chrome.tabs,
        create: () => new Promise((resolve) => setTimeout(() => resolve(accessorTab), 80)),
      },
    };
    const delayedWorker = StartWorker(delayedChrome, async () => ({ ok: true, json: async () => ({}) }), 19_600);
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
    process.on('unhandledRejection', onUnhandled);
    try {
      await expect(delayedWorker.HandleCdp('late-accessor-task', {
        id: 2, method: 'Target.createTarget', params: { url: 'https://example.test/' },
      }, undefined, Date.now() + 25)).rejects.toMatchObject({ code: 'BROWSER_COMMAND_TIMEOUT' });
      await new Promise((done) => setTimeout(done, 140));
      expect(getterReads).toBe(0);
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('poll rejects malformed response shapes without getter execution, unhandled rejection, or a busy loop', async () => {
    const local: Record<string, unknown> = { averyBridge: { token: 'a'.repeat(64), port: 1111 } };
    const session: Record<string, unknown> = {};
    let pollCalls = 0;
    const forgedResponse = Object.assign(Object.create({ inherited: true }), { commands: [] });
    const accessorResponse: Record<string, unknown> = {};
    let commandsGetterReads = 0;
    Object.defineProperty(accessorResponse, 'commands', {
      configurable: true,
      get() { commandsGetterReads += 1; throw new Error('poll commands getter executed'); },
    });
    const malformedResponses: unknown[] = [
      null,
      [],
      forgedResponse,
      accessorResponse,
      { commands: {} },
      { commands: [], unexpected: true },
      { commands: [] },
    ];
    const chrome = {
      storage: { local: StorageArea(local), session: StorageArea(session) },
      runtime: {
        onMessage: { addListener: () => undefined }, onStartup: { addListener: () => undefined },
        onInstalled: { addListener: () => undefined }, getManifest: () => ({ version: '0.2.0' }),
      },
      alarms: { create: () => undefined, onAlarm: { addListener: () => undefined } },
      tabs: { onRemoved: { addListener: () => undefined } },
      debugger: { onDetach: { addListener: () => undefined } },
    };
    const fetch = async (url: string, options: { signal?: AbortSignal } = {}) => {
      const parsed = new URL(url);
      if (parsed.pathname === '/bridge/poll') {
        pollCalls += 1;
        if (malformedResponses.length) {
          const response = malformedResponses.shift();
          return { ok: true, json: async () => response };
        }
        return AbortableWait(options.signal);
      }
      return { ok: true, json: async () => ({}) };
    };
    const worker = StartWorker(chrome, fetch, 19_300);
    expect(worker).toBeDefined();
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
    process.on('unhandledRejection', onUnhandled);
    try {
      await WaitUntil(() => pollCalls >= 7, 2000);
      await new Promise((done) => setTimeout(done, 150));
      expect(commandsGetterReads).toBe(0);
      expect(unhandled).toEqual([]);
      expect(pollCalls).toBeLessThan(20);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('poll 的网络/HTTP失败在 worker 生命周期内退避重试，并能在重配对时取消唯一 loop', async () => {
    const local: Record<string, unknown> = { averyBridge: { token: 'a'.repeat(64), port: 1111 } };
    let pollCalls = 0;
    const chrome = {
      storage: { local: StorageArea(local), session: StorageArea({}) },
      runtime: {
        onMessage: { addListener: () => undefined }, onStartup: { addListener: () => undefined },
        onInstalled: { addListener: () => undefined }, getManifest: () => ({ version: '0.2.0' }),
      },
      alarms: { create: () => undefined, onAlarm: { addListener: () => undefined } },
      tabs: { onRemoved: { addListener: () => undefined } }, debugger: { onDetach: { addListener: () => undefined } },
    };
    const fetch = async (url: string) => {
      if (new URL(url).pathname === '/bridge/poll') {
        pollCalls += 1;
        if (pollCalls < 3) throw new Error('temporary network failure');
        return { ok: true, json: async () => ({ commands: [] }) };
      }
      return { ok: true, json: async () => ({}) };
    };
    const worker = StartWorker(chrome, fetch, 19_350, true);
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
    process.on('unhandledRejection', onUnhandled);
    try {
      await WaitUntil(() => pollCalls >= 3, 1500);
      expect(pollCalls).toBeGreaterThanOrEqual(3);
      await new Promise((done) => setTimeout(done, 20));
      expect(unhandled).toEqual([]);
      runInContext('pollEpoch += 1; activePollAbort?.abort();', worker);
      await new Promise((done) => setTimeout(done, 20));
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('切换桥接时不会被旧实例中未结束的轮询阻塞', async () => {
    let onPair: MessageListener | undefined;
    const fetchedPorts: number[] = [];
    const helloVersions: string[] = [];
    const storage: Record<string, unknown> = {
      averyBridge: { token: 'a'.repeat(64), port: 1111 },
    };
    const chrome = {
      storage: { local: StorageArea(storage), session: StorageArea({}) },
      runtime: {
        onMessage: { addListener: (listener: typeof onPair) => { onPair = listener; } },
        onStartup: { addListener: () => undefined },
        onInstalled: { addListener: () => undefined },
        getManifest: () => ({ version: '0.2.0' }),
      },
      alarms: { create: () => undefined, onAlarm: { addListener: () => undefined } },
      tabs: { onRemoved: { addListener: () => undefined } },
      debugger: { onDetach: { addListener: () => undefined } },
    };
    const fetch = (url: string, options: { signal?: AbortSignal; body?: string } = {}) => {
      const parsed = new URL(url);
      if (parsed.pathname === '/bridge/hello') { helloVersions.push(JSON.parse(options.body || '{}').version); return Promise.resolve({ ok: true, json: async () => ({}) }); }
      fetchedPorts.push(Number(parsed.port));
      // 旧桥接的长轮询即使没有响应，新配对也必须能够启动独立轮询。
      return AbortableWait(options.signal);
    };
    const source = readFileSync(resolve('apps/browser-extension/service-worker.js'), 'utf8');
    runInNewContext(source, { chrome, fetch, URL, AbortController, AbortSignal, setTimeout, clearTimeout, Object, Array });
    await new Promise((done) => setTimeout(done, 0));

    expect(fetchedPorts).toContain(1111);
    expect(onPair).toBeDefined();
    expect(await CallMessage(onPair!, { type: 'avery_pair', token: 'a'.repeat(64), port: 2222 })).toEqual({
      returnValue: true, responses: [{ ok: true }], value: { ok: true },
    });
    expect(helloVersions.length).toBeGreaterThanOrEqual(1);
    await new Promise((done) => setTimeout(done, 0));
    expect(fetchedPorts).toContain(2222);
  });

  it('重配对期间等待旧任务收尾，避免旧 close_task 与新 createTarget 并发破坏任务页登记', async () => {
    let onPair: MessageListener | undefined;
    const events: string[] = [];
    const results: any[] = [];
    const pollCounts = new Map<number, number>();
    const storage: Record<string, unknown> = {
      averyBridge: { token: 'a'.repeat(64), port: 1111 },
      averyTaskTabId: 10,
    };
    const sessionStorage = SeedTaskRegistry({ 'old-task': { tabIds: [10], parentTabId: null, activeTabId: 10 } });
    let removeCount = 0;
    let releaseOldClose!: () => void;
    const oldCloseFinished = new Promise<void>((resolve) => { releaseOldClose = resolve; });
    let oldCloseStarted!: () => void;
    const oldCloseStartedPromise = new Promise<void>((resolve) => { oldCloseStarted = resolve; });
    let newCreateStarted!: () => void;
    const newCreateStartedPromise = new Promise<void>((resolve) => { newCreateStarted = resolve; });
    const chrome = {
      storage: {
        local: StorageArea(storage),
        session: StorageArea(sessionStorage),
      },
      runtime: {
        onMessage: { addListener: (listener: typeof onPair) => { onPair = listener; } },
        onStartup: { addListener: () => undefined },
        onInstalled: { addListener: () => undefined },
        getManifest: () => ({ version: '0.2.0' }),
      },
      alarms: { create: () => undefined, onAlarm: { addListener: () => undefined } },
      tabs: {
        get: async (tabId: number) => ({ id: tabId, status: 'complete', url: tabId === 10 ? 'https://example.com/old' : 'https://example.com/new', title: String(tabId) }),
        create: async ({ url }: { url: string }) => {
          events.push(`create:${url}`);
          newCreateStarted();
          return { id: 20, status: 'complete', url, title: 'new' };
        },
        remove: async (tabId: number) => {
          removeCount += 1;
          events.push(`remove:${tabId}`);
          if (removeCount === 1) {
            oldCloseStarted();
            await oldCloseFinished;
          }
        },
        update: async () => undefined,
        onRemoved: { addListener: () => undefined },
      },
      windows: { update: async () => undefined },
      debugger: {
        attach: async () => undefined,
        detach: async () => undefined,
        sendCommand: async () => ({}),
        onDetach: { addListener: () => undefined },
      },
    };
    const fetch = async (url: string, options: { body?: string; signal?: AbortSignal } = {}) => {
      const parsed = new URL(url);
      if (parsed.pathname === '/bridge/hello') return { ok: true, json: async () => ({ ok: true }) };
      if (parsed.pathname === '/bridge/result') {
        results.push(JSON.parse(options.body ?? '{}'));
        return { ok: true, json: async () => ({ ok: true }) };
      }
      if (parsed.pathname === '/bridge/command-status') return { ok: true, json: async () => ({ active: true }) };
      if (parsed.pathname !== '/bridge/poll') return { ok: false, status: 404, json: async () => ({}) };
      const port = Number(parsed.port);
      const count = pollCounts.get(port) ?? 0;
      pollCounts.set(port, count + 1);
      if (port === 1111 && count === 0) {
        return { ok: true, json: async () => ({ commands: [{ id: 'old-close', browserTaskId: 'old-task', operation: 'close_task', payload: {}, deadline: Date.now() + 5_000 }] }) };
      }
      if (port === 2222 && count === 0) {
        return { ok: true, json: async () => ({ commands: [{
          id: 'new-create',
          browserTaskId: 'new-task',
          operation: 'cdp',
          payload: { id: 2, method: 'Target.createTarget', params: { url: 'https://example.com/new' } },
          deadline: Date.now() + 5_000,
        }] }) };
      }
      return AbortableWait(options.signal) as any;
    };
    const source = readFileSync(resolve('apps/browser-extension/service-worker.js'), 'utf8');
    runInNewContext(source, { chrome, fetch, URL, AbortController, AbortSignal, setTimeout, clearTimeout, Object, Array });

    await oldCloseStartedPromise;
    expect(events).toEqual(['remove:10']);
    expect(await CallMessage(onPair!, { type: 'avery_pair', token: 'b'.repeat(64), port: 2222 })).toEqual({
      returnValue: true, responses: [{ ok: true }], value: { ok: true },
    });
    // 新 Poll 已拿到命令，但必须在旧 close_task 结束前停在串行闸门外。
    await new Promise((done) => setTimeout(done, 0));
    expect(events).toEqual(['remove:10']);

    releaseOldClose();
    await newCreateStartedPromise;
    expect(events).toEqual(['remove:10', 'create:https://example.com/new']);
    await new Promise((done) => setTimeout(done, 0));
    expect(LatestTaskRegistry(sessionStorage)).toEqual({ 'new-task': { tabIds: [20], parentTabId: null, activeTabId: 20 } });
    expect(Object.keys(storage).some((key) => key.startsWith('averyTaskTabs.'))).toBe(false);
    await new Promise((done) => setTimeout(done, 0));
    expect(results).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'old-close', ok: true, data: { closed: true, status: 'confirmed', browserTaskId: 'old-task', closedTabs: 1, unknownTabs: 0 }, version: '0.2.0', protocolRevision: 'avery-browser-extension-bridge-v2', workerInstanceId: expect.any(String) }),
      expect.objectContaining({ id: 'new-create', ok: true, data: { id: 2, result: { targetId: '20' } }, version: '0.2.0', protocolRevision: 'avery-browser-extension-bridge-v2', workerInstanceId: expect.any(String) }),
    ]));
  });

  it('命令在 poll 后排队到 deadline 仍未取得执行闸门时，不启动新的任务页写操作', async () => {
    const events: string[] = [];
    const results: any[] = [];
    const pollCounts = new Map<number, number>();
    const storage: Record<string, unknown> = {
      averyBridge: { token: 'a'.repeat(64), port: 1111 },
    };
    const sessionStorage = SeedTaskRegistry({ 'close-task': { tabIds: [10], parentTabId: null, activeTabId: 10 } });
    let onPair: MessageListener | undefined;
    let releaseFirst!: () => void;
    const firstFinished = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let firstStarted!: () => void;
    const firstStartedPromise = new Promise<void>((resolve) => { firstStarted = resolve; });
    const chrome = {
      storage: {
        local: StorageArea(storage),
        session: StorageArea(sessionStorage),
      },
      runtime: {
        onMessage: { addListener: (listener: typeof onPair) => { onPair = listener; } },
        onStartup: { addListener: () => undefined },
        onInstalled: { addListener: () => undefined },
        getManifest: () => ({ version: '0.2.0' }),
      },
      alarms: { create: () => undefined, onAlarm: { addListener: () => undefined } },
      tabs: {
        get: async (tabId: number) => ({ id: tabId, status: 'complete', url: 'https://example.com/task', title: 'task' }),
        create: async ({ url }: { url: string }) => { events.push(`create:${url}`); return { id: 30, status: 'complete', url, title: 'late' }; },
        remove: async (tabId: number) => { events.push(`remove:${tabId}`); firstStarted(); await firstFinished; },
        update: async () => { events.push('update'); },
        onRemoved: { addListener: () => undefined },
      },
      windows: { update: async () => undefined },
      debugger: { attach: async () => undefined, detach: async () => undefined, sendCommand: async () => ({}), onDetach: { addListener: () => undefined } },
    };
    const fetch = async (url: string, options: { body?: string; signal?: AbortSignal } = {}) => {
      const parsed = new URL(url);
      if (parsed.pathname === '/bridge/hello') return { ok: true, json: async () => ({ ok: true }) };
      if (parsed.pathname === '/bridge/command-status') return { ok: true, json: async () => ({ active: true }) };
      if (parsed.pathname === '/bridge/result') { results.push(JSON.parse(options.body ?? '{}')); return { ok: true, json: async () => ({ ok: true }) }; }
      if (parsed.pathname !== '/bridge/poll') return { ok: false, status: 404, json: async () => ({}) };
      const port = Number(parsed.port); const count = pollCounts.get(port) ?? 0; pollCounts.set(port, count + 1);
      if (count > 0) return new Promise(() => undefined) as any;
      return { ok: true, json: async () => ({ commands: [
        { id: 'first-close', browserTaskId: 'close-task', operation: 'close_task', payload: {}, deadline: Date.now() + 5_000 },
        { id: 'late-create', browserTaskId: 'late-task', operation: 'cdp', payload: { id: 3, method: 'Target.createTarget', params: { url: 'https://example.com/late' } }, deadline: Date.now() + 25 },
      ] }) };
    };
    const source = readFileSync(resolve('apps/browser-extension/service-worker.js'), 'utf8');
    runInNewContext(source, { chrome, fetch, URL, AbortController, AbortSignal, setTimeout, clearTimeout, Object, Array });

    await firstStartedPromise;
    // 让后一个命令在前一个 close_task 的执行闸门后过期，再释放前一个命令。
    await new Promise((done) => setTimeout(done, 50));
    releaseFirst();
    for (let attempt = 0; attempt < 20 && !results.some((result) => result.id === 'late-create'); attempt += 1) {
      await new Promise((done) => setTimeout(done, 0));
    }
    expect(events).toEqual(['remove:10']);
    expect(results).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'first-close', ok: true, data: { closed: true, status: 'confirmed', browserTaskId: 'close-task', closedTabs: 1, unknownTabs: 0 }, version: '0.2.0', protocolRevision: 'avery-browser-extension-bridge-v2', workerInstanceId: expect.any(String) }),
      expect.objectContaining({ id: 'late-create', ok: false, error: { code: 'BROWSER_COMMAND_TIMEOUT', message: 'Browser command expired before execution.', statusUnknown: false }, version: '0.2.0', protocolRevision: 'avery-browser-extension-bridge-v2', workerInstanceId: expect.any(String) }),
    ]));
  });

  it('deadline 在 TaskTab 读取后到期时，仍不会进入 tabs.update 写入口', async () => {
    const events: string[] = [];
    const results: any[] = [];
    const storage: Record<string, unknown> = { averyBridge: { token: 'a'.repeat(64), port: 1111 } };
    const sessionStorage = SeedTaskRegistry({ 'test-task': { tabIds: [10], parentTabId: null, activeTabId: 10 } });
    let tabLookupStarted!: () => void;
    const tabLookupStartedPromise = new Promise<void>((resolve) => { tabLookupStarted = resolve; });
    let releaseTabLookup!: () => void;
    const tabLookupFinished = new Promise<void>((resolve) => { releaseTabLookup = resolve; });
    const chrome = {
      storage: { local: StorageArea(storage), session: StorageArea(sessionStorage) },
      runtime: {
        onMessage: { addListener: () => undefined }, onStartup: { addListener: () => undefined }, onInstalled: { addListener: () => undefined }, getManifest: () => ({ version: '0.2.0' }),
      },
      alarms: { create: () => undefined, onAlarm: { addListener: () => undefined } },
      tabs: {
        get: async (tabId: number) => { tabLookupStarted(); await tabLookupFinished; return { id: tabId, status: 'complete', url: 'https://example.com/task', title: 'task' }; },
        update: async () => { events.push('update'); }, onRemoved: { addListener: () => undefined },
      },
      debugger: { onDetach: { addListener: () => undefined } },
    };
    let pollDelivered = false;
    const fetch = async (url: string, options: { body?: string; signal?: AbortSignal } = {}) => {
      const parsed = new URL(url);
      if (parsed.pathname === '/bridge/command-status') return { ok: true, json: async () => ({ active: true }) };
      if (parsed.pathname === '/bridge/result') { results.push(JSON.parse(options.body ?? '{}')); return { ok: true, json: async () => ({ ok: true }) }; }
      if (parsed.pathname === '/bridge/poll') {
        if (pollDelivered) return AbortableWait(options.signal) as any;
        pollDelivered = true;
        return { ok: true, json: async () => ({ commands: [{ id: 'late-update', browserTaskId: 'test-task', operation: 'cdp', payload: { id: 4, method: 'Target.activateTarget', params: { targetId: '10' } }, deadline: Date.now() + 25 }] }) };
      }
      return { ok: true, json: async () => ({}) };
    };
    const source = readFileSync(resolve('apps/browser-extension/service-worker.js'), 'utf8');
    runInNewContext(source, { chrome, fetch, URL, AbortController, AbortSignal, setTimeout, clearTimeout, Object, Array });
    await tabLookupStartedPromise;
    await new Promise((done) => setTimeout(done, 50));
    releaseTabLookup();
    for (let attempt = 0; attempt < 20 && !results.length; attempt += 1) await new Promise((done) => setTimeout(done, 0));

    expect(events).toEqual([]);
    // tabs.get 是只读等待；截止时间已过时没有进入 tabs.update，因此状态仍可确定为未执行。
    expect(results).toEqual([expect.objectContaining({ id: 'late-update', ok: false, error: expect.objectContaining({ code: 'BROWSER_COMMAND_TIMEOUT', statusUnknown: false }) })]);
  });

  it('session-bound CDP command converts the owned numeric tabId back to a protocol targetId', async () => {
    const sessionStorage = SeedTaskRegistry({ 'runtime-task': { tabIds: [21], parentTabId: null, activeTabId: 21 } });
    const debuggerCalls: Array<{ target: unknown; method: string; params: unknown }> = [];
    const chrome = {
      storage: { local: StorageArea({}), session: StorageArea(sessionStorage) },
      runtime: {
        onMessage: { addListener: () => undefined }, onStartup: { addListener: () => undefined },
        onInstalled: { addListener: () => undefined }, getManifest: () => ({ version: '0.2.0' }),
      },
      alarms: { create: () => undefined, onAlarm: { addListener: () => undefined } },
      tabs: {
        get: async (tabId: number) => ({ id: tabId, windowId: 2, status: 'complete', url: 'https://example.test/task', title: 'task' }),
        onRemoved: { addListener: () => undefined },
      },
      debugger: {
        attach: async () => undefined,
        sendCommand: async (target: unknown, method: string, params: unknown) => {
          debuggerCalls.push({ target, method, params });
          return { result: { type: 'string', value: 'complete' } };
        },
        onDetach: { addListener: () => undefined },
      },
    };
    const worker = StartWorker(chrome, async () => ({ ok: true, json: async () => ({}) }), 20_500);
    const beforeExternalCommand = async () => undefined;

    const response = await worker.HandleCdp('runtime-task', {
      id: 7,
      method: 'Runtime.evaluate',
      sessionId: worker.ExpectedSessionId('runtime-task', 21),
      params: { expression: 'document.readyState', returnByValue: true },
    }, beforeExternalCommand, Date.now() + 5_000);

    expect(response).toEqual({ id: 7, result: { result: { type: 'string', value: 'complete' } } });
    expect(debuggerCalls).toEqual([{
      target: { tabId: 21 },
      method: 'Runtime.evaluate',
      params: { expression: 'document.readyState', returnByValue: true },
    }]);
  });

  it('Host 取消发生在 TaskTab 读取期间时，恢复后不会进入 tabs.update 或 debugger.sendCommand', async () => {
    const events: string[] = [];
    const results: any[] = [];
    const storage: Record<string, unknown> = { averyBridge: { token: 'a'.repeat(64), port: 1111 } };
    const sessionStorage = SeedTaskRegistry({ 'test-task': { tabIds: [10], parentTabId: null, activeTabId: 10 } });
    let statusChecks = 0;
    let tabLookupStarted!: () => void;
    const tabLookupStartedPromise = new Promise<void>((resolve) => { tabLookupStarted = resolve; });
    let releaseTabLookup!: () => void;
    const tabLookupFinished = new Promise<void>((resolve) => { releaseTabLookup = resolve; });
    const chrome = {
      storage: { local: StorageArea(storage), session: StorageArea(sessionStorage) },
      runtime: {
        onMessage: { addListener: () => undefined }, onStartup: { addListener: () => undefined }, onInstalled: { addListener: () => undefined }, getManifest: () => ({ version: '0.2.0' }),
      },
      alarms: { create: () => undefined, onAlarm: { addListener: () => undefined } },
      tabs: {
        get: async (tabId: number) => { tabLookupStarted(); await tabLookupFinished; return { id: tabId, status: 'complete', url: 'https://example.com/task', title: 'task' }; },
        update: async () => { events.push('update'); }, onRemoved: { addListener: () => undefined },
      },
      debugger: { sendCommand: async () => { events.push('sendCommand'); return {}; }, onDetach: { addListener: () => undefined } },
    };
    let pollDelivered = false;
    const fetch = async (url: string, options: { body?: string; signal?: AbortSignal } = {}) => {
      const parsed = new URL(url);
      if (parsed.pathname === '/bridge/command-status') {
        statusChecks += 1;
        return { ok: true, json: async () => ({ active: statusChecks < 3 }) };
      }
      if (parsed.pathname === '/bridge/result') { results.push(JSON.parse(options.body ?? '{}')); return { ok: true, json: async () => ({ ok: true }) }; }
      if (parsed.pathname === '/bridge/poll') {
        if (pollDelivered) return AbortableWait(options.signal) as any;
        pollDelivered = true;
        return { ok: true, json: async () => ({ commands: [{ id: 'cancelled-update', browserTaskId: 'test-task', operation: 'cdp', payload: { id: 5, method: 'Target.activateTarget', params: { targetId: '10' } }, deadline: Date.now() + 5_000 }] }) };
      }
      return { ok: true, json: async () => ({}) };
    };
    const source = readFileSync(resolve('apps/browser-extension/service-worker.js'), 'utf8');
    runInNewContext(source, { chrome, fetch, URL, AbortController, AbortSignal, setTimeout, clearTimeout, Object, Array });
    await tabLookupStartedPromise;
    // 模拟 Host 在只读 Chrome API 等待期间撤销 Bridge pending；恢复后、tabs.update 前的校验应观察到撤销。
    releaseTabLookup();
    for (let attempt = 0; attempt < 20 && !results.length; attempt += 1) await new Promise((done) => setTimeout(done, 0));

    expect(events).toEqual([]);
    expect(results).toEqual([expect.objectContaining({
      id: 'cancelled-update', ok: false,
      error: expect.objectContaining({ code: 'CANCELLED', statusUnknown: false }),
    })]);
  });

  it('经典 sendResponse listener 覆盖同步拒绝与异步失败，并只响应一次', async () => {
    let onMessage: MessageListener | undefined;
    const local: Record<string, unknown> = {};
    const chrome = {
      storage: { local: StorageArea(local), session: StorageArea({}) },
      runtime: {
        onMessage: { addListener: (listener: MessageListener) => { onMessage = listener; } },
        onStartup: { addListener: () => undefined }, onInstalled: { addListener: () => undefined },
        getManifest: () => ({ version: '0.2.0' }),
      },
      alarms: { create: () => undefined, onAlarm: { addListener: () => undefined } },
      tabs: { onRemoved: { addListener: () => undefined } },
      debugger: { onDetach: { addListener: () => undefined } },
    };
    const fetch = async (url: string) => url.includes('/bridge/hello')
      ? ({ ok: false, status: 503, json: async () => ({}) })
      : ({ ok: false, status: 503, json: async () => ({}) });
    StartWorker(chrome, fetch, 20_000);

    const rejected = await CallMessage(onMessage!, { type: 'avery_pair', token: 'invalid', port: 2222 });
    expect(rejected).toEqual({
      returnValue: false, responses: [{ ok: false, message: 'pairing credentials are invalid' }],
      value: { ok: false, message: 'pairing credentials are invalid' },
    });
    const failed = await CallMessage(onMessage!, { type: 'avery_pair', token: 'b'.repeat(64), port: 2222 });
    expect(failed.returnValue).toBe(true);
    expect(failed.responses).toHaveLength(1);
    expect(failed.value).toMatchObject({ ok: false, message: expect.stringContaining('HTTP 503') });
  });

  it('browserTaskId 或 deadline 缺失时扩展命令 fail closed，不接触标签页', async () => {
    const results: any[] = [];
    let delivered = false;
    let tabTouches = 0;
    const chrome = {
      storage: { local: StorageArea({ averyBridge: { token: 'a'.repeat(64), port: 1111 } }), session: StorageArea({}) },
      runtime: { onMessage: { addListener: () => undefined }, onStartup: { addListener: () => undefined }, onInstalled: { addListener: () => undefined }, getManifest: () => ({ version: '0.2.0' }) },
      alarms: { create: () => undefined, onAlarm: { addListener: () => undefined } },
      tabs: {
        get: async () => { tabTouches += 1; return undefined; }, create: async () => { tabTouches += 1; return undefined; },
        remove: async () => { tabTouches += 1; }, update: async () => { tabTouches += 1; }, onRemoved: { addListener: () => undefined },
      },
      debugger: { onDetach: { addListener: () => undefined } },
    };
    const commands = [
      { id: 'missing-task-id', operation: 'cdp', deadline: Date.now() + 5_000, payload: { id: 1, method: 'Target.getTargets', params: {} } },
      { id: 'missing-deadline', browserTaskId: 'task-missing-deadline', operation: 'close_task', payload: {} },
    ];
    const fetch = async (url: string, options: { body?: string; signal?: AbortSignal } = {}) => {
      const parsed = new URL(url);
      if (parsed.pathname === '/bridge/command-status') return { ok: true, json: async () => ({ active: true }) };
      if (parsed.pathname === '/bridge/result') { results.push(JSON.parse(options.body ?? '{}')); return { ok: true, json: async () => ({ ok: true }) }; }
      if (parsed.pathname === '/bridge/poll') {
        if (delivered) return AbortableWait(options.signal) as any;
        delivered = true;
        return { ok: true, json: async () => ({ commands }) };
      }
      return { ok: true, json: async () => ({}) };
    };
    StartWorker(chrome, fetch, 20_500);
    await WaitUntil(() => results.length === 2);

    expect(results).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'missing-task-id', ok: false, error: expect.objectContaining({ code: 'BROWSER_TASK_ID_REQUIRED', statusUnknown: false }) }),
      expect.objectContaining({ id: 'missing-deadline', ok: false, error: expect.objectContaining({ code: 'BROWSER_COMMAND_DEADLINE_REQUIRED', statusUnknown: false }) }),
    ]));
    expect(tabTouches).toBe(0);
  });

  it('任务登记隔离 A/B、只继承已登记 opener 子页，并真实切换跨域子页', async () => {
    const local: Record<string, unknown> = { averyBridge: { token: 'a'.repeat(64), port: 1111 } };
    const session: Record<string, unknown> = {};
    const results: any[] = [];
    const tabs = new Map<number, any>();
    const updated: number[] = [];
    const removed: number[] = [];
    let onCreated: ((tab: any) => void) | undefined;
    const chrome = {
      storage: { local: StorageArea(local), session: StorageArea(session) },
      runtime: {
        onMessage: { addListener: () => undefined }, onStartup: { addListener: () => undefined },
        onInstalled: { addListener: () => undefined }, getManifest: () => ({ version: '0.2.0' }),
      },
      alarms: { create: () => undefined, onAlarm: { addListener: () => undefined } },
      tabs: {
        get: async (id: number) => {
          const tab = tabs.get(id);
          if (!tab) throw Object.assign(new Error('No such tab'), { code: 'NO_TAB' });
          return tab;
        },
        create: async ({ url }: { url: string }) => {
          const id = tabs.has(10) ? 20 : 10;
          const tab = { id, status: 'complete', url, title: `task-${id}`, windowId: 1 };
          tabs.set(id, tab);
          return tab;
        },
        update: async (id: number, options: any) => { updated.push(id); if (options.url) tabs.set(id, { ...tabs.get(id), url: options.url }); },
        remove: async (id: number) => { removed.push(id); tabs.delete(id); },
        onCreated: { addListener: (listener: (tab: any) => void) => { onCreated = listener; } },
        onActivated: { addListener: () => undefined }, onRemoved: { addListener: () => undefined },
      },
      windows: { update: async () => undefined },
      debugger: { attach: async () => undefined, detach: async () => undefined, sendCommand: async () => ({}), onDetach: { addListener: () => undefined } },
    };
    const cdp = (id: number, browserTaskId: string, method: string, params: Record<string, unknown> = {}) => ({
      id: `${browserTaskId}-${id}`, browserTaskId, operation: 'cdp', deadline: Date.now() + 5_000,
      payload: { id, method, params },
    });
    const commands = [
      cdp(1, 'task-a', 'Target.createTarget', { url: 'https://a.example.test' }),
      cdp(2, 'task-a', 'Target.getTargets'),
      cdp(3, 'task-a', 'Target.activateTarget', { targetId: '11' }),
      cdp(4, 'task-b', 'Target.createTarget', { url: 'https://b.example.test' }),
      cdp(5, 'task-b', 'Target.getTargets'),
      cdp(6, 'task-a', 'Target.getTargets'),
      cdp(7, 'task-a', 'Target.activateTarget', { targetId: '99' }),
      cdp(8, 'task-b', 'Target.activateTarget', { targetId: '10' }),
      { id: 'close-a', browserTaskId: 'task-a', operation: 'close_task', payload: {}, deadline: Date.now() + 5_000 },
      cdp(9, 'task-b', 'Target.getTargets'),
      { id: 'close-a-late', browserTaskId: 'task-a', operation: 'close_task', payload: {}, deadline: Date.now() + 5_000 },
      cdp(10, 'task-b', 'Target.getTargets'),
    ];
    let pollDelivered = false;
    const fetch = async (url: string, options: { body?: string; signal?: AbortSignal } = {}) => {
      const parsed = new URL(url);
      if (parsed.pathname === '/bridge/command-status') return { ok: true, json: async () => ({ active: true }) };
      if (parsed.pathname === '/bridge/result') {
        const result = JSON.parse(options.body ?? '{}');
        results.push(result);
        if (result.id === 'task-a-1' && result.ok) {
          tabs.set(11, { id: 11, openerTabId: 10, status: 'complete', url: 'https://cross-domain.example.test/child', title: 'child', windowId: 1 });
          tabs.set(12, { id: 12, status: 'complete', url: 'https://no-opener.example.test/', title: 'no opener', windowId: 1 });
          tabs.set(99, { id: 99, status: 'complete', url: 'https://user.example.test/', title: 'user tab', windowId: 1 });
          onCreated?.(tabs.get(11));
          onCreated?.(tabs.get(12));
          onCreated?.(tabs.get(99));
    await WaitUntil(() => LatestTaskRegistry(session)?.['task-a']?.tabIds?.includes(11) === true);
        }
        return { ok: true, json: async () => ({ ok: true }) };
      }
      if (parsed.pathname === '/bridge/poll') {
        if (pollDelivered) return AbortableWait(options.signal) as any;
        pollDelivered = true;
        return { ok: true, json: async () => ({ commands }) };
      }
      return { ok: true, json: async () => ({}) };
    };
    StartWorker(chrome, fetch, 21_000);
    await WaitUntil(() => results.length === commands.length, 3000);

    const taskATargets = results.find((result) => result.id === 'task-a-2')?.data?.result?.targetInfos;
    const taskBTargets = results.find((result) => result.id === 'task-b-5')?.data?.result?.targetInfos;
    const taskBAfterClose = results.find((result) => result.id === 'task-b-9')?.data?.result?.targetInfos;
    expect(taskATargets.map((target: any) => target.targetId)).toEqual(['10', '11']);
    expect(taskATargets.find((target: any) => target.targetId === '11').url).toBe('https://cross-domain.example.test/child');
    expect(taskBTargets.map((target: any) => target.targetId)).toEqual(['20']);
    expect(taskBAfterClose.map((target: any) => target.targetId)).toEqual(['20']);
    expect(results.find((result) => result.id === 'task-a-7')?.error).toMatchObject({ code: 'BROWSER_TAB_NOT_FOUND', message: expect.stringContaining('rel=noopener') });
    expect(results.find((result) => result.id === 'task-b-8')?.error).toMatchObject({ code: 'BROWSER_TAB_NOT_FOUND' });
    expect(updated).toEqual([11]);
    expect(removed).toEqual([10, 11]);
    expect(tabs.has(99)).toBe(true);
    expect(LatestTaskRegistry(session)).toEqual({ 'task-b': { tabIds: [20], parentTabId: null, activeTabId: 20 } });
  });

  it('browser-wide tab oracle verifies A closes only its cross-window opener tree and preserves user/B/noopener tabs', async () => {
    const local: Record<string, unknown> = { averyBridge: { token: 'a'.repeat(64), port: 1111 } };
    const session = SeedTaskRegistry({
      'task-a': { tabIds: [10], parentTabId: null, activeTabId: 10 },
      'task-b': { tabIds: [20], parentTabId: null, activeTabId: 20 },
    });
    const tabs = new Map<number, any>([
      [10, { id: 10, status: 'complete', url: 'https://a.example.test/main', title: 'A main', windowId: 1 }],
      [20, { id: 20, status: 'complete', url: 'https://b.example.test/sentinel', title: 'B sentinel', windowId: 3 }],
      [90, { id: 90, status: 'complete', url: 'https://user.example.test/original', title: 'User original', windowId: 4 }],
      [91, { id: 91, status: 'complete', url: 'https://user.example.test/noopener', title: 'No opener', windowId: 5 }],
    ]);
    const results: any[] = [];
    const activated: number[] = [];
    const removed: number[] = [];
    const focusedWindows: number[] = [];
    let onCreated: ((tab: any) => void) | undefined;
    let deliverCommands!: () => void;
    const commandsReady = new Promise<void>((resolve) => { deliverCommands = resolve; });
    const chrome = {
      storage: { local: StorageArea(local), session: StorageArea(session) },
      runtime: { onMessage: { addListener: () => undefined }, onStartup: { addListener: () => undefined }, onInstalled: { addListener: () => undefined }, getManifest: () => ({ version: '0.2.0' }) },
      alarms: { create: () => undefined, onAlarm: { addListener: () => undefined } },
      tabs: {
        get: async (id: number) => {
          const tab = tabs.get(id);
          if (!tab) throw Object.assign(new Error('No such tab'), { code: 'NO_TAB' });
          return tab;
        },
        create: async () => { throw new Error('not used'); },
        update: async (id: number, options: any) => { if (options.active) activated.push(id); },
        remove: async (id: number) => { removed.push(id); tabs.delete(id); },
        onCreated: { addListener: (listener: (tab: any) => void) => { onCreated = listener; } },
        onActivated: { addListener: () => undefined }, onRemoved: { addListener: () => undefined },
      },
      windows: { update: async (windowId: number) => { focusedWindows.push(windowId); } },
      debugger: { onDetach: { addListener: () => undefined } },
    };
    const commands = [
      { id: 'oracle-a-targets', browserTaskId: 'task-a', operation: 'cdp', deadline: Date.now() + 5_000, payload: { id: 1, method: 'Target.getTargets', params: {} } },
      { id: 'oracle-a-activate-child', browserTaskId: 'task-a', operation: 'cdp', deadline: Date.now() + 5_000, payload: { id: 2, method: 'Target.activateTarget', params: { targetId: '11' } } },
      { id: 'oracle-a-noopener', browserTaskId: 'task-a', operation: 'cdp', deadline: Date.now() + 5_000, payload: { id: 3, method: 'Target.activateTarget', params: { targetId: '91' } } },
      { id: 'oracle-close-a', browserTaskId: 'task-a', operation: 'close_task', deadline: Date.now() + 5_000, payload: {} },
    ];
    let delivered = false;
    const fetch = async (url: string, options: { body?: string; signal?: AbortSignal } = {}) => {
      const parsed = new URL(url);
      if (parsed.pathname === '/bridge/command-status') return { ok: true, json: async () => ({ active: true }) };
      if (parsed.pathname === '/bridge/result') { results.push(JSON.parse(options.body ?? '{}')); return { ok: true, json: async () => ({ ok: true }) }; }
      if (parsed.pathname === '/bridge/poll') {
        if (delivered) return AbortableWait(options.signal) as any;
        await commandsReady;
        delivered = true;
        return { ok: true, json: async () => ({ commands }) };
      }
      return { ok: true, json: async () => ({}) };
    };
    StartWorker(chrome, fetch, 21_500);

    const openerChild = { id: 11, openerTabId: 10, status: 'complete', url: 'https://cross-domain.example.test/child', title: 'A child', windowId: 2 };
    tabs.set(11, openerChild);
    onCreated?.(openerChild);
    onCreated?.(tabs.get(91));
    await WaitUntil(() => LatestTaskRegistry(session)?.['task-a']?.tabIds?.includes(11) === true);
    deliverCommands();
    await WaitUntil(() => results.length === commands.length, 2_000);

    const aTargets = results.find((result) => result.id === 'oracle-a-targets')?.data?.result?.targetInfos;
    expect(aTargets).toEqual(expect.arrayContaining([
      expect.objectContaining({ targetId: '10', tabId: 10, windowId: 1 }),
      expect.objectContaining({ targetId: '11', tabId: 11, windowId: 2, openerTabId: 10 }),
    ]));
    expect(aTargets).toHaveLength(2);
    expect(results.find((result) => result.id === 'oracle-a-noopener')?.error).toMatchObject({ code: 'BROWSER_TAB_NOT_FOUND' });
    expect(activated).toEqual([11]);
    expect(focusedWindows).toEqual([2]);
    expect(removed.sort((a, b) => a - b)).toEqual([10, 11]);
    // This is an independent browser-wide oracle: do not infer safety from A's scoped getTargets result.
    expect([...tabs.keys()].sort((a, b) => a - b)).toEqual([20, 90, 91]);
    expect(LatestTaskRegistry(session)).toEqual({ 'task-b': { tabIds: [20], parentTabId: null, activeTabId: 20 } });
    expect(results.find((result) => result.id === 'oracle-close-a')?.data).toMatchObject({ status: 'confirmed', closedTabs: 2, unknownTabs: 0 });
  });

  it('hung tabs.get 释放 commandTail，且迟到只读结果不能阻止新任务执行', async () => {
    const local: Record<string, unknown> = { averyBridge: { token: 'a'.repeat(64), port: 1111 } };
    const session = SeedTaskRegistry({ 'task-old': { tabIds: [10], parentTabId: null, activeTabId: 10 } });
    const results: any[] = [];
    let releaseOldLookup!: () => void;
    const oldLookup = new Promise<void>((resolve) => { releaseOldLookup = resolve; });
    let lookupCount = 0;
    const tabs = new Map<number, any>([[10, { id: 10, status: 'complete', url: 'https://old.example.test', title: 'old' }]]);
    const chrome = {
      storage: { local: StorageArea(local), session: StorageArea(session) },
      runtime: { onMessage: { addListener: () => undefined }, onStartup: { addListener: () => undefined }, onInstalled: { addListener: () => undefined }, getManifest: () => ({ version: '0.2.0' }) },
      alarms: { create: () => undefined, onAlarm: { addListener: () => undefined } },
      tabs: {
        get: async (id: number) => {
          lookupCount += 1;
          if (id === 10) { await oldLookup; return tabs.get(id); }
          return tabs.get(id);
        },
        create: async ({ url }: { url: string }) => { tabs.set(20, { id: 20, status: 'complete', url, title: 'new' }); return tabs.get(20); },
        remove: async (id: number) => { tabs.delete(id); }, update: async () => undefined,
        onRemoved: { addListener: () => undefined },
      },
      debugger: { onDetach: { addListener: () => undefined } },
    };
    const commands = [
      { id: 'hung-get', browserTaskId: 'task-old', operation: 'cdp', deadline: Date.now() + 120, payload: { id: 1, method: 'Target.getTargets', params: {} } },
      { id: 'fresh-create', browserTaskId: 'task-new', operation: 'cdp', deadline: Date.now() + 5_000, payload: { id: 2, method: 'Target.createTarget', params: { url: 'https://new.example.test' } } },
    ];
    let pollDelivered = false;
    const fetch = async (url: string, options: { body?: string; signal?: AbortSignal } = {}) => {
      const parsed = new URL(url);
      if (parsed.pathname === '/bridge/command-status') return { ok: true, json: async () => ({ active: true }) };
      if (parsed.pathname === '/bridge/result') { results.push(JSON.parse(options.body ?? '{}')); return { ok: true, json: async () => ({ ok: true }) }; }
      if (parsed.pathname === '/bridge/poll') {
        if (pollDelivered) return AbortableWait(options.signal) as any;
        pollDelivered = true;
        return { ok: true, json: async () => ({ commands }) };
      }
      return { ok: true, json: async () => ({}) };
    };
    StartWorker(chrome, fetch, 22_000, true);
    await WaitUntil(() => results.some((result) => result.id === 'fresh-create'), 1500);
    releaseOldLookup();

    expect(lookupCount).toBeGreaterThanOrEqual(2);
    expect(results.find((result) => result.id === 'hung-get')?.error).toMatchObject({ code: 'BROWSER_COMMAND_TIMEOUT', statusUnknown: false });
    expect(results.find((result) => result.id === 'fresh-create')).toMatchObject({ ok: true, data: { result: { targetId: '20' } } });
    expect(LatestTaskRegistry(session)).toEqual({ 'task-old': { tabIds: [10], parentTabId: null, activeTabId: 10 }, 'task-new': { tabIds: [20], parentTabId: null, activeTabId: 20 } });
  });

  it('hung storage.session.get 释放 commandTail，迟到旧快照不能覆盖新任务', async () => {
    const local: Record<string, unknown> = { averyBridge: { token: 'a'.repeat(64), port: 1111 } };
    const session: Record<string, unknown> = {};
    let getCalls = 0;
    let releaseOldGet!: (value: Record<string, unknown>) => void;
    const oldGet = new Promise<Record<string, unknown>>((resolve) => { releaseOldGet = resolve; });
    const sessionArea = {
      ...StorageArea(session),
      get: async (keys: string | string[] | null) => {
        getCalls += 1;
        if (getCalls === 1) return oldGet;
        return StorageArea(session).get(keys);
      },
    };
    const results: any[] = [];
    const tabs = new Map<number, any>();
    const chrome = {
      storage: { local: StorageArea(local), session: sessionArea },
      runtime: { onMessage: { addListener: () => undefined }, onStartup: { addListener: () => undefined }, onInstalled: { addListener: () => undefined }, getManifest: () => ({ version: '0.2.0' }) },
      alarms: { create: () => undefined, onAlarm: { addListener: () => undefined } },
      tabs: {
        get: async (id: number) => tabs.get(id),
        create: async ({ url }: { url: string }) => { const tab = { id: 20, status: 'complete', url, title: 'new' }; tabs.set(20, tab); return tab; },
        remove: async (id: number) => { tabs.delete(id); }, update: async () => undefined,
        onRemoved: { addListener: () => undefined },
      },
      debugger: { onDetach: { addListener: () => undefined } },
    };
    const commands = [
      { id: 'hung-session-get', browserTaskId: 'task-old', operation: 'cdp', deadline: Date.now() + 120, payload: { id: 1, method: 'Target.getTargets', params: {} } },
      { id: 'fresh-after-session-get', browserTaskId: 'task-new', operation: 'cdp', deadline: Date.now() + 5_000, payload: { id: 2, method: 'Target.createTarget', params: { url: 'https://new.example.test' } } },
    ];
    let delivered = false;
    const fetch = async (url: string, options: { body?: string; signal?: AbortSignal } = {}) => {
      const parsed = new URL(url);
      if (parsed.pathname === '/bridge/command-status') return { ok: true, json: async () => ({ active: true }) };
      if (parsed.pathname === '/bridge/result') { results.push(JSON.parse(options.body ?? '{}')); return { ok: true, json: async () => ({ ok: true }) }; }
      if (parsed.pathname === '/bridge/poll') {
        if (delivered) return AbortableWait(options.signal) as any;
        delivered = true;
        return { ok: true, json: async () => ({ commands }) };
      }
      return { ok: true, json: async () => ({}) };
    };
    StartWorker(chrome, fetch, 23_000, true);
    await WaitUntil(() => results.some((result) => result.id === 'fresh-after-session-get'), 1500);
    releaseOldGet(SeedTaskRegistry({ 'stale-task': { tabIds: [99], parentTabId: null, activeTabId: 99 } }));

    expect(results.find((result) => result.id === 'hung-session-get')?.error).toMatchObject({ code: 'BROWSER_COMMAND_TIMEOUT', statusUnknown: false });
    expect(results.find((result) => result.id === 'fresh-after-session-get')).toMatchObject({ ok: true, data: { result: { targetId: '20' } } });
    expect(getCalls).toBeGreaterThanOrEqual(2);
    expect(LatestTaskRegistry(session)).toEqual({ 'task-new': { tabIds: [20], parentTabId: null, activeTabId: 20 } });
  });

  it('短 storage.session.get waiter timeout 不会作废长 mutator 共享的 registry load', async () => {
    const local: Record<string, unknown> = {};
    const session = SeedTaskRegistry({
      'task-a': { tabIds: [10], parentTabId: null, activeTabId: 10 },
      'task-b': { tabIds: [20], parentTabId: null, activeTabId: 20 },
    });
    let getCalls = 0;
    let onCreated: ((tab: any) => void) | undefined;
    const sessionArea = {
      ...StorageArea(session),
      get: async (keys: string | string[] | null) => {
        getCalls += 1;
        if (getCalls === 1) {
          return new Promise<Record<string, unknown>>((resolve) => setTimeout(() => resolve({ ...session }), 1250));
        }
        return StorageArea(session).get(keys);
      },
    };
    const chrome = {
      storage: { local: StorageArea(local), session: sessionArea },
      runtime: { onMessage: { addListener: () => undefined }, onStartup: { addListener: () => undefined }, onInstalled: { addListener: () => undefined }, getManifest: () => ({ version: '0.2.0' }) },
      alarms: { create: () => undefined, onAlarm: { addListener: () => undefined } },
      tabs: {
        onCreated: { addListener: (listener: (tab: any) => void) => { onCreated = listener; } },
        onRemoved: { addListener: () => undefined },
      },
      debugger: { onDetach: { addListener: () => undefined } },
    };
    const worker = StartWorker(chrome, async () => ({ ok: true, json: async () => ({}) }), 25_000);
    const start = Date.now();
    onCreated?.({ id: 11, openerTabId: 10 });
    await WaitUntil(() => getCalls === 1);
    const longMutation = worker.MutateTaskRegistry((registry: Record<string, any>) => {
      registry['task-c'] = { tabIds: [30], parentTabId: null, activeTabId: 30 };
    }, Date.now() + 4_000);

    await expect(longMutation).resolves.toBeUndefined();
    expect(Date.now() - start).toBeGreaterThanOrEqual(1_200);
    expect(LatestTaskRegistry(session)).toEqual({
      'task-a': { tabIds: [10], parentTabId: null, activeTabId: 10 },
      'task-b': { tabIds: [20], parentTabId: null, activeTabId: 20 },
      'task-c': { tabIds: [30], parentTabId: null, activeTabId: 30 },
    });
  });

  it('CloseTask 的多个挂起 tabs.remove 共用一个 deadline，命令队列按期释放', async () => {
    const local: Record<string, unknown> = { averyBridge: { token: 'a'.repeat(64), port: 1111 } };
    const session = SeedTaskRegistry({ 'task-close': { tabIds: [10, 11, 12], parentTabId: null, activeTabId: 10 } });
    const results: any[] = [];
    const removeStarted: number[] = [];
    const tabs = new Map<number, any>([10, 11, 12].map((id) => [id, { id, windowId: 1, openerTabId: null, status: 'complete', url: `https://task-${id}.example.test`, title: String(id) }]));
    const chrome = {
      storage: { local: StorageArea(local), session: StorageArea(session) },
      runtime: { onMessage: { addListener: () => undefined }, onStartup: { addListener: () => undefined }, onInstalled: { addListener: () => undefined }, getManifest: () => ({ version: '0.2.0' }) },
      alarms: { create: () => undefined, onAlarm: { addListener: () => undefined } },
      tabs: {
        get: async (id: number) => tabs.get(id),
        create: async ({ url }: { url: string }) => { const tab = { id: 20, windowId: 1, openerTabId: null, status: 'complete', url, title: 'fresh' }; tabs.set(20, tab); return tab; },
        remove: async (id: number) => { removeStarted.push(id); return new Promise<void>(() => undefined); },
        update: async () => undefined, onRemoved: { addListener: () => undefined },
      },
      debugger: { onDetach: { addListener: () => undefined } },
    };
    const start = Date.now();
    const commands = [
      { id: 'close-hung-tabs', browserTaskId: 'task-close', operation: 'close_task', deadline: start + 180, payload: {} },
      { id: 'fresh-after-close', browserTaskId: 'task-fresh', operation: 'cdp', deadline: start + 5_000, payload: { id: 1, method: 'Target.createTarget', params: { url: 'https://fresh.example.test' } } },
      { id: 'fresh-targets-after-close', browserTaskId: 'task-fresh', operation: 'cdp', deadline: start + 5_000, payload: { id: 2, method: 'Target.getTargets', params: {} } },
    ];
    let delivered = false;
    const fetch = async (url: string, options: { body?: string; signal?: AbortSignal } = {}) => {
      const parsed = new URL(url);
      if (parsed.pathname === '/bridge/command-status') return { ok: true, json: async () => ({ active: true }) };
      if (parsed.pathname === '/bridge/result') { results.push(JSON.parse(options.body ?? '{}')); return { ok: true, json: async () => ({ ok: true }) }; }
      if (parsed.pathname === '/bridge/poll') {
        if (delivered) return AbortableWait(options.signal) as any;
        delivered = true;
        return { ok: true, json: async () => ({ commands }) };
      }
      return { ok: true, json: async () => ({}) };
    };
    StartWorker(chrome, fetch, 24_000, true);
    await WaitUntil(() => results.some((result) => result.id === 'fresh-targets-after-close'), 1500);

    const closeResult = results.find((result) => result.id === 'close-hung-tabs');
    expect(removeStarted.sort()).toEqual([10, 11, 12]);
    expect(closeResult).toMatchObject({
      ok: true,
      data: { status: 'status_unknown', browserTaskId: 'task-close', closedTabs: 0, unknownTabs: 3, code: 'BROWSER_COMMAND_TIMEOUT' },
    });
    expect(results.find((result) => result.id === 'fresh-after-close')).toMatchObject({ ok: true, data: { result: { targetId: '20' } } });
    expect(results.find((result) => result.id === 'fresh-targets-after-close')?.data?.result?.targetInfos).toEqual([
      expect.objectContaining({ targetId: '20', tabId: 20 }),
    ]);
    expect([...tabs.keys()].sort((a, b) => a - b)).toEqual([10, 11, 12, 20]);
    expect(Date.now() - start).toBeLessThan(600);
  });

  it('hung storage.session.set 超时后释放队列；新 worker 与迟到快照逆序时仍加载新状态', async () => {
    const local: Record<string, unknown> = { averyBridge: { token: 'a'.repeat(64), port: 1111 } };
    const session: Record<string, unknown> = SeedTaskRegistry({});
    let setCalls = 0;
    let lateAValue: Record<string, unknown> | null = null;
    let releaseLateA!: () => void;
    const lateA = new Promise<void>((resolve) => { releaseLateA = resolve; });
    const sessionArea = {
      ...StorageArea(session),
      set: async (value: Record<string, unknown>) => {
        setCalls += 1;
        if (setCalls === 2) {
          lateAValue = value;
          await lateA;
        }
        Object.assign(session, value);
      },
    };
    const createChrome = (tabs: Map<number, any>, createdTabId: number) => ({
      storage: { local: StorageArea(local), session: sessionArea },
      runtime: { onMessage: { addListener: () => undefined }, onStartup: { addListener: () => undefined }, onInstalled: { addListener: () => undefined }, getManifest: () => ({ version: '0.2.0' }) },
      alarms: { create: () => undefined, onAlarm: { addListener: () => undefined } },
      tabs: {
        get: async (id: number) => tabs.get(id),
        create: async ({ url }: { url: string }) => { const tab = { id: createdTabId, status: 'complete', url, title: 'task' }; tabs.set(tab.id, tab); return tab; },
        remove: async (id: number) => { tabs.delete(id); }, update: async () => undefined,
        onRemoved: { addListener: () => undefined },
      },
      debugger: { onDetach: { addListener: () => undefined } },
    });
    const commandFetch = (command: any, results: any[]) => {
      let delivered = false;
      return async (url: string, options: { body?: string; signal?: AbortSignal } = {}) => {
        const parsed = new URL(url);
        if (parsed.pathname === '/bridge/command-status') return { ok: true, json: async () => ({ active: true }) };
        if (parsed.pathname === '/bridge/result') { results.push(JSON.parse(options.body ?? '{}')); return { ok: true, json: async () => ({ ok: true }) }; }
        if (parsed.pathname === '/bridge/poll') {
          if (delivered) return AbortableWait(options.signal) as any;
          delivered = true;
          return { ok: true, json: async () => ({ commands: [command] }) };
        }
        return { ok: true, json: async () => ({}) };
      };
    };

    const tabsA = new Map<number, any>();
    const resultsA: any[] = [];
    StartWorker(createChrome(tabsA, 10), commandFetch({
      id: 'worker-a-create', browserTaskId: 'task-a', operation: 'cdp', deadline: Date.now() + 500,
      payload: { id: 1, method: 'Target.createTarget', params: { url: 'https://a.example.test' } },
    }, resultsA), 10_000, true);
    await WaitUntil(() => resultsA.length === 1 && lateAValue !== null, 1500);
    expect(resultsA[0]).toMatchObject({ ok: false, error: { code: 'BROWSER_COMMAND_TIMEOUT', statusUnknown: true } });

    const tabsB = new Map<number, any>();
    const resultsB: any[] = [];
    StartWorker(createChrome(tabsB, 20), commandFetch({
      id: 'worker-b-create', browserTaskId: 'task-b', operation: 'cdp', deadline: Date.now() + 5_000,
      payload: { id: 2, method: 'Target.createTarget', params: { url: 'https://b.example.test' } },
    }, resultsB), 11_000, true);
    await WaitUntil(() => resultsB.length === 1, 1500);
    expect(resultsB[0]).toMatchObject({ ok: true, data: { result: { targetId: '20' } } });
    releaseLateA();
    await WaitUntil(() => Object.keys(session).some((key) => key.includes('.2.worker-10000')), 1000);

    // Highest revision is deliberately malformed; restart must select B's newest complete snapshot.
    session['averyTaskTabs.12000000.999.worker-corrupt'] = {
      schemaVersion: 1, epoch: 12_000_000, revision: 999, writerId: 'worker-corrupt',
      registry: { broken: { tabIds: [7], parentTabId: null, activeTabId: 8 } },
    };
    const tabsReload = new Map<number, any>([[20, { id: 20, windowId: 1, openerTabId: null, status: 'complete', url: 'https://b.example.test', title: 'B' }]]);
    const reloadResults: any[] = [];
    StartWorker(createChrome(tabsReload, 20), commandFetch({
      id: 'reload-b-targets', browserTaskId: 'task-b', operation: 'cdp', deadline: Date.now() + 5_000,
      payload: { id: 3, method: 'Target.getTargets', params: {} },
    }, reloadResults), 12_000, true);
    await WaitUntil(() => reloadResults.length === 1, 1500);
    expect(reloadResults[0]).toMatchObject({ ok: true, data: { result: { targetInfos: [{ targetId: '20' }] } } });

    // Chrome 重启会清空 storage.session；残留 browser tab 不能凭旧 taskId 重新可信。
    for (const key of Object.keys(session)) delete session[key];
    const restartResults: any[] = [];
    let staleTabLookups = 0;
    const tabsAfterBrowserRestart = new Map<number, any>([[20, { id: 20, status: 'complete', url: 'https://b.example.test', title: 'B' }]]);
    const restartChrome = createChrome(tabsAfterBrowserRestart, 20);
    restartChrome.tabs.get = async (id: number) => { if (id === 20) staleTabLookups += 1; return tabsAfterBrowserRestart.get(id); };
    StartWorker(restartChrome, commandFetch({
      id: 'chrome-restart-targets', browserTaskId: 'task-b', operation: 'cdp', deadline: Date.now() + 5_000,
      payload: { id: 4, method: 'Target.getTargets', params: {} },
    }, restartResults), 13_000, true);
    await WaitUntil(() => restartResults.length === 1, 1500);
    expect(restartResults[0]).toMatchObject({ ok: true, data: { result: { targetInfos: [] } } });
    expect(staleTabLookups).toBe(0);
  });

  it('BridgeConfig 的 storage.local.get 挂起有界后仍可配对并启动 Poll', async () => {
    let onMessage: MessageListener | undefined;
    let getCalls = 0;
    const local: Record<string, unknown> = {};
    const normal = StorageArea(local);
    const localArea = {
      ...normal,
      get: async (keys: string | string[] | null) => {
        getCalls += 1;
        if (getCalls === 1) return new Promise<Record<string, unknown>>(() => undefined);
        return normal.get(keys);
      },
    };
    const polledPorts: number[] = [];
    let onAlarm: ((alarm: { name: string }) => void) | undefined;
    const chrome = {
      storage: { local: localArea, session: StorageArea({}) },
      runtime: {
        onMessage: { addListener: (listener: MessageListener) => { onMessage = listener; } },
        onStartup: { addListener: () => undefined }, onInstalled: { addListener: () => undefined }, getManifest: () => ({ version: '0.2.0' }),
      },
      alarms: { create: () => undefined, onAlarm: { addListener: (listener: (alarm: { name: string }) => void) => { onAlarm = listener; } } },
      tabs: { onRemoved: { addListener: () => undefined } }, debugger: { onDetach: { addListener: () => undefined } },
    };
    const fetch = async (url: string) => {
      const parsed = new URL(url);
      if (parsed.pathname === '/bridge/hello') return { ok: true, json: async () => ({}) };
      if (parsed.pathname === '/bridge/poll') { polledPorts.push(Number(parsed.port)); return { ok: false, status: 503, json: async () => ({}) }; }
      return { ok: true, json: async () => ({}) };
    };
    StartWorker(chrome, fetch, 30_000, true);
    await WaitUntil(() => getCalls === 1);
    const paired = await CallMessage(onMessage!, { type: 'avery_pair', token: 'c'.repeat(64), port: 3333 });
    expect(paired.value).toEqual({ ok: true });
    await WaitUntil(() => polledPorts.includes(3333));
    onAlarm?.({ name: 'avery-bridge-poll' });
    await WaitUntil(() => polledPorts.filter((port) => port === 3333).length >= 2);
    expect(polledPorts.every((port) => port === 3333)).toBe(true);
  });

  it('慢速旧 pair get 在较新 pair 成功后恢复也不能写入或成为 Poll 配置', async () => {
    let onMessage: MessageListener | undefined;
    let onAlarm: ((alarm: { name: string }) => void) | undefined;
    let getCalls = 0;
    let releaseOldGet!: (value: Record<string, unknown>) => void;
    const oldGet = new Promise<Record<string, unknown>>((resolve) => { releaseOldGet = resolve; });
    const local: Record<string, unknown> = {};
    const normal = StorageArea(local);
    const localArea = {
      ...normal,
      get: async (keys: string | string[] | null) => {
        getCalls += 1;
        if (getCalls === 2) return oldGet;
        return normal.get(keys);
      },
    };
    const polledPorts: number[] = [];
    const chrome = {
      storage: { local: localArea, session: StorageArea({}) },
      runtime: {
        onMessage: { addListener: (listener: MessageListener) => { onMessage = listener; } },
        onStartup: { addListener: () => undefined }, onInstalled: { addListener: () => undefined }, getManifest: () => ({ version: '0.2.0' }),
      },
      alarms: { create: () => undefined, onAlarm: { addListener: (listener: (alarm: { name: string }) => void) => { onAlarm = listener; } } },
      tabs: { onRemoved: { addListener: () => undefined } }, debugger: { onDetach: { addListener: () => undefined } },
    };
    const fetch = async (url: string) => {
      const parsed = new URL(url);
      if (parsed.pathname === '/bridge/hello') return { ok: true, json: async () => ({}) };
      if (parsed.pathname === '/bridge/poll') { polledPorts.push(Number(parsed.port)); return { ok: false, status: 503, json: async () => ({}) }; }
      return { ok: true, json: async () => ({}) };
    };
    StartWorker(chrome, fetch, 31_000, true);
    await WaitUntil(() => getCalls === 1);
    const oldPair = CallMessage(onMessage!, { type: 'avery_pair', token: 'a'.repeat(64), port: 1111 });
    await WaitUntil(() => getCalls === 2);
    const newPair = await CallMessage(onMessage!, { type: 'avery_pair', token: 'b'.repeat(64), port: 2222 });
    expect(newPair.value).toEqual({ ok: true });
    await WaitUntil(() => polledPorts.includes(2222));
    releaseOldGet({ ...local });
    expect((await oldPair).value).toMatchObject({ ok: false, message: expect.stringContaining('newer Avery browser pairing') });
    await new Promise((done) => setTimeout(done, 0));
    onAlarm?.({ name: 'avery-bridge-poll' });
    await WaitUntil(() => polledPorts.filter((port) => port === 2222).length >= 2);
    expect(polledPorts.every((port) => port === 2222)).toBe(true);
    expect(Object.entries(local).filter(([key]) => key.startsWith('averyBridge.')).map(([, value]: any) => value.port)).toEqual([2222]);
  });

  it('超时的旧 pair set 迟到落盘后仍不能覆盖新 token 或 Poll 端口', async () => {
    let onMessage: MessageListener | undefined;
    let onAlarm: ((alarm: { name: string }) => void) | undefined;
    const local: Record<string, unknown> = {};
    const normal = StorageArea(local);
    let setCalls = 0;
    let lateValue: Record<string, unknown> | null = null;
    let releaseLateSet!: () => void;
    const lateSet = new Promise<void>((resolve) => { releaseLateSet = resolve; });
    const localArea = {
      ...normal,
      set: async (value: Record<string, unknown>) => {
        setCalls += 1;
        if (setCalls === 1) { lateValue = value; await lateSet; }
        Object.assign(local, value);
      },
    };
    const polledPorts: number[] = [];
    const chrome = {
      storage: { local: localArea, session: StorageArea({}) },
      runtime: {
        onMessage: { addListener: (listener: MessageListener) => { onMessage = listener; } },
        onStartup: { addListener: () => undefined }, onInstalled: { addListener: () => undefined }, getManifest: () => ({ version: '0.2.0' }),
      },
      alarms: { create: () => undefined, onAlarm: { addListener: (listener: (alarm: { name: string }) => void) => { onAlarm = listener; } } },
      tabs: { onRemoved: { addListener: () => undefined } }, debugger: { onDetach: { addListener: () => undefined } },
    };
    const fetch = async (url: string) => {
      const parsed = new URL(url);
      if (parsed.pathname === '/bridge/hello') return { ok: true, json: async () => ({}) };
      if (parsed.pathname === '/bridge/poll') { polledPorts.push(Number(parsed.port)); return { ok: false, status: 503, json: async () => ({}) }; }
      return { ok: true, json: async () => ({}) };
    };
    StartWorker(chrome, fetch, 32_000, true);
    await WaitUntil(() => Object.keys(local).length === 0);
    const oldPair = await CallMessage(onMessage!, { type: 'avery_pair', token: 'a'.repeat(64), port: 1111 });
    expect(oldPair.value).toMatchObject({ ok: false, message: expect.stringContaining('could not be saved') });
    const newPair = await CallMessage(onMessage!, { type: 'avery_pair', token: 'b'.repeat(64), port: 2222 });
    expect(newPair.value).toEqual({ ok: true });
    await WaitUntil(() => polledPorts.includes(2222));
    expect(lateValue).not.toBeNull();
    releaseLateSet();
    await WaitUntil(() => Object.values(local).some((value: any) => value?.port === 1111));
    await new Promise((done) => setTimeout(done, 0));
    onAlarm?.({ name: 'avery-bridge-poll' });
    await WaitUntil(() => polledPorts.filter((port) => port === 2222).length >= 2);
    expect(polledPorts.every((port) => port === 2222)).toBe(true);
  });
});
