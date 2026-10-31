import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { BundledModelDirectory, FindModelDirectoryEntry, NormalizeModelEndpoint, OfficialModelEndpoints, UnknownModelCapabilities } from '@avery/agent-sdk';
import type { ModelCapabilityOverrides, ModelCapabilityValues, ModelConfigurationIdentity, ModelDirectoryEntry, ResolvedModelConfiguration } from '@avery/agent-sdk';
import { GetModelConfigurationSchema, ModelCapabilityOverridesSchema, ModelConfigurationIdentitySchema, SaveModelConfigurationSchema } from '@avery/contracts';

const DirectorySources = ['https://models.dev/api.json', 'https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/core/src/models-dev/snapshot.txt'] as const;
const MaximumDirectoryBytes = 16 * 1024 * 1024;
const RefreshIntervalMs = 24 * 60 * 60_000;
const RecordSchema = ModelConfigurationIdentitySchema.extend({ baseUrl: z.string(), overrides: ModelCapabilityOverridesSchema, revision: z.number().int().positive() }).strict();
const StoreSchema = z.object({ version: z.literal(1), records: z.array(RecordSchema).max(5000) }).strict();
type SavedRecord = z.infer<typeof RecordSchema>;

/** 固定公开目录的投影：只提取事实字段，不执行远端脚本，也不向目录发送供应商凭据。 */
export function ParseModelDirectory(raw: unknown): ModelDirectoryEntry[] {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('模型目录结构无效。');
  const entries: ModelDirectoryEntry[] = [];
  for (const value of Object.values(raw)) {
    if (!value || typeof value !== 'object') continue;
    const provider = value as Record<string, unknown>;
    if (typeof provider.api !== 'string' || !provider.models || typeof provider.models !== 'object') continue;
    let baseUrl: string;
    try { baseUrl = NormalizeModelEndpoint(provider.api); } catch { continue; }
    for (const [model, item] of Object.entries(provider.models)) {
      if (!item || typeof item !== 'object' || !model || model.length > 200) continue;
      const record = item as Record<string, unknown>;
      const limit = record.limit as Record<string, unknown> | undefined;
      const modalities = record.modalities as { input?: unknown } | undefined;
      if (!Number.isSafeInteger(limit?.context) || !Number.isSafeInteger(limit?.output) || Number(limit?.context) <= 0 || Number(limit?.output) <= 0) continue;
      if (!Array.isArray(modalities?.input) || typeof record.reasoning !== 'boolean' || typeof record.tool_call !== 'boolean') continue;
      const input = Array.isArray(modalities?.input) ? modalities.input : [];
      entries.push({ baseUrl, model, values: {
        contextWindow: Math.min(Number(limit!.context), 1_000_000), maxOutput: Math.min(Number(limit!.output), 1_000_000),
        inputImage: input.includes('image'), inputPdf: input.includes('pdf'), thinking: record.reasoning === true, toolCall: record.tool_call === true,
      } });
      if (entries.length >= 50_000) throw new Error('模型目录条目过多。');
    }
  }
  if (!entries.length) throw new Error('模型目录没有可用条目。');
  return entries;
}

/** 后端唯一能力配置源。目录与个人覆盖分别存储；写入先落盘再发布，单模型 revision 防止并发覆盖。 */
export class ModelConfigurationService {
  private readonly records = new Map<string, SavedRecord>();
  private directory: ModelDirectoryEntry[] = [];
  private updatedAt: string | undefined;
  private initialized: Promise<void> | undefined;
  private writes: Promise<unknown> = Promise.resolve();
  private refreshPromise: Promise<void> | undefined;
  private lastRefreshAttempt = 0;
  private readonly controller = new AbortController();
  constructor(private readonly options: {
    userDataPath: string;
    fetch?: typeof fetch;
    readLegacy?: () => Promise<unknown>;
    now?: () => number;
  }) {}

  private Identity(input: ModelConfigurationIdentity): Required<ModelConfigurationIdentity> {
    if (input.provider === '自定义' && !input.baseUrl) throw new Error('自定义模型能力配置必须指定实际接口地址。');
    return { provider: input.provider, model: input.model,
      baseUrl: NormalizeModelEndpoint(input.provider === '自定义' ? input.baseUrl ?? 'https://api.deepseek.com' : OfficialModelEndpoints[input.provider]) };
  }
  private Key(input: ModelConfigurationIdentity): string {
    const identity = this.Identity(input);
    return JSON.stringify([identity.provider, identity.baseUrl, identity.model]);
  }
  private async ReadOptional(name: string): Promise<unknown> {
    try { return JSON.parse(await readFile(join(this.options.userDataPath, name), 'utf8')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  }
  private async WriteAtomic(name: string, value: unknown): Promise<void> {
    await mkdir(this.options.userDataPath, { recursive: true });
    const temporary = join(this.options.userDataPath, `${name}.${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, JSON.stringify(value), 'utf8');
      await rename(temporary, join(this.options.userDataPath, name));
    } finally { await unlink(temporary).catch(() => undefined); }
  }
  Initialize(): Promise<void> {
    if (!this.initialized) this.initialized = this.Load().catch((error) => { this.initialized = undefined; throw error; });
    return this.initialized;
  }
  private async Load(): Promise<void> {
    const saved = await this.ReadOptional('model-configurations.json');
    if (saved !== undefined) {
      for (const row of StoreSchema.parse(saved).records) this.records.set(this.Key(row), row);
    }
    // 目录缓存可重建；损坏时使用随应用发布的快照，绝不覆盖损坏的个人配置。
    try {
      const cache = await this.ReadOptional('model-directory-cache.json') as { updatedAt?: unknown; catalog?: unknown } | undefined;
      if (cache && typeof cache.updatedAt === 'string') { this.directory = ParseModelDirectory(cache.catalog); this.updatedAt = cache.updatedAt; }
    } catch { this.directory = []; }
    if (saved === undefined && this.options.readLegacy) {
      const legacy = await this.options.readLegacy() as { providerConfigs?: Record<string, unknown> } | null;
      const candidates = legacy?.providerConfigs ? Object.values(legacy.providerConfigs) : legacy ? [legacy] : [];
      for (const raw of candidates) {
        if (!raw || typeof raw !== 'object') continue;
        const row = raw as Record<string, unknown>;
        const parsed = ModelConfigurationIdentitySchema.safeParse({ provider: row.provider, model: row.model, ...(row.provider === '自定义' ? { baseUrl: row.baseUrl } : {}) });
        if (!parsed.success) continue;
        const overrides: ModelCapabilityOverrides = {};
        if (row.contextLimitMode === 'custom' && Number.isSafeInteger(row.contextLimit) && Number(row.contextLimit) >= 1024 && Number(row.contextLimit) <= 1_000_000) overrides.contextWindow = Number(row.contextLimit);
        if (row.thinkingEnabled === false && parsed.data.provider !== 'Z.AI') overrides.thinking = false;
        if (Object.keys(overrides).length) { const identity = this.Identity(parsed.data); this.records.set(this.Key(identity), { ...identity, overrides, revision: 1 }); }
      }
      if (this.records.size) await this.WriteAtomic('model-configurations.json', { version: 1, records: [...this.records.values()] });
    }
  }
  /** 只读解析可同步注入 Provider；调用方先等待 Initialize，Run 再复制并冻结解析结果。 */
  Resolve(input: ModelConfigurationIdentity): ResolvedModelConfiguration {
    const identity = this.Identity(input);
    const matched = FindModelDirectoryEntry(this.directory, identity.baseUrl, identity.model)
      ?? FindModelDirectoryEntry(BundledModelDirectory, identity.baseUrl, identity.model);
    const inherited = { ...(matched?.values ?? UnknownModelCapabilities) };
    const record = this.records.get(this.Key(identity));
    const overrides = { ...record?.overrides };
    return { ...identity, values: { ...inherited, ...overrides }, inherited, overrides, source: matched ? 'directory' : 'unknown',
      revision: record?.revision ?? 0, ...(this.updatedAt ? { directoryUpdatedAt: this.updatedAt } : {}), verified: false };
  }
  async Get(input: unknown): Promise<ResolvedModelConfiguration> {
    const parsed = GetModelConfigurationSchema.parse(input);
    await this.Initialize();
    if (parsed.refresh) await this.Refresh(true);
    return this.Resolve(parsed);
  }
  async Save(input: unknown): Promise<ResolvedModelConfiguration> {
    const parsed = SaveModelConfigurationSchema.parse(input);
    if (parsed.provider === 'Z.AI' && parsed.overrides.thinking === false) throw new Error('当前 GLM 接入始终启用思考模式，不能保存关闭覆盖。');
    await this.Initialize();
    const operation = this.writes.catch(() => undefined).then(async () => {
      const identity = this.Identity(parsed);
      const key = this.Key(identity);
      if (!this.records.has(key) && this.records.size >= 5000) throw new Error('模型个人配置数量已达到上限。');
      if ((this.records.get(key)?.revision ?? 0) !== parsed.expectedRevision) throw Object.assign(new Error('模型配置已被其他操作修改，请重新加载后保存。'), { code: 'REVISION_CONFLICT' });
      const record = { ...identity, overrides: parsed.overrides, revision: parsed.expectedRevision + 1 };
      const next = new Map(this.records); next.set(key, record);
      await this.WriteAtomic('model-configurations.json', { version: 1, records: [...next.values()] });
      this.records.set(key, record);
      return this.Resolve(identity);
    });
    this.writes = operation;
    return operation;
  }
  /** 仅请求固定公开数据源；失败保留原目录，背景刷新不阻塞启动与当前 Run。 */
  async Refresh(force = false): Promise<void> {
    await this.Initialize();
    if (this.refreshPromise) return this.refreshPromise;
    const now = (this.options.now ?? Date.now)();
    if (!force && (now - this.lastRefreshAttempt < RefreshIntervalMs || (this.updatedAt && now - Date.parse(this.updatedAt) < RefreshIntervalMs))) return;
    this.lastRefreshAttempt = now;
    this.refreshPromise = (async () => {
      let lastError: unknown;
      for (const source of DirectorySources) {
        try {
          const signal = AbortSignal.any([this.controller.signal, AbortSignal.timeout(8000)]);
          const response = await (this.options.fetch ?? fetch)(source, { signal, redirect: 'error', headers: { 'User-Agent': 'Avery/0.1 model-catalog' } });
          if (!response.ok || !response.body) throw new Error(`模型目录更新失败（${response.status}）。`);
          const reader = response.body.getReader();
          const chunks: Uint8Array[] = []; let bytes = 0;
          try {
            while (true) {
              const next = await reader.read(); if (next.done) break;
              bytes += next.value.byteLength;
              if (bytes > MaximumDirectoryBytes) throw new Error('模型目录超过大小限制。');
              chunks.push(next.value);
            }
          } finally { await reader.cancel().catch(() => undefined); }
          const catalog = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          const directory = ParseModelDirectory(catalog);
          this.controller.signal.throwIfAborted();
          const updatedAt = new Date(now).toISOString();
          await this.WriteAtomic('model-directory-cache.json', { updatedAt, catalog });
          this.directory = directory; this.updatedAt = updatedAt;
          return;
        } catch (error) { lastError = error; if (this.controller.signal.aborted) throw error; }
      }
      throw lastError;
    })().finally(() => { this.refreshPromise = undefined; });
    return this.refreshPromise;
  }
  Close(): void { this.controller.abort(); }
}
