const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs/promises');
const os = require('node:os');
test('离线服务器提供必要资源，不公开期望答案或工作区文件', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'career-server-test-'));
  const child = spawn(process.execPath, [path.resolve(__dirname, '../serve.cjs')], { env: { ...process.env, PORT: '0', CAREER_DATA_ROOT: root }, windowsHide: true });
  t.after(async () => { const exited = new Promise(resolve => child.once('exit', resolve)); child.kill(); await exited; if (path.dirname(path.resolve(root)) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('career-server-test-')) throw new Error('清理路径不安全'); await fs.rm(root, { recursive: true, force: true }); });
  const base = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('服务未就绪')), 5000);
    child.on('error', error => { clearTimeout(timeout); reject(error); });
    child.stdout.on('data', bytes => { const match = bytes.toString().match(/http:\/\/127\.0\.0\.1:\d+/); if (match) { clearTimeout(timeout); resolve(match[0]); } });
  });
  const page = await fetch(base); assert.equal(page.status, 200); assert.match(await page.text(), /序光科技/);
  assert.equal((await fetch(base + '/engine.js')).headers.get('content-type'), 'text/javascript; charset=utf-8');
  const pdf = await fetch(new URL('attachment', page.url)); assert.equal(pdf.status, 200); assert.ok((await pdf.text()).startsWith('%PDF-'));
  for (const route of ['/fixtures/lin-zhixia-resume.pdf', '/fixtures/expected.json', '/README.md', '/serve.cjs', '/package.json', '/%2e%2e/package.json']) assert.equal((await fetch(base + route)).status, 404, route);
  assert.equal((await fetch(base, { method: 'POST' })).status, 405);
});
