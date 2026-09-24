import { readFile, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp } from 'node:fs/promises';
import { createContext, runInContext } from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BrowserExtensionBridge, BrowserExtensionProtocolRevision } from '../../../apps/backend/src/electron/backend/browser-extension-bridge';
import { CreatePersonalBrowserExtensionRuntime } from '../../../apps/backend/src/electron/backend/personal-browser-extension-runtime';

const roots: string[] = [];
const WorkerInstanceId = 'worker-test';

function WorkerBody(body: Record<string, unknown> = {}, workerInstanceId = String(body.workerInstanceId ?? WorkerInstanceId)) {
  return { ...body, workerInstanceId };
}

async function PostBridge(bridge: BrowserExtensionBridge, statePath: string, path: string, body: Record<string, unknown>, workerInstanceId = WorkerInstanceId, signal?: AbortSignal) {
  const state = JSON.parse(await readFile(statePath, 'utf8'));
  return fetch(`http://127.0.0.1:${bridge.Status().port}${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${state.token}`, 'content-type': 'application/json' },
    body: JSON.stringify(WorkerBody(body, workerInstanceId)),
    ...(signal ? { signal } : {}),
  });
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('BrowserExtensionBridge', () => {
  it('请求在 deadline 已过期时不会启动 Bridge 或 Launch 浏览器', async () => {
    const root = await mkdtemp(join(tmpdir(), 'avery-extension-bridge-expired-'));
    roots.push(root);
    const launchBrowser = vi.fn();
    const bridge = new BrowserExtensionBridge({
      statePath: join(root, 'bridge.json'),
      browserPaths: { chrome: process.execPath },
      port: 0,
      launchBrowser,
    });

    try {
      await expect(bridge.Request('chrome', 'cdp', { id: 0, method: 'Target.getTargets', params: {} }, { deadline: Date.now() + 1_000 }))
        .rejects.toMatchObject({ code: 'BROWSER_TASK_ID_REQUIRED' });
      await expect(bridge.Request('chrome', 'cdp', { id: 0, method: 'Target.getTargets', params: {} }, { browserTaskId: 'task-test' }))
        .rejects.toMatchObject({ code: 'BROWSER_COMMAND_DEADLINE_REQUIRED' });
      await expect(bridge.Request('chrome', 'cdp', { id: 1, method: 'Target.getTargets', params: {} }, { deadline: Date.now() - 1, browserTaskId: 'task-test' }))
        .rejects.toMatchObject({ code: 'BROWSER_COMMAND_TIMEOUT', statusUnknown: false });
      expect(launchBrowser).not.toHaveBeenCalled();
    } finally {
      await bridge.Close();
    }
  });

  it('hello/poll 严格要求 exact protocolRevision，并把同版本旧 Worker 标为 stale', async () => {
    const root = await mkdtemp(join(tmpdir(), 'avery-extension-bridge-protocol-revision-'));
    roots.push(root);
    const statePath = join(root, 'bridge.json');
    const launchBrowser = vi.fn();
    const bridge = new BrowserExtensionBridge({ statePath, browserPaths: { chrome: process.execPath }, port: 0, launchBrowser });

    const post = async (path: string, body: unknown) => {
      const state = JSON.parse(await readFile(statePath, 'utf8'));
      return fetch(`http://127.0.0.1:${bridge.Status().port}${path}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${state.token}`, 'content-type': 'application/json' },
        body: JSON.stringify(WorkerBody(body as Record<string, unknown>)),
      });
    };

    try {
      await bridge.Start();
      const missing = await post('/bridge/hello', { version: '0.2.0' });
      expect(missing.status).toBe(409);
      expect(await missing.json()).toMatchObject({
        code: 'BROWSER_EXTENSION_STALE',
        expectedProtocolRevision: BrowserExtensionProtocolRevision,
        actualProtocolRevision: null,
      });
      expect(bridge.Status()).toMatchObject({ connected: false, state: 'stale', protocolRevision: null, expectedProtocolRevision: BrowserExtensionProtocolRevision });
      await expect(bridge.EnsureConnected('chrome', { launch: false, deadline: Date.now() + 1_000 }))
        .rejects.toMatchObject({ code: 'BROWSER_EXTENSION_STALE', message: expect.stringContaining('chrome://extensions') });
      expect(launchBrowser).not.toHaveBeenCalled();

      const wrong = await post('/bridge/hello', { version: '0.2.0', protocolRevision: 'avery-browser-extension-bridge-v0' });
      expect(wrong.status).toBe(409);
      expect(await wrong.json()).toMatchObject({
        code: 'BROWSER_EXTENSION_STALE',
        expectedProtocolRevision: BrowserExtensionProtocolRevision,
        actualProtocolRevision: 'avery-browser-extension-bridge-v0',
      });
      expect(bridge.Status()).toMatchObject({ connected: false, state: 'stale', protocolRevision: 'avery-browser-extension-bridge-v0' });

      const right = await post('/bridge/hello', { version: '0.2.0', protocolRevision: BrowserExtensionProtocolRevision });
      expect(right.status).toBe(200);
      expect(bridge.Status()).toMatchObject({ connected: true, state: 'online', version: '0.2.0', protocolRevision: BrowserExtensionProtocolRevision });

      // 旧 Worker 的 poll 没有 revision 时，不能沿用刚才的在线状态继续发送导航/CDP 命令。
      const stalePoll = await post('/bridge/poll', {});
      expect(stalePoll.status).toBe(409);
      expect(bridge.Status()).toMatchObject({ connected: false, state: 'stale', protocolRevision: null });
      await expect(bridge.Request('chrome', 'cdp', { id: 1, method: 'Target.createTarget', params: { url: 'https://example.test' } }, {
        deadline: Date.now() + 1_000,
        browserTaskId: 'stale-worker-task',
      })).rejects.toMatchObject({ code: 'BROWSER_EXTENSION_STALE' });

      const rightAgain = await post('/bridge/hello', { version: '0.2.0', protocolRevision: BrowserExtensionProtocolRevision });
      expect(rightAgain.status).toBe(200);
      const pending = bridge.Request('chrome', 'cdp', { id: 2, method: 'Target.createTarget', params: { url: 'https://example.test' } }, {
        deadline: Date.now() + 5_000,
        browserTaskId: 'stale-worker-pending-task',
      });
      const pendingAssertion = expect(pending).rejects.toMatchObject({ code: 'BROWSER_EXTENSION_STALE' });
      const stalePendingPoll = await post('/bridge/poll', {});
      expect(stalePendingPoll.status).toBe(409);
      await pendingAssertion;
    } finally {
      await bridge.Close();
    }
  });

  it('完整 version/protocolRevision 的 authenticated poll 可以建立 honest poll 握手，不伪造 hello', async () => {
    const root = await mkdtemp(join(tmpdir(), 'avery-extension-bridge-poll-handshake-'));
    roots.push(root);
    const statePath = join(root, 'bridge.json');
    const bridge = new BrowserExtensionBridge({ statePath, port: 0 });
    try {
      await bridge.Start();
      const state = JSON.parse(await readFile(statePath, 'utf8'));
      const controller = new AbortController();
      const poll = fetch(`http://127.0.0.1:${bridge.Status().port}/bridge/poll`, {
        method: 'POST',
        headers: { authorization: `Bearer ${state.token}`, 'content-type': 'application/json' },
        body: JSON.stringify(WorkerBody({ version: '0.2.0', protocolRevision: BrowserExtensionProtocolRevision })),
        signal: controller.signal,
      });
      for (let attempt = 0; attempt < 50 && !bridge.Status().handshakeReceived; attempt += 1) await new Promise((resolveWait) => setTimeout(resolveWait, 2));
      expect(bridge.Status()).toMatchObject({ connected: true, state: 'online', handshakeReceived: true, handshakeSource: 'poll', source: 'poll', version: '0.2.0', actualVersion: '0.2.0', protocolRevision: BrowserExtensionProtocolRevision });
      controller.abort();
      await poll.catch(() => undefined);
    } finally {
      await bridge.Close();
    }
  });

  it('stale 按 delivery 区分 queued/delivered，并保留 late result/ack 对账诊断', async () => {
    const root = await mkdtemp(join(tmpdir(), 'avery-extension-bridge-delivery-race-'));
    roots.push(root);
    const statePath = join(root, 'bridge.json');
    const bridge = new BrowserExtensionBridge({ statePath, browserPaths: { chrome: process.execPath }, port: 0 });
    const post = async (path: string, body: unknown) => {
      const state = JSON.parse(await readFile(statePath, 'utf8'));
      return fetch(`http://127.0.0.1:${bridge.Status().port}${path}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${state.token}`, 'content-type': 'application/json' },
        body: JSON.stringify(WorkerBody(body as Record<string, unknown>)),
      });
    };

    try {
      await bridge.Start();
      expect((await post('/bridge/hello', { version: '0.2.0', protocolRevision: BrowserExtensionProtocolRevision })).status).toBe(200);

      const delivered = bridge.Request('chrome', 'cdp', { id: 11, method: 'Target.createTarget', params: { url: 'https://delivered.example' } }, {
        deadline: Date.now() + 5_000, browserTaskId: 'delivered-task', runId: 'run-delivered',
      });
      const poll = await post('/bridge/poll', { version: '0.2.0', protocolRevision: BrowserExtensionProtocolRevision });
      expect(poll.status).toBe(200);
      const deliveredCommand = ((await poll.json() as any).commands ?? [])[0];
      expect(deliveredCommand).toMatchObject({ browserTaskId: 'delivered-task' });

      const queued = bridge.Request('chrome', 'cdp', { id: 12, method: 'Target.createTarget', params: { url: 'https://queued.example' } }, {
        deadline: Date.now() + 5_000, browserTaskId: 'queued-task', runId: 'run-queued',
      });
      const deliveredAssertion = expect(delivered).rejects.toMatchObject({ code: 'BROWSER_EXTENSION_STALE', statusUnknown: true });
      const queuedAssertion = expect(queued).rejects.toMatchObject({ code: 'BROWSER_EXTENSION_STALE', statusUnknown: false });

      expect((await post('/bridge/poll', { protocolRevision: 'avery-browser-extension-bridge-v0' })).status).toBe(409);
      await Promise.all([deliveredAssertion, queuedAssertion]);

      const staleDiagnostics = bridge.GetDiagnostics().filter((diagnostic) => diagnostic.event === 'stale_revoke');
      expect(staleDiagnostics).toEqual(expect.arrayContaining([
        expect.objectContaining({ commandId: deliveredCommand.id, browserTaskId: 'delivered-task', runId: 'run-delivered', delivery: 'delivered', statusUnknown: true }),
        expect.objectContaining({ browserTaskId: 'queued-task', runId: 'run-queued', delivery: 'queued', statusUnknown: false }),
      ]));
      const queuedCommandId = staleDiagnostics.find((diagnostic) => diagnostic.browserTaskId === 'queued-task')?.commandId;
      expect(queuedCommandId).toEqual(expect.any(String));

      // 已经终态的 delivered 命令收到迟到 result/ack 时只记诊断，不得二次 settle。
      expect((await post('/bridge/result', { id: deliveredCommand.id, ok: true, data: { late: true }, version: '0.2.0', protocolRevision: BrowserExtensionProtocolRevision })).status).toBe(200);
      expect((await post('/bridge/result', { id: deliveredCommand.id, ok: true, data: { duplicate: true }, version: '0.2.0', protocolRevision: BrowserExtensionProtocolRevision })).status).toBe(200);
      expect((await post('/bridge/command-status', { id: queuedCommandId, version: '0.2.0', protocolRevision: BrowserExtensionProtocolRevision })).status).toBe(200);
      const diagnostics = bridge.GetDiagnostics();
      expect(diagnostics).toEqual(expect.arrayContaining([
        expect.objectContaining({ event: 'late_result', commandId: deliveredCommand.id, delivery: 'delivered', statusUnknown: true }),
        expect.objectContaining({ event: 'late_ack', commandId: queuedCommandId, delivery: 'queued', statusUnknown: false }),
      ]));
    } finally {
      await bridge.Close();
    }
  });

  it('EnsureConnected 返回后到 pending 入队前遇到 stale 会 fail closed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'avery-extension-bridge-enqueue-race-'));
    roots.push(root);
    const statePath = join(root, 'bridge.json');
    const bridge = new BrowserExtensionBridge({ statePath, browserPaths: { chrome: process.execPath }, port: 0 });
    const post = async (path: string, body: unknown) => {
      const state = JSON.parse(await readFile(statePath, 'utf8'));
      return fetch(`http://127.0.0.1:${bridge.Status().port}${path}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${state.token}`, 'content-type': 'application/json' },
        body: JSON.stringify(WorkerBody(body as Record<string, unknown>)),
      });
    };

    try {
      await bridge.Start();
      expect((await post('/bridge/hello', { version: '0.2.0', protocolRevision: BrowserExtensionProtocolRevision })).status).toBe(200);
      const ensureConnected = bridge.EnsureConnected.bind(bridge);
      vi.spyOn(bridge, 'EnsureConnected').mockImplementation(async (engine, options) => {
        await ensureConnected(engine, options);
        expect((await post('/bridge/hello', { protocolRevision: 'avery-browser-extension-bridge-v0' })).status).toBe(409);
      });

      await expect(bridge.Request('chrome', 'cdp', { id: 21, method: 'Target.createTarget', params: {} }, {
        deadline: Date.now() + 1_000, browserTaskId: 'enqueue-race-task', runId: 'enqueue-race-run',
      })).rejects.toMatchObject({ code: 'BROWSER_EXTENSION_STALE', statusUnknown: false });
      expect((bridge as any).pending.size).toBe(0);
      expect((bridge as any).commands).toHaveLength(0);
    } finally {
      await bridge.Close();
    }
  });

  it('long-poll 等待期间 stale 不会让后续 command 进入旧 Worker', async () => {
    const root = await mkdtemp(join(tmpdir(), 'avery-extension-bridge-long-poll-race-'));
    roots.push(root);
    const statePath = join(root, 'bridge.json');
    const bridge = new BrowserExtensionBridge({ statePath, browserPaths: { chrome: process.execPath }, port: 0 });
    const post = async (path: string, body: unknown) => {
      const state = JSON.parse(await readFile(statePath, 'utf8'));
      return fetch(`http://127.0.0.1:${bridge.Status().port}${path}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${state.token}`, 'content-type': 'application/json' },
        body: JSON.stringify(WorkerBody(body as Record<string, unknown>)),
      });
    };

    try {
      await bridge.Start();
      expect((await post('/bridge/hello', { version: '0.2.0', protocolRevision: BrowserExtensionProtocolRevision })).status).toBe(200);
      const poll = post('/bridge/poll', { version: '0.2.0', protocolRevision: BrowserExtensionProtocolRevision });
      for (let attempt = 0; attempt < 50 && !(bridge as any).pollResponse; attempt += 1) {
        await new Promise((resolveWait) => setTimeout(resolveWait, 5));
      }
      expect((bridge as any).pollResponse).not.toBeNull();
      expect((await post('/bridge/hello', { protocolRevision: 'avery-browser-extension-bridge-v0' })).status).toBe(409);
      await expect(bridge.Request('chrome', 'cdp', { id: 22, method: 'Target.createTarget', params: {} }, {
        deadline: Date.now() + 1_000, browserTaskId: 'long-poll-task', runId: 'long-poll-run',
      })).rejects.toMatchObject({ code: 'BROWSER_EXTENSION_STALE', statusUnknown: false });
      expect(await (await poll).json()).toEqual({ commands: [] });

      // Reloading the Worker creates a new epoch. The old poll is already
      // resolved; only a new Worker poll may receive a newly queued command.
      expect((await post('/bridge/hello', { version: '0.2.0', protocolRevision: BrowserExtensionProtocolRevision })).status).toBe(200);
      const next = bridge.Request('chrome', 'cdp', { id: 23, method: 'Target.createTarget', params: {} }, {
        deadline: Date.now() + 5_000, browserTaskId: 'new-worker-task', runId: 'new-worker-run',
      });
      const nextPoll = await post('/bridge/poll', { version: '0.2.0', protocolRevision: BrowserExtensionProtocolRevision });
      const nextCommands = (await nextPoll.json() as any).commands ?? [];
      expect(nextCommands).toHaveLength(1);
      expect(nextCommands[0]).toMatchObject({ browserTaskId: 'new-worker-task' });
      expect((await post('/bridge/result', {
        id: nextCommands[0].id, ok: true, data: { acceptedBy: 'new-worker' },
        version: '0.2.0', protocolRevision: BrowserExtensionProtocolRevision,
      })).status).toBe(200);
      await expect(next).resolves.toEqual({ acceptedBy: 'new-worker' });
    } finally {
      await bridge.Close();
    }
  });

  it('新旧 hello epoch 切换会撤销旧 generation 的 queued command', async () => {
    const root = await mkdtemp(join(tmpdir(), 'avery-extension-bridge-epoch-race-'));
    roots.push(root);
    const statePath = join(root, 'bridge.json');
    const bridge = new BrowserExtensionBridge({ statePath, browserPaths: { chrome: process.execPath }, port: 0 });
    const post = async (path: string, body: unknown) => {
      const state = JSON.parse(await readFile(statePath, 'utf8'));
      return fetch(`http://127.0.0.1:${bridge.Status().port}${path}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${state.token}`, 'content-type': 'application/json' },
        body: JSON.stringify(WorkerBody(body as Record<string, unknown>)),
      });
    };

    try {
      await bridge.Start();
      expect((await post('/bridge/hello', WorkerBody({ version: '0.2.0', protocolRevision: BrowserExtensionProtocolRevision }, 'worker-old'))).status).toBe(200);
      const pending = bridge.Request('chrome', 'cdp', { id: 23, method: 'Target.createTarget', params: {} }, {
        deadline: Date.now() + 5_000, browserTaskId: 'epoch-old-task', runId: 'epoch-old-run',
      });
      for (let attempt = 0; attempt < 50 && !(bridge as any).pending.size; attempt += 1) {
        await new Promise((resolveWait) => setTimeout(resolveWait, 5));
      }
      const pendingAssertion = expect(pending).rejects.toMatchObject({ code: 'BROWSER_EXTENSION_STALE', statusUnknown: false });
      expect((await post('/bridge/hello', WorkerBody({ version: '0.2.0', protocolRevision: BrowserExtensionProtocolRevision }, 'worker-new'))).status).toBe(200);
      await pendingAssertion;
      expect(bridge.GetDiagnostics()).toEqual(expect.arrayContaining([
        expect.objectContaining({ event: 'epoch_revoke', browserTaskId: 'epoch-old-task', runId: 'epoch-old-run', delivery: 'queued', statusUnknown: false }),
      ]));
      expect((bridge as any).commands).toEqual([]);
    } finally {
      await bridge.Close();
    }
  });

  it('通过一次配对建立鉴权长轮询，并原样返回扩展命令结果', async () => {
    const root = await mkdtemp(join(tmpdir(), 'avery-extension-bridge-'));
    roots.push(root);
    const statePath = join(root, 'bridge.json');
    let launchedUrl = '';
    let bridge!: BrowserExtensionBridge;
    const launchBrowser = vi.fn(async (_engine: 'chrome' | 'edge', url: string) => {
      launchedUrl = url;
      const state = JSON.parse(await readFile(statePath, 'utf8'));
      const port = bridge.Status().port;
      const response = await fetch(`http://127.0.0.1:${port}/bridge/hello`, {
        method: 'POST',
        headers: { authorization: `Bearer ${state.token}`, 'content-type': 'application/json' },
        body: JSON.stringify(WorkerBody({ version: '0.2.0', protocolRevision: BrowserExtensionProtocolRevision })),
      });
      expect(response.ok).toBe(true);
    });
    bridge = new BrowserExtensionBridge({
      statePath,
      browserPaths: { chrome: process.execPath },
      port: 0,
      launchBrowser,
    });

    try {
      await bridge.EnsureConnected('chrome');
      expect(launchBrowser).toHaveBeenCalledOnce();
      expect(launchedUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/pair#token=[a-f0-9]{64}&port=\d+$/);
      expect(bridge.Status()).toMatchObject({ connected: true, version: '0.2.0' });

      const state = JSON.parse(await readFile(statePath, 'utf8'));
      const port = bridge.Status().port;
      const resultPromise = bridge.Request('chrome', 'cdp', { id: 7, method: 'Target.getTargets', params: {} }, { deadline: Date.now() + 5_000, browserTaskId: 'task-test' });
      const poll = await fetch(`http://127.0.0.1:${port}/bridge/poll`, {
        method: 'POST',
        headers: { authorization: `Bearer ${state.token}`, 'content-type': 'application/json' },
        body: JSON.stringify(WorkerBody({ version: '0.2.0', protocolRevision: BrowserExtensionProtocolRevision })),
      }).then((response) => response.json()) as any;
      expect(poll.commands).toHaveLength(1);
      expect(poll.commands[0]).toMatchObject({
        operation: 'cdp', browserTaskId: 'task-test', deadline: expect.any(Number),
        payload: { id: 7, method: 'Target.getTargets' },
      });
      await fetch(`http://127.0.0.1:${port}/bridge/result`, {
        method: 'POST',
        headers: { authorization: `Bearer ${state.token}`, 'content-type': 'application/json' },
        body: JSON.stringify(WorkerBody({ id: poll.commands[0].id, ok: true, data: { id: 7, result: { targetInfos: [] } }, version: '0.2.0', protocolRevision: BrowserExtensionProtocolRevision })),
      });
      await expect(resultPromise).resolves.toEqual({ id: 7, result: { targetInfos: [] } });

      const closePromise = bridge.CloseTask('chrome', 'task-test');
      const closePoll = await fetch(`http://127.0.0.1:${port}/bridge/poll`, {
        method: 'POST',
        headers: { authorization: `Bearer ${state.token}`, 'content-type': 'application/json' },
        body: JSON.stringify(WorkerBody({ version: '0.2.0', protocolRevision: BrowserExtensionProtocolRevision })),
      }).then((response) => response.json()) as any;
      expect(closePoll.commands).toHaveLength(1);
      expect(closePoll.commands[0]).toMatchObject({ operation: 'close_task', browserTaskId: 'task-test', deadline: expect.any(Number) });
      await fetch(`http://127.0.0.1:${port}/bridge/result`, {
        method: 'POST',
        headers: { authorization: `Bearer ${state.token}`, 'content-type': 'application/json' },
        body: JSON.stringify(WorkerBody({ id: closePoll.commands[0].id, ok: true, data: { closed: true, status: 'confirmed', browserTaskId: 'task-test', closedTabs: 2, unknownTabs: 0 }, version: '0.2.0', protocolRevision: BrowserExtensionProtocolRevision })),
      });
      await expect(closePromise).resolves.toEqual({ status: 'confirmed', browserTaskId: 'task-test', closedTabs: 2, unknownTabs: 0 });

      const unauthorized = await fetch(`http://127.0.0.1:${port}/bridge/poll`, { method: 'POST', body: '{}' });
      expect(unauthorized.status).toBe(401);
    } finally {
      await bridge.Close();
    }
  });

  it('真实 worker CloseTask 输出原样通过 Bridge result handler 保留三种 cleanup outcome', async () => {
    const root = await mkdtemp(join(tmpdir(), 'avery-extension-bridge-worker-cleanup-contract-'));
    roots.push(root);
    const statePath = join(root, 'bridge.json');
    let bridge!: BrowserExtensionBridge;
    const launchBrowser = vi.fn(async () => {
      const state = JSON.parse(await readFile(statePath, 'utf8'));
      const response = await fetch(`http://127.0.0.1:${bridge.Status().port}/bridge/hello`, {
        method: 'POST', headers: { authorization: `Bearer ${state.token}`, 'content-type': 'application/json' },
        body: JSON.stringify(WorkerBody({ version: '0.2.0', protocolRevision: BrowserExtensionProtocolRevision })),
      });
      expect(response.ok).toBe(true);
    });
    bridge = new BrowserExtensionBridge({ statePath, browserPaths: { chrome: process.execPath }, port: 0, launchBrowser });
    const post = async (path: string, body: unknown) => {
      const state = JSON.parse(await readFile(statePath, 'utf8'));
      return fetch(`http://127.0.0.1:${bridge.Status().port}${path}`, {
        method: 'POST', headers: { authorization: `Bearer ${state.token}`, 'content-type': 'application/json' }, body: JSON.stringify(WorkerBody({ ...(body as Record<string, unknown>), version: '0.2.0', protocolRevision: BrowserExtensionProtocolRevision })),
      });
    };
    const workerSource = readFileSync(resolve('apps/browser-extension/service-worker.js'), 'utf8');
    const createStorageArea = (values: Record<string, unknown>, failSet = false) => ({
      get: async (keys: string | string[] | null) => {
        if (keys === null) return { ...values };
        if (Array.isArray(keys)) return Object.fromEntries(keys.map((key) => [key, values[key]]));
        return { [keys]: values[keys] };
      },
      set: async (value: Record<string, unknown>) => {
        if (failSet) throw new Error('session registry write failed');
        Object.assign(values, value);
      },
      remove: async (keys: string | string[]) => { for (const key of Array.isArray(keys) ? keys : [keys]) delete values[key]; },
    });

    try {
      await bridge.EnsureConnected('chrome');
      const bridgeState = JSON.parse(await readFile(statePath, 'utf8'));
      const closeThroughWorker = async (taskId: string, tabId: number, failure: 'none' | 'remove' | 'storage') => {
        const localStorage: Record<string, unknown> = {};
        const sessionStorage: Record<string, unknown> = {
          'averyTaskTabs.1.1.seed': {
            schemaVersion: 1, epoch: 1, revision: 1, writerId: 'seed',
            registry: { [taskId]: { tabIds: [tabId], parentTabId: null, activeTabId: tabId } },
          },
        };
        const chrome = {
          storage: { local: createStorageArea(localStorage), session: createStorageArea(sessionStorage, failure === 'storage') },
          runtime: {
            onMessage: { addListener: () => undefined }, onStartup: { addListener: () => undefined },
            onInstalled: { addListener: () => undefined }, getManifest: () => ({ version: '0.2.0' }),
          },
          alarms: { create: () => undefined, onAlarm: { addListener: () => undefined } },
          tabs: {
            remove: failure === 'remove' ? () => new Promise<void>(() => undefined) : async () => undefined,
            onRemoved: { addListener: () => undefined },
          },
          debugger: { onDetach: { addListener: () => undefined } },
        };
        const context = createContext({
          chrome,
          fetch: async () => ({ ok: true, json: async () => ({ active: true }) }),
          URL, AbortController, AbortSignal, setTimeout: (callback: (...args: any[]) => void, milliseconds: number, ...args: any[]) => setTimeout(callback, Math.min(milliseconds, 40), ...args),
          clearTimeout, performance: { timeOrigin: Date.now() }, crypto: { randomUUID: () => `worker-${taskId}` },
        });
        runInContext(workerSource, context);

        const closePromise = bridge.CloseTask('chrome', taskId, { deadline: Date.now() + 10_000 });
        const pollResponse = await post('/bridge/poll', {});
        const command = (await pollResponse.json() as any).commands[0];
        expect(command).toMatchObject({ operation: 'close_task', browserTaskId: taskId });
        context.workerCommand = command;
        context.workerConfig = { token: bridgeState.token, port: bridge.Status().port };
        const workerOutput = await runInContext('EnqueueCommand(workerCommand, 0, workerConfig)', context) as any;
        expect(workerOutput).toMatchObject({ id: command.id, ok: true, data: { browserTaskId: taskId } });
        // Pass the actual service-worker result envelope unchanged through the Bridge's real /bridge/result handler.
        await post('/bridge/result', workerOutput);
        return { outcome: await closePromise, workerOutput };
      };

      const confirmed = await closeThroughWorker('task-confirmed', 10, 'none');
      expect(confirmed.workerOutput.data).toMatchObject({ closed: true, status: 'confirmed', browserTaskId: 'task-confirmed', closedTabs: 1, unknownTabs: 0 });
      expect(confirmed.outcome).toEqual({ status: 'confirmed', browserTaskId: 'task-confirmed', closedTabs: 1, unknownTabs: 0 });

      const unknown = await closeThroughWorker('task-unknown', 20, 'remove');
      expect(unknown.workerOutput.data).toMatchObject({ closed: false, status: 'status_unknown', browserTaskId: 'task-unknown', code: 'BROWSER_COMMAND_TIMEOUT', closedTabs: 0, unknownTabs: 1 });
      expect(unknown.outcome).toMatchObject({ status: 'status_unknown', browserTaskId: 'task-unknown', code: 'BROWSER_COMMAND_TIMEOUT', closedTabs: 0, unknownTabs: 1 });

      const failed = await closeThroughWorker('task-failed', 30, 'storage');
      expect(failed.workerOutput.data).toMatchObject({ closed: false, status: 'failed', browserTaskId: 'task-failed', code: 'BROWSER_TASK_CLEANUP_FAILED', closedTabs: 1, unknownTabs: 0 });
      expect(failed.outcome).toMatchObject({ status: 'failed', browserTaskId: 'task-failed', code: 'BROWSER_TASK_CLEANUP_FAILED', closedTabs: 1, unknownTabs: 0 });
    } finally {
      await bridge.Close();
    }
  });

  it('CloseTask 分类扩展明确失败与命令执行后超时，不吞掉清理状态', async () => {
    const root = await mkdtemp(join(tmpdir(), 'avery-extension-bridge-cleanup-outcome-'));
    roots.push(root);
    const statePath = join(root, 'bridge.json');
    let bridge!: BrowserExtensionBridge;
    const launchBrowser = vi.fn(async () => {
      const state = JSON.parse(await readFile(statePath, 'utf8'));
      const response = await fetch(`http://127.0.0.1:${bridge.Status().port}/bridge/hello`, {
        method: 'POST', headers: { authorization: `Bearer ${state.token}`, 'content-type': 'application/json' },
        body: JSON.stringify(WorkerBody({ version: '0.2.0', protocolRevision: BrowserExtensionProtocolRevision })),
      });
      expect(response.ok).toBe(true);
    });
    bridge = new BrowserExtensionBridge({ statePath, browserPaths: { chrome: process.execPath }, port: 0, launchBrowser });
    const post = async (path: string, body: unknown) => {
      const state = JSON.parse(await readFile(statePath, 'utf8'));
      return fetch(`http://127.0.0.1:${bridge.Status().port}${path}`, {
        method: 'POST', headers: { authorization: `Bearer ${state.token}`, 'content-type': 'application/json' }, body: JSON.stringify(WorkerBody({ ...(body as Record<string, unknown>), version: '0.2.0', protocolRevision: BrowserExtensionProtocolRevision })),
      });
    };
    try {
      await bridge.EnsureConnected('chrome');
      const failedPromise = bridge.CloseTask('chrome', 'task-failed', { deadline: Date.now() + 5_000 });
      const failedPoll = await post('/bridge/poll', {});
      const failedCommand = (await failedPoll.json() as any).commands[0];
      await post('/bridge/result', { id: failedCommand.id, ok: false, error: { code: 'BROWSER_TASK_CLEANUP_FAILED', message: 'registry cleanup failed', statusUnknown: false } });
      await expect(failedPromise).resolves.toMatchObject({
        status: 'failed', browserTaskId: 'task-failed', code: 'BROWSER_TASK_CLEANUP_FAILED', closedTabs: 0, unknownTabs: 0,
      });

      const deadline = Date.now() + 250;
      const unknownPromise = bridge.CloseTask('chrome', 'task-timeout', { deadline });
      const unknownPoll = await post('/bridge/poll', {});
      const unknownCommand = (await unknownPoll.json() as any).commands[0];
      expect(unknownCommand).toMatchObject({ operation: 'close_task', browserTaskId: 'task-timeout' });
      await expect(unknownPromise).resolves.toMatchObject({
        status: 'status_unknown', browserTaskId: 'task-timeout', code: 'BROWSER_COMMAND_TIMEOUT', unknownTabs: null,
      });
    } finally {
      await bridge.Close();
    }
  });

  it('扩展尚未取走命令时超时会从发送队列撤销，避免迟到执行写操作', async () => {
    const root = await mkdtemp(join(tmpdir(), 'avery-extension-bridge-timeout-'));
    roots.push(root);
    const statePath = join(root, 'bridge.json');
    let bridge!: BrowserExtensionBridge;
    const launchBrowser = vi.fn(async () => {
      const state = JSON.parse(await readFile(statePath, 'utf8'));
      const response = await fetch(`http://127.0.0.1:${bridge.Status().port}/bridge/hello`, {
        method: 'POST',
        headers: { authorization: `Bearer ${state.token}`, 'content-type': 'application/json' },
        body: JSON.stringify(WorkerBody({ version: '0.2.0', protocolRevision: BrowserExtensionProtocolRevision })),
      });
      expect(response.ok).toBe(true);
    });
    bridge = new BrowserExtensionBridge({ statePath, browserPaths: { chrome: process.execPath }, port: 0, launchBrowser });

    try {
      await bridge.EnsureConnected('chrome');
      const timedOut = bridge.Request('chrome', 'cdp', {
        id: 8,
        method: 'DOM.setFileInputFiles',
        params: { targetId: 'task', files: ['C:\\authorized\\resume.pdf'] },
      }, { deadline: Date.now() + 30, browserTaskId: 'task-test' });
      await expect(timedOut).rejects.toMatchObject({ code: 'BROWSER_COMMAND_TIMEOUT', statusUnknown: true });

      const state = JSON.parse(await readFile(statePath, 'utf8'));
      // 被撤销的命令不应让空 poll 等待 20 秒；用无副作用 probe 触发一次 flush，
      // 并确认响应中只有 probe，没有迟到的文件上传命令。
      const probePromise = bridge.Request('chrome', 'cdp', { id: 9, method: 'Target.getTargets', params: {} }, { deadline: Date.now() + 1_000, browserTaskId: 'task-test' });
      const poll = await fetch(`http://127.0.0.1:${bridge.Status().port}/bridge/poll`, {
        method: 'POST',
        headers: { authorization: `Bearer ${state.token}`, 'content-type': 'application/json' },
        body: JSON.stringify(WorkerBody({ version: '0.2.0', protocolRevision: BrowserExtensionProtocolRevision })),
      }).then((response) => response.json()) as any;
      expect(poll.commands).toHaveLength(1);
      expect(poll.commands[0]).toMatchObject({ id: expect.any(String), operation: 'cdp', payload: { id: 9, method: 'Target.getTargets' } });
      await fetch(`http://127.0.0.1:${bridge.Status().port}/bridge/result`, {
        method: 'POST',
        headers: { authorization: `Bearer ${state.token}`, 'content-type': 'application/json' },
        body: JSON.stringify(WorkerBody({ id: poll.commands[0].id, ok: true, data: { id: 9, result: { targetInfos: [] } }, version: '0.2.0', protocolRevision: BrowserExtensionProtocolRevision })),
      });
      await expect(probePromise).resolves.toEqual({ id: 9, result: { targetInfos: [] } });
    } finally {
      await bridge.Close();
    }
  });

  it('new Worker hello atomically retires old poll/status/result traffic without settling twice', async () => {
    const root = await mkdtemp(join(tmpdir(), 'avery-extension-bridge-worker-generation-'));
    roots.push(root);
    const statePath = join(root, 'bridge.json');
    const bridge = new BrowserExtensionBridge({ statePath, port: 0 });
    try {
      await bridge.Start();
      expect((await PostBridge(bridge, statePath, '/bridge/hello', { version: '0.2.0', protocolRevision: BrowserExtensionProtocolRevision }, 'worker-old')).status).toBe(200);
      const delivered = bridge.Request('chrome', 'cdp', { id: 501, method: 'Target.getTargets', params: {} }, {
        deadline: Date.now() + 5_000, browserTaskId: 'old-generation-task', runId: 'old-generation-run',
      });
      for (let attempt = 0; attempt < 50 && !(bridge as any).pending.size; attempt += 1) await new Promise((resolveWait) => setTimeout(resolveWait, 2));
      const deliveredPoll = await PostBridge(bridge, statePath, '/bridge/poll', { version: '0.2.0', protocolRevision: BrowserExtensionProtocolRevision }, 'worker-old');
      const deliveredCommand = (await deliveredPoll.json() as any).commands[0];
      expect(deliveredCommand).toMatchObject({ browserTaskId: 'old-generation-task' });

      const oldLongPoll = PostBridge(bridge, statePath, '/bridge/poll', { version: '0.2.0', protocolRevision: BrowserExtensionProtocolRevision }, 'worker-old');
      for (let attempt = 0; attempt < 50 && !(bridge as any).pollResponse; attempt += 1) await new Promise((resolveWait) => setTimeout(resolveWait, 2));
      expect((bridge as any).pollResponse).not.toBeNull();

      const deliveredAssertion = expect(delivered).rejects.toMatchObject({ code: 'BROWSER_EXTENSION_STALE', statusUnknown: true });
      expect((await PostBridge(bridge, statePath, '/bridge/hello', { version: '0.2.0', protocolRevision: BrowserExtensionProtocolRevision }, 'worker-new')).status).toBe(200);
      await deliveredAssertion;
      expect((await oldLongPoll).status).toBe(200);

      expect((await PostBridge(bridge, statePath, '/bridge/hello', { version: '0.2.0', protocolRevision: BrowserExtensionProtocolRevision }, 'worker-old')).status).toBe(409);
      expect((await PostBridge(bridge, statePath, '/bridge/command-status', { id: deliveredCommand.id, version: '0.2.0', protocolRevision: BrowserExtensionProtocolRevision }, 'worker-old')).status).toBe(409);
      expect((await PostBridge(bridge, statePath, '/bridge/result', { id: deliveredCommand.id, ok: true, data: { late: true }, version: '0.2.0', protocolRevision: BrowserExtensionProtocolRevision }, 'worker-old')).status).toBe(409);
      expect(bridge.Status()).toMatchObject({ activeWorkerInstanceId: 'worker-new', connected: true, handshakeSource: 'hello' });

      const next = bridge.Request('chrome', 'cdp', { id: 502, method: 'Target.getTargets', params: {} }, {
        deadline: Date.now() + 5_000, browserTaskId: 'new-generation-task', runId: 'new-generation-run',
      });
      const nextPoll = await PostBridge(bridge, statePath, '/bridge/poll', { version: '0.2.0', protocolRevision: BrowserExtensionProtocolRevision }, 'worker-new');
      const nextCommand = (await nextPoll.json() as any).commands[0];
      expect(nextCommand).toMatchObject({ browserTaskId: 'new-generation-task' });
      await PostBridge(bridge, statePath, '/bridge/result', { id: nextCommand.id, ok: true, data: { id: 502, result: { targetInfos: [] } }, version: '0.2.0', protocolRevision: BrowserExtensionProtocolRevision }, 'worker-new');
      await expect(next).resolves.toEqual({ id: 502, result: { targetInfos: [] } });
    } finally {
      await bridge.Close();
    }
  });

  it('Bridge 重启后允许完整 poll 建立 poll-only handshake，但缺失/错误 generation fail closed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'avery-extension-bridge-poll-only-generation-'));
    roots.push(root);
    const statePath = join(root, 'bridge.json');
    const first = new BrowserExtensionBridge({ statePath, port: 0 });
    const firstAbort = new AbortController();
    try {
      await first.Start();
      const firstPoll = PostBridge(first, statePath, '/bridge/poll', { version: '0.2.0', protocolRevision: BrowserExtensionProtocolRevision }, 'worker-restarted', firstAbort.signal);
      for (let attempt = 0; attempt < 50 && !first.Status().handshakeReceived; attempt += 1) await new Promise((resolveWait) => setTimeout(resolveWait, 2));
      expect(first.Status()).toMatchObject({ connected: true, handshakeSource: 'poll', activeWorkerInstanceId: 'worker-restarted' });
      firstAbort.abort();
      await firstPoll.catch(() => undefined);
    } finally {
      await first.Close();
    }

    const second = new BrowserExtensionBridge({ statePath, port: 0 });
    const secondAbort = new AbortController();
    try {
      await second.Start();
      const missing = await PostBridge(second, statePath, '/bridge/hello', { version: '0.2.0', protocolRevision: BrowserExtensionProtocolRevision }, '');
      expect(missing.status).toBe(409);
      const poll = PostBridge(second, statePath, '/bridge/poll', { version: '0.2.0', protocolRevision: BrowserExtensionProtocolRevision }, 'worker-restarted', secondAbort.signal);
      for (let attempt = 0; attempt < 50 && !second.Status().handshakeReceived; attempt += 1) await new Promise((resolveWait) => setTimeout(resolveWait, 2));
      expect(second.Status()).toMatchObject({ connected: true, state: 'online', handshakeReceived: true, handshakeSource: 'poll', activeWorkerInstanceId: 'worker-restarted' });
      const wrong = await PostBridge(second, statePath, '/bridge/poll', { version: '0.2.0', protocolRevision: BrowserExtensionProtocolRevision }, 'worker-other');
      expect(wrong.status).toBe(409);
      expect(second.Status()).toMatchObject({ activeWorkerInstanceId: 'worker-restarted', connected: true });
      secondAbort.abort();
      await poll.catch(() => undefined);
    } finally {
      await second.Close();
    }
  });

  it('PersonalBrowser Runtime 取消 CDP 命令时会撤销 Bridge pending，扩展查询不到活动命令', async () => {
    const root = await mkdtemp(join(tmpdir(), 'avery-extension-runtime-cancel-'));
    roots.push(root);
    const statePath = join(root, 'bridge.json');
    let bridge!: BrowserExtensionBridge;
    const launchBrowser = vi.fn(async () => {
      const state = JSON.parse(await readFile(statePath, 'utf8'));
      const response = await fetch(`http://127.0.0.1:${bridge.Status().port}/bridge/hello`, {
        method: 'POST',
        headers: { authorization: `Bearer ${state.token}`, 'content-type': 'application/json' },
        body: JSON.stringify(WorkerBody({ version: '0.2.0', protocolRevision: BrowserExtensionProtocolRevision })),
      });
      expect(response.ok).toBe(true);
    });
    bridge = new BrowserExtensionBridge({ statePath, browserPaths: { chrome: process.execPath }, port: 0, launchBrowser });
    const post = async (path: string, body: unknown) => {
      const state = JSON.parse(await readFile(statePath, 'utf8'));
      return fetch(`http://127.0.0.1:${bridge.Status().port}${path}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${state.token}`, 'content-type': 'application/json' },
        body: JSON.stringify(WorkerBody({ ...(body as Record<string, unknown>), version: '0.2.0', protocolRevision: BrowserExtensionProtocolRevision })),
      });
    };
    try {
      await bridge.Start();
      const runtime = CreatePersonalBrowserExtensionRuntime({ bridge, engine: 'chrome' });
      const connect = runtime.Connect();
      const firstPoll = await post('/bridge/poll', {});
      const firstCommand = (await firstPoll.json() as any).commands[0];
      expect(firstCommand).toMatchObject({ operation: 'cdp', payload: { method: 'Target.getTargets' } });
      await post('/bridge/result', { id: firstCommand.id, ok: true, data: { id: firstCommand.payload.id, result: { targetInfos: [{ targetId: 'anchor', tabId: 10, windowId: 1, openerTabId: null, type: 'page', url: 'https://example.com/task' }] } } });
      await expect(connect).resolves.toEqual({ anchorUrl: 'https://example.com/task' });

      const controller = new AbortController();
      const run = runtime.Run(['get', 'url'], { signal: controller.signal, deadline: Date.now() + 5_000 });
      const secondPoll = await post('/bridge/poll', {});
      const lookupCommand = (await secondPoll.json() as any).commands[0];
      expect(lookupCommand).toMatchObject({ operation: 'cdp', payload: { method: 'Target.getTargets' } });
      await post('/bridge/result', { id: lookupCommand.id, ok: true, data: { id: lookupCommand.payload.id, result: { targetInfos: [] } } });
      const createPoll = await post('/bridge/poll', {});
      const secondCommand = (await createPoll.json() as any).commands[0];
      expect(secondCommand).toMatchObject({ operation: 'cdp', payload: { method: 'Target.createTarget' } });
      controller.abort();
      await expect(run).rejects.toMatchObject({ code: 'CANCELLED' });
      const status = await post('/bridge/command-status', { id: secondCommand.id }).then((response) => response.json());
      expect(status).toEqual({ active: false });
      await runtime.Close();
    } finally {
      await bridge.Close();
    }
  });

  it('PersonalBrowser Runtime 建连 deadline 到期时会 abort 尚未完成的 Bridge EnsureConnected', async () => {
    let aborted = false;
    const fakeBridge = {
      Status: () => ({
        port: 17653,
        state: 'online' as const,
        protocolRevision: BrowserExtensionProtocolRevision,
        actualProtocolRevision: BrowserExtensionProtocolRevision,
        expectedProtocolRevision: BrowserExtensionProtocolRevision,
      }),
      EnsureConnected: async (_engine: 'chrome' | 'edge', options: { signal?: AbortSignal }) => {
        await new Promise<void>((_resolve, reject) => {
          const onAbort = () => { aborted = true; reject(new Error('connection aborted')); };
          options.signal?.addEventListener('abort', onAbort, { once: true });
        });
      },
      Request: async () => ({}),
      CloseTask: async () => undefined,
    } as unknown as BrowserExtensionBridge;
    const runtime = CreatePersonalBrowserExtensionRuntime({ bridge: fakeBridge, engine: 'chrome' });

    await expect(runtime.Connect({ deadline: Date.now() + 20 })).rejects.toMatchObject({ code: 'BROWSER_COMMAND_TIMEOUT' });
    expect(aborted).toBe(true);
    await runtime.Close();
  });

  it('每个扩展 PersonalBrowser Runtime 都得到不可复用的 browserTaskId', async () => {
    const bridge = {
      Status: () => ({
        port: 17653,
        state: 'online' as const,
        protocolRevision: BrowserExtensionProtocolRevision,
        actualProtocolRevision: BrowserExtensionProtocolRevision,
        expectedProtocolRevision: BrowserExtensionProtocolRevision,
      }),
      EnsureConnected: vi.fn(async () => undefined),
      Request: vi.fn(async () => ({})),
      CloseTask: vi.fn(async () => undefined),
    } as unknown as BrowserExtensionBridge;
    const first = CreatePersonalBrowserExtensionRuntime({ bridge, engine: 'chrome' });
    const second = CreatePersonalBrowserExtensionRuntime({ bridge, engine: 'chrome' });

    expect(first.GetBrowserTaskId?.()).toMatch(/^[A-Za-z0-9-]{36}$/);
    expect(second.GetBrowserTaskId?.()).toMatch(/^[A-Za-z0-9-]{36}$/);
    expect(first.GetBrowserTaskId?.()).not.toBe(second.GetBrowserTaskId?.());
    await Promise.all([first.Close(), second.Close()]);
  });

  it('PersonalBrowser Runtime 不接受 EnsureConnected 后仍为 stale 的扩展状态', async () => {
    const bridge = {
      Status: () => ({
        port: 17653,
        state: 'stale' as const,
        protocolRevision: 'avery-browser-extension-bridge-v0',
        actualProtocolRevision: 'avery-browser-extension-bridge-v0',
        expectedProtocolRevision: BrowserExtensionProtocolRevision,
      }),
      EnsureConnected: vi.fn(async () => undefined),
      Request: vi.fn(async () => ({})),
      CloseTask: vi.fn(async () => undefined),
    } as unknown as BrowserExtensionBridge;
    const runtime = CreatePersonalBrowserExtensionRuntime({ bridge, engine: 'chrome' });

    await expect(runtime.Connect({ deadline: Date.now() + 1_000 })).rejects.toMatchObject({
      code: 'BROWSER_EXTENSION_STALE',
      message: expect.stringContaining('chrome://extensions'),
    });
    expect(bridge.Request).not.toHaveBeenCalled();
    await runtime.Close();
  });
});
