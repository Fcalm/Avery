const { test } = require('node:test');
const assert = require('node:assert/strict');
const { definitions, createScenario, valuesOf } = require('../scenarios.cjs');
const E = require('../engine.js');
test('8 场景覆盖缺失、冲突、同名、预填与3种 ATS 模型', () => {
  assert.equal(definitions.length, 8);
  for (const definition of definitions) {
    const scenario = createScenario(definition.id, 'fill', 12);
    assert.ok(scenario.input.includes('不提交')); assert.equal(scenario.expected.truth, false);
    assert.equal(scenario.initial.files.resume, undefined);
    const expected = structuredClone(scenario.expected); expected.files.resume = { name: 'test.pdf', size: 100 };
    const errors = E.validate(expected);
    assert.deepEqual(Object.keys(errors).filter(key => !['truth', 'privacy', ...scenario.expectedMissing].includes(key)), [], definition.id);
  }
});
test('同一版本与种子输入及场景哈希一致；换种子和目标留下差异', () => {
  const one = createScenario('moka-race', 'preview', 42), two = createScenario('moka-race', 'preview', 42);
  assert.equal(one.hash, two.hash); assert.equal(one.inputHash, two.inputHash);
  assert.notEqual(one.hash, createScenario('moka-race', 'preview', 43).hash);
  assert.notEqual(one.inputHash, createScenario('moka-race', 'fill', 42).inputHash);
});
test('解析配置拒绝非法路径、过长延迟和错误类型；不允许解析代签声明', () => {
  for (const values of [{ 'truth': true }, { 'projects.99.name': 'x' }, { 'personal.name': {} }, { '__proto__.a': 'x' }]) assert.throws(() => createScenario('baseline', 'fill', 1, { stages: [{ delayMs: 50, mode: 'overwrite', values }] }));
  assert.throws(() => createScenario('baseline', 'fill', 1, { stages: [{ delayMs: 100000, mode: 'overwrite', values: {} }] }));
});
test('工作至今解析包含 current 标记，不携带过期结束值；资料不含评分文件路径', () => {
  const scenario = createScenario('baseline'); const values = valuesOf(scenario.expected);
  assert.equal(values['work.1.current'], true); assert.equal(values['work.1.end'], undefined);
  assert.equal(scenario.input.includes('expected.json'), false);
});
