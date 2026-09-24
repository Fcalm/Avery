import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const asar = require('@electron/asar');
const root = join(import.meta.dirname, '..');
const releaseDirectory = process.env.AVERY_RELEASE_DIRECTORY || 'release';
const release = resolve(root, releaseDirectory);
const unpacked = join(release, 'win-unpacked');
const archive = join(unpacked, 'resources', 'app.asar');
if (!existsSync(archive)) throw new Error('Packaged app.asar is unavailable.');
const files = asar.listPackage(archive).map((name) => name.replace(/\\/g, '/'));
const forbidden = files.filter((name) => /^\/(Docs|electron\/smoke|output|release)(\/|$)/i.test(name)
  || /^\/node_modules\/agent-browser(\/|$)/i.test(name)
  || /^\/apps\/desktop\/(src|dist)\/browser-companion\.(ts|js)$/i.test(name)
  || /^\/node_modules\/@avery\/desktop\/dist\/browser-companion\.js$/i.test(name)
  || /\/(\.env(?:\..*)?|avery\.db|profile\.json|[^/]*\.log)$/i.test(name)
  || /^\/node_modules\/[^/]+\/(docs?|tests?|examples?)(\/|$)/i.test(name)
  || /\.map$/i.test(name));
const nativeModule = join(unpacked, 'resources', 'app.asar.unpacked', 'node_modules', 'better-sqlite3', 'prebuilds', 'win32-x64.node');
const oldBrowserBinary = join(unpacked, 'resources', 'app.asar.unpacked', 'node_modules', 'agent-browser');
const extensionRoot = join(unpacked, 'resources', 'browser-extension');
const extensionManifestPath = join(extensionRoot, 'manifest.json');
const extensionManifest = existsSync(extensionManifestPath) ? JSON.parse(readFileSync(extensionManifestPath, 'utf8')) : null;
const extensionReady = extensionManifest?.manifest_version === 3
  && typeof extensionManifest.version === 'string'
  && existsSync(join(extensionRoot, extensionManifest.background?.service_worker ?? 'missing-worker'))
  && existsSync(join(extensionRoot, 'pair.js'));
const pkg = require('../package.json');
const installer = `Avery-Setup-${pkg.version}-x64.exe`;
const required = ['/dist/index.html', '/apps/backend/dist/index.js', '/apps/desktop/dist/main.js', '/electron/preload.cjs', '/migrations/business/manifest.json', '/node_modules/@avery/contracts/dist/index.js', '/node_modules/@avery/agent-core/dist/index.js'];
const missing = required.filter((name) => !files.includes(name));
const result = { releaseDirectory, archiveFiles: files.length, forbidden, missing, nativeModule: existsSync(nativeModule), oldBrowserBinary: existsSync(oldBrowserBinary), extensionReady, extensionVersion: extensionManifest?.version ?? null, installer: existsSync(join(release, installer)) ? installer : null };
console.log(JSON.stringify(result));
if (forbidden.length || missing.length || !result.nativeModule || result.oldBrowserBinary || !result.extensionReady || !result.installer) process.exit(1);
