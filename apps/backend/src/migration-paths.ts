import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/**
 * 从当前模块位置向上寻找顶层 migrations；兼容仓库内 apps/backend/dist 与打包后
 * node_modules/@avery/backend/dist 两种解析位置，且只接受含固定 manifest 的目录。
 */
export function ResolveBusinessMigrationRoot(startDirectory: string): string {
  let current = resolve(startDirectory);
  for (let depth = 0; depth < 8; depth += 1) {
    const candidate = join(current, 'migrations', 'business');
    if (existsSync(join(candidate, 'manifest.json'))) return candidate;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new Error('Business migration manifest is unavailable.');
}
