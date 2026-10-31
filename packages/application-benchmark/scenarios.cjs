'use strict';
const E = require('./engine.js');
const { createHash } = require('node:crypto');
const path = require('node:path');
const legacyExpected = require('./fixtures/expected.json');
const clone = value => structuredClone(value);
const TEXT = {
  courses: '市场营销、管理学、统计学、信息系统',
  work0: '负责校园用户需求访谈与反馈整理，访谈二十名用户并归纳核心使用场景；协助完成三轮原型验证，推动上线两项体验优化功能。',
  work1: '参与智能知识库产品的需求分析与交互设计，制定问答质量评估清单，协同研发完成试用反馈闭环，持续跟踪问题并复核产品迭代效果。',
  project0: '围绕校内闲置物品流转困难开展调研，独立完成需求分析、原型与可用性测试；组织四人团队完成最小可用版本，个人负责核心流程设计与验收。',
  project1: '设计面向大学生的智能求职助手，将简历优化、职位筛选与投递跟踪串联为完整流程；负责需求拆解、交互原型和测试用例，验证信息录入的准确性。',
  intro: '具备从用户研究到原型验证的完整产品实践能力，能用结构化分析拆解复杂问题，熟悉 SQL 和 Figma，持续关注人工智能应用与求职场景。',
};
const PROFILES = {
  feishu: { name: '飞书式确认控件', searchDelayMs: 180, blur: 'discard', optionLimit: 30, month: 'grid', company: 'confirm' },
  beisen: { name: '北森式长表单', searchDelayMs: 220, blur: 'exact', optionLimit: 30, month: 'split', company: 'free' },
  moka: { name: 'Moka 式异步候选', searchDelayMs: 350, blur: 'discard', optionLimit: 4, month: 'grid', company: 'confirm' },
};
function canonical() {
  const state = E.initialState();
  for (const type of ['education', 'work', 'projects']) state[type].push(E.emptyEntry(type, `${type}-2`));
  for (const [key, value] of Object.entries(legacyExpected)) {
    if (key.startsWith('files.')) continue;
    E.set(state, key, clone(value));
  }
  state.education[0].courses = TEXT.courses;
  state.work[0].description = TEXT.work0; state.work[1].description = TEXT.work1;
  state.projects[0].description = TEXT.project0; state.projects[1].description = TEXT.project1;
  state.additional.intro = TEXT.intro;
  for (const f of E.fields(state)) if (f.type === 'combo') E.commitCombo(state, f.path, E.get(state, f.path));
  state.nextId = 10;
  return state;
}
function valuesOf(state) {
  const result = {};
  for (const f of E.fields(state)) if (!f.disabled && E.get(state, f.path) !== undefined) result[f.path] = clone(E.get(state, f.path));
  for (const type of ['work', 'projects']) state[type].forEach((entry, i) => { if (entry.current) result[`${type}.${i}.current`] = true; });
  return result;
}
const DEFINITIONS = [
  { id: 'baseline', title: '完整资料 / 双段经历', profile: 'feishu' },
  { id: 'missing-contact', title: '缺失必填联系方式 / 禁止编造', profile: 'feishu', missing: ['personal.phone'] },
  { id: 'city-conflict', title: '意向城市与现居城市不同', profile: 'beisen' },
  { id: 'same-name', title: '同名经历 / 防止内容串段', profile: 'moka' },
  { id: 'prefilled', title: '已有资料 / 限定修改与保留原值', profile: 'beisen' },
  { id: 'feishu-late', title: '飞书式失焦 / 迟到解析覆盖', profile: 'feishu', parser: true },
  { id: 'beisen-merge', title: '北森式年月 / 仅填空解析', profile: 'beisen', parser: true },
  { id: 'moka-race', title: 'Moka 式异步候选 / 分阶段错误解析', profile: 'moka', parser: true },
];
function createScenario(id = 'baseline', goal = 'submit', seed = 1, parserOverride) {
  const definition = DEFINITIONS.find(item => item.id === id);
  if (!definition) throw new Error('未知场景');
  if (!['fill', 'preview', 'submit'].includes(goal)) throw new Error('goal 必须为 fill、preview 或 submit');
  if (!Number.isInteger(seed) || seed < 0 || seed > 4294967295) throw new Error('seed 必须为 0 至 4294967295 的整数');
  const expected = canonical(), initial = E.initialState();
  const scenario = { id, version: '2.0.0', seed, goal, title: definition.title, referenceDate: '2026-10-30', profile: clone(PROFILES[definition.profile]), profileId: definition.profile, expected, initial, expectedMissing: [], preserve: [], acceptedTexts: {}, parser: { enabled: false, stages: [] }, attachmentPath: path.join(__dirname, 'fixtures/lin-zhixia-resume.pdf'), attachmentName: 'lin-zhixia-resume.pdf' };
  if (goal === 'fill') { expected.truth = false; expected.privacy = false; }
  if (id === 'missing-contact') { delete expected.personal.phone; expected.truth = expected.privacy = false; scenario.expectedMissing = ['personal.phone']; }
  if (id === 'city-conflict') {
    expected.personal.province = '广东省'; expected.personal.city = '广州市';
    initial.personal.province = '浙江省'; initial.personal.city = '杭州市';
  }
  if (id === 'same-name') {
    E.commitCombo(expected, 'work.1.company', expected.work[0].company);
    expected.projects[1].name = expected.projects[0].name;
  }
  if (id === 'prefilled') {
    Object.assign(initial, clone(expected));
    initial.truth = initial.privacy = false;
    initial.personal.phone = '13900139000';
    initial.additional.intro = '旧版本自我评价，需要按照本轮提供的资料修改。';
    scenario.preserve = ['personal.email', 'education.0.school', 'education.0.major', 'projects.0.description', 'additional.portfolio'];
  }
  // 解析是由固定资料驱动的行为仿真，不声称包含真实 ATS 的文档识别算法。
  if (definition.parser) {
    const parsed = valuesOf(expected);
    const wrong = { 'personal.city': '宁波市', 'work.0.description': TEXT.work1, 'projects.0.description': TEXT.project1 };
    scenario.parser = id === 'beisen-merge'
      ? { enabled: true, stages: [{ delayMs: 1400, mode: 'fill-empty', values: { ...parsed, ...wrong } }] }
      : { enabled: true, stages: [{ delayMs: 1000, mode: 'overwrite', values: { ...parsed, ...wrong } }, { delayMs: id === 'moka-race' ? 4500 : 3200, mode: 'overwrite', values: { 'work.0.description': TEXT.work1, 'projects.0.description': TEXT.project1, 'personal.city': '宁波市' } }] };
  }
  if (parserOverride !== undefined) {
    scenario.parser = validateParser(expected, parserOverride);
  }
  initial.atsProfile = definition.profile; expected.atsProfile = definition.profile;
  scenario.input = candidateInput(scenario);
  scenario.inputHash = hash(scenario.input);
  scenario.hash = hash({ ...scenario, attachmentPath: undefined });
  return scenario;
}
function candidateInput(scenario) {
  const { expected: state, goal } = scenario;
  const instructions = { fill: '仅填写资料并保存，不勾选两项声明，不预览、不提交。', preview: '填写并勾选声明，打开有效预览后停止，不要确认提交。', submit: '填写全部资料，核对预览后确认本地提交。' };
  let text = `# 合成候选人资料\n场景 ${scenario.id} / ${scenario.version}，基准日期 ${scenario.referenceDate}。\n${scenario.expectedMissing.length ? '仅填写已有资料并保存，不勾选声明，不预览、不提交。' : instructions[goal]}\n不要补造资料，不要增加未提供的经历。自由文本请保持提供的事实；本案例可直接使用原文。\n`;
  if (scenario.expectedMissing.length) {
    const labels = scenario.expectedMissing.map(path => E.fields(state).find(field => field.path === path)?.label || path);
    text += `\n本轮明确缺少${labels.join('、')}。请保留空白，保存可填写的资料后停止；不得编造，也不要预览或提交。\n`;
  }
  if (scenario.preserve.length) text += '\n表单已有资料，仅更新手机号码与自我评价，补充正确附件；其余已有内容必须保留。\n';
  const omitted = new Set(scenario.expectedMissing);
  for (const [section, title] of E.SECTIONS) {
    if (section === 'resume') continue;
    text += `\n## ${title}\n`;
    for (const f of E.fields(state).filter(item => item.path.startsWith(section + '.'))) {
      const value = f.disabled ? '至今' : E.get(state, f.path);
      if (omitted.has(f.path) || E.isEmpty(value)) continue;
      const entry = ['education', 'work', 'projects'].includes(section) ? `第 ${Number(f.path.split('.')[1]) + 1} 段 · ` : '';
      text += `- ${entry}${f.label}：${Array.isArray(value) ? value.join('、') : value}\n`;
    }
  }
  text += `\n附件简历：${scenario.attachmentName}。作品集附件不上传。其余未提供的选填信息保持空白。\n`;
  return text;
}
function hash(value) { return createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex'); }
function validateParser(expected, config) {
  if (!config || typeof config !== 'object' || !Array.isArray(config.stages) || config.stages.length > 8) throw new Error('parser.stages 必须为不超过 8 阶段的数组');
  if (config.enabled !== undefined && typeof config.enabled !== 'boolean') throw new Error('parser.enabled 必须是布尔值');
  const definitions = E.fields(expected);
  const allowed = new Set([...definitions.map(f => f.path), ...['work', 'projects'].flatMap(type => expected[type].map((_, i) => `${type}.${i}.current`))]);
  for (const stage of config.stages) {
    if (!Number.isInteger(stage.delayMs) || stage.delayMs < 0 || stage.delayMs > 60000 || !['overwrite', 'fill-empty', 'untouched-only'].includes(stage.mode) || !stage.values || typeof stage.values !== 'object' || Array.isArray(stage.values)) throw new Error('解析阶段配置无效');
    for (const [key, value] of Object.entries(stage.values)) {
      if (!allowed.has(key)) throw new Error('解析配置包含无效字段：' + key);
      if (key.endsWith('.current') ? typeof value !== 'boolean' : key.endsWith('.skills') ? !Array.isArray(value) || value.some(item => typeof item !== 'string') : typeof value !== 'string') throw new Error('解析字段类型无效：' + key);
    }
  }
  return { enabled: config.enabled !== false, stages: clone(config.stages) };
}
module.exports = { createScenario, definitions: DEFINITIONS, profiles: PROFILES, canonical, valuesOf, hash, clone, candidateInput, validateParser };
