import { GetNow, WriteAudit, AssertRevision } from './helpers';
import { JobToStorage, JobToDisplay, ApplicationStatusDisplay } from './enum-map';
import { ParseJobQuery, type CollectedJob, type JobImportResult, type JobQueryInput, type JobQueryResult } from '@avery/contracts';
import { BuildJobQueryWhere, JobCityMatches, MonthlySalaryMinimum, NormalizeJobFilterValue } from './job-query';

/** 岗位行 → 契约 Job ViewModel；枚举映射为稳定英文值，created_at / deadline 由投影列回填。 */
function ToJobViewModel(row: any): any {
  return JobToDisplay({
    ...JSON.parse(row.payload_json), revision: row.revision, createdAt: row.created_at,
    deadline: row.deadline ?? undefined,
  });
}

/** 岗位库的独立事实源；写入基于应用层 ID 幂等 upsert，删除走逻辑墓碑。 */
export class JobRepository {
  private db: any;
  private queryFunctionsRegistered = false;

  constructor({ db }: { db: any }) {
    this.db = db;
  }

  /**
   * 读取全部未删除岗位，按最近更新倒序。
   * 读取前先清理已到截止时间的岗位，使列表结果与数据库的到期事实保持一致。
   */
  ListAll(now: number = GetNow()): any[] {
    this.DeleteExpired(now);
    return this.db.prepare('SELECT payload_json, revision, created_at, deadline FROM jobs WHERE deleted_at IS NULL ORDER BY updated_at DESC').all()
      .map(ToJobViewModel);
  }

  /** 在业务 Worker 内完成筛选和分页；仅返回当前页，排序始终以 ID 破除同分同时间歧义。 */
  Query(input: JobQueryInput): JobQueryResult {
    const query = ParseJobQuery(input);
    if (!this.queryFunctionsRegistered) {
      this.db.function('avery_job_lower', { deterministic: true }, (value: string) => value.toLowerCase());
      this.db.function('avery_job_monthly_salary', { deterministic: true }, MonthlySalaryMinimum);
      this.db.function('avery_job_filter_value', { deterministic: true }, NormalizeJobFilterValue);
      this.db.function('avery_job_city', { deterministic: true }, JobCityMatches);
      this.queryFunctionsRegistered = true;
    }
    this.DeleteExpired();
    const { sql, values } = BuildJobQueryWhere(query);
    const order = query.sort === 'score' ? 'j.match_score DESC, j.created_at DESC, j.id ASC' : 'j.created_at DESC, j.id ASC';
    // 总数与页内容在同一读事务中产生，避免其他连接的写入使一次响应自相矛盾。
    return this.db.transaction(() => {
      const total = this.db.prepare(`SELECT COUNT(*) AS total FROM jobs j WHERE ${sql}`).get(...values).total as number;
      const pageCount = Math.ceil(total / query.pageSize);
      const page = Math.min(query.page, Math.max(1, pageCount));
      const items = this.db.prepare(`SELECT j.payload_json, j.revision, j.created_at, j.deadline FROM jobs j WHERE ${sql} ORDER BY ${order} LIMIT ? OFFSET ?`)
        .all(...values, query.pageSize, (page - 1) * query.pageSize).map(ToJobViewModel);
      return { items, total, page, pageSize: query.pageSize, pageCount };
    })();
  }

  /** Agent只读取当前页及其投递状态；单岗位详情也复用可见性、到期及逻辑删除条件。 */
  QueryForAgent(input: JobQueryInput): JobQueryResult {
    return this.db.transaction(() => {
      const result = this.Query(input);
      const statuses = this.db.prepare('SELECT DISTINCT status FROM applications WHERE job_id = ?');
      return { ...result, items: result.items.map((job) => ({ ...job,
        applicationStatuses: statuses.all(job.id).map((row: { status: string }) => ApplicationStatusDisplay[row.status] ?? row.status),
      })) };
    })();
  }

  /**
   * 按 ID 读取岗位原始行，不受岗位库可见性影响（含已到期与已删除的墓碑）。
   * 投递跟踪等关联链路必须拿到存储版本与既有字段，否则到期岗位会在无关写入中被当作新岗位
   * 重新插入，从而丢掉截止时间并让已自动删除的岗位重新出现在岗位库。
   */
  FindById(id: string): any | undefined {
    if (typeof id !== 'string' || id.length === 0 || id.length > 200) return undefined;
    const row = this.db.prepare('SELECT payload_json, revision, created_at, deadline FROM jobs WHERE id = ?').get(id);
    return row ? ToJobViewModel(row) : undefined;
  }

  /**
   * 批量采集走独立写入口：墓碑不复活，事实更新不覆盖用户编辑或投递状态。
   * 每条使用嵌套事务隔离坏记录；整个批次由 Worker 串行提交后才报告数量。
   */
  ImportCollectedJobs(batch: CollectedJob[]): JobImportResult {
    if (!Array.isArray(batch) || batch.length > 25) throw new Error('采集写入批次无效。');
    const factKeys = ['company', 'title', 'city', 'salary', 'experience', 'education', 'companySize', 'jobSeekingType', 'channel', 'url', 'jd'] as const;
    return this.db.transaction(() => {
      this.DeleteExpired();
      const items: JobImportResult['items'] = [];
      for (const entry of batch) {
        try {
          const result = this.db.transaction(() => {
            if (!entry.identity || !entry.job?.title || !entry.job.company) throw new Error('来源岗位缺少稳定身份、名称或企业。');
            const existing = this.db.prepare(`SELECT id, payload_json, revision, deleted_at FROM jobs
              WHERE id = ? OR json_extract(payload_json, '$.collectionIdentity') = ?
              OR (? != '' AND channel = ? AND json_extract(payload_json, '$.url') = ?)
              ORDER BY (deleted_at IS NOT NULL) DESC, (id = ?) DESC LIMIT 1`)
              .get(entry.job.id, entry.identity, entry.job.url ?? '', JobToStorage(entry.job).channel, entry.job.url ?? '', entry.job.id);
            if (existing?.deleted_at !== null && existing?.deleted_at !== undefined) {
              return { identity: entry.identity, jobId: existing.id, status: 'deleted' as const };
            }
            const old = existing ? JobToDisplay(JSON.parse(existing.payload_json)) : undefined;
            const next = { ...(old ?? {}), id: existing?.id ?? entry.job.id };
            const facts: Record<string, unknown> = {};
            const edited = new Set<string>(old?.collectionUserEditedFields ?? []);
            for (const key of factKeys) {
              const incoming = entry.job[key];
              if (old && (old.collectionFacts ? key in old.collectionFacts && old[key] !== old.collectionFacts[key] : old[key] !== undefined && old[key] !== '')) edited.add(key);
              // 来源缺失不清空已有事实；旧记录首次采集只补空字段，不猜测用户意图。
              if (incoming === undefined || incoming === '') continue;
              facts[key] = incoming;
              if (!edited.has(key)) next[key] = incoming;
            }
            if (!old) Object.assign(next, { favorite: false, city: next.city ?? '', experience: next.experience ?? '', jd: next.jd ?? '' });
            Object.assign(next, {
              collectionFacts: { ...(old?.collectionFacts ?? {}), ...facts }, collectionIdentity: entry.identity, collectionUserEditedFields: [...edited],
              platform: entry.platform, sourceId: entry.sourceId, originalJobId: entry.originalJobId,
              sourceUrl: entry.sourceUrl, collectedAt: entry.collectedAt,
            });
            this.Upsert(next, existing?.revision);
            return { identity: entry.identity, jobId: next.id, status: existing ? 'existing' as const : 'inserted' as const };
          })();
          items.push(result);
        } catch (error) {
          items.push({ identity: entry.identity, jobId: entry.job?.id ?? '', status: 'failed', error: error instanceof Error ? error.message.slice(0, 300) : '岗位写入失败。' });
        }
      }
      return { items };
    })();
  }

  /**
   * 清理已到截止时间的岗位；写逻辑墓碑而非物理删除，保证被投递引用的岗位快照仍可追溯。
   * deadline 已建部分索引，代价与到期数量成正比，因此可以直接在每个读取路径前调用。
   */
  DeleteExpired(now: number = GetNow()): number {
    const result = this.db.prepare('UPDATE jobs SET deleted_at = ?, updated_at = ? WHERE deleted_at IS NULL AND deadline IS NOT NULL AND deadline <= ?')
      .run(now, now, now);
    if (result.changes > 0) WriteAudit(this.db, 'system', 'cleanup', 'job', null, { expired: result.changes });
    return result.changes;
  }

  /** 创建或编辑岗位；已存在 ID 时校验期望版本、更新并清除逻辑删除标记；写入前将枚举映射为存储中文值。 */
  Upsert(job: any, expectedRevision?: number): any {
    if (!job || typeof job !== 'object') throw new Error('Job is invalid.');
    if (typeof job.id !== 'string' || job.id.length === 0 || job.id.length > 200) throw new Error('Job id is invalid.');
    if (typeof job.title !== 'string' || job.title.length === 0 || job.title.length > 300) throw new Error('Job title is invalid.');
    if (typeof job.channel !== 'string' || job.channel.length === 0 || job.channel.length > 100) throw new Error('Job channel is invalid.');
    // 缺省 deadline 表示长期有效；显式传入时必须是可比较的 UTC 毫秒，非法值直接拒绝而不是回退成长期有效。
    if (job.deadline !== undefined && job.deadline !== null && (typeof job.deadline !== 'number' || !Number.isSafeInteger(job.deadline) || job.deadline <= 0)) {
      throw new Error('Job deadline is invalid.');
    }
    const storageJob = JobToStorage(job);
    const now = GetNow();
    const existing = this.db.prepare('SELECT revision FROM jobs WHERE id = ?').get(job.id);
    if (existing) AssertRevision(existing, expectedRevision, 'job', job.id);
    const nextRevision = existing ? existing.revision + 1 : 1;
    this.db.prepare('INSERT INTO jobs(id, payload_json, is_favorite, channel, match_score, deadline, revision, created_at, updated_at, deleted_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, NULL) ON CONFLICT(id) DO UPDATE SET payload_json = excluded.payload_json, is_favorite = excluded.is_favorite, channel = excluded.channel, match_score = excluded.match_score, deadline = excluded.deadline, revision = excluded.revision, updated_at = excluded.updated_at, deleted_at = NULL')
      .run(job.id, JSON.stringify(storageJob), storageJob.favorite ? 1 : 0, storageJob.channel, storageJob.matchScore ?? null, storageJob.deadline ?? null, nextRevision, now, now);
    WriteAudit(this.db, 'user', 'save', 'job', job.id, {});
    return { id: job.id, revision: nextRevision };
  }

  /** 切换岗位收藏状态；校验期望版本，同步更新 payload 与投影列。 */
  SetFavorite(id: string, favorite: boolean, expectedRevision?: number): any {
    if (typeof id !== 'string' || id.length === 0 || id.length > 200) throw new Error('Job id is invalid.');
    const existing = this.db.prepare('SELECT payload_json, revision FROM jobs WHERE id = ?').get(id);
    if (!existing) throw new Error('Job was not found.');
    AssertRevision(existing, expectedRevision, 'job', id);
    const payload = JSON.parse(existing.payload_json);
    payload.favorite = Boolean(favorite);
    const nextRevision = existing.revision + 1;
    this.db.prepare('UPDATE jobs SET is_favorite = ?, payload_json = ?, revision = ?, updated_at = ? WHERE id = ?').run(favorite ? 1 : 0, JSON.stringify(payload), nextRevision, GetNow(), id);
    WriteAudit(this.db, 'user', favorite ? 'favorite' : 'unfavorite', 'job', id, {});
    return { id, isFavorite: Boolean(favorite), revision: nextRevision };
  }

  /** 批量逻辑删除；更新与逐项审计同事务提交，不移除关联投递记录。 */
  DeleteMany(ids: string[]): { ids: string[] } {
    // 先整体校验再开启事务，避免非法 ID 造成部分删除；墓碑继续参与采集防重。
    if (!Array.isArray(ids) || ids.length === 0 || ids.length > 10000 || ids.some((id) => typeof id !== 'string' || id.length === 0 || id.length > 200)) {
      throw Object.assign(new Error('批量删除岗位参数无效。'), { code: 'VALIDATION_ERROR' });
    }
    return this.db.transaction(() => {
      const now = GetNow();
      const update = this.db.prepare('UPDATE jobs SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL');
      const deleted: string[] = [];
      for (const id of new Set(ids)) {
        if (update.run(now, now, id).changes > 0) {
          deleted.push(id);
          WriteAudit(this.db, 'user', 'delete', 'job', id, { batch: true });
        }
      }
      return { ids: deleted };
    })();
  }

  /** 逻辑删除岗位；被投递引用时保留墓碑以维持投递快照。 */
  Delete(id: string): any {
    if (typeof id !== 'string' || id.length === 0 || id.length > 200) throw new Error('Job id is invalid.');
    this.db.prepare('UPDATE jobs SET deleted_at = ?, updated_at = ? WHERE id = ?').run(GetNow(), GetNow(), id);
    WriteAudit(this.db, 'user', 'delete', 'job', id, {});
    return { id };
  }
}
