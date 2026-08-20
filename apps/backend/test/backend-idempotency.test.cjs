'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { CreateBackend } = require('../dist/router.js');
const { IdempotencyStore } = require('../dist/idempotency-store.js');

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
