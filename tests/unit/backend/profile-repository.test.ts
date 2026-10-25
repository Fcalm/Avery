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
  it('统计快照读取实际原文，但不刷新外部改动检测的哈希基线', async () => {
    const root = await mkdtemp(join(tmpdir(), 'avery-profile-changes-'));
    temporaryRoots.push(root);
    const profilePath = join(root, 'profile.json');
    const original = { id: 'p1', category: '个人信息', title: '信息', content: '旧正文' };
    await writeFile(profilePath, JSON.stringify({ items: [original] }), 'utf8');
    const repository = new ProfileRepository({ profilePath });
    repository.Load([]);
    const beforeHash = repository.GetHash();
    await writeFile(profilePath, JSON.stringify({ items: [{ ...original, content: '外部修改' }] }), 'utf8');
    expect(await repository.ReadSnapshot()).toEqual([expect.objectContaining({ content: '外部修改' })]);
    expect(repository.GetHash()).toBe(beforeHash);
    expect(repository.IsModified()).toBe(true);
    expect(() => repository.Save([original])).toThrow('modified outside');
  });

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
