const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const candidates = [process.env.CAREER_TSC_PATH, path.resolve(root, 'node_modules/typescript/bin/tsc'), path.resolve(root, '../../node_modules/typescript/bin/tsc'), path.resolve(root, '../../project/node_modules/typescript/bin/tsc')].filter(Boolean);
const compiler = candidates.find(file => fs.existsSync(file));
if (!compiler) { console.error('接口类型契约检查需要 TypeScript 开发工具，请设置 CAREER_TSC_PATH 指向已有的 typescript/bin/tsc。运行平台本身无需 TypeScript。'); process.exitCode = 1; }
else {
  const checked = spawnSync(process.execPath, [compiler, '--project', path.join(root, 'tests/tsconfig.types.json')], { encoding: 'utf8', windowsHide: true });
  process.stdout.write(checked.stdout); process.stderr.write(checked.stderr); process.exitCode = checked.status || 0;
  if (checked.status === 0) console.log('控制端接口 TypeScript 类型契约检查通过。');
}
