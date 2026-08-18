import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const sourceCommit = execFileSync('git.exe', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
const candidateVersion = '0.0.9';
const temporaryRoot = mkdtempSync(join(tmpdir(), 'ogv9-'));
const candidateCache = join(tmpdir(), 'offerget-candidate-npm-cache');
const project = join(temporaryRoot, 'project');
const fixtureRoot = join(root, 'release', 'fixtures');
mkdirSync(fixtureRoot, { recursive: true });
const ExecCmd = (file, args, cwd) => execFileSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', file, ...args], {
  cwd,
  stdio: 'inherit',
  env: { ...process.env, npm_config_cache: candidateCache },
});

try {
  // Windows tar 对仓库内中文路径的 archive 解包不稳定；本地 clone 能保留完整文件名且不触碰当前工作树。
  execFileSync('git.exe', ['clone', '--no-checkout', '--no-hardlinks', root, project], { cwd: temporaryRoot, stdio: 'inherit' });
  execFileSync('git.exe', ['checkout', '--detach', sourceCommit], { cwd: project, stdio: 'inherit' });
  ExecCmd('npm.cmd', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], project);
  ExecCmd('npm.cmd', ['run', 'build'], project);
  ExecCmd('npm.cmd', ['run', 'rebuild:native'], project);

  mkdirSync(join(project, 'build'), { recursive: true });
  copyFileSync(join(root, 'build', 'icon.ico'), join(project, 'build', 'icon.ico'));
  const pkgPath = join(project, 'package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  pkg.version = candidateVersion;
  pkg.description = 'OfferGet V1 previous candidate lifecycle fixture';
  pkg.author = 'OfferGet';
  pkg.license = 'UNLICENSED';
  pkg.build = {
    appId: 'com.offerget.desktop', productName: 'OfferGet', asar: true,
    asarUnpack: ['node_modules/better-sqlite3/**'], npmRebuild: false,
    directories: { output: 'release' },
    files: [
      'dist/**', 'apps/backend/dist/**', 'apps/backend/package.json', 'packages/*/dist/**', 'packages/*/package.json',
      'electron/**/*.cjs', 'migrations/**', 'package.json',
      '!electron/smoke-*.cjs', '!node_modules/**/{docs,doc,test,tests,example,examples}/**', '!node_modules/**/*.map',
      { from: 'packages', to: 'node_modules/@offerget', filter: ['*/dist/**', '*/package.json'] },
      { from: 'apps/backend', to: 'node_modules/@offerget/backend', filter: ['dist/**', 'package.json'] },
    ],
    win: { icon: 'build/icon.ico', target: ['nsis'] },
    nsis: { oneClick: false, allowToChangeInstallationDirectory: true, deleteAppDataOnUninstall: false, artifactName: 'OfferGet-Setup-${version}-${arch}.${ext}' },
  };
  writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');

  const builder = join(root, 'node_modules', '.bin', 'electron-builder.cmd');
  ExecCmd(builder, ['--projectDir', project, '--win', 'nsis', '--x64', '--publish', 'never'], root);
  const name = `OfferGet-Setup-${candidateVersion}-x64.exe`;
  const source = join(project, 'release', name);
  const target = join(fixtureRoot, name);
  copyFileSync(source, target);
  const bytes = readFileSync(target);
  const manifest = { version: candidateVersion, sourceCommit, electron: '32.3.3', name, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  writeFileSync(join(fixtureRoot, 'previous-candidate.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify(manifest));
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
