import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const root = join(import.meta.dirname, '..');
const currentInstaller = process.env.OFFERGET_LIFECYCLE_CURRENT_INSTALLER
  ? join(root, process.env.OFFERGET_LIFECYCLE_CURRENT_INSTALLER)
  : join(root, 'release', 'OfferGet-Setup-0.1.0-x64.exe');
const fixtureRoot = join(root, 'release', 'fixtures');
const candidateManifestPath = join(fixtureRoot, 'previous-candidate.json');
if (!existsSync(currentInstaller) || !existsSync(candidateManifestPath)) throw new Error('Current or previous candidate installer is missing.');
const candidateManifest = JSON.parse(readFileSync(candidateManifestPath, 'utf8'));
const previousInstaller = join(fixtureRoot, candidateManifest.name);
const previousHash = createHash('sha256').update(readFileSync(previousInstaller)).digest('hex');
if (previousHash !== candidateManifest.sha256 || candidateManifest.version !== '0.0.9') throw new Error('Previous candidate manifest verification failed.');

const testRoot = mkdtempSync(join(tmpdir(), 'offerget-lifecycle-'));
const attachmentPath = join(testRoot, 'lifecycle-attachment.txt');
writeFileSync(attachmentPath, Buffer.alloc(5 * 1024 * 1024, 0x41));

function Install(installer, installDir) {
  const result = spawnSync(installer, ['/S', `/D=${installDir}`], { cwd: root, windowsHide: true, stdio: 'pipe', encoding: 'utf8' });
  if (result.error || result.status !== 0 || !existsSync(join(installDir, 'OfferGet.exe'))) throw new Error(`Silent install failed (${result.status ?? 'spawn'}).`);
}

function Uninstall(installDir) {
  const name = existsSync(installDir) ? readdirSync(installDir).find((entry) => /^Uninstall.*\.exe$/i.test(entry)) : null;
  if (!name) throw new Error('Installed NSIS uninstaller is missing.');
  const result = spawnSync(join(installDir, name), ['/S'], { cwd: root, windowsHide: true, stdio: 'pipe', encoding: 'utf8' });
  if (result.error || result.status !== 0) throw new Error(`Silent uninstall failed (${result.status ?? 'spawn'}).`);
}

function RunCurrent(executable, userData, mode, resultPath) {
  const smoke = spawnSync(process.execPath, [join(root, 'scripts', 'smoke-packaged-app.mjs')], {
    cwd: root,
    env: { ...process.env, OFFERGET_PACKAGED_EXE: executable, OFFERGET_SMOKE_USER_DATA: userData, OFFERGET_SMOKE_RESULT_PATH: resultPath, OFFERGET_LIFECYCLE_MODE: mode, OFFERGET_LIFECYCLE_ATTACHMENT: attachmentPath, OFFERGET_LIFECYCLE_API_KEY: 'lifecycle-smoke-credential' },
    windowsHide: true,
    stdio: 'inherit',
  });
  if (smoke.status !== 0 || !existsSync(resultPath)) throw new Error(`Installed lifecycle ${mode} failed.`);
  const payload = JSON.parse(readFileSync(resultPath, 'utf8'));
  if (payload.stage !== 'ready' || !payload.lifecycle) throw new Error(`Installed lifecycle ${mode} did not reach ready.`);
  return payload.lifecycle;
}

function RunCandidateScript(executable, userData, scriptName, resultPath, extra = {}) {
  const installedResources = join(dirname(executable), 'resources');
  const run = spawnSync(executable, [join(root, 'scripts', scriptName)], {
    cwd: root,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      OFFERGET_INSTALLED_RESOURCES: installedResources,
      OFFERGET_LIFECYCLE_WORKSPACE: join(userData, 'OfferGet Workspace'),
      OFFERGET_LIFECYCLE_USER_DATA: userData,
      OFFERGET_LIFECYCLE_ATTACHMENT: attachmentPath,
      OFFERGET_LIFECYCLE_RESULT: resultPath,
      ...extra,
    },
    windowsHide: true,
    stdio: 'inherit',
  });
  if (run.status !== 0 || !existsSync(resultPath)) throw new Error(`Candidate script ${scriptName} failed.`);
  return JSON.parse(readFileSync(resultPath, 'utf8'));
}

function CompareState(before, after) {
  return {
    counts: JSON.stringify(before.counts) === JSON.stringify(after.counts),
    revision: before.resumeRevision === after.resumeRevision && before.resumeRevisionCount === after.resumeRevisionCount,
    attachment: before.attachmentSha256 === after.attachmentSha256 && after.attachmentPreserved === true,
    profile: before.profileHash === after.profileHash,
  };
}

async function InterruptUpgrade(installer, installDir) {
  const child = spawn(installer, ['/S', `/D=${installDir}`], { cwd: root, windowsHide: true, stdio: 'ignore' });
  await new Promise((resolve) => setTimeout(resolve, 20));
  let killed = false;
  if (child.pid) {
    try { execFileSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); killed = true; } catch {}
  }
  await new Promise((resolve) => setTimeout(resolve, 300));
  return killed;
}

const report = { candidate: candidateManifest, freshInstall: {}, upgrade: {}, uninstallReinstall: {}, abnormal: {} };
try {
  // 新装：真实安装版本初始化工作空间、Provider、档案、简历、岗位、投递、附件、备份与三格式导出。
  const freshRoot = join(testRoot, 'fresh');
  const freshInstallDir = join(freshRoot, 'app');
  const freshUserData = join(freshRoot, 'user-data');
  mkdirSync(freshUserData, { recursive: true });
  Install(currentInstaller, freshInstallDir);
  const freshSeed = RunCurrent(join(freshInstallDir, 'OfferGet.exe'), freshUserData, 'seed', join(freshRoot, 'seed.json'));
  report.freshInstall = {
    healthy: freshSeed.schemaVersion === 6 && freshSeed.integrity === 'ok',
    initialized: freshSeed.counts.resumes === 1 && freshSeed.counts.profiles === 1,
    provider: freshSeed.providerConfigured && freshSeed.credentialEncrypted,
    exports: Object.values(freshSeed.exports).every(Boolean),
    attachment: freshSeed.attachmentPreserved,
  };

  // 普通卸载不得删除 AppData；重装后读取并继续使用原数据。
  Uninstall(freshInstallDir);
  report.uninstallReinstall.preservedAfterUninstall = existsSync(join(freshUserData, 'OfferGet Workspace', 'offerget.db')) && existsSync(join(freshUserData, 'agent-config.json'));
  Install(currentInstaller, freshInstallDir);
  const freshReloaded = RunCurrent(join(freshInstallDir, 'OfferGet.exe'), freshUserData, 'verify', join(freshRoot, 'reloaded.json'));
  report.uninstallReinstall.state = CompareState(freshSeed, freshReloaded);
  report.uninstallReinstall.provider = freshReloaded.providerConfigured && freshReloaded.credentialEncrypted;
  report.uninstallReinstall.exports = Object.values(freshReloaded.exports).every(Boolean);
  Uninstall(freshInstallDir);

  // 真实上一候选：0.0.9 安装后写入 v4 数据，再覆盖安装 0.1.0 并触发 v4→v6。
  const upgradeRoot = join(testRoot, 'upgrade');
  const upgradeInstallDir = join(upgradeRoot, 'app');
  const upgradeUserData = join(upgradeRoot, 'user-data');
  mkdirSync(upgradeUserData, { recursive: true });
  Install(previousInstaller, upgradeInstallDir);
  const candidateExe = join(upgradeInstallDir, 'OfferGet.exe');
  const v4 = RunCandidateScript(candidateExe, upgradeUserData, 'lifecycle-v4-seed.cjs', join(upgradeRoot, 'v4.json'));
  const interrupted = await InterruptUpgrade(currentInstaller, upgradeInstallDir);
  const oldStillUsable = RunCandidateScript(candidateExe, upgradeUserData, 'lifecycle-candidate-probe.cjs', join(upgradeRoot, 'interrupted-probe.json'), { OFFERGET_LIFECYCLE_EXPECTATION: 'open-v4' }).passed;
  report.abnormal.interruptedInstaller = interrupted && oldStillUsable;
  Install(currentInstaller, upgradeInstallDir);
  const upgraded = RunCurrent(join(upgradeInstallDir, 'OfferGet.exe'), upgradeUserData, 'verify', join(upgradeRoot, 'upgraded.json'));
  report.upgrade = {
    sourceSchema: v4.schemaVersion,
    targetSchema: upgraded.schemaVersion,
    state: CompareState(v4, upgraded),
    provider: upgraded.providerConfigured && upgraded.credentialEncrypted,
    exports: Object.values(upgraded.exports).every(Boolean),
    preUpgradeBackup: upgraded.backups >= 2,
  };

  // 降级保护：复制已升级工作空间并注入未来 schema，当前安装版必须只读拒写并提供兼容版本引导所需恢复状态。
  const futureUserData = join(upgradeRoot, 'future-user-data');
  cpSync(upgradeUserData, futureUserData, { recursive: true });
  const currentExe = join(upgradeInstallDir, 'OfferGet.exe');
  RunCandidateScript(currentExe, futureUserData, 'lifecycle-future-schema.cjs', join(upgradeRoot, 'future-schema.json'));
  const futureRecovery = RunCurrent(currentExe, futureUserData, 'recovery', join(upgradeRoot, 'future-recovery.json'));
  report.abnormal.downgradeRejected = futureRecovery.recoveryReadOnly === true && futureRecovery.recoveryCanRestore === true && futureRecovery.recoveryMode === 'recovery';
  Uninstall(upgradeInstallDir);

  const booleans = [
    ...Object.values(report.freshInstall),
    report.uninstallReinstall.preservedAfterUninstall, ...Object.values(report.uninstallReinstall.state), report.uninstallReinstall.provider, report.uninstallReinstall.exports,
    report.upgrade.sourceSchema === 4, report.upgrade.targetSchema === 6, ...Object.values(report.upgrade.state), report.upgrade.provider, report.upgrade.exports, report.upgrade.preUpgradeBackup,
    report.abnormal.interruptedInstaller, report.abnormal.downgradeRejected,
  ];
  report.passed = booleans.every(Boolean);
  const reportRoot = join(dirname(currentInstaller), 'lifecycle');
  mkdirSync(reportRoot, { recursive: true });
  writeFileSync(join(reportRoot, '2.2-lifecycle-report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  writeFileSync(join(reportRoot, '2.2-lifecycle-report.md'), `# V1 2.2 安装生命周期验收\n\n- 上一候选：${candidateManifest.version} / ${candidateManifest.sourceCommit}\n- 新装初始化：${report.freshInstall.initialized ? '通过' : '失败'}\n- Provider 密文配置：${report.freshInstall.provider ? '通过' : '失败'}\n- v4 → v6 数据升级：${Object.values(report.upgrade.state).every(Boolean) ? '通过' : '失败'}\n- 卸载保留与重装恢复：${Object.values(report.uninstallReinstall.state).every(Boolean) ? '通过' : '失败'}\n- 安装中断保持旧版本：${report.abnormal.interruptedInstaller ? '通过' : '失败'}\n- 高 schema 降级拒写：${report.abnormal.downgradeRejected ? '通过' : '失败'}\n- PDF/DOCX/PNG 导出：${report.freshInstall.exports && report.upgrade.exports ? '通过' : '失败'}\n\n结论：${report.passed ? '2.2 自动化生命周期门禁通过。' : '存在失败项，不得进入 2.3。'}\n`, 'utf8');
  console.log(JSON.stringify(report));
  if (!report.passed) process.exitCode = 1;
} finally {
  // NSIS 卸载器会在父进程退出后短暂持有自删除句柄；等待后有界重试，避免把清理竞态误报为业务失败。
  await new Promise((resolve) => setTimeout(resolve, 1000));
  let cleanupError;
  for (let attempt = 0; attempt < 20 && existsSync(testRoot); attempt += 1) {
    try { rmSync(testRoot, { recursive: true, force: true }); cleanupError = undefined; }
    catch (error) { cleanupError = error; await new Promise((resolve) => setTimeout(resolve, 250)); }
  }
  if (existsSync(testRoot)) throw cleanupError || new Error('Lifecycle temporary directory cleanup failed.');
}
