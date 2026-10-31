import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PersonalBrowserCdpRuntime } from '../apps/backend/dist/electron/backend/personal-browser-cdp-runtime.js';

// P0 固定场景只使用独立 Chrome 数据目录，不读取用户页面和登录状态。
const output = resolve('output/snapshot-eval/p0', new Date().toISOString().replaceAll(':', '-'));
await mkdir(output, { recursive: true });
const baselinePath = process.argv.find((value) => value.startsWith('--baseline-runtime='))?.split('=').slice(1).join('=');
const Runtime = baselinePath ? (await import(pathToFileURL(resolve(baselinePath)).href)).PersonalBrowserCdpRuntime : PersonalBrowserCdpRuntime;
const html = `<!doctype html><html><head><meta charset="utf-8"><title>Snapshot P0</title></head><body>
<h1>快照节点身份验证</h1><input aria-label="学校" value="学校A"><button id="keep">保留按钮</button><button id="replace" onclick="window.replacementClicks=(window.replacementClicks||0)+1">同名按钮</button>
<select aria-label="学历"><option>本科</option><option>硕士</option></select><input type="date" aria-label="毕业日期"><input type="checkbox" aria-label="复核">
</body></html>`;
const server = createServer((_request, response) => { response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); response.end(html); });
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const url = `http://127.0.0.1:${server.address().port}/form`;
const profile = join(output, 'chrome-profile');
const chrome = spawn(process.env.AVERY_CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', [
  `--user-data-dir=${profile}`, '--remote-debugging-port=0', '--no-first-run', '--no-default-browser-check', url,
], { windowsHide: true, stdio: 'ignore' });
// 生产扩展已剥离 CDP 路由字段；直连测试复用相同回执契约。
class FixtureSocket {
  constructor(url) { this.socket = new WebSocket(url); }
  get readyState() { return this.socket.readyState; }
  send(value) { this.socket.send(value); }
  close() { this.socket.close(); }
  addEventListener(name, listener, options) {
    this.socket.addEventListener(name, name === 'message' ? (event) => {
      const value = JSON.parse(event.data);
      delete value.sessionId;
      listener({ data: JSON.stringify(value) });
    } : listener, options);
  }
  removeEventListener(name, listener) { this.socket.removeEventListener(name, listener); }
}
let runtime;
let endpoint;
const evidence = { browser: 'Google Chrome', baseline: Boolean(baselinePath), url, checks: {}, startedAt: new Date().toISOString() };
try {
  const end = Date.now() + 20_000;
  while (Date.now() < end) {
    try {
      const [port, path] = (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).trim().split(/\r?\n/);
      endpoint = `ws://127.0.0.1:${port}${path}`;
      break;
    } catch { await new Promise((done) => setTimeout(done, 100)); }
  }
  assert(endpoint, 'Chrome debugging endpoint must become available');
  runtime = new Runtime({ endpoint, anchorUrl: url, webSocketFactory: (endpoint) => new FixtureSocket(endpoint) });
  await runtime.Run(['open', url]);
  const evaluate = async (source) => (await runtime.Run(['eval', '-b', Buffer.from(source).toString('base64')])).data.result;
  const snapshot = async () => (await runtime.Run(['snapshot'])).data;
  const refFor = (data, name) => Object.entries(data.refs).find(([, element]) => element.name === name)?.[0];
  const first = await snapshot();
  await evaluate(`(() => {const r=document.getElementById('keep').getBoundingClientRect();const cover=document.createElement('div');cover.id='cover';cover.style.cssText='position:fixed;z-index:2147483647;background:white;left:'+r.left+'px;top:'+r.top+'px;width:'+r.width+'px;height:'+r.height+'px';document.body.append(cover);})()`);
  const covered = await snapshot();
  evidence.checks.occludedControlsOmitted = refFor(covered, '保留按钮') === undefined;
  await evaluate(`document.getElementById('cover').remove()`);
  await evaluate(`(() => { const button=document.createElement('button'); button.textContent='前插按钮'; document.body.prepend(button); })()`);
  const second = await snapshot();
  evidence.checks.insertKeepsRefs = ['学校', '保留按钮', '同名按钮'].every((name) => refFor(first, name) === refFor(second, name));
  await evaluate(`document.body.append(document.getElementById('keep'))`);
  const third = await snapshot();
  evidence.checks.reorderKeepsRefs = refFor(second, '保留按钮') === refFor(third, '保留按钮');
  const oldRef = refFor(third, '同名按钮');
  await evaluate(`(() => { const old=document.getElementById('replace'); old.replaceWith(old.cloneNode(true)); })()`);
  let staleCode;
  try { await runtime.Run(['click', `@${oldRef}`]); } catch (error) { staleCode = error.code; }
  evidence.checks.replacementRejectsOldRef = staleCode === 'BROWSER_STALE_PAGE_REF';
  evidence.checks.replacementNotClicked = (await evaluate(`window.replacementClicks || 0`)) === 0;
  const fourth = await snapshot();
  evidence.checks.replacementGetsNewRef = refFor(fourth, '同名按钮') !== oldRef;
  // 同 URL 重新导航后，必须按文档身份重新分配引用。
  const schoolRef = refFor(fourth, '学校');
  await runtime.Run(['open', url]);
  const reloaded = await snapshot();
  evidence.checks.sameUrlReloadGetsNewRef = refFor(reloaded, '学校') !== schoolRef && refFor(reloaded, '学校') !== refFor(first, '学校');
  await runtime.Run(['select', `@${refFor(reloaded, '学历')}`, '硕士']);
  await runtime.Run(['fill', `@${refFor(reloaded, '毕业日期')}`, '2024-06-30']);
  await runtime.Run(['check', `@${refFor(reloaded, '复核')}`]);
  const state = await evaluate(`({degree:document.querySelector('select').value,date:document.querySelector('input[type=date]').value,checked:document.querySelector('input[type=checkbox]').checked})`);
  evidence.checks.relatedActions = state.degree === '硕士' && state.date === '2024-06-30' && state.checked === true;
  await runtime.Run(['screenshot', join(output, 'chrome.png')]);
  evidence.passed = Object.values(evidence.checks).every(Boolean);
} catch (error) {
  evidence.error = { code: error.code, message: error.message };
  evidence.passed = false;
} finally {
  await runtime?.Close().catch(() => {});
  if (endpoint) {
    // 仅关闭此脚本创建的独立浏览器实例。
    await new Promise((done) => {
      const socket = new WebSocket(endpoint);
      socket.addEventListener('open', () => socket.send(JSON.stringify({ id: 1, method: 'Browser.close' })));
      socket.addEventListener('close', done);
      socket.addEventListener('error', done);
      setTimeout(() => { socket.close(); done(); }, 2_000).unref();
    });
  } else chrome.kill();
  await new Promise((done) => server.close(done));
  await writeFile(join(output, 'result.json'), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify({ ...evidence, output }));
}
if (!evidence.passed) process.exitCode = 1;
