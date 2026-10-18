import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { SourceRun } from './source-runner';
import type { NormalizedJob } from './types';

interface MatchEntry { fingerprint: string; accepted: boolean }
interface MatchState {
  schemaVersion: 1;
  scopes: Record<string, { entries: Record<string, MatchEntry>; lastUsedAt: string }>;
  errors: Array<{ sourceId: string; jobId: string; scope: string; message: string; at: string }>;
}

/** 缓存条件匹配而非简历理解分数；岗位事实由 Runner 先落盘，匹配失败不回滚采集。 */
export class AtsCandidateMatcher {
  private state: MatchState = { schemaVersion: 1, scopes: {}, errors: [] };
  private initialized = false;
  private tail: Promise<unknown> = Promise.resolve();
  constructor(private readonly filePath?: string) {}

  async Process(scope: unknown, runs: SourceRun[], match: (job: NormalizedJob) => boolean | Promise<boolean>, signal?: AbortSignal): Promise<{
    jobs: NormalizedJob[]; processed: number; reused: number; errors: MatchState['errors'];
  }> {
    const work = this.tail.then(async () => {
      signal?.throwIfAborted();
      if (!this.initialized) {
        if (this.filePath) {
          try {
            const stored = JSON.parse(await readFile(this.filePath, 'utf8')) as MatchState;
            if (stored.schemaVersion !== 1 || !stored.scopes || !Array.isArray(stored.errors)) throw new Error('Unsupported ATS match store format.');
            this.state = stored;
          } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        }
        this.initialized = true;
      }
      const scopeId = createHash('sha256').update(JSON.stringify(scope)).digest('hex');
      const next: MatchState = structuredClone(this.state);
      const at = new Date().toISOString();
      const partition = next.scopes[scopeId] ?? { entries: {}, lastUsedAt: at };
      partition.lastUsedAt = at;
      next.scopes[scopeId] = partition;
      const jobs = new Map<string, NormalizedJob>();
      const errors: MatchState['errors'] = [];
      let processed = 0;
      let reused = 0;
      // 关闭及 stale 事件清除所有条件分区，防止稍后切换条件推荐过期岗位。
      for (const run of runs) {
        signal?.throwIfAborted();
        for (const change of run.changes) {
          if (change.event === 'CLOSED' || (change.event === 'UPDATED' && !change.rematch)) {
            for (const value of Object.values(next.scopes)) delete value.entries[`${run.sourceId}:${change.id}`];
          }
        }
        for (const job of run.jobs) {
          signal?.throwIfAborted();
          const key = `${run.sourceId}:${job.id}`;
          if (job.status !== 'open') {
            for (const value of Object.values(next.scopes)) delete value.entries[key];
            continue;
          }
          // 同一批次或重复事件只处理一次；不同来源的事实仍保持隔离。
          if (jobs.has(key)) continue;
          const fingerprint = createHash('sha256').update(JSON.stringify([job.rawHash, job.salary, job.education, job.experience, job.jobType])).digest('hex');
          let entry = partition.entries[key];
          if (entry?.fingerprint === fingerprint) reused += 1;
          else {
            processed += 1;
            try {
              entry = { fingerprint, accepted: await match(job) };
              partition.entries[key] = entry;
            } catch (error) {
              signal?.throwIfAborted();
              delete partition.entries[key];
              errors.push({ sourceId: run.sourceId, jobId: job.id, scope: scopeId, message: error instanceof Error ? error.message : String(error), at });
              continue;
            }
          }
          if (entry.accepted) jobs.set(key, job);
        }
      }
      next.errors = [...next.errors, ...errors].slice(-1000);
      signal?.throwIfAborted();
      // 只保留最近 32 组筛选条件，不删除事实库；淘汰后再次查询允许重新匹配。
      next.scopes = Object.fromEntries(Object.entries(next.scopes).sort((a, b) =>
        a[0] === scopeId ? -1 : b[0] === scopeId ? 1 : b[1].lastUsedAt.localeCompare(a[1].lastUsedAt)).slice(0, 32));
      if (this.filePath) {
        await mkdir(dirname(this.filePath), { recursive: true });
        const temporary = `${this.filePath}.${randomUUID()}.tmp`;
        try { await writeFile(temporary, JSON.stringify(next), 'utf8'); await rename(temporary, this.filePath); }
        finally { await unlink(temporary).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; }); }
      }
      this.state = next;
      return { jobs: [...jobs.values()], processed, reused, errors };
    });
    this.tail = work.catch(() => undefined);
    return work;
  }
}
