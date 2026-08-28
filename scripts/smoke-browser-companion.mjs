import { execFile, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const ExecFile = promisify(execFile);
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const platformName = process.platform === 'darwin' ? 'darwin' : process.platform === 'win32' ? 'win32' : 'linux';
const electronExecutable = process.env.OFFERGET_COMPANION_EXECUTABLE || (process.platform === 'win32'
  ? join(projectRoot, 'node_modules', 'electron', 'dist', 'electron.exe')
  : join(projectRoot, 'node_modules', 'electron', 'dist', process.platform === 'darwin' ? 'Electron.app/Contents/MacOS/Electron' : 'electron'));
const companionAppPath = process.env.OFFERGET_COMPANION_APP_PATH ?? projectRoot;
const agentBrowserExecutable = process.env.OFFERGET_AGENT_BROWSER_EXECUTABLE || join(projectRoot, 'node_modules', 'agent-browser', 'bin', `agent-browser-${platformName}-${process.arch}${process.platform === 'win32' ? '.exe' : ''}`);

function Assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function WaitFor(read, timeoutMs, description) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await read();
      if (value) return value;
    } catch (error) { lastError = error; }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error(`${description} timed out${lastError instanceof Error ? `: ${lastError.message}` : ''}.`);
}

async function RunCli(baseArgs, ...command) {
  const { stdout } = await ExecFile(agentBrowserExecutable, [...baseArgs, ...command, '--json'], { cwd: projectRoot, timeout: 30_000, windowsHide: true });
  const line = stdout.trim().split(/\r?\n/).filter(Boolean).at(-1);
  const envelope = JSON.parse(line || '{}');
  if (envelope.success !== true) throw new Error(String(envelope.error || 'agent-browser command failed'));
  return envelope.data;
}

const root = await mkdtemp(join(tmpdir(), 'offerget-browser-companion-smoke-'));
const profilePath = join(root, 'profile');
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
for (const key of Object.keys(env)) if (/^OFFERGET_(DESKTOP_SMOKE|SMOKE_|LIFECYCLE_|INSTALLED_VISUAL_)/i.test(key)) delete env[key];

const server = createServer((_request, response) => {
  response.setHeader('content-type', 'text/html; charset=utf-8');
  response.end('<!doctype html><title>Companion Fixture</title><label>Keyword<input id="keyword" aria-label="Keyword"></label><button id="search" onclick="document.querySelector(\'#result\').textContent=\'result:\'+document.querySelector(\'#keyword\').value">Search</button><p id="result">idle</p>');
});
await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
const address = server.address();
const fixturePort = typeof address === 'object' && address ? address.port : 0;
const child = spawn(electronExecutable, [
  ...(companionAppPath ? [companionAppPath] : []),
  '--offerget-browser-companion',
  `--offerget-browser-profile=${profilePath}`,
  `--offerget-browser-parent-pid=${process.pid}`,
  '--remote-debugging-address=127.0.0.1',
  '--remote-debugging-port=0',
  `--user-data-dir=${profilePath}`,
], { cwd: projectRoot, env, shell: false, windowsHide: false, stdio: ['ignore', 'pipe', 'pipe'] });

let stderr = '';
child.stderr?.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-4_000); });

try {
  const cdpPort = await WaitFor(async () => {
    if (child.exitCode !== null) throw new Error(`companion exited with code ${child.exitCode}: ${stderr}`);
    const port = Number((await readFile(join(profilePath, 'DevToolsActivePort'), 'utf8')).split(/\r?\n/, 1)[0]);
    return Number.isSafeInteger(port) && port > 0 ? port : null;
  }, 15_000, 'DevToolsActivePort');

  const initialTargets = await WaitFor(async () => {
    const response = await fetch(`http://127.0.0.1:${cdpPort}/json/list`);
    const targets = await response.json();
    return Array.isArray(targets) && targets.length >= 2 ? targets : null;
  }, 10_000, 'companion CDP target');
  Assert(initialTargets.length === 2, `expected two isolated companion targets, received ${initialTargets.length}`);
  Assert(initialTargets.every((target) => String(target.url || '').startsWith('http://127.0.0.1:')), 'companion exposed a non-internal initial target');

  const namespace = `offerget-companion-smoke-${process.pid}`;
  const discoveryArgs = ['--namespace', namespace, '--session', 'companion-smoke', '--cdp', String(cdpPort), '--no-auto-dialog', '--content-boundaries', '--max-output', '50000', '--idle-timeout', '10s'];
  const tabs = await RunCli(discoveryArgs, 'tab');
  Assert(Array.isArray(tabs.tabs) && tabs.tabs.length === 2, 'agent-browser did not discover both companion targets');
  const readyTab = tabs.tabs.find((tab) => String(tab.url || '').endsWith('/ready'));
  Assert(readyTab?.tabId, 'agent-browser did not discover the companion page target');
  if (readyTab.active !== true) await RunCli(discoveryArgs, 'tab', readyTab.tabId);
  const baseArgs = [...discoveryArgs, '--pin-tab'];
  await RunCli(baseArgs, 'open', `http://127.0.0.1:${fixturePort}/`);
  const snapshot = await RunCli(baseArgs, 'snapshot', '-i');
  Assert(String(snapshot.snapshot || '').includes('Keyword'), 'snapshot did not read the companion page');
  await RunCli(baseArgs, 'fill', '#keyword', 'isolated-browser');
  await RunCli(baseArgs, 'click', '#search');
  const result = await RunCli(baseArgs, 'get', 'text', '#result');
  Assert(result.text === 'result:isolated-browser', `click result mismatch: ${result.text}`);

  const finalTargets = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json();
  Assert(Array.isArray(finalTargets) && finalTargets.length === 2, 'companion exposed an unexpected target count');
  Assert(!finalTargets.some((target) => String(target.title || '').includes('OfferGet Main')), 'OfferGet main target leaked into companion CDP');
  console.log(JSON.stringify({ passed: true, cdpTargetCount: finalTargets.length, internalShellTarget: true, snapshot: true, fill: true, click: true, mainTargetExposed: false }));
} finally {
  try { child.kill(); } catch { /* 已退出时无需重复终止。 */ }
  await new Promise((resolveClose) => server.close(resolveClose));
  await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}
