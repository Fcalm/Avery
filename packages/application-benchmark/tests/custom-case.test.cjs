const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { RunStore } = require('../run-store.cjs');
const { canonical } = require('../scenarios.cjs');
test('缺失字段说明按实际字段生成，声明期望随本轮完成目标确定', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'career-case-test-'));
  const store = await new RunStore(root).init();
  t.after(async () => { store.close(); if (path.dirname(path.resolve(root)) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('career-case-test-')) throw new Error('清理路径不安全'); await fs.rm(root, { recursive: true, force: true }); });
  const attachment = { name: 'resume.pdf', base64: (await fs.readFile(path.join(__dirname, '../fixtures/lin-zhixia-resume.pdf'))).toString('base64') };
  const expected = canonical(); delete expected.personal.email;
  const missing = await store.registerCase({ id: 'custom-no-email', version: '1.0.0', title: '缺邮箱', profileId: 'feishu', expected, expectedMissing: ['personal.email'], attachment });
  const run = await store.create({ scenarioId: missing.scenarioId, goal: 'fill' });
  assert.match(run.input, /明确缺少电子邮箱/); assert.doesNotMatch(run.input, /明确缺少手机号码/);
  const full = canonical(); full.truth = full.privacy = false;
  const normal = await store.registerCase({ id: 'custom-consent', version: '1.0.0', title: '声明', profileId: 'feishu', expected: full, attachment });
  for (const goal of ['fill', 'preview', 'submit']) {
    const created = await store.create({ scenarioId: normal.scenarioId, goal });
    assert.equal(store.get(created.id).scenario.expected.truth, goal !== 'fill');
  }
});
test('注入、固定版本和重新加载自定义案例，附件、自由文本白名单生效', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'career-case-test-'));
  const store = await new RunStore(root).init();
  t.after(async () => { store.close(); if (path.dirname(path.resolve(root)) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('career-case-test-')) throw new Error('清理路径不安全'); await fs.rm(root, { recursive: true, force: true }); });
  const expected = canonical(), alternate = '负责用户研究和原型设计，结合真实反馈推进产品迭代与验证。';
  const definition = { id: 'custom-example', version: '1.0.0', title: '可注入场景', profileId: 'beisen', expected, initial: undefined, acceptedTexts: { 'additional.intro': [alternate] }, attachment: { name: 'candidate.pdf', base64: (await fs.readFile(path.join(__dirname, '../fixtures/lin-zhixia-resume.pdf'))).toString('base64') } };
  const registered = await store.registerCase(definition); assert.equal(registered.scenarioId, 'custom-example@1.0.0');
  await assert.rejects(store.registerCase(definition), { code: 'CASE_VERSION_EXISTS' });
  const created = await store.create({ scenarioId: registered.scenarioId, goal: 'fill', seed: 42 }), run = store.get(created.id);
  assert.ok(created.input.includes('candidate.pdf')); assert.equal(run.scenario.expected.truth, false); assert.equal(run.scenario.expected.privacy, false);
  await store.upload(run.id, 'resume', await fs.readFile(created.attachmentPath), 'candidate.pdf');
  const state = structuredClone(run.scenario.expected); state.additional.intro = alternate;
  await store.save(run.id, { revision: run.revision, state });
  assert.equal((await store.end(run.id)).payload.report.passed, true);
  const resumed = await new RunStore(root).init(); t.after(() => resumed.close()); assert.equal(resumed.listScenarios().scenarios.length, 9);
  const duplicate = await resumed.create({ scenarioId: registered.scenarioId, goal: 'fill', seed: 42 }); assert.equal(duplicate.manifest.scenarioHash, created.manifest.scenarioHash);
});
test('无效自定义预期与越界路径拒绝，而不是创建不可完成的测试', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'career-case-test-'));
  const store = await new RunStore(root).init();
  t.after(async () => { store.close(); if (path.dirname(path.resolve(root)) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('career-case-test-')) throw new Error('清理路径不安全'); await fs.rm(root, { recursive: true, force: true }); });
  const body = { id: 'custom-invalid', version: '1.0.0', title: '坏案例', profileId: 'feishu', expected: canonical(), attachment: { name: 'test.pdf', base64: (await fs.readFile(path.join(__dirname, '../fixtures/lin-zhixia-resume.pdf'))).toString('base64') } };
  body.expected.personal.phone = 'not-a-phone'; await assert.rejects(store.registerCase(body), { code: 'INVALID_EXPECTATION' });
  body.id = '../escape'; await assert.rejects(store.registerCase(body), { code: 'INVALID_CASE' });
});
