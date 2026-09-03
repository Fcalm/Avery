import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const require = createRequire(import.meta.url);
const pkg = require('../package.json');
const installer = process.env.AVERY_INSTALLED_SMOKE_INSTALLER
  ? join(root, process.env.AVERY_INSTALLED_SMOKE_INSTALLER)
  : join(root, 'release', `Avery-Setup-${pkg.version}-x64.exe`);
if (!existsSync(installer)) throw new Error(`Installer is missing: ${installer}`);

const testRoot = mkdtempSync(join(tmpdir(), 'avery-installed-smoke-'));
const installDir = join(testRoot, 'app');
let installed = false;
let launched = false;
let uninstalled = false;
try {
  const install = spawnSync(installer, ['/S', `/D=${installDir}`], { cwd: root, windowsHide: true, stdio: 'pipe', encoding: 'utf8' });
  if (install.error || install.status !== 0) throw new Error(`Silent install failed (${install.status ?? 'spawn'}): ${install.error?.message ?? install.stderr}`);
  const executable = join(installDir, 'Avery.exe');
  installed = existsSync(executable);
  if (!installed) throw new Error('Silent installer exited successfully but Avery.exe is missing.');

  const smoke = spawnSync(process.execPath, [join(root, 'scripts', 'smoke-packaged-app.mjs')], {
    cwd: root,
    env: { ...process.env, AVERY_PACKAGED_EXE: executable },
    windowsHide: true,
    stdio: 'inherit',
  });
  launched = smoke.status === 0;
  if (!launched) throw new Error(`Installed application smoke failed (${smoke.status ?? 'spawn'}).`);

  const uninstallerName = readdirSync(installDir).find((name) => /^Uninstall.*\.exe$/i.test(name));
  if (!uninstallerName) throw new Error('NSIS uninstaller is missing after installation.');
  const uninstall = spawnSync(join(installDir, uninstallerName), ['/S'], { cwd: root, windowsHide: true, stdio: 'pipe', encoding: 'utf8' });
  if (uninstall.error || uninstall.status !== 0) throw new Error(`Silent uninstall failed (${uninstall.status ?? 'spawn'}): ${uninstall.error?.message ?? uninstall.stderr}`);
  uninstalled = true;
} finally {
  try { rmSync(testRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch {}
}

console.log(JSON.stringify({ installed, launched, uninstalled }));
if (!installed || !launched || !uninstalled) process.exit(1);
