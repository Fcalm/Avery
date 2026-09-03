import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ResolveBusinessMigrationRoot } from '../../../apps/backend/src/migration-paths';

describe('打包态迁移路径解析', () => {
  it('从 workspace 依赖的 dist 位置向上找到应用顶层 migrations', () => {
    const simulatedPackagedModule = join(process.cwd(), 'node_modules', '@avery', 'backend', 'dist');
    expect(ResolveBusinessMigrationRoot(simulatedPackagedModule)).toBe(join(process.cwd(), 'migrations', 'business'));
  });
});
