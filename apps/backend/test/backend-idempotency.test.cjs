'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { CreateBackend } = require('../dist/router.js');
const { IdempotencyStore } = require('../dist/idempotency-store.js');
const { RegisterGateway } = require('../../desktop/dist/gateway.js');
const { BridgeNamespaces, CreateWriteIntentKeyStore, WriteCommandEnvelopeSchema } = require('../../../packages/contracts/dist/index.js');

function createContainer(executions, delayMs = 0) {
  return {
    settings: {
      async SaveSettings(payload) {
        if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
        executions.count += 1;
        return { saved: true, ...payload };
      },
    },
  };
}

function createFakeStore(putImpl) {
  const records = new Map();
  return {
    Get(key, payloadHash) {
      const record = records.get(key);
      if (!record) return { hit: false, conflict: false };
      if (record.payloadHash !== payloadHash) return { hit: false, conflict: true };
      return { hit: true, conflict: false, result: record.result };
    },
    Put(key, payloadHash, result) {
      if (putImpl) putImpl(key, payloadHash, result);
      records.set(key, { payloadHash, result });
    },
  };
}

test('业务成功但幂等记录写盘失败时返回成功且同键重试不重复执行', async () => {
  const executions = { count: 0 };
  const store = createFakeStore(() => {
    const error = new Error('disk full');
    error.code = 'STORAGE_ERROR';
    throw error;
  });
  const backend = CreateBackend({ container: createContainer(executions), idempotencyStore: store });

  const first = await backend.HandleCommand('workspace:save-settings', 'req-1', 'idem-put-fail', { nickname: 'x' });
  assert.equal(first.ok, true, '业务成功后不得因幂等记录写盘失败返回失败');
  assert.equal(executions.count, 1);

  const second = await backend.HandleCommand('workspace:save-settings', 'req-2', 'idem-put-fail', { nickname: 'x' });
  assert.equal(second.ok, true, '同幂等键重试应返回首次结果');
  assert.equal(executions.count, 1, '同幂等键重试不得重复执行业务');
});

test('同幂等键并发请求只执行一次业务', async () => {
  const executions = { count: 0 };
  const backend = CreateBackend({ container: createContainer(executions, 20), idempotencyStore: createFakeStore() });

  const [first, second] = await Promise.all([
    backend.HandleCommand('workspace:save-settings', 'req-concurrent-1', 'idem-concurrent', { nickname: 'x' }),
    backend.HandleCommand('workspace:save-settings', 'req-concurrent-2', 'idem-concurrent', { nickname: 'x' }),
  ]);
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(executions.count, 1, '同幂等键并发时业务只能执行一次');
});

test('同幂等键不同 payload 返回 REVISION_CONFLICT', async () => {
  const executions = { count: 0 };
  const backend = CreateBackend({ container: createContainer(executions), idempotencyStore: createFakeStore() });

  const first = await backend.HandleCommand('workspace:save-settings', 'req-diff-1', 'idem-diff', { nickname: 'a' });
  assert.equal(first.ok, true);
  assert.equal(executions.count, 1);

  const second = await backend.HandleCommand('workspace:save-settings', 'req-diff-2', 'idem-diff', { nickname: 'b' });
  assert.equal(second.ok, false);
  assert.equal(second.error.code, 'REVISION_CONFLICT');
  assert.equal(executions.count, 1, '冲突请求不得再次执行业务');
});

test('不同内部 requestId 但同稳定幂等键的重试只执行一次业务', async () => {
  const executions = { count: 0 };
  const backend = CreateBackend({ container: createContainer(executions), idempotencyStore: createFakeStore() });

  const first = await backend.HandleCommand('workspace:save-settings', 'req-timeout-1', 'idem-retry', { nickname: 'x' });
  assert.equal(first.ok, true);
  assert.equal(executions.count, 1);

  const second = await backend.HandleCommand('workspace:save-settings', 'req-timeout-2', 'idem-retry', { nickname: 'x' });
  assert.equal(second.ok, true);
  assert.equal(executions.count, 1, '超时后以同一稳定幂等键重试不得重复执行');
});

test('Backend 重启后以同一幂等键重放只执行一次业务', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'offerget-idem-'));
  const file = join(dir, 'idempotency-replay.json');
  const executions = { count: 0 };
  try {
    let store = new IdempotencyStore(file);
    let backend = CreateBackend({ container: createContainer(executions), idempotencyStore: store });
    const first = await backend.HandleCommand('workspace:save-settings', 'req-restart-1', 'idem-restart', { nickname: 'x' });
    assert.equal(first.ok, true);
    assert.equal(executions.count, 1);

    store = new IdempotencyStore(file);
    backend = CreateBackend({ container: createContainer(executions), idempotencyStore: store });
    const second = await backend.HandleCommand('workspace:save-settings', 'req-restart-2', 'idem-restart', { nickname: 'x' });
    assert.equal(second.ok, true);
    assert.equal(executions.count, 1, 'Backend 重启后重放不得再次执行业务');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('幂等记录写盘失败会报告降级，重启后不承诺回放', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'offerget-idem-degraded-'));
  const blockedParent = join(dir, 'not-a-directory');
  const replayFile = join(blockedParent, 'idempotency-replay.json');
  const executions = { count: 0 };
  try {
    writeFileSync(blockedParent, 'blocked');
    let store = new IdempotencyStore(replayFile);
    let backend = CreateBackend({ container: createContainer(executions), idempotencyStore: store });
    const first = await backend.HandleCommand('workspace:save-settings', 'req-degraded-1', 'idem-degraded', { nickname: 'x' });
    assert.equal(first.ok, true);
    assert.deepEqual(store.GetHealth(), { degraded: true, code: 'STORAGE_ERROR' });

    store = new IdempotencyStore(replayFile);
    backend = CreateBackend({ container: createContainer(executions), idempotencyStore: store });
    const second = await backend.HandleCommand('workspace:save-settings', 'req-degraded-2', 'idem-degraded', { nickname: 'x' });
    assert.equal(second.ok, true);
    assert.equal(executions.count, 2, '持久化降级后的重启不应承诺跨进程回放');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('生产 Preload/Gateway 与 Bridge 契约一致，并透传稳定幂等键', async () => {
  const { Module } = require('node:module');
  const originalLoad = Module._load;
  const exposed = new Map();
  const invokes = [];
  const preloadPath = require.resolve('../../../electron/preload.cjs');
  try {
    Module._load = function mockElectron(request, parent, isMain) {
      if (request === 'electron') {
        return {
          contextBridge: { exposeInMainWorld: (name, value) => exposed.set(name, value) },
          ipcRenderer: { invoke: (...args) => { invokes.push(args); return Promise.resolve({ ok: true }); }, on() {}, removeListener() {} },
          webUtils: { getPathForFile: () => 'C:/fixture.txt' },
        };
      }
      return originalLoad.call(this, request, parent, isMain);
    };
    delete require.cache[preloadPath];
    require(preloadPath);
  } finally {
    Module._load = originalLoad;
    delete require.cache[preloadPath];
  }

  for (const namespace of ['agent', 'workspace']) {
    assert.deepEqual(
      Object.keys(exposed.get(`offerget${namespace[0].toUpperCase()}${namespace.slice(1)}`)).sort(),
      [...BridgeNamespaces[namespace]].sort(),
      `Preload ${namespace} Bridge 方法必须与 contracts 保持一致`,
    );
  }

  const idempotencyKey = 'idem-production-retry';
  await exposed.get('offergetWorkspace').SaveSettings({ nickname: 'x' }, { idempotencyKey });
  assert.deepEqual(invokes, [['workspace:save-settings', { idempotencyKey, payload: [{ nickname: 'x' }] }]]);
  await exposed.get('offergetWorkspace').RemoveConversationMessage('conversation-1', 'message-1', { idempotencyKey: 'idem-remove-message' });
  assert.deepEqual(invokes[1], ['workspace:conversations-remove-message', {
    idempotencyKey: 'idem-remove-message', payload: ['conversation-1', 'message-1'],
  }]);
  await exposed.get('offergetWorkspace').ImportAttachment({}, 'text/plain', { idempotencyKey: 'idem-attachment' });
  assert.deepEqual(invokes[2], ['workspace:import-attachment', { idempotencyKey: 'idem-attachment', payload: ['C:/fixture.txt', 'text/plain'] }]);

  const executions = { count: 0 };
  const backend = CreateBackend({ container: createContainer(executions), idempotencyStore: createFakeStore() });
  const handlers = new Map();
  let transportSequence = 0;
  const windowContents = { id: 1, getURL: () => 'file:///offerget/index.html' };
  RegisterGateway({
    ipcMainApi: { handle: (channel, handler) => handlers.set(channel, handler) },
    webContentsGetter: () => ({ isDestroyed: () => false, webContents: windowContents }),
    backendHost: {
      state: () => 'ready',
      Command: (channel, key, ...args) => backend.HandleCommand(channel, `transport-${++transportSequence}`, key, ...args),
      OnEvent: () => {},
    },
  });
  const event = { sender: windowContents, senderFrame: { url: 'file:///offerget/index.html' } };
  const handler = handlers.get('workspace:save-settings');
  const missingKey = await handler(event, { payload: [{ nickname: 'x' }] });
  assert.equal(missingKey.ok, false);
  assert.equal(missingKey.error.code, 'VALIDATION_ERROR');
  const first = await handler(event, invokes[0][1]);
  const second = await handler(event, invokes[0][1]);
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(executions.count, 1, 'Gateway 重试必须透传稳定键，且不能复用内部 requestId 作为幂等键');
});

test('写命令信封要求稳定键，Mutation 意图在 settle 后生成新键', () => {
  assert.equal(WriteCommandEnvelopeSchema.safeParse({ payload: [] }).success, false, '可重放写命令不得省略稳定键');
  const issued = ['intent-1', 'intent-2'];
  const keys = CreateWriteIntentKeyStore(() => issued.shift());
  const intent = {};
  assert.equal(keys.Resolve(intent), 'intent-1');
  assert.equal(keys.Resolve(intent), 'intent-1', '自动重试必须复用同一意图的键');
  keys.Release(intent);
  assert.equal(keys.Resolve(intent), 'intent-2', 'settle 后复用变量对象也必须视为新意图');
});
