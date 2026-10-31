import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { AgentBrowserRuntime } from '../apps/backend/dist/electron/backend/agent-browser-runtime.js';
import { PersonalBrowserCdpRuntime } from '../apps/backend/dist/electron/backend/personal-browser-cdp-runtime.js';
import { CreateToolsModule } from '../packages/agent-modules-defaults/dist/tools.js';

// 仅测试此进程创建的本地表单和独立 Chrome；不读取用户配置、登录状态或招聘站点。
const output = resolve('output/browser-script-eval', new Date().toISOString().replaceAll(':', '-'));
await mkdir(output, { recursive: true });
const html = `<!doctype html><meta charset="utf-8"><title>Avery browser script test</title>
<style>body{font:18px sans-serif;padding:40px;background:#f4f6f8}label{display:block;margin:18px}input{padding:8px;width:320px}</style>
<h1>Avery 浏览器脚本实测</h1>
${['学校', '专业', '项目', '岗位'].map((label, index) => `<label>${label}<input aria-label="${label}" id="f${index}"></label>`).join('')}
<p id="status">等待填写</p>
<script>window.committed={}; document.addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();window.committed[e.target.id]=e.target.value;document.getElementById('status').textContent='已确认 '+Object.keys(window.committed).length+' 个字段';}});</script>`;
const server = createServer((_request, response) => { response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); response.end(html); });
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const url = `http://127.0.0.1:${server.address().port}/form`;
const profile = join(output, 'chrome-profile');
const chromePath = process.env.AVERY_CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const chrome = spawn(chromePath, [`--user-data-dir=${profile}`, '--headless=new', '--remote-debugging-port=0', '--no-first-run', '--no-default-browser-check', '--window-size=1100,850', url], { windowsHide: true, stdio: 'ignore' });
// 直连测试仅移除 CDP 路由字段，页面执行、引用检查和宿主工具管道均使用生产实现。
class FixtureSocket {
  constructor(url) { this.socket = new WebSocket(url); }
  get readyState() { return this.socket.readyState; }
  send(value) { this.socket.send(value); }
  close() { this.socket.close(); }
  addEventListener(name, listener, options) {
    this.socket.addEventListener(name, name === 'message' ? (event) => { const value = JSON.parse(event.data); delete value.sessionId; listener({ data: JSON.stringify(value) }); } : listener, options);
  }
  removeEventListener(name, listener) { this.socket.removeEventListener(name, listener); }
}
let endpoint, driver, runtime;
const evidence = { url, browser: 'isolated Google Chrome', extensionTransportTested: false, checks: {}, measurements: {}, output };
try {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      const [port, path] = (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).trim().split(/\r?\n/);
      endpoint = `ws://127.0.0.1:${port}${path}`; break;
    } catch { await new Promise((done) => setTimeout(done, 100)); }
  }
  assert.ok(endpoint, 'isolated Chrome must become available');
  driver = new PersonalBrowserCdpRuntime({ endpoint, anchorUrl: url, webSocketFactory: (endpoint) => new FixtureSocket(endpoint) });
  const bridge = {
    Start: async () => {}, EnsureConnected: async () => {}, IsConnected: () => true, Status: () => ({ connected: true, state: 'online', port: 0 }),
    Close: async () => {}, CloseTask: async () => ({ status: 'confirmed', closedTabs: 1, unknownTabs: 0 }),
  };
  runtime = new AgentBrowserRuntime({ runtimeRoot: join(output, 'runtime'), resolveUploadFile: async () => null, browserExtensionBridge: bridge,
    externalBrowserPaths: { chrome: chromePath }, createExtensionRuntime: () => driver });
  const events = [], ledger = new Map(), inContext = new Set();
  const tools = CreateToolsModule({ getConfig: async () => null, getStoredSettings: async () => ({}), saveConfig: async () => {}, observabilityStore: null });
  const context = {
    sessionId: 'script-smoke', requestId: 'script-smoke', runId: 'script-smoke', scenarioId: 'application', confirmationMode: 'fully_trusted',
    attachments: [], profileSnapshot: [], boundResume: null, bindResume() {}, resumeEditing: false, projectRoot: null,
    ports: { browser: runtime }, tasks: new Map(), pendingEdits: new Map(), pendingQuestions: new Map(), pendingBrowserActions: new Map(),
    allowedToolNames: new Set(tools.GetToolDefinitions('application').map((tool) => tool.definition.function.name)),
    emit: (event) => events.push(event), persistSessionState() {}, hasToolResultInContext: (id) => inContext.has(id),
    ledger: {
      Start: async (entry) => ledger.set(entry.ledgerId, { ...entry, status: 'started' }),
      Finish: async (id, status, extra) => ledger.set(id, { ...ledger.get(id), ...extra, status }),
      FindByIdempotencyKey: async (key) => [...ledger.values()].find((item) => item.idempotencyKey === key && item.status === 'succeeded'),
    },
  };
  let index = 0;
  const execute = async (name, args) => {
    const id = `live-${++index}`;
    const result = await tools.ExecuteToolCall({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }, context);
    inContext.add(id);
    return { ...result, payload: JSON.parse(result.content) };
  };
  const action = async (name, args) => { const result = await execute(name, args); assert.equal(result.payload.ok, true, JSON.stringify(result.payload)); return result.payload.data; };
  const inspect = async (expression) => (await driver.Run(['eval', '-b', Buffer.from(expression).toString('base64')])).data.result;
  const expected = ['测试大学', '计算机专业', '浏览器项目', 'Agent工程师'];
  const refs = (snapshot) => ['学校', '专业', '项目', '岗位'].map((name, i) => ({ ref: `@${Object.entries(snapshot.refs).find(([, ref]) => ref.name === name)[0]}`, text: expected[i] }));

  await action('BrowserNavigate', { url });
  const initial = await action('BrowserSnapshot', {});
  let revision = initial.pageRevision;
  const startBaseline = performance.now();
  for (const field of refs(initial)) {
    const filled = await action('BrowserFill', { ...field, pageRevision: revision });
    assert.ok(filled.filled);
    const entered = await action('BrowserPressKey', { key: 'Enter' });
    assert.equal(entered.referencesPreserved, true);
  }
  await action('BrowserSnapshot', {});
  const baselineState = await inspect(`({values:[...document.querySelectorAll('input')].map(i=>i.value),committed:window.committed})`);
  assert.deepEqual(baselineState.values, expected);
  assert.equal(Object.keys(baselineState.committed).length, 4);
  evidence.measurements.atomic = { agentToolCalls: 9, browserSequenceMs: Math.round(performance.now() - startBaseline) };

  await action('BrowserNavigate', { url });
  const second = await action('BrowserSnapshot', {});
  const script = `for(const field of ${JSON.stringify(refs(second))}) { await page.fill(field.ref,field.text); await page.press('Enter'); } await page.snapshot();`;
  const startScript = performance.now();
  const result = await execute('BrowserRunScript', { script, pageRevision: second.pageRevision });
  assert.equal(result.payload.ok, true, JSON.stringify(result.payload));
  assert.equal(result.payload.steps.length, 9);
  assert.equal(result.payload.observations.length, 1);
  const scriptState = await inspect(`({values:[...document.querySelectorAll('input')].map(i=>i.value),committed:window.committed})`);
  assert.deepEqual(scriptState, baselineState);
  evidence.measurements.script = { agentToolCalls: 1, browserSequenceMs: Math.round(performance.now() - startScript), internalSteps: result.payload.steps.length };
  evidence.checks.realValuesAndEnterCommit = true;
  evidence.checks.sameResultAsAtomic = true;
  evidence.checks.onlyOneFinalObservation = true;
  evidence.checks.visibleStepEvents = events.filter((event) => event.activity?.toolCallId?.startsWith(`live-${index}:browser:`) && event.activity.toolStatus === 'succeeded').length === 9;
  const next = await execute('BrowserSnapshot', {});
  assert.notEqual(next.payload.data.mode, 'full');
  evidence.checks.crossCallDelta = true;
  const currentRevision = next.payload.data.pageRevision;
  const bad = await execute('BrowserRunScript', { script: `await page.fill('@missing','禁止写入'); await page.fill('${refs(second)[0].ref}','不应执行');`, pageRevision: currentRevision });
  assert.equal(bad.payload.ok, false);
  assert.equal(bad.payload.steps.length, 1);
  assert.equal((await inspect(`document.getElementById('f0').value`)), expected[0]);
  evidence.checks.failureStopsRemainingActions = true;
  await driver.Run(['screenshot', join(output, 'form.png')]);
  evidence.passed = Object.values(evidence.checks).every(Boolean);
} catch (error) {
  evidence.passed = false; evidence.error = { code: error.code, message: error.message };
} finally {
  await runtime?.Close().catch(() => {});
  await driver?.Close().catch(() => {});
  if (endpoint) await new Promise((done) => {
    const socket = new WebSocket(endpoint);
    socket.addEventListener('open', () => socket.send(JSON.stringify({ id: 1, method: 'Browser.close' })));
    socket.addEventListener('close', done); socket.addEventListener('error', done);
    setTimeout(() => { socket.close(); done(); }, 2000).unref();
  }); else chrome.kill();
  await new Promise((done) => server.close(done));
  await writeFile(join(output, 'result.json'), JSON.stringify(evidence, null, 2));
}
console.log(JSON.stringify(evidence, null, 2));
if (!evidence.passed) process.exitCode = 1;
