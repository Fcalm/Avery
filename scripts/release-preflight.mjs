import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const root = join(import.meta.dirname, '..');
const pkg = require('../package.json');
const electronPkg = require('../node_modules/electron/package.json');
const expectedElectron = pkg.devDependencies.electron;
const expectedBuilder = '26.15.3';
const expectedRebuild = '4.2.0';
const builderPkg = require('../node_modules/electron-builder/package.json');
const rebuildPkg = require('../node_modules/@electron/rebuild/package.json');
const errors = [];
if (electronPkg.version !== expectedElectron || pkg.devDependencies.electron !== expectedElectron) errors.push(`Electron must be exactly ${expectedElectron}.`);
if (builderPkg.version !== expectedBuilder || pkg.devDependencies['electron-builder'] !== expectedBuilder) errors.push(`electron-builder must be exactly ${expectedBuilder}.`);
if (rebuildPkg.version !== expectedRebuild || pkg.devDependencies['@electron/rebuild'] !== expectedRebuild) errors.push(`@electron/rebuild must be exactly ${expectedRebuild}.`);
for (const file of ['build/icon.ico', 'build/icon.png', 'electron/preload.cjs']) if (!existsSync(join(root, file))) errors.push(`Missing release input: ${file}`);
const electronPath = require('electron');
if (!existsSync(electronPath)) errors.push('Downloaded Electron executable is unavailable.');
else {
  const version = execFileSync(electronPath, ['--version'], { encoding: 'utf8', env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined } }).trim().replace(/^v/, '');
  if (version !== expectedElectron) errors.push(`Electron executable version is ${version}.`);
}
const forbidden = ['offerget.db', 'profile.json', '.env'];
for (const name of forbidden) if (existsSync(join(root, name))) errors.push(`Workspace/private file must not exist at repository root: ${name}`);
const cacheRoot = join(process.env.LOCALAPPDATA || '', 'electron-builder', 'Cache');
const cacheEntries = existsSync(cacheRoot) ? readdirSync(cacheRoot).filter((name) => statSync(join(cacheRoot, name)).isDirectory()) : [];
const requiredCacheFiles = [
  join(cacheRoot, 'nsis-3.0.4.1', 'nsis-3.0.4.1.7z'),
  join(cacheRoot, 'nsis-resources-3.4.1', 'nsis-resources-3.4.1.7z'),
  join(cacheRoot, '7zip@1.0.0', '7zip-win-x64.tar.gz'),
];
const builderCacheReady = requiredCacheFiles.every((file) => existsSync(file) && statSync(file).size > 100000);
if (process.argv.includes('--require-builder-cache') && !builderCacheReady) errors.push('Electron-builder NSIS cache is incomplete. Run one online builder preparation first.');
console.log(JSON.stringify({ electron: electronPkg.version, electronBuilder: builderPkg.version, electronRebuild: rebuildPkg.version, electronDownloaded: existsSync(electronPath), builderCacheEntries: cacheEntries, builderCacheReady, icon: 'build/icon.ico', errors }));
if (errors.length) process.exit(1);
