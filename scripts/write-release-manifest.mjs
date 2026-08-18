import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, relative, resolve } from 'node:path';

const require = createRequire(import.meta.url);
const root = join(import.meta.dirname, '..');
const releaseDirectory = process.env.OFFERGET_RELEASE_DIRECTORY || 'release';
const release = resolve(root, releaseDirectory);
if (relative(root, release).startsWith('..')) throw new Error('Release directory must stay inside the repository.');
const pkg = require('../package.json');
const electron = require('../node_modules/electron/package.json').version;
const names = readdirSync(release).filter((name) => /^OfferGet-Setup-.*-x64\.exe$/.test(name) || name === 'win-unpacked');
const artifacts = [];
for (const name of names) {
  const file = name === 'win-unpacked' ? join(release, name, 'OfferGet.exe') : join(release, name);
  if (!statSync(file).isFile()) continue;
  const bytes = readFileSync(file);
  artifacts.push({ name: name === 'win-unpacked' ? 'win-unpacked/OfferGet.exe' : name, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
}
const manifest = { product: 'OfferGet', version: pkg.version, electron, architecture: 'x64', codeSigning: 'unsigned', generatedAt: new Date().toISOString(), artifacts };
writeFileSync(join(release, 'release-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
writeFileSync(join(release, 'BUILD-SUMMARY.md'), `# OfferGet Windows 构建摘要\n\n- 版本：${pkg.version}\n- Electron：${electron}\n- 架构：x64\n- 代码签名：未签名（V1 内部验收包）\n- 生成时间：${manifest.generatedAt}\n- 门禁：release preflight → CJS gate → build → Electron ABI rebuild → smoke:all → NSIS → packaged app smoke → silent install/launch/uninstall smoke → package contents\n\n${artifacts.map((item) => `- \`${item.name}\`：${item.bytes} bytes，SHA-256 \`${item.sha256}\``).join('\n')}\n`, 'utf8');
console.log(JSON.stringify(manifest));
