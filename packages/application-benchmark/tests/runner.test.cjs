const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { startServer } = require('../serve.cjs');
const { createClient } = require('../client.cjs');
const { runCase } = require('../runner.cjs');
test('Runner 自动结束清理；区分 Agent 失败、环境失败与成功，执行前不暴露期望值', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'career-runner-test-'));
  const { server, store, baseUrl } = await startServer({ dataRoot: root, port: 0 });
  t.after(async () => { store.close(); await new Promise(resolve => server.close(resolve)); if (path.dirname(path.resolve(root)) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('career-runner-test-')) throw new Error('清理路径不安全'); await fs.rm(root, { recursive: true, force: true }); });
  const client = await createClient({ baseUrl, token: store.adminToken });
  for (const category of ['agent', 'environment']) {
    const result = await runCase({ client, scenarioId: 'baseline', goal: 'fill', execute: async task => { assert.equal('expected' in task, false); const error = new Error('模拟执行失败'); error.category = category; error.code = category === 'environment' ? 'BROWSER_CRASH' : 'MODEL_TIMEOUT'; throw error; } });
    assert.equal(result.payload.report.outcome, category === 'environment' ? 'environment_failure' : 'agent_failure');
    assert.equal(store.runs.has(result.payload.manifest.runId), false);
  }
  let flushed = false;
  const success = await runCase({ client, goal: 'fill', execute: async task => {
    const run = store.get(task.id); await store.upload(task.id, 'resume', await fs.readFile(task.attachmentPath), task.attachmentName); await store.save(task.id, { state: structuredClone(run.scenario.expected), revision: run.revision });
    return { metrics: { tokens: { input: 100, output: 50 }, retries: 0 } };
  }, flush: async () => { flushed = true; } });
  assert.equal(flushed, true); assert.equal(success.payload.report.passed, true); assert.equal(success.payload.report.metrics.tokens.input, 100);
  const flushFailure = await runCase({ client, goal: 'fill', execute: async () => {}, flush: async () => { throw new Error('浏览器状态同步失败'); } });
  assert.equal(flushFailure.payload.report.outcome, 'environment_failure');
  assert.equal(flushFailure.payload.evidence.agentFailures.length, 0);
  assert.equal(flushFailure.payload.evidence.environmentFailures[0].code, 'FLUSH_FAILED');
  const metricsFailure = await runCase({ client, goal: 'fill', execute: async () => ({ metrics: { tokens: { input: -1 } } }) });
  assert.equal(metricsFailure.payload.report.outcome, 'environment_failure');
  assert.equal(metricsFailure.payload.evidence.agentFailures.length, 0);
  const emptyThrownValue = await runCase({ client, goal: 'fill', execute: async () => { throw null; } });
  assert.equal(emptyThrownValue.payload.report.outcome, 'agent_failure');
  await assert.rejects(runCase({ client, scenarioId: 'unknown-case', execute: async () => {} }), error => error.category === 'environment' && error.code === 'INVALID_SCENARIO');
});
