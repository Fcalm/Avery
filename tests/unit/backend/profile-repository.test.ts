import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ProfileRepository } from '../../../apps/backend/src/electron/repositories/profile-repository';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('ProfileRepository', () => {
  it('读取时忽略已删除分类的旧档案', async () => {
    const root = await mkdtemp(join(tmpdir(), 'avery-profile-repository-'));
    temporaryRoots.push(root);
    const profilePath = join(root, 'profile.json');
    await writeFile(profilePath, JSON.stringify({ items: [
      { id: 'legacy', category: '投递档案', title: '旧聚合档案', content: '[个人信息]\n姓名：旧用户' },
      { id: 'current', category: '个人信息', title: '个人信息', content: '[个人信息]\n姓名：新用户' },
    ] }), 'utf8');

    const result = new ProfileRepository({ profilePath }).Load([]);

    expect(result.items).toEqual([expect.objectContaining({ id: 'current', category: 'application' })]);
  });
});
