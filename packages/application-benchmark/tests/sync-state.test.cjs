const { test } = require('node:test');
const assert = require('node:assert/strict');
const { rebase } = require('../sync-state.js');
test('解析姓名时保留并发输入的手机号，同一字段冲突以解析为准', () => {
  const base = { personal: { name: '', phone: '' }, education: [{ id: 'a', school: '' }] };
  const local = structuredClone(base); local.personal.phone = '13800138000'; local.personal.name = 'Local'; local.education[0].school = '大学';
  const remote = structuredClone(base); remote.personal.name = 'Parsed';
  assert.deepEqual(rebase(base, local, remote, ['personal.name']), { personal: { name: 'Parsed', phone: '13800138000' }, education: [{ id: 'a', school: '大学' }] });
  assert.equal(rebase(base, local, base, ['personal.name']).personal.name, '');
});
test('并发经历结构变化不按旧索引串段，保留其他区域的本地输入', () => {
  const base = { personal: { phone: '' }, education: [{ id: 'a', school: '' }] };
  const local = structuredClone(base); local.education = [{ id: 'b', school: 'Local' }]; local.personal.phone = '13800138000';
  const remote = structuredClone(base); remote.education[0].school = 'Parsed';
  assert.deepEqual(rebase(base, local, remote), { personal: { phone: '13800138000' }, education: [{ id: 'a', school: 'Parsed' }] });
});
