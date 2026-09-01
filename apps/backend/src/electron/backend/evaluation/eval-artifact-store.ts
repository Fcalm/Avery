import { mkdir, readFile, realpath, writeFile, appendFile, rm } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';

const SensitiveKey = /^(?:api[_-]?key|x-api-key|authorization|token|cookie|set-cookie)$/i;

/** 先按结构脱敏再序列化，避免 Bearer 正则跨越 JSON 字段并破坏证据。 */
function ScrubArtifactValue(value: unknown, key = ''): unknown {
  if (SensitiveKey.test(key)) return '[REDACTED]';
  if (typeof value === 'string') {
    return value
      .replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]')
      .replace(/\bsk-[A-Za-z0-9_-]+\b/g, '[REDACTED_API_KEY]')
      .replace(/\b[A-Za-z]:\\[^\s"'<>]*/g, '[REDACTED_PATH]');
  }
  if (Array.isArray(value)) return value.map((item) => ScrubArtifactValue(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([field, item]) => [field, ScrubArtifactValue(item, field)]));
  }
  return value;
}

/** Artifact 需要保留完整证据，因此只脱敏、不沿用 Trace 的 20k 展示截断。 */
function ScrubArtifactContent(value: unknown, pretty = false): string {
  return JSON.stringify(ScrubArtifactValue(value), null, pretty ? 2 : undefined);
}

/** 大体积测评证据的追加式文件存储；Renderer 永远只接收逻辑 ID，不接收物理路径。 */
export class EvalArtifactStore {
  readonly root: string;
  readonly dataRoot: string;

  constructor(userDataPath: string) {
    this.dataRoot = resolve(userDataPath, 'evaluation-data');
    this.root = resolve(this.dataRoot, 'runs');
  }

  async Initialize(): Promise<void> { await mkdir(this.root, { recursive: true }); }

  private Path(runId: string, ...segments: string[]): string {
    const valid = [runId, ...segments].every((segment) => /^[A-Za-z0-9._-]{1,200}$/.test(segment));
    if (!valid) throw Object.assign(new Error('Evaluation artifact identifier is invalid.'), { code: 'VALIDATION_ERROR' });
    const target = resolve(this.root, runId, ...segments);
    if (!(target === this.root || target.startsWith(`${this.root}${sep}`))) throw Object.assign(new Error('Evaluation artifact path escapes its root.'), { code: 'PERMISSION_DENIED' });
    return target;
  }

  async WriteJson(runId: string, fileName: string, value: unknown): Promise<void> {
    await this.Initialize();
    const target = this.Path(runId, fileName);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, `${ScrubArtifactContent(value, true)}\n`, 'utf8');
  }

  async WriteCaseJson(runId: string, caseRunId: string, fileName: string, value: unknown): Promise<void> {
    await this.Initialize();
    const target = this.Path(runId, 'cases', caseRunId, fileName);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, `${ScrubArtifactContent(value, true)}\n`, 'utf8');
  }

  async AppendEvent(runId: string, value: unknown): Promise<void> {
    await this.Initialize();
    const target = this.Path(runId, 'events.jsonl');
    await mkdir(dirname(target), { recursive: true });
    const scrubbed = ScrubArtifactContent(value);
    await appendFile(target, `${scrubbed}\n`, 'utf8');
  }

  async AppendCaseEvent(runId: string, caseRunId: string, fileName: string, value: unknown): Promise<void> {
    await this.Initialize();
    const target = this.Path(runId, 'cases', caseRunId, fileName);
    await mkdir(dirname(target), { recursive: true });
    const scrubbed = ScrubArtifactContent(value);
    await appendFile(target, `${scrubbed}\n`, 'utf8');
  }

  async ReadCaseJson<T>(runId: string, caseRunId: string, fileName: string): Promise<T | null> {
    await this.Initialize();
    const target = this.Path(runId, 'cases', caseRunId, fileName);
    try {
      const content = await readFile(target, 'utf8');
      return JSON.parse(content) as T;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  async WriteDataset(projectId: string, version: string, jsonl: string): Promise<string> {
    if (![projectId, version].every((value) => /^[A-Za-z0-9._-]{1,200}$/.test(value))) throw Object.assign(new Error('Evaluation dataset identifier is invalid.'), { code: 'VALIDATION_ERROR' });
    const target = resolve(this.dataRoot, 'datasets', projectId, `${version}.jsonl`);
    if (!target.startsWith(`${this.dataRoot}${sep}`)) throw Object.assign(new Error('Evaluation dataset path escapes its root.'), { code: 'PERMISSION_DENIED' });
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, jsonl, 'utf8');
    return `datasets/${projectId}/${version}.jsonl`;
  }

  async ReadDataset(projectId: string, version: string): Promise<string> {
    if (![projectId, version].every((value) => /^[A-Za-z0-9._-]{1,200}$/.test(value))) throw Object.assign(new Error('Evaluation dataset identifier is invalid.'), { code: 'VALIDATION_ERROR' });
    const target = resolve(this.dataRoot, 'datasets', projectId, `${version}.jsonl`);
    if (!target.startsWith(`${this.dataRoot}${sep}`)) throw Object.assign(new Error('Evaluation dataset path escapes its root.'), { code: 'PERMISSION_DENIED' });
    return readFile(target, 'utf8');
  }

  /** 只删除一个已校验项目的数据集目录；历史 Run 自带完整快照，不依赖该目录。 */
  async DeleteProjectDatasets(projectId: string): Promise<void> {
    if (!/^[A-Za-z0-9._-]{1,200}$/.test(projectId)) throw Object.assign(new Error('Evaluation dataset identifier is invalid.'), { code: 'VALIDATION_ERROR' });
    const datasetsRoot = resolve(this.dataRoot, 'datasets');
    const target = resolve(datasetsRoot, projectId);
    if (target === datasetsRoot || !target.startsWith(`${datasetsRoot}${sep}`)) {
      throw Object.assign(new Error('Evaluation dataset delete path escapes its root.'), { code: 'PERMISSION_DENIED' });
    }
    await rm(target, { recursive: true, force: true });
  }

  /** 测试辅助：证明根目录为已解析的真实目录，不把外部路径作为删除目标。 */
  async ResolveRoot(): Promise<string> {
    await this.Initialize();
    return realpath(this.root);
  }
}
