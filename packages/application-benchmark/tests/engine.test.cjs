const { test } = require('node:test');
const assert = require('node:assert/strict');
const E = require('../engine.js');

function valid() {
  const s = E.initialState();
  Object.assign(s.intention, { kind: '实习', city: '杭州', arrival: '2 周内', source: '学校就业网', days: '4 天', duration: '6 个月及以上' });
  Object.assign(s.personal, { name: '林知夏', gender: '女', phone: '13800138000', email: 'lin.zhixia@example.com', birthday: '2003-08-16', nationality: '中国大陆', province: '浙江省', city: '杭州市' });
  Object.assign(s.education[0], { degree: '本科', mode: '全日制', start: '2022-09', end: '2026-06' });
  E.commitCombo(s, 'education.0.school', '南昌大学'); E.commitCombo(s, 'education.0.major', '工商管理');
  E.commitCombo(s, 'work.0.company', '杭州云序科技有限公司');
  Object.assign(s.work[0], { position: '产品实习生', type: '实习', start: '2025-07', end: '2025-12', description: '参与校园用户需求调研与产品原型设计，整理用户反馈，推动研发上线体验改进功能，并完成可用性测试。' });
  Object.assign(s.projects[0], { name: '校园平台', role: '产品负责人', start: '2025-01', end: '2025-05', description: '围绕校园闲置物品交易场景开展用户调研，完成产品流程和交互原型设计，组织团队完成开发并推动项目上线。' });
  Object.assign(s.additional, { skills: ['SQL'], intro: '具备产品分析与交互设计能力，熟悉数据分析方法，愿意持续学习人工智能技术。', adjustment: '接受' });
  s.truth = s.privacy = true; s.files.resume = { name: 'resume.pdf', size: 1000 };
  return s;
}
test('完整场景通过校验且完整度为100%', () => { const s = valid(); assert.deepEqual(E.validate(s), {}); assert.equal(E.progress(s).percent, 100); });
test('仅输入未确认：失焦丢弃，普通字段不受影响', () => { const s = valid(); s.education[0].school = ''; delete s.education[0]._committed.school; assert.deepEqual(E.resolveBlur('', '南昌大学'), { value: '', discarded: true }); assert.match(E.validate(s)['education.0.school'], /学校名称/); assert.equal(s.personal.name, '林知夏'); });
test('有旧选择时失焦恢复已确认值，不破坏旧选择', () => { assert.deepEqual(E.resolveBlur('南昌大学', '清华'), { value: '南昌大学', discarded: true }); assert.deepEqual(E.resolveBlur('南昌大学', '南昌大学'), { value: '南昌大学', discarded: false }); });
test('DOM或草稿直接写入未确认的值不能通过校验', () => { const s = valid(); s.education[0].school = '浙江大学'; assert.match(E.validate(s)['education.0.school'], /确认/); E.commitCombo(s, 'education.0.school', '浙江大学'); assert.equal(E.validate(s)['education.0.school'], undefined); });
test('确认自定义学校或公司，与候选选择遵循同一规则', () => { const s = valid(); E.commitCombo(s, 'work.0.company', '一家未收录的测试公司'); assert.equal(E.validate(s)['work.0.company'], undefined); });
test('无工作经历隐藏校验但保留草稿，导出不带隐藏经历', () => { const s = valid(); s.noWork = true; delete s.work[0].position; assert.equal(E.validate(s)['work.0.position'], undefined); assert.equal(E.snapshot(s).application.work.length, 0); assert.equal(s.work.length, 1); });
test('多段经历按各自索引校验，不串联', () => { const s = valid(); s.education.push({ id: 'edu-2' }); const err = E.validate(s); assert.equal(err['education.0.school'], undefined); assert.ok(err['education.1.school']); });
test('日期校验：先后、未来、预计毕业、至今', () => { const s = valid(); s.work[0].end = '2024-01'; assert.ok(E.validate(s)['work.0.end']); s.work[0].end = '2027-01'; assert.ok(E.validate(s)['work.0.end']); s.work[0].current = true; assert.equal(E.validate(s)['work.0.end'], undefined); s.education[0].end = '2029-06'; assert.equal(E.validate(s)['education.0.end'], undefined); s.projects[0].start = '2027-01'; assert.ok(E.validate(s)['projects.0.start']); });
test('毕业与出生日期必须真实有效', () => { const s = valid(); s.education[0].end = '2026-13'; s.personal.birthday = '2003-02-31'; const err = E.validate(s); assert.ok(err['education.0.end']); assert.ok(err['personal.birthday']); });
test('省市级联不能保留不属于当前省份的城市', () => { const s = valid(); s.personal.province = '广东省'; assert.ok(E.validate(s)['personal.city']); });
test('条件必填：实习与全职、内推、证件、英语、GPA', () => { const s = valid(); s.intention.kind = '全职'; s.intention.source = '员工内推'; s.personal.documentType = '护照'; s.additional.english = '雅思'; s.education[0].gpa = '3.7'; const err = E.validate(s); for (const path of ['intention.salary', 'intention.referral', 'personal.documentNumber', 'additional.englishScore', 'education.0.gpaScale']) assert.ok(err[path], path); assert.equal(err['intention.days'], undefined); });
test('成绩上限、邮箱、手机号与危险链接拦截', () => { const s = valid(); s.education[0].gpa = '4.5'; s.education[0].gpaScale = '4'; s.additional.english = '雅思'; s.additional.englishScore = '10'; s.personal.email = 'bad'; s.personal.phone = '111'; s.projects[0].url = 'javascript:alert(1)'; const err = E.validate(s); for (const path of ['education.0.gpa', 'additional.englishScore', 'personal.email', 'personal.phone', 'projects.0.url']) assert.ok(err[path], path); });
test('附件格式、空文件与大小', () => { assert.ok(E.validateFile(null, 'resume')); assert.ok(E.validateFile({ name: 'x.exe', size: 99 }, 'resume')); assert.ok(E.validateFile({ name: 'x.pdf', size: 0 }, 'resume')); assert.ok(E.validateFile({ name: 'x.pdf', size: 11 * 1024 * 1024 }, 'resume')); assert.equal(E.validateFile({ name: 'x.DOCX', size: 1000 }, 'resume'), ''); });
test('不能跳过教育、项目与声明；导出无副作用', () => { const s = valid(); s.education = []; s.projects = []; s.truth = false; const err = E.validate(s); assert.ok(err.education); assert.ok(err.projects); assert.ok(err.truth); const before = JSON.stringify(s); E.snapshot(s); assert.equal(JSON.stringify(s), before); });
test('导出包含失焦和提交事件计数', () => { const s = valid(); s.events = [{ type: 'combo_blur_discard' }, { type: 'combo_commit' }, { type: 'preview_attempt' }]; assert.deepEqual(E.snapshot(s).metrics, { blurDiscards: 1, confirmedSelections: 1, submitAttempts: 1 }); });
