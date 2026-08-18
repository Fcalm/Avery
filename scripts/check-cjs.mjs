#!/usr/bin/env node
/**
 * CJS 源文件门禁（阶段 6 S6）：
 * 1. TS 组合根目录（apps 与 packages 下各包的 src、根 src/）不允许出现 .cjs/.cts 源文件。
 * 2. electron/ 下 CJS 源文件仅允许「桌面壳 + 领域层」清单（preload 沙箱限制必须 CJS；领域层待后续阶段 TS 化）。
 * 3. 输出允许清单，CI 可执行；发现越界 CJS 以非零退出。
 */
import { readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** 深度遍历收集相对路径下的 .cjs/.cts 文件。 */
function CollectCjs(directory) {
  const found = [];
  const visit = (current) => {
    for (const entry of readdirSync(current)) {
      if (entry === 'node_modules' || entry === 'dist') continue;
      const candidate = join(current, entry);
      const stat = statSync(candidate);
      if (stat.isDirectory()) visit(candidate);
      else if (/\.c(js|ts)$/.test(entry)) found.push(relative(root, candidate).replace(/\\/g, '/'));
    }
  };
  visit(directory);
  return found;
}

/** electron 下 CJS 源文件允许前缀（桌面壳 + 领域层；smoke 与迁移脚本不参与门禁）。 */
const AllowedCjsPrefixes = ['electron/preload.cjs'];

/** 检查一个 CJS 文件是否命中允许清单（精确匹配或前缀匹配）。 */
function IsAllowed(file) {
  return AllowedCjsPrefixes.some((prefix) => file === prefix || file.startsWith(prefix));
}

const tsSourceRoots = ['apps', 'packages', 'src'].map((name) => join(root, name));
const violations = [];
for (const sourceRoot of tsSourceRoots) {
  if (!statSync(sourceRoot, { throwIfNoEntry: false })) continue;
  for (const file of CollectCjs(sourceRoot)) violations.push(`TS 组合根目录不应有 CJS 源文件：${file}`);
}

// Test and release-verification entrypoints are not production Electron sources.
const electronCjs = CollectCjs(join(root, 'electron')).filter((file) => !/^electron\/(?:smoke-|verify-)/.test(file));
for (const file of electronCjs) {
  if (!IsAllowed(file)) violations.push(`electron CJS 源文件不在允许清单：${file}`);
}

if (violations.length) {
  console.error('CJS 源文件门禁失败：');
  for (const line of violations) console.error(`  - ${line}`);
  process.exit(1);
}
console.log(`CJS 门禁通过：TS 组合根目录无 CJS；electron 允许清单 ${electronCjs.length} 个文件。`);
