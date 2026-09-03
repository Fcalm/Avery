import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MigrateLegacyUserData } from '../../../apps/desktop/src/brand-migration';

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});
describe('Avery 品牌数据迁移', () => {
  it('复制旧用户数据并迁移工作空间数据库和备份清单', async () => {
    const root = await mkdtemp(join(tmpdir(), 'avery-brand-migration-'));
    cleanup.push(root);
    const legacyLower = ['offer', 'get'].join('');
    const legacyProduct = ['Offer', 'Get'].join('');
    const legacyRoot = join(root, legacyLower);
    const legacyWorkspace = join(legacyRoot, `${legacyProduct} Workspace`);
    const legacyDatabase = `${legacyLower}.db`;
    await mkdir(join(legacyWorkspace, 'backups', 'daily-fixture'), { recursive: true });
    await writeFile(join(legacyRoot, 'agent-config.json'), '{"provider":"DeepSeek"}', 'utf8');
    await writeFile(join(legacyWorkspace, legacyDatabase), 'database', 'utf8');
    await writeFile(join(legacyWorkspace, 'backups', 'daily-fixture', legacyDatabase), 'backup', 'utf8');
    await writeFile(join(legacyWorkspace, 'backups', 'daily-fixture', 'manifest.json'), JSON.stringify({ database: legacyDatabase }), 'utf8');

    const currentRoot = join(root, 'avery');
    await MigrateLegacyUserData(currentRoot);

    await expect(readFile(join(currentRoot, 'agent-config.json'), 'utf8')).resolves.toContain('DeepSeek');
    await expect(readFile(join(currentRoot, 'Avery Workspace', 'avery.db'), 'utf8')).resolves.toBe('database');
    await expect(readFile(join(currentRoot, 'Avery Workspace', 'backups', 'daily-fixture', 'avery.db'), 'utf8')).resolves.toBe('backup');
    await expect(readFile(join(currentRoot, 'Avery Workspace', 'backups', 'daily-fixture', 'manifest.json'), 'utf8')).resolves.toContain('avery.db');
  });

  it('重复执行时不覆盖 Avery 已有数据', async () => {
    const root = await mkdtemp(join(tmpdir(), 'avery-brand-migration-'));
    cleanup.push(root);
    const legacyLower = ['offer', 'get'].join('');
    const legacyProduct = ['Offer', 'Get'].join('');
    const legacyWorkspace = join(root, legacyLower, `${legacyProduct} Workspace`);
    const currentWorkspace = join(root, 'avery', 'Avery Workspace');
    await mkdir(legacyWorkspace, { recursive: true });
    await mkdir(currentWorkspace, { recursive: true });
    await writeFile(join(legacyWorkspace, `${legacyLower}.db`), 'legacy', 'utf8');
    await writeFile(join(currentWorkspace, 'avery.db'), 'current', 'utf8');

    await MigrateLegacyUserData(join(root, 'avery'));

    await expect(readFile(join(currentWorkspace, 'avery.db'), 'utf8')).resolves.toBe('current');
  });
});
