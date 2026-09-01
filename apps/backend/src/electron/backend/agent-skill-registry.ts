import { createHash, randomUUID } from 'node:crypto';
import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import * as path from 'node:path';
import type { AgentMessage, FrozenSkill, SkillManifest, SkillSnapshot } from '@offerget/agent-sdk';

const { load: ParseYaml } = require('js-yaml') as { load(source: string): unknown };

const MaximumSkillBytes = 64 * 1024;
const MaximumResourceBytes = 64 * 1024;
const MaximumResourcesPerSkill = 16;
const MaximumResourceBytesPerSkill = 512 * 1024;

function RequireText(value: unknown, field: string, maximum = 500): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum) throw new Error(`Skill ${field} is invalid.`);
  return value.trim();
}

function RequireTextArray(value: unknown, field: string, maximumItems: number, maximumText = 240): string[] {
  if (!Array.isArray(value) || value.length > maximumItems) throw new Error(`Skill ${field} is invalid.`);
  return value.map((item) => RequireText(item, field, maximumText));
}

function NormalizeResourcePath(value: string): string {
  const normalized = value.replace(/\\/g, '/');
  if (!normalized || normalized.startsWith('/') || normalized.includes('\0') || normalized.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new Error('Skill resource path is invalid.');
  }
  return normalized;
}

function EscapeXml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function SkillLookupKey(value: string): string {
  return value.trim().toLowerCase().replace(/-/g, '');
}

async function ReadUtf8File(filePath: string, maximumBytes: number): Promise<string> {
  const fileStat = await stat(filePath);
  if (!fileStat.isFile() || fileStat.size > maximumBytes) throw new Error(`Skill file exceeds the ${maximumBytes}-byte limit.`);
  const bytes = await readFile(filePath);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error('Skill file must use valid UTF-8 encoding.');
  }
}

async function ResolveContainedFile(directory: string, relativePath: string): Promise<string> {
  const resolved = await realpath(path.join(directory, ...relativePath.replace(/\\/g, '/').split('/')));
  if (!resolved.startsWith(`${directory}${path.sep}`)) throw new Error(`Skill file ${relativePath} escapes its directory.`);
  return resolved;
}

/** 标准 Skill 以 SKILL.md 为唯一入口；普通草稿或说明目录不会被注册。 */
async function HasSkillEntrypoint(directory: string): Promise<boolean> {
  try {
    await stat(path.join(directory, 'SKILL.md'));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

function ParseSkillFrontmatter(content: string): { name: string; description: string; scenarios: string[] } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content);
  if (!match) throw new Error('Skill SKILL.md must start with valid YAML frontmatter.');
  let value: unknown;
  try { value = ParseYaml(match[1]); } catch (error) {
    throw new Error(`Skill YAML frontmatter is invalid: ${error instanceof Error ? error.message : 'parse failed'}`);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Skill YAML frontmatter must be an object.');
  const source = value as Record<string, unknown>;
  const allowed = new Set(['name', 'description', 'license', 'allowed-tools', 'metadata']);
  const unexpected = Object.keys(source).filter((key) => !allowed.has(key));
  if (unexpected.length) throw new Error(`Skill YAML frontmatter contains unsupported keys: ${unexpected.join(', ')}.`);
  const name = RequireText(source.name, 'name', 64);
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) throw new Error('Skill name must use lowercase hyphen-case.');
  const description = RequireText(source.description, 'description', 1024);
  if (/[<>]/.test(description)) throw new Error('Skill description cannot contain angle brackets.');
  const metadata = source.metadata;
  if (metadata !== undefined && (!metadata || typeof metadata !== 'object' || Array.isArray(metadata))) throw new Error('Skill metadata must be an object.');
  const offerget = (metadata as Record<string, unknown> | undefined)?.offerget;
  if (offerget !== undefined && (!offerget || typeof offerget !== 'object' || Array.isArray(offerget))) throw new Error('Skill metadata.offerget must be an object.');
  const scenarioValue = (offerget as Record<string, unknown> | undefined)?.scenarios ?? ['default'];
  const scenarios = [...new Set(RequireTextArray(scenarioValue, 'metadata.offerget.scenarios', 2, 20))];
  if (!scenarios.length || scenarios.some((scenario) => scenario !== 'default' && scenario !== 'application')) {
    throw new Error('Skill metadata.offerget.scenarios may contain only default and application.');
  }
  return { name, description, scenarios };
}

/** references 下的 UTF-8 文件自动进入冻结资源列表，不再维护第二份资源清单。 */
async function DiscoverReferencePaths(directory: string): Promise<string[]> {
  const referencesPath = path.join(directory, 'references');
  let referencesRoot: string;
  try { referencesRoot = await realpath(referencesPath); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  if (!referencesRoot.startsWith(`${directory}${path.sep}`)) throw new Error('Skill references directory escapes its directory.');
  const resources: string[] = [];
  const pending = [{ absolute: referencesRoot, relative: 'references' }];
  while (pending.length) {
    const current = pending.shift()!;
    const entries = await readdir(current.absolute, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const relative = NormalizeResourcePath(`${current.relative}/${entry.name}`);
      const absolute = path.join(current.absolute, entry.name);
      if (entry.isDirectory()) pending.push({ absolute, relative });
      else if (entry.isFile()) resources.push(relative);
      if (resources.length > MaximumResourcesPerSkill) throw new Error(`Skill references exceed the ${MaximumResourcesPerSkill}-file limit.`);
    }
  }
  return resources;
}

/** 从应用固定目录构建冻结 Skill 快照；所有物理路径都停留在 Backend 内部。 */
export class AgentSkillRegistry {
  private readonly rootPath: string;

  constructor(rootPath = path.resolve(__dirname, '../../../../../skills')) {
    this.rootPath = rootPath;
  }

  private async ReadSkill(directoryPath: string, scenarioId: string): Promise<FrozenSkill | null> {
    const root = await realpath(this.rootPath);
    const directory = await realpath(directoryPath);
    if (!(directory === root || directory.startsWith(`${root}${path.sep}`))) throw new Error('Skill directory escapes the trusted registry.');
    const skillPath = await ResolveContainedFile(directory, 'SKILL.md');
    const content = await ReadUtf8File(skillPath, MaximumSkillBytes);
    const contentHash = createHash('sha256').update(content).digest('hex');
    const frontmatter = ParseSkillFrontmatter(content);
    if (path.basename(directory) !== frontmatter.name) throw new Error('Skill folder name must match the SKILL.md frontmatter name.');
    if (!frontmatter.scenarios.includes(scenarioId)) return null;
    const resourcePaths = await DiscoverReferencePaths(directory);
    const manifest: SkillManifest = {
      id: frontmatter.name,
      name: frontmatter.name,
      version: contentHash.slice(0, 16),
      description: frontmatter.description,
      scenarios: frontmatter.scenarios,
      resources: resourcePaths,
    };
    const resources = [];
    let resourceBytes = 0;
    for (const resourcePath of manifest.resources) {
      const absolutePath = await ResolveContainedFile(directory, resourcePath);
      const resourceContent = await ReadUtf8File(absolutePath, MaximumResourceBytes);
      resourceBytes += new TextEncoder().encode(resourceContent).byteLength;
      if (resourceBytes > MaximumResourceBytesPerSkill) throw new Error(`Skill ${manifest.id} resources exceed the aggregate size limit.`);
      resources.push({ path: resourcePath, content: resourceContent, contentHash: createHash('sha256').update(resourceContent).digest('hex') });
    }
    return { manifest, content, contentHash, resources };
  }

  /** 读取当前注册表并冻结完整正文；后续普通 Run 只能使用此快照。 */
  async BuildSnapshot(sessionId: string, sessionRevision: number, scenarioId: string): Promise<SkillSnapshot> {
    const entries = await readdir(this.rootPath, { withFileTypes: true });
    const skills: FrozenSkill[] = [];
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (!entry.isDirectory()) continue;
      const directory = path.join(this.rootPath, entry.name);
      if (!(await HasSkillEntrypoint(directory))) continue;
      const skill = await this.ReadSkill(directory, scenarioId);
      if (skill) skills.push(skill);
    }
    const ids = new Set<string>();
    for (const skill of skills) {
      const normalized = SkillLookupKey(skill.manifest.id);
      if (ids.has(normalized)) throw new Error(`Duplicate Skill id: ${skill.manifest.id}.`);
      ids.add(normalized);
    }
    const snapshotBody = JSON.stringify(skills);
    return {
      snapshotId: randomUUID(),
      sessionId,
      sessionRevision,
      skills,
      snapshotHash: createHash('sha256').update(snapshotBody).digest('hex'),
    };
  }

  /** 首次发送或快照刷新后的索引消息；正文与资源内容不会进入索引。 */
  CreateIndexMessage(snapshot: SkillSnapshot): AgentMessage {
    const lines = snapshot.skills.flatMap(({ manifest }) => [
      `<skill id="${EscapeXml(manifest.id)}" version="${EscapeXml(manifest.version)}">`,
      `Description: ${EscapeXml(manifest.description)}`,
      '</skill>',
    ]);
    return {
      role: 'user',
      content: `<skill-index>\n${lines.join('\n')}\nThis is the available Skill index. Do not reply to this message; continue with the user task.\n</skill-index>`,
      metadata: {
        source: 'runtime', visibility: 'hidden', kind: 'skill_index',
        snapshotId: snapshot.snapshotId, sessionRevision: snapshot.sessionRevision,
      },
    };
  }

  /** 解析标准 `/<skill-name>`；同时兼容迁移前的无连字符写法，未知 Slash 文本仍作为普通消息。 */
  MatchExplicitCommand(content: string, snapshot: SkillSnapshot): FrozenSkill | null {
    const match = /^\/([A-Za-z0-9]+(?:-[A-Za-z0-9]+)*)(?=\s|$)/.exec(content.trim());
    if (!match) return null;
    const requested = SkillLookupKey(match[1]);
    return snapshot.skills.find((skill) => SkillLookupKey(skill.manifest.id) === requested) ?? null;
  }

  /** 从冻结快照创建正文或资源消息；调用方不能提供任意路径。 */
  Load(snapshot: SkillSnapshot, scenarioId: string, input: { skillId: string; resource?: string }): {
    skillId: string; skillVersion: string; resource?: string; message: AgentMessage;
  } {
    const requested = SkillLookupKey(input.skillId);
    const skill = snapshot.skills.find((entry) => SkillLookupKey(entry.manifest.id) === requested);
    if (!skill) throw new Error(`Skill "${input.skillId}" is not available in this scenario.`);
    if (!skill.manifest.scenarios.includes(scenarioId)) throw new Error(`Skill "${skill.manifest.id}" is not available in this scenario.`);
    if (input.resource) {
      const requested = NormalizeResourcePath(input.resource);
      const resource = skill.resources.find((entry) => entry.path === requested);
      if (!resource) throw new Error(`Skill resource "${requested}" was not found.`);
      return {
        skillId: skill.manifest.id,
        skillVersion: skill.manifest.version,
        resource: resource.path,
        message: {
          role: 'user',
          content: `<loaded-skill-resource skill-id="${EscapeXml(skill.manifest.id)}" version="${EscapeXml(skill.manifest.version)}" path="${EscapeXml(resource.path)}">\n${resource.content}\n</loaded-skill-resource>`,
          metadata: {
            source: 'runtime', visibility: 'hidden', kind: 'loaded_skill_resource',
            skillId: skill.manifest.id, skillVersion: skill.manifest.version, resourcePath: resource.path,
          },
        },
      };
    }
    return {
      skillId: skill.manifest.id,
      skillVersion: skill.manifest.version,
      message: {
        role: 'user',
        content: `<loaded-skill id="${EscapeXml(skill.manifest.id)}" version="${EscapeXml(skill.manifest.version)}">\n${skill.content}\n</loaded-skill>`,
        metadata: {
          source: 'runtime', visibility: 'hidden', kind: 'loaded_skill',
          skillId: skill.manifest.id, skillVersion: skill.manifest.version,
        },
      },
    };
  }
}
