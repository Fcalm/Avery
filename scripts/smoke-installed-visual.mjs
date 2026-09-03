import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';

const root = join(import.meta.dirname, '..');
const installer = process.env.AVERY_INSTALLED_VISUAL_INSTALLER ? join(root, process.env.AVERY_INSTALLED_VISUAL_INSTALLER) : join(root, 'release', 'Avery-Setup-0.1.0-x64.exe');
if (!existsSync(installer)) throw new Error('Installed visual smoke requires the current NSIS installer.');
const temporaryRoot = mkdtempSync(join(tmpdir(), 'avery-installed-visual-'));
const installDirectory = join(temporaryRoot, 'app');
const userData = join(temporaryRoot, 'user-data');
const attachment = join(temporaryRoot, 'visual-large-attachment.txt');
const visualOutputDirectory = process.env.AVERY_INSTALLED_VISUAL_OUTPUT || 'output/playwright/v1-2.3';
const outputDirectory = resolve(root, visualOutputDirectory);
if (relative(root, outputDirectory).startsWith('..')) throw new Error('Installed visual output must stay inside the repository.');
mkdirSync(outputDirectory, { recursive: true });
writeFileSync(attachment, Buffer.alloc(5 * 1024 * 1024, 0x41));

function RunSmoke(resultName, extra) {
  const resultPath = join(temporaryRoot, resultName);
  const result = spawnSync(process.execPath, [join(root, 'scripts', 'smoke-packaged-app.mjs')], {
    cwd: root,
    env: { ...process.env, AVERY_PACKAGED_EXE: join(installDirectory, 'Avery.exe'), AVERY_SMOKE_USER_DATA: userData, AVERY_SMOKE_RESULT_PATH: resultPath, ...extra },
    windowsHide: true,
    encoding: 'utf8',
  });
  if (result.status !== 0 || !existsSync(resultPath)) throw new Error(`Installed visual subprocess failed: ${result.stderr || result.stdout}`);
  return JSON.parse(readFileSync(resultPath, 'utf8'));
}

try {
  const installation = spawnSync(installer, ['/S', `/D=${installDirectory}`], { cwd: root, windowsHide: true, encoding: 'utf8' });
  if (installation.status !== 0 || !existsSync(join(installDirectory, 'Avery.exe'))) throw new Error('Installed visual setup failed.');
  const seed = RunSmoke('seed.json', { AVERY_LIFECYCLE_MODE: 'seed', AVERY_LIFECYCLE_ATTACHMENT: attachment, AVERY_LIFECYCLE_API_KEY: 'visual-smoke-credential' });
  writeFileSync(join(outputDirectory, '2.3-installed-seed-report.json'), JSON.stringify(seed, null, 2), 'utf8');
  const visual = RunSmoke('visual.json', { AVERY_INSTALLED_VISUAL_OUTPUT: outputDirectory });
  const report = { electron: visual.electron, startupReadyMs: visual.startupReadyMs, seedPerformance: seed.lifecycle?.performance, installedVisual: visual.installedVisual, passed: visual.installedVisual?.passed === true && visual.startupReadyMs <= 2000 };
  writeFileSync(join(outputDirectory, '2.3-installed-report.json'), JSON.stringify(report, null, 2), 'utf8');
  console.log(JSON.stringify(report));
  if (!report.passed) process.exitCode = 1;
} finally {
  const uninstaller = existsSync(installDirectory) ? readdirSync(installDirectory).find((name) => /^Uninstall.*\.exe$/i.test(name)) : null;
  if (uninstaller) try { execFileSync(join(installDirectory, uninstaller), ['/S'], { windowsHide: true, stdio: 'ignore' }); } catch {}
  try { rmSync(temporaryRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch {}
}
