import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const temporaryRoot = await mkdtemp(join(tmpdir(), 'avery-evaluation-ui-'));
const resultPath = join(temporaryRoot, 'result.json');
const visualRoot = resolve(process.env.AVERY_EVALUATION_UI_OUTPUT || join(root, 'artifacts', 'evaluation-ui-smoke', new Date().toISOString().replaceAll(':', '-')));
await mkdir(visualRoot, { recursive: true });
const executable = join(root, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : process.platform === 'darwin' ? 'Electron.app/Contents/MacOS/Electron' : 'electron');
const child = spawn(executable, ['.'], {
  cwd: root, windowsHide: true, stdio: 'ignore',
  env: { ...process.env, AVERY_DESKTOP_SMOKE: '1', AVERY_SMOKE_USER_DATA: temporaryRoot, AVERY_SMOKE_RESULT_PATH: resultPath, AVERY_INSTALLED_VISUAL_OUTPUT: visualRoot },
});
let exited = false; let exitCode = null;
child.once('exit', (code) => { exited = true; exitCode = code; });
const deadline = Date.now() + 90_000;
let payload = null;
while (!exited && Date.now() < deadline) {
  if (existsSync(resultPath)) {
    try { payload = JSON.parse(await readFile(resultPath, 'utf8')); } catch { payload = null; }
    if (payload && ['ready', 'failed'].includes(payload.stage)) break;
  }
  await new Promise((resolveWait) => setTimeout(resolveWait, 100));
}
if (process.platform === 'win32' && child.pid) {
  await new Promise((resolveKill) => {
    const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    killer.once('exit', () => resolveKill()); killer.once('error', () => resolveKill());
  });
} else child.kill();
await rm(temporaryRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => undefined);
const result = { stage: payload?.stage ?? null, exited, exitCode, visualRoot, installedVisual: payload?.installedVisual ?? null, rendererAgentIpc: payload?.rendererAgentIpc ?? null };
console.log(JSON.stringify(result));
if (payload?.stage !== 'ready' || payload?.installedVisual?.passed !== true) process.exitCode = 1;
