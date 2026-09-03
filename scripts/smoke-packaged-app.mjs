import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = join(import.meta.dirname, '..');
const expectedElectron = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).devDependencies.electron;
const executable = process.env.AVERY_PACKAGED_EXE ? resolve(process.env.AVERY_PACKAGED_EXE) : join(root, 'release', 'win-unpacked', 'Avery.exe');
if (!existsSync(executable)) throw new Error(`Packaged executable is missing: ${executable}`);
const ownsUserData = !process.env.AVERY_SMOKE_USER_DATA;
const userData = process.env.AVERY_SMOKE_USER_DATA ? resolve(process.env.AVERY_SMOKE_USER_DATA) : mkdtempSync(join(tmpdir(), 'avery-packaged-smoke-'));
const resultPath = process.env.AVERY_SMOKE_RESULT_PATH ? resolve(process.env.AVERY_SMOKE_RESULT_PATH) : join(userData, 'smoke-result.json');
const child = spawn(executable, [], { cwd: root, env: { ...process.env, AVERY_DESKTOP_SMOKE: '1', AVERY_SMOKE_USER_DATA: userData, AVERY_SMOKE_RESULT_PATH: resultPath }, windowsHide: true, stdio: 'ignore' });
const deadline = Date.now() + 60000;
let exited = false;
let exitCode = null;
child.once('exit', (code) => { exited = true; exitCode = code; });
function ReadResult() {
  if (!existsSync(resultPath)) return null;
  try { return JSON.parse(readFileSync(resultPath, 'utf8')); }
  catch { return null; }
}
let payload = ReadResult();
while ((!payload || !['ready', 'failed'].includes(payload.stage)) && !exited && Date.now() < deadline) {
  await new Promise((resolve) => setTimeout(resolve, 100));
  payload = ReadResult();
}
if (process.platform === 'win32' && child.pid) {
  try { execFileSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); } catch {}
} else child.kill();
if (ownsUserData) try { rmSync(userData, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); } catch {}
const result = { resultWritten: Boolean(payload), stage: payload?.stage ?? null, exited, exitCode, rendererLoaded: payload?.rendererLoaded === true, backendReady: payload?.backendReady === true, rendererAgentIpc: payload?.rendererAgentIpc ?? null, electron: payload?.electron ?? null, startupReadyMs: payload?.startupReadyMs ?? null, backendState: payload?.backendState ?? null, lifecycleError: payload?.lifecycleError ?? null, lifecycleErrorMessage: payload?.lifecycleErrorMessage ?? null, lifecycleStep: payload?.lifecycleStep ?? null, ...(payload?.lifecycle ? { lifecycle: payload.lifecycle } : {}), ...(payload?.installedVisual ? { installedVisual: payload.installedVisual } : {}) };
console.log(JSON.stringify(result));
if (!result.resultWritten || !result.rendererLoaded || !result.backendReady || result.rendererAgentIpc?.agentStatus !== true || result.rendererAgentIpc?.browserRuntimeStatus !== true || result.electron !== expectedElectron || !Number.isFinite(result.startupReadyMs) || result.startupReadyMs > 2000 || (result.installedVisual && !result.installedVisual.passed)) process.exit(1);
