import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const BIN = join(ROOT, 'node_modules', 'agent-browser', 'bin', 'agent-browser-win32-x64.exe');
const ACTIVE_PORT = join(
  process.env.LOCALAPPDATA ?? '',
  'Google',
  'Chrome',
  'User Data',
  'DevToolsActivePort',
);
const stamp = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-');
const namespace = `avery-boss-e1-${process.pid}-${Date.now()}`;
const session = 'boss-e1';
const outputDir = join(ROOT, 'artifacts', 'boss-cdp-diagnostics', `${stamp}-agent-browser-connect`);
const events = [];

function record(type, data = {}) {
  events.push({ at: new Date().toISOString(), type, ...data });
}

function parseLastJson(stdout) {
  const lines = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      return JSON.parse(lines[index]);
    } catch {
      // agent-browser may emit status lines before its JSON response.
    }
  }
  throw new Error('agent-browser did not return a JSON response');
}

function sanitizeBossUrl(value) {
  const url = new URL(value);
  const hostname = url.hostname.toLowerCase();
  if (hostname !== 'zhipin.com' && !hostname.endsWith('.zhipin.com')) {
    throw new Error('Refusing to record a non-BOSS URL');
  }
  return `${url.origin}${url.pathname}`;
}

function runAgentBrowser(args, timeoutMs = 60_000) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(BIN, args, {
      cwd: ROOT,
      windowsHide: true,
      env: {
        ...process.env,
        AGENT_BROWSER_DEFAULT_TIMEOUT: '60000',
        AGENT_BROWSER_AUTO_CONNECT_TIMEOUT: '60000',
        NO_COLOR: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      rejectRun(new Error(`agent-browser timed out after ${timeoutMs} ms`));
    }, timeoutMs);

    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.once('error', (error) => {
      clearTimeout(timer);
      rejectRun(error);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        rejectRun(new Error(`agent-browser exited with code ${code}: ${stderr.trim()}`));
        return;
      }
      resolveRun({ stdout, stderr });
    });
  });
}

function extractTabs(payload) {
  if (Array.isArray(payload?.data?.tabs)) return payload.data.tabs;
  if (Array.isArray(payload?.tabs)) return payload.tabs;
  if (Array.isArray(payload?.data)) return payload.data;
  throw new Error('Unexpected tab-list response shape');
}

await mkdir(outputDir, { recursive: true });

let result = 'failed';
let errorMessage;
let bossTarget;

try {
  const [portLine, websocketPath] = (await readFile(ACTIVE_PORT, 'utf8'))
    .trim()
    .split(/\r?\n/);
  if (!/^\d+$/.test(portLine) || !websocketPath?.startsWith('/devtools/browser/')) {
    throw new Error('Chrome DevToolsActivePort is invalid');
  }
  const endpoint = `ws://127.0.0.1:${portLine}${websocketPath}`;
  record('chrome_endpoint_validated', { port: Number(portLine) });

  const common = [
    '--namespace', namespace,
    '--session', session,
    '--cdp', endpoint,
    '--no-auto-dialog',
    '--content-boundaries',
    '--max-output', '50000',
  ];

  const listed = await runAgentBrowser([...common, 'tab', '--json']);
  const tabs = extractTabs(parseLastJson(listed.stdout));
  bossTarget = tabs.find((tab) => {
    try {
      const hostname = new URL(tab.url).hostname.toLowerCase();
      return hostname === 'zhipin.com' || hostname.endsWith('.zhipin.com');
    } catch {
      return false;
    }
  });
  if (!bossTarget) throw new Error('No BOSS tab was found in the attached Chrome');

  const targetId = bossTarget.targetId ?? bossTarget.id ?? bossTarget.tabId;
  if (!targetId) throw new Error('BOSS tab did not expose a stable target id');
  const bossUrl = sanitizeBossUrl(bossTarget.url);
  record('agent_browser_connected', { bossUrl });

  const selected = await runAgentBrowser([...common, '--pin-tab', 'tab', String(targetId), '--json']);
  parseLastJson(selected.stdout);
  record('boss_target_pinned', { bossUrl });

  console.log('E1 connected and pinned the BOSS tab. Observing for 30 seconds...');
  await new Promise((resolveWait) => setTimeout(resolveWait, 30_000));
  record('observation_completed', { durationMs: 30_000 });
  result = 'passed';
} catch (error) {
  errorMessage = error instanceof Error ? error.message : String(error);
  record('diagnostic_failed', { error: errorMessage });
} finally {
  try {
    await runAgentBrowser([
      '--namespace', namespace,
      '--session', session,
      '--idle-timeout', '10s',
      'close',
      '--json',
    ], 20_000);
    record('agent_browser_disconnected');
  } catch (error) {
    record('disconnect_failed', {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  const summary = {
    schemaVersion: 1,
    experiment: 'E1_AGENT_BROWSER_CONNECT_AND_PIN_ONLY',
    result,
    namespace,
    session,
    bossUrl: bossTarget?.url ? sanitizeBossUrl(bossTarget.url) : undefined,
    observationMs: result === 'passed' ? 30_000 : 0,
    prohibitedCommandsInvoked: [],
    error: errorMessage,
    generatedAt: new Date().toISOString(),
  };
  await writeFile(join(outputDir, 'events.jsonl'), `${events.map((event) => JSON.stringify(event)).join('\n')}\n`);
  await writeFile(join(outputDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  console.log(JSON.stringify({ result, outputDir, error: errorMessage }));
}
