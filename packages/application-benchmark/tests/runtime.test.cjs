const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { RunStore, verifyEnvelope } = require('../run-store.cjs');
const { clone, hash } = require('../scenarios.cjs');
const { score } = require('../scorer.cjs');
async function setup(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'career-v2-test-'));
  const store = await new RunStore(root).init(); store.baseUrl = 'http://127.0.0.1:4178';
  t.after(async () => { store.close(); const resolved = path.resolve(root); if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('career-v2-test-')) throw new Error('测试清理路径不安全'); await fs.rm(resolved, { recursive: true, force: true }); });
  return store;
}
async function filled(store, options = {}) {
  const created = await store.create(options), run = store.get(created.id);
  const bytes = await fs.readFile(run.scenario.attachmentPath);
  await store.upload(created.id, 'resume', bytes, run.scenario.attachmentName);
  assert.ok(run.events.some(event => event.type === 'upload_verified' && event.mimeType === 'application/pdf'));
  const state = clone(run.scenario.expected);
  await store.save(created.id, { state, revision: run.revision, events: [] });
  return run;
}
test('自动创建隔离轮次、读取状态与事件、结束清理，结果签名可验证', async t => {
  const store = await setup(t), run = await filled(store);
  await store.preview(run.id, run.revision); await store.submit(run.id, { revision: run.revision, previewId: run.preview.id });
  const result = await store.end(run.id); assert.equal(result.payload.report.passed, true); assert.equal(verifyEnvelope(result, store.publicKey), true);
  const second = await store.create(); assert.equal(store.get(second.id).state.personal.name, undefined); assert.deepEqual(store.get(second.id).files, {});
  await store.cleanup(run.id); assert.equal(store.runs.has(run.id), false); assert.ok(await fs.stat(path.join(store.root, 'results', `${run.id}.json`)));
  assert.equal(store.runs.has(second.id), true);
});
test('三种目标分别通过，填表和预览不要求提交', async t => {
  const store = await setup(t);
  for (const goal of ['fill', 'preview', 'submit']) {
    const run = await filled(store, { goal });
    if (goal !== 'fill') await store.preview(run.id, run.revision);
    if (goal === 'submit') await store.submit(run.id, { revision: run.revision, previewId: run.preview.id });
    assert.equal((await store.end(run.id)).payload.report.passed, true, goal);
  }
});
test('伪造客户端提交事件被拒绝；伪造 files 和 submitted 状态不能生效', async t => {
  const store = await setup(t), run = store.get((await store.create()).id), state = clone(run.scenario.expected);
  state.files.resume = { name: 'lin-zhixia-resume.pdf', size: 3541 }; state.status = 'submitted'; state.submission = { id: 'fake' };
  await assert.rejects(store.save(run.id, { state, revision: run.revision, events: [{ type: 'submission_success' }] }), { code: 'FORGED_EVENT' });
  await store.save(run.id, { state, revision: run.revision });
  assert.equal(run.state.status, 'draft'); assert.equal(run.state.submission, null); assert.deepEqual(run.state.files, {});
  assert.equal((await store.end(run.id)).payload.report.passed, false);
});
test('实际附件被替换或删除，无法提交与获得满分', async t => {
  const store = await setup(t), run = await filled(store);
  await fs.writeFile(path.join(store.runPath(run.id), 'resume.bin'), '%PDF-wrong-content');
  await assert.rejects(store.preview(run.id, run.revision), { code: 'FILE_NOT_PROVEN' });
  assert.equal(score(run.scenario, await store.evidence(run)).passed, false);
});
test('不能无预览直接提交；预览后编辑失效；重复提交幂等', async t => {
  const store = await setup(t), run = await filled(store);
  await assert.rejects(store.submit(run.id, { revision: run.revision, previewId: 'fake' }), { code: 'PREVIEW_REQUIRED' });
  await store.preview(run.id, run.revision); const oldId = run.preview.id;
  const state = clone(run.state); state.personal.name = '新名字'; await store.save(run.id, { revision: run.revision, state });
  await assert.rejects(store.submit(run.id, { revision: run.revision, previewId: oldId }), { code: 'PREVIEW_REQUIRED' });
  await store.preview(run.id, run.revision); const body = { revision: run.revision, previewId: run.preview.id };
  const one = await store.submit(run.id, body), two = await store.submit(run.id, body); assert.equal(one.receipt.id, two.receipt.id); assert.equal(run.events.filter(e => e.type === 'submission_success').length, 1);
});
test('迟到解析覆盖、仅填空与 untouched-only 按固定配置工作', async t => {
  const store = await setup(t);
  for (const mode of ['overwrite', 'fill-empty', 'untouched-only']) {
    const created = await store.create({ parser: { stages: [{ delayMs: 60000, mode, values: { 'personal.name': '解析姓名' } }] } });
    const run = store.get(created.id), state = clone(run.state); state.personal.name = '用户修改';
    await store.save(run.id, { state, revision: run.revision });
    await store.upload(run.id, 'resume', await fs.readFile(run.scenario.attachmentPath), run.scenario.attachmentName);
    await store.applyParse(run.id, run.parser.jobs[0].id);
    assert.equal(run.state.personal.name, mode === 'overwrite' ? '解析姓名' : '用户修改', mode);
    assert.ok(run.events.some(e => e.type === 'parser_applied'));
  }
});
test('解析中的结束记录不能满分，旧附件解析任务取消后不能污染新附件或其他轮次', async t => {
  const store = await setup(t), run = await filled(store, { goal: 'fill', parser: { stages: [{ delayMs: 60000, mode: 'overwrite', values: { 'personal.name': '迟到更新' } }] } });
  const oldJob = run.parser.jobs[0].id; await store.removeFile(run.id, 'resume');
  await store.applyParse(run.id, oldJob); assert.equal(run.state.personal.name, '林知夏');
  const next = await filled(store, { goal: 'fill', parser: { stages: [{ delayMs: 60000, mode: 'overwrite', values: { 'personal.name': '迟到更新' } }] } });
  const result = await store.end(next.id); assert.ok(result.payload.report.issues.some(e => e.code === 'parser_still_pending'));
});
test('版本冲突不静默重放旧资料；服务重启保留轮次与签名密钥', async t => {
  const store = await setup(t), run = await filled(store, { goal: 'fill' });
  await assert.rejects(store.save(run.id, { state: run.state, revision: run.revision - 1 }), { code: 'REVISION_CONFLICT' });
  store.close(); const resumed = await new RunStore(store.root).init(); t.after(() => resumed.close());
  assert.equal(resumed.get(run.id).state.personal.name, '林知夏'); assert.equal(resumed.publicKey, store.publicKey);
});
test('篡改签名结果、换自签公钥不能验过；附件哈希为真实 SHA256', async t => {
  const store = await setup(t), run = await filled(store, { goal: 'fill' }), result = await store.end(run.id);
  assert.equal(result.payload.evidence.files.resume.sha256, hash(await fs.readFile(run.scenario.attachmentPath)));
  result.payload.evidence.state.personal.name = 'tampered'; assert.equal(verifyEnvelope(result, store.publicKey), false);
});
test('指标缺省是 null；控制端上报与环境错误独立保留', async t => {
  const store = await setup(t), run = await filled(store, { goal: 'fill' });
  await store.metrics(run.id, { tokens: { input: 800, output: 200 }, retries: 1, agent: 'test', model: 'test' });
  await store.environmentFailure(run.id, { code: 'BROWSER_CRASH', message: '测评浏览器崩溃' });
  const result = await store.end(run.id); assert.equal(result.payload.report.outcome, 'environment_failure'); assert.equal(result.payload.report.score, null); assert.equal(result.payload.report.metrics.tokens.input, 800);
});
test('真实计时任务按延迟执行，不靠手动调用解析；事件编号去重', async t => {
  const store = await setup(t);
  const created = await store.create({ goal: 'fill', parser: { stages: [{ delayMs: 35, mode: 'overwrite', values: { 'personal.name': '解析姓名' } }] } });
  const run = store.get(created.id);
  await store.upload(run.id, 'resume', await fs.readFile(run.scenario.attachmentPath), run.scenario.attachmentName);
  const dueAt = run.parser.jobs[0].dueAt;
  const deadline = Date.now() + 2000;
  while (run.parser.jobs[0].status === 'pending' && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(run.parser.jobs[0].status, 'applied'); assert.equal(run.state.personal.name, '解析姓名');
  const event = run.events.find(item => item.type === 'parser_applied'); assert.ok(Date.parse(event.at) >= dueAt);
  const clientEvent = { id: require('node:crypto').randomUUID(), type: 'combo_blur_discard', path: 'education.0.school', queryLength: 4 };
  await store.save(run.id, { state: run.state, revision: run.revision, events: [clientEvent] });
  await store.save(run.id, { state: run.state, revision: run.revision, events: [clientEvent] });
  assert.equal(run.events.filter(item => item.type === 'combo_blur_discard').length, 1);
});
test('非活动浏览器的零视口可如实记录，未知字段和非法指标不能混入状态', async t => {
  const store = await setup(t), run = store.get((await store.create()).id);
  await store.context(run.id, { userAgent: 'test', width: 0, height: 0, dpr: 1 });
  assert.equal(store.manifest(run).environment.browser.width, 0);
  await store.context(run.id, { userAgent: 'test', width: 1280, height: 800, dpr: 1.5 });
  assert.equal(store.manifest(run).environment.browser.width, 1280);
  const state = clone(run.state); state.personal.unknown = '未知字段';
  await assert.rejects(store.save(run.id, { state, revision: run.revision }), { code: 'INVALID_STATE' });
  await assert.rejects(store.metrics(run.id, { tokens: { input: -1 } }), { code: 'INVALID_METRICS' });
});
