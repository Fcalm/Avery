import { join } from 'node:path';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentSkillRegistry } from '../../../apps/backend/src/electron/backend/agent-skill-registry';

describe('AgentSkillRegistry', () => {
  const registry = new AgentSkillRegistry(join(process.cwd(), 'skills'));
  const roots: string[] = [];

  afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

  it('跳过没有 SKILL.md 的普通目录，但不掩盖已注册 Skill 的损坏 frontmatter', async () => {
    const root = await mkdtemp(join(tmpdir(), 'offerget-skill-registry-')); roots.push(root);
    const draft = join(root, 'Draft');
    await mkdir(draft);
    await writeFile(join(draft, 'notes.md'), '# Draft', 'utf8');
    await expect(new AgentSkillRegistry(root).BuildSnapshot('draft-session', 1, 'default')).resolves.toMatchObject({ skills: [] });

    await writeFile(join(draft, 'SKILL.md'), '# Missing frontmatter', 'utf8');
    await expect(new AgentSkillRegistry(root).BuildSnapshot('broken-session', 1, 'default')).rejects.toThrow(/frontmatter/i);

    await writeFile(join(draft, 'SKILL.md'), '---\nname: another-name\ndescription: A valid skill stored under the wrong folder name.\n---\n\n# Another skill\n', 'utf8');
    await expect(new AgentSkillRegistry(root).BuildSnapshot('mismatch-session', 1, 'default')).rejects.toThrow(/folder name/i);
  });

  it('按场景冻结完整 Skill，但索引只披露精简 frontmatter 元数据', async () => {
    const snapshot = await registry.BuildSnapshot('session-1', 1, 'default');
    const index = registry.CreateIndexMessage(snapshot);

    expect(snapshot.skills.map((skill) => skill.manifest.id)).toEqual(['resume-tailoring']);
    expect(snapshot.skills[0].content).toContain('# Resume tailoring');
    expect(index.role).toBe('user');
    expect(index.metadata).toMatchObject({ kind: 'skill_index', sessionRevision: 1 });
    expect(index.content).toContain('resume-tailoring');
    expect(index.content).not.toContain('## 工作流程');
  });

  it('显式指令大小写不敏感，正文与清单资源分别加载', async () => {
    const snapshot = await registry.BuildSnapshot('session-1', 1, 'default');
    const matched = registry.MatchExplicitCommand('/resume-tailoring 请优化简历', snapshot);
    const legacyMatched = registry.MatchExplicitCommand('/ResumeTailoring 请优化简历', snapshot);
    const main = registry.Load(snapshot, 'default', { skillId: 'resume-tailoring' });
    const resource = registry.Load(snapshot, 'default', { skillId: 'resume-tailoring', resource: 'references/review-checklist.md' });

    expect(matched?.manifest.id).toBe('resume-tailoring');
    expect(legacyMatched?.manifest.id).toBe('resume-tailoring');
    expect(main.message.role).toBe('user');
    expect(main.message.metadata).toMatchObject({ kind: 'loaded_skill', skillId: 'resume-tailoring' });
    expect(resource.message.metadata).toMatchObject({ kind: 'loaded_skill_resource', resourcePath: 'references/review-checklist.md' });
    expect(() => registry.Load(snapshot, 'default', { skillId: 'resume-tailoring', resource: '../secret.md' })).toThrow(/invalid/i);
  });

  it('投递场景不披露默认场景 Skill', async () => {
    const snapshot = await registry.BuildSnapshot('session-2', 1, 'application');

    expect(snapshot.skills.map((skill) => skill.manifest.id)).toEqual(['boss-browser-control', 'job-application', 'job-discovery']);
    expect(() => registry.Load(snapshot, 'application', { skillId: 'resume-tailoring' })).toThrow(/not available/i);
  });
});
