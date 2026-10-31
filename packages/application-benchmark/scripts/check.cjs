const fs = require('node:fs/promises');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
(async () => {
  const root = path.resolve(__dirname, '..');
  const entries = await fs.readdir(root, { recursive: true, withFileTypes: true });
  const scripts = entries.filter(entry => entry.isFile() && /\.(?:cjs|js)$/.test(entry.name)).map(entry => path.join(entry.parentPath, entry.name));
  for (const file of scripts) { const checked = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8', windowsHide: true }); if (checked.status !== 0) throw new Error(checked.stderr || '语法检查失败：' + file); }
  console.log(`${scripts.length} 个 JavaScript 文件语法检查通过。`);
})().catch(error => { console.error(error.message); process.exitCode = 1; });
