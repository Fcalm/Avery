import { existsSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const asar = require('@electron/asar');
const root = join(import.meta.dirname, '..');
const releaseDirectory = process.env.OFFERGET_RELEASE_DIRECTORY || 'release';
const release = resolve(root, releaseDirectory);
if (relative(root, release).startsWith('..')) throw new Error('Release directory must stay inside the repository.');
const unpacked = join(release, 'win-unpacked');
const archive = join(unpacked, 'resources', 'app.asar');
if (!existsSync(archive)) throw new Error('Packaged app.asar is unavailable.');
const files = asar.listPackage(archive).map((name) => name.replace(/\\/g, '/'));
const forbidden = files.filter((name) => /^\/(Docs|electron\/smoke|output|release)(\/|$)/i.test(name)
  || /\/(\.env(?:\..*)?|offerget\.db|profile\.json|[^/]*\.log)$/i.test(name)
  || /^\/node_modules\/[^/]+\/(docs?|tests?|examples?)(\/|$)/i.test(name)
  || /\.map$/i.test(name));
const nativeModule = join(unpacked, 'resources', 'app.asar.unpacked', 'node_modules', 'better-sqlite3', 'prebuilds', 'win32-x64.node');
const pkg = require('../package.json');
const installer = `OfferGet-Setup-${pkg.version}-x64.exe`;
const required = ['/dist/index.html', '/apps/backend/dist/index.js', '/apps/desktop/dist/main.js', '/electron/preload.cjs', '/migrations/business/manifest.json', '/node_modules/@offerget/contracts/dist/index.js', '/node_modules/@offerget/agent-core/dist/index.js'];
const missing = required.filter((name) => !files.includes(name));
const result = { releaseDirectory, archiveFiles: files.length, forbidden, missing, nativeModule: existsSync(nativeModule), installer: existsSync(join(release, installer)) ? installer : null };
console.log(JSON.stringify(result));
if (forbidden.length || missing.length || !result.nativeModule || !result.installer) process.exit(1);
