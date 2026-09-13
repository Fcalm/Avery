import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { JobRepository } from '../../../apps/backend/src/electron/repositories/job-repository';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

/** 建立与 v13 之后一致的最小表结构；只保留本用例断言涉及的列。 */
function CreateDatabase() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE jobs(
      id TEXT PRIMARY KEY, payload_json TEXT NOT NULL, is_favorite INTEGER NOT NULL DEFAULT 0,
      channel TEXT NOT NULL, match_score REAL, deadline INTEGER, revision INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER
    );
    CREATE TABLE audit_events(
      id TEXT PRIMARY KEY, actor_type TEXT NOT NULL, action TEXT NOT NULL, entity_type TEXT NOT NULL,
      entity_id TEXT, metadata_json TEXT, created_at INTEGER NOT NULL
    );
  `);
  return db;
}

function CreateJob(overrides: Record<string, unknown> = {}) {
  return {
    id: 'job-1', company: '示例科技', title: '产品设计师', city: '上海', salary: '25k 到 40k',
    experience: '3 到 5 年', jobSeekingType: 'social_recruitment', channel: 'boss_zhipin',
    favorite: false, jd: '职位描述', ...overrides,
  };
}

describe('岗位截止时间', () => {
  it('截止时间写入投影列并在读取时回填为 deadline 与 createdAt', () => {
    const db = CreateDatabase();
    const repository = new JobRepository({ db });
    const deadline = Date.now() + 86_400_000;

    repository.Upsert(CreateJob({ deadline }));

    expect(db.prepare('SELECT deadline, created_at FROM jobs WHERE id = ?').get('job-1').deadline).toBe(deadline);
    expect(repository.ListAll()).toMatchObject([{ id: 'job-1', deadline, createdAt: expect.any(Number) }]);
    db.close();
  });

  it('读取时清理已到期岗位：列表不再返回，行改为逻辑墓碑并写入系统审计', () => {
    const db = CreateDatabase();
    const repository = new JobRepository({ db });
    const now = Date.now();
    repository.Upsert(CreateJob({ id: 'expired', deadline: now - 1000 }));
    repository.Upsert(CreateJob({ id: 'active', deadline: now + 86_400_000 }));
    repository.Upsert(CreateJob({ id: 'evergreen' }));

    const jobs = repository.ListAll(now);

    // 三次写入可能落在同一毫秒，先后顺序不作断言，只断言到期岗位被排除。
    expect(jobs.map((job: any) => job.id).sort()).toEqual(['active', 'evergreen']);
    expect(db.prepare('SELECT deleted_at FROM jobs WHERE id = ?').get('expired').deleted_at).toBe(now);
    expect(db.prepare("SELECT actor_type, action, entity_type, metadata_json FROM audit_events WHERE action = 'cleanup'").get())
      .toMatchObject({ actor_type: 'system', action: 'cleanup', entity_type: 'job', metadata_json: '{"expired":1}' });
    // 到期岗位的墓碑保留原始行，投递快照仍可追溯。
    expect(db.prepare('SELECT payload_json FROM jobs WHERE id = ?').get('expired').payload_json).toContain('示例科技');
    db.close();
  });

  it('截止时间恰好等于当前时间即视为到期，且只在确有到期岗位时写审计', () => {
    const db = CreateDatabase();
    const repository = new JobRepository({ db });
    const now = Date.now();
    repository.Upsert(CreateJob({ deadline: now }));

    expect(repository.ListAll(now)).toEqual([]);
    expect(repository.DeleteExpired(now)).toBe(0);
    expect(db.prepare("SELECT COUNT(*) AS count FROM audit_events WHERE action = 'cleanup'").get().count).toBe(1);
    db.close();
  });

  it('按 ID 读取不受岗位库可见性影响，投递跟踪因此仍能拿到到期岗位的截止时间与版本', () => {
    const db = CreateDatabase();
    const repository = new JobRepository({ db });
    const now = Date.now();
    repository.Upsert(CreateJob({ id: 'expired', deadline: now - 1000 }));

    expect(repository.ListAll(now)).toEqual([]);
    expect(repository.FindById('expired')).toMatchObject({ id: 'expired', deadline: now - 1000, revision: 1 });
    expect(repository.FindById('missing')).toBeUndefined();
    expect(repository.FindById('')).toBeUndefined();
    db.close();
  });

  it('拒绝非法截止时间，避免写入无法比较的值', () => {
    const db = CreateDatabase();
    const repository = new JobRepository({ db });

    expect(() => repository.Upsert(CreateJob({ deadline: 0 }))).toThrow('Job deadline is invalid.');
    expect(() => repository.Upsert(CreateJob({ deadline: Number.NaN }))).toThrow('Job deadline is invalid.');
    expect(() => repository.Upsert(CreateJob({ deadline: '2026-09-30' }))).toThrow('Job deadline is invalid.');
    db.close();
  });

  it('重新保存时保留原截止时间，清除后不再自动删除', () => {
    const db = CreateDatabase();
    const repository = new JobRepository({ db });
    const now = Date.now();
    repository.Upsert(CreateJob({ deadline: now + 86_400_000 }));

    // 编辑表单回填原值 → 保存后截止时间不变。
    const existing = repository.ListAll(now)[0];
    repository.Upsert({ ...existing, salary: '30k 到 45k' }, existing.revision);
    expect(repository.ListAll(now)[0]).toMatchObject({ salary: '30k 到 45k', deadline: now + 86_400_000 });

    // 用户清空截止时间 → 岗位恢复长期有效，即使时间已经越过原截止时间。
    const updated = repository.ListAll(now)[0];
    repository.Upsert({ ...updated, deadline: undefined }, updated.revision);
    expect(repository.ListAll(now + 172_800_000).map((job: any) => job.id)).toEqual(['job-1']);
    db.close();
  });
});
