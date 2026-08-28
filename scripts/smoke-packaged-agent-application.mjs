import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = join(import.meta.dirname, '..');
const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const packageRoot = process.env.OFFERGET_PACKAGED_ROOT
  ? resolve(process.env.OFFERGET_PACKAGED_ROOT)
  : join(root, 'release-rebuild', 'win-unpacked');
const executable = process.env.OFFERGET_PACKAGED_EXE
  ? resolve(process.env.OFFERGET_PACKAGED_EXE)
  : join(packageRoot, `${packageJson.build?.productName || packageJson.name}.exe`);
const binaryName = process.platform === 'win32'
  ? `agent-browser-win32-${process.arch}.exe`
  : `agent-browser-${process.platform === 'darwin' ? 'darwin' : 'linux'}-${process.arch}`;
const cli = join(packageRoot, 'resources', 'app.asar.unpacked', 'node_modules', 'agent-browser', 'bin', binaryName);

if (!existsSync(executable)) throw new Error(`Packaged executable is missing: ${executable}`);
if (!existsSync(cli)) throw new Error(`Packaged agent-browser CLI is missing: ${cli}`);

const child = spawn(process.execPath, [join(root, 'scripts', 'smoke-agent-application.mjs')], {
  cwd: root,
  env: {
    ...process.env,
    OFFERGET_AGENT_BROWSER_EXECUTABLE: cli,
    OFFERGET_COMPANION_EXECUTABLE: executable,
    OFFERGET_COMPANION_APP_PATH: '',
  },
  windowsHide: true,
  stdio: ['ignore', 'pipe', 'pipe'],
});

let stdout = '';
let stderr = '';
child.stdout.setEncoding('utf8');
child.stderr.setEncoding('utf8');
child.stdout.on('data', chunk => { stdout += chunk; process.stdout.write(chunk); });
child.stderr.on('data', chunk => { stderr += chunk; process.stderr.write(chunk); });
const exitCode = await new Promise(resolveExit => child.once('exit', code => resolveExit(code)));

const lines = stdout.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
let applicationResult = null;
for (let index = lines.length - 1; index >= 0; index -= 1) {
  try {
    const parsed = JSON.parse(lines[index]);
    if (parsed?.entry === 'AgentHost.Send') { applicationResult = parsed; break; }
  } catch { /* 诊断日志不要求是 JSON。 */ }
}

const result = {
  passed: exitCode === 0 && applicationResult?.passed === true,
  packageRoot,
  productVersion: packageJson.version,
  packagedExecutable: true,
  packagedCli: true,
  packagedCompanion: true,
  agentEntry: applicationResult?.entry ?? null,
  submissionCount: applicationResult?.submissionCount ?? null,
  receipt: applicationResult?.receipt ?? null,
  exitCode,
};
console.log(JSON.stringify(result));
if (!result.passed) {
  if (!stderr.trim()) console.error('Packaged Agent application smoke failed without stderr output.');
  process.exit(1);
}
