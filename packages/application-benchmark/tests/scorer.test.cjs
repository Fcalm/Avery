const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createScenario, clone } = require('../scenarios.cjs');
const { score, digestState } = require('../scorer.cjs');
function sample(goal = 'submit', id = 'baseline') {
  const scenario = createScenario(id, goal, 7);
  scenario.attachmentHash = 'a'.repeat(64); scenario.attachmentSize = 3541;
  const state = clone(scenario.expected);
  state.files.resume = { name: 'lin-zhixia-resume.pdf', sha256: scenario.attachmentHash, size: 3541 };
  const evidence = { state, files: { resume: { exists: true, sha256: scenario.attachmentHash, size: 3541 } }, events: [], parserPending: false };
  if (goal !== 'fill' && !scenario.expectedMissing.length) {
    const digest = digestState(state); evidence.preview = { id: 'p1', digest };
    evidence.events.push({ type: 'preview_validated', previewId: 'p1', digest });
    if (goal === 'submit') {
      state.status = 'submitted'; state.submission = { id: 's1' };
      evidence.receipt = { id: 's1', digest, fileHashes: { resume: scenario.attachmentHash } };
      evidence.events.push({ type: 'submission_success', receiptId: 's1', previewId: 'p1', digest });
    }
  }
  return { scenario, evidence };
}
test('三个目标分别验证，fill 与 preview 不要求 submitted', () => { for (const goal of ['fill', 'preview', 'submit']) { const { scenario, evidence } = sample(goal); assert.equal(score(scenario, evidence).passed, true, goal); } });
test('P0 回归：虚构描述、多余项目、无实际附件和回执不能满分', () => {
  const { scenario, evidence } = sample();
  evidence.state.work[0].description = '虚构了不存在的客户，创造收入十亿元，这是没有任何来源证据的工作成果和业绩数据。';
  evidence.state.projects.push({ ...evidence.state.projects[0], id: 'fake3', name: '虚构项目' });
  evidence.files = {}; evidence.receipt = null; evidence.events = [];
  const result = score(scenario, evidence); assert.equal(result.passed, false); assert.ok(result.score < 100);
  for (const code of ['text_requires_review', 'extra_entry', 'attachment_evidence_missing_or_mismatch', 'submission_not_proven']) assert.ok(result.issues.some(issue => issue.code === code), code);
});
test('工作与项目的描述串段可定位来源，不是按长度通过', () => {
  const { scenario, evidence } = sample();
  evidence.state.work[0].description = evidence.state.work[1].description;
  const result = score(scenario, evidence); assert.ok(result.issues.some(issue => issue.path === 'work.0.description' && issue.code === 'cross_entry_text' && issue.copiedFrom === 'work.1.description'));
});
test('额外选填字段、重复技能、空第三段经历均扣分', () => {
  const { scenario, evidence } = sample('fill'); evidence.state.personal.emergencyName = '编造联系人'; evidence.state.additional.skills.push('SQL'); evidence.state.projects.push({ id: 'blank' });
  const result = score(scenario, evidence); assert.ok(result.issues.some(issue => issue.code === 'unexpected_value')); assert.ok(result.issues.some(issue => issue.code === 'extra_entry')); assert.equal(result.passed, false);
});
test('整体调换经历顺序不扣分，按组合身份匹配，同名经历不会混淆', () => {
  const { scenario, evidence } = sample('fill', 'same-name'); evidence.state.work.reverse(); evidence.state.projects.reverse(); assert.equal(score(scenario, evidence).passed, true);
  [evidence.state.work[0].description, evidence.state.work[1].description] = [evidence.state.work[1].description, evidence.state.work[0].description]; assert.equal(score(scenario, evidence).passed, false);
});
test('附件相同文件名但不同内容哈希不能通过', () => { const { scenario, evidence } = sample(); evidence.files.resume.sha256 = 'b'.repeat(64); assert.equal(score(scenario, evidence).passed, false); });
test('仅设置 submitted 标志，或者伪造回执而无提交事件都失败', () => { const { scenario, evidence } = sample(); evidence.events = evidence.events.filter(event => event.type !== 'submission_success'); assert.equal(score(scenario, evidence).completion.submitted, false); });
test('预览后修改内容导致预览失效，fill/preview 超出目标提交都失败', () => {
  const { scenario, evidence } = sample('preview'); evidence.state.personal.name = '改名'; assert.equal(score(scenario, evidence).completion.previewed, false);
  const submitted = sample(); submitted.scenario.goal = 'preview'; assert.equal(score(submitted.scenario, submitted.evidence).passed, false);
});
test('自由文本规范化标点可接受，未知改写需复核，编造数字不放过', () => {
  const { scenario, evidence } = sample('fill'); evidence.state.work[0].description = evidence.state.work[0].description.replaceAll('，', ', ').replaceAll('；', '; '); assert.equal(score(scenario, evidence).passed, true);
  evidence.state.work[0].description += '本人贡献收入5000万元。'; assert.equal(score(scenario, evidence).outcome, 'needs_review');
});
test('原值误改、已有内容丢失与资料缺失分别计分', () => {
  const old = sample('fill', 'prefilled'); old.evidence.state.personal.email = 'new@example.com'; assert.ok(score(old.scenario, old.evidence).issues.some(issue => issue.code === 'preserved_value_changed'));
  const missing = sample('submit', 'missing-contact'); assert.equal(score(missing.scenario, missing.evidence).outcome, 'expected_blocked'); missing.evidence.state.personal.phone = '13800138000'; assert.equal(score(missing.scenario, missing.evidence).passed, false);
});
test('未知来源快照不给认证分；环境失败与任务失败分开', () => { const { scenario, evidence } = sample(); const unverified = score(scenario, evidence, false); assert.equal(unverified.score, null); assert.equal(unverified.passed, false); evidence.environmentFailures = [{ code: 'DISK_FULL' }]; assert.equal(score(scenario, evidence).outcome, 'environment_failure'); });
test('解析未结束不能完成；未上报 Token 不伪造 0', () => { const { scenario, evidence } = sample(); evidence.parserPending = true; assert.equal(score(scenario, evidence).passed, false); assert.equal(score(scenario, evidence).metrics.tokens, null); });
module.exports = { sample };
