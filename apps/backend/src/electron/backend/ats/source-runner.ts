import { createHash, randomUUID } from 'node:crypto';
import { readFile, mkdir, rename, writeFile, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { BeisenCareerAdapter, DetectAts, MokaPublicAdapter } from './adapters';
import { HotjobPublicAdapter } from './hotjob';
import { AtsPublicTransport } from './public-transport';
import { AtsError, type AtsAdapter, type AtsSource, type CollectionContinuation, type NormalizedJob, type PublicTransport, type QuarantinedJob, type SourceResult } from './types';

export type JobChange = { id: string; event: 'NEW' | 'UPDATED' | 'UNCHANGED' | 'CLOSED'; rematch: boolean };
export type SourceRun = SourceResult & { changes: JobChange[] };
type StoredSourceRun = Omit<SourceRun, 'jobs' | 'quarantine' | 'continuation'> & {
  normalizedCount: number; quarantineCount: number;
  fieldQuality?: { present: Record<string, number>; issues: Record<string, number> };
};
interface AtsState {
  schemaVersion: 1;
  sources: Record<string, AtsSource>;
  jobs: Record<string, NormalizedJob>;
  sourceRuns: StoredSourceRun[];
  jobQuarantine: QuarantinedJob[];
  continuations?: Record<string, CollectionContinuation>;
}

export function CreateSource(input: { url: string; company: string; ats?: AtsSource['ats']; maxPages?: AtsSource['maxPages'] }): AtsSource {
  const url = new URL(input.url);
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) {
    throw new AtsError('SOURCE_ACCESS_DENIED', 'Source must be a public HTTPS recruitment URL without credentials.');
  }
  url.hash = '';
  if (!input.company.trim()) throw new AtsError('SOURCE_SCHEMA_CHANGED', 'Company name is required.');
  const id = createHash('sha256').update(url.toString()).digest('hex').slice(0, 24);
  return { id, companyId: id, company: input.company.trim(), url: url.toString(), ats: input.ats, enabled: true, maxPages: input.maxPages };
}

/** 仅非空、成功且完整的事实集合可关闭缺失岗位；筛选结果和增量集合不进入这里。 */
export function ApplySnapshot(previous: NormalizedJob[], result: SourceResult, at: string): { jobs: NormalizedJob[]; changes: JobChange[] } {
  const jobs = new Map(previous.map((job) => [job.id, { ...job }]));
  const changes: JobChange[] = [];
  const seen = new Set<string>();
  for (const job of result.jobs) {
    seen.add(job.id);
    const old = jobs.get(job.id);
    const event = old && old.status !== 'closed' && job.status === 'closed' && result.snapshotStatus === 'complete' && result.health === 'healthy'
      ? 'CLOSED' : !old ? 'NEW' : old.rawHash !== job.rawHash || old.status !== job.status ? 'UPDATED' : 'UNCHANGED';
    jobs.set(job.id, { ...job, firstSeenAt: old?.firstSeenAt ?? at, lastSeenAt: at });
    changes.push({ id: job.id, event, rematch: job.status === 'open' && (event !== 'UNCHANGED' || old?.status === 'closed') });
  }
  const canClose = result.snapshotStatus === 'complete' && result.health === 'healthy' && result.jobs.length > 0 && !result.errors.length && !result.quarantine.length;
  for (const job of jobs.values()) {
    if (job.sourceId !== result.sourceId || seen.has(job.id) || job.status === 'closed') continue;
    if (canClose) {
      job.status = 'closed';
      changes.push({ id: job.id, event: 'CLOSED', rematch: false });
    } else if (job.status !== 'stale' && Date.parse(at) - Date.parse(job.lastSeenAt) >= 30 * 86400_000) {
      job.status = 'stale';
      changes.push({ id: job.id, event: 'UPDATED', rematch: false });
    }
  }
  return { jobs: [...jobs.values()], changes };
}

/** 独立事实存储只记录 ATS 快照，不调用 SaveTrackedJob；写入串行且原子替换。 */
export class AtsFactStore {
  private state: AtsState = { schemaVersion: 1, sources: {}, jobs: {}, sourceRuns: [], jobQuarantine: [] };
  private initialized = false;
  private initialization?: Promise<void>;
  private tail: Promise<unknown> = Promise.resolve();
  constructor(private readonly filePath?: string) {}

  /** 读取前等待已有写入；检查点与事实在同一原子文件内保存，重启不会丢失续跑位置。 */
  async GetContinuation(sourceId: string): Promise<CollectionContinuation | undefined> {
    await this.tail;
    await this.Initialize();
    return structuredClone(this.state.continuations?.[sourceId]);
  }

  private async Initialize(): Promise<void> {
    if (this.initialized) return;
    return this.initialization ??= this.Load();
  }

  private async Load(): Promise<void> {
    if (this.filePath) {
      try {
        const stored = JSON.parse(await readFile(this.filePath, 'utf8')) as AtsState;
        if (stored.schemaVersion !== 1 || !stored.sources || !stored.jobs || !Array.isArray(stored.sourceRuns) || !Array.isArray(stored.jobQuarantine)) throw new Error('Unsupported ATS fact store format.');
        this.state = stored;
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    this.initialized = true;
  }

  async Record(source: AtsSource, result: SourceResult): Promise<SourceRun> {
    const work = this.tail.then(async () => {
      await this.Initialize();
      const existing = Object.values(this.state.jobs);
      const snapshot = ApplySnapshot(existing.filter((job) => job.sourceId === source.id), result, result.finishedAt);
      const run: SourceRun = { ...result, changes: snapshot.changes };
      const { jobs: _jobs, quarantine: _quarantine, continuation: _continuation, ...summary } = run;
      // 保存采集当时的字段计数；不能用最新岗位覆盖历史质量，也不能将旧历史缺失统计误当 0%。
      const fieldQuality = {
        present: Object.fromEntries(['locations', 'description', 'requirements', 'updatedAt'].map((field) => [field,
          run.jobs.filter((job) => { const value = job[field as keyof NormalizedJob]; return Array.isArray(value) ? value.length > 0 : Boolean(value); }).length])),
        issues: {} as Record<string, number>,
      };
      for (const job of run.jobs) for (const [field, reason] of Object.entries(job.fieldIssues ?? {})) {
        const key = `${field}:${reason}`;
        fieldQuality.issues[key] = (fieldQuality.issues[key] ?? 0) + 1;
      }
      const continuations = { ...this.state.continuations };
      if (result.continuation) continuations[source.id] = result.continuation;
      else if (result.snapshotStatus === 'complete' || result.errors.some((error) => !['SOURCE_TIMEOUT', 'SOURCE_NETWORK_ERROR', 'SOURCE_REQUEST_LIMIT'].includes(error.code))) delete continuations[source.id];
      const next: AtsState = {
        schemaVersion: 1,
        continuations,
        sources: { ...this.state.sources, [source.id]: { ...source, ats: result.ats, health: result.health, snapshotStatus: result.snapshotStatus, transport: result.transport,
          lastProbeAt: result.startedAt, lastSuccessAt: result.health === 'healthy' || result.health === 'empty' || (result.health === 'partial' && result.jobs.length > 0) ? result.finishedAt : this.state.sources[source.id]?.lastSuccessAt, lastJobCount: result.jobs.length } },
        jobs: Object.fromEntries([...existing.filter((job) => job.sourceId !== source.id), ...snapshot.jobs].map((job) => [`${job.sourceId}:${job.id}`, job])),
        // 运行历史和隔离原始数据限量保留；岗位事实与来源登记不按此窗口删除。
        sourceRuns: [...this.state.sourceRuns, { ...summary, normalizedCount: run.jobs.length, quarantineCount: run.quarantine.length, fieldQuality }].slice(-1000),
        jobQuarantine: [...this.state.jobQuarantine, ...result.quarantine].slice(-1000),
      };
      if (this.filePath) {
        await mkdir(dirname(this.filePath), { recursive: true });
        const temporary = `${this.filePath}.${randomUUID()}.tmp`;
        try { await writeFile(temporary, JSON.stringify(next), 'utf8'); await rename(temporary, this.filePath); }
        finally { await unlink(temporary).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; }); }
      }
      this.state = next;
      return run;
    });
    this.tail = work.catch(() => undefined);
    return work;
  }
}

export class AtsSourceRunner {
  private readonly adapters: Map<string, AtsAdapter>;
  constructor(private readonly transport: PublicTransport = new AtsPublicTransport(), private readonly store = new AtsFactStore(), adapters: AtsAdapter[] = [new BeisenCareerAdapter(), new MokaPublicAdapter(), new HotjobPublicAdapter()]) {
    this.adapters = new Map(adapters.map((adapter) => [adapter.ats, adapter]));
  }

  async Run(source: AtsSource, parentSignal?: AbortSignal): Promise<SourceRun> {
    const started = Date.now();
    const startedAt = new Date(started).toISOString();
    const signal = AbortSignal.any([AbortSignal.timeout(30_000), ...(parentSignal ? [parentSignal] : [])]);
    let requestCount = 0;
    const transport: PublicTransport = { Request: async (url, input) => {
      if (requestCount >= 30) throw new AtsError('SOURCE_REQUEST_LIMIT', 'Reached the 30-request source segment budget.');
      let observed = false;
      try { return await this.transport.Request(url, { ...input, onRequest: () => {
        observed = true;
        if (requestCount >= 30) throw new AtsError('SOURCE_REQUEST_LIMIT', 'Reached the 30-request source segment budget.');
        requestCount += 1;
      } }); }
      finally { if (!observed && requestCount < 30) requestCount += 1; }
    } };
    let result: SourceResult = { sourceId: source.id, ats: source.ats, health: 'unsupported', snapshotStatus: 'unknown', transport: 'public_portal_json', jobs: [], quarantine: [], errors: [], startedAt, finishedAt: startedAt, durationMs: 0, requestCount: 0, receivedCount: 0 };
    try {
      if (!source.enabled) throw new AtsError('SOURCE_UNSUPPORTED', 'Source is disabled.');
      const ats = await DetectAts(source, transport, signal);
      result.ats = ats;
      const adapter = this.adapters.get(ats);
      if (!adapter) throw new AtsError('SOURCE_UNSUPPORTED', 'ATS adapter is unavailable.');
      const probe = await adapter.probe(source, transport, signal);
      result.transport = probe.transport;
      const collected = await adapter.collect(source, probe, transport, signal, await this.store.GetContinuation(source.id));
      parentSignal?.throwIfAborted();
      if (signal.aborted && !collected.errors.some((error) => error.code === 'SOURCE_TIMEOUT')) signal.throwIfAborted();
      result = { ...result, ...collected, health: collected.jobs.length ? collected.snapshotStatus === 'complete' ? 'healthy' : 'partial' : 'empty' };
      if (!collected.jobs.length) result.errors.push({ code: 'SOURCE_EMPTY', message: 'No standardized jobs returned; existing jobs remain unclosed.' });
    } catch (error) {
      if (parentSignal?.aborted) throw parentSignal.reason;
      const code = signal.aborted ? 'SOURCE_TIMEOUT' : error instanceof AtsError ? error.code : 'SOURCE_NETWORK_ERROR';
      if (error instanceof AtsError && error.detectedPlatform) result.detectedPlatform = error.detectedPlatform;
      const health = code === 'SOURCE_TIMEOUT' ? 'timeout' : ['SOURCE_401', 'SOURCE_403', 'SOURCE_CAPTCHA', 'SOURCE_LOGIN_REQUIRED', 'SOURCE_ACCESS_DENIED'].includes(code) ? 'access_controlled'
        : ['SOURCE_PRIVATE_API', 'SOURCE_UNSUPPORTED', 'SOURCE_MULTIPLE_PORTALS', 'SOURCE_UNKNOWN_PLATFORM', 'SOURCE_ADAPTER_UNAVAILABLE'].includes(code) ? 'unsupported' : ['SOURCE_NETWORK_ERROR', 'SOURCE_REQUEST_LIMIT'].includes(code) ? 'partial' : 'schema_changed';
      result.health = health;
      if (code === 'SOURCE_PRIVATE_API') result.transport = 'unsupported_private_api';
      result.errors.push({ code, message: error instanceof Error ? error.message : String(error) });
    }
    result.finishedAt = new Date().toISOString();
    result.durationMs = Date.now() - started;
    result.requestCount = requestCount;
    return this.store.Record(source, result);
  }

  /** 批次最多五个来源同时运行；一个来源错误不终止其余来源，用户取消除外。 */
  async RunBatch(sources: AtsSource[], signal?: AbortSignal): Promise<SourceRun[]> {
    const results: SourceRun[] = new Array(sources.length);
    let index = 0;
    await Promise.all(Array.from({ length: Math.min(5, sources.length) }, async () => {
      while (index < sources.length) {
        signal?.throwIfAborted();
        const current = index++;
        results[current] = await this.Run(sources[current], signal);
      }
    }));
    return results;
  }
}
