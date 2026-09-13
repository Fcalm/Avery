import { GetNow, WriteAudit, AssertRevision } from './helpers';
import { JobToStorage, JobToDisplay } from './enum-map';

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

  /** 逻辑删除岗位；被投递引用时保留墓碑以维持投递快照。 */
  Delete(id: string): any {
    if (typeof id !== 'string' || id.length === 0 || id.length > 200) throw new Error('Job id is invalid.');
    this.db.prepare('UPDATE jobs SET deleted_at = ?, updated_at = ? WHERE id = ?').run(GetNow(), GetNow(), id);
    WriteAudit(this.db, 'user', 'delete', 'job', id, {});
    return { id };
  }
}
