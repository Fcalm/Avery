const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createResumePdf } = require('../resume-pdf.cjs');
const { createScenario } = require('../scenarios.cjs');
const encoded = text => Buffer.from(text, 'utf16le').swap16().toString('hex');
test('内置附件与本轮资料一致，缺手机号、城市冲突和同名经历不会混入旧资料', () => {
  const baseline = createResumePdf(createScenario('baseline', 'fill').expected);
  const missing = createResumePdf(createScenario('missing-contact', 'fill').expected);
  assert.equal(baseline.subarray(0, 5).toString(), '%PDF-');
  assert.ok(baseline.toString().includes(encoded('13800138000')));
  assert.ok(!missing.toString().includes(encoded('13800138000')));
  const city = createResumePdf(createScenario('city-conflict', 'fill').expected).toString();
  assert.ok(city.includes(encoded('广州市')));
  const same = createResumePdf(createScenario('same-name', 'fill').expected).toString();
  assert.ok(!same.includes(encoded('序光信息技术有限公司')));
  assert.deepEqual(baseline, createResumePdf(createScenario('baseline', 'submit').expected));
});
