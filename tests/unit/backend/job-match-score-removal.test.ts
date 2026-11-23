import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { JobUpsertSchema } from '../../../packages/contracts/src/write-schemas';
import { JobToDisplay, JobToStorage } from '../../../apps/backend/src/electron/repositories/enum-map';
import { JobRepository } from '../../../apps/backend/src/electron/repositories/job-repository';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const root = join(process.cwd(), 'migrations/business');
const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8')) as {
  migrations: Array<{ version: number; file: string; kind: string }>;
};

describe('移除岗位匹配分', () => {
  it('存量升级删除投影列及 JSON 字段，保留岗位、墓碑、元数据、索引和投递关联', () => {
    const db = new Database(':memory:');
    try {
      db.pragma('foreign_keys = ON');
      for (const entry of manifest.migrations.filter(entry => entry.version < 20)) {
        if (entry.kind === 'sql') db.exec(readFileSync(join(root, entry.file), 'utf8'));
        else require(join(root, entry.file)).up(db);
      }
      const insert = db.prepare('INSERT INTO jobs(id,payload_json,is_favorite,channel,match_score,revision,created_at,updated_at,deleted_at,deadline) VALUES(?,?,?,?,?,?,?,?,?,?)');
      for (const [id, score, deleted] of [['active', 88, null], ['deleted', 0, 3000], ['unknown', null, null]] as const) {
        const payload = { id, title: '产品经理', company: '测试企业', channel: 'company_website', favorite: true,
          city: '上海', experience: '', jd: '原始岗位正文', note: '用户备注', matchScore: score, match_score: score };
        insert.run(id, JSON.stringify(payload), 1, '企业官网', score, 7, 1000, 2000, deleted, null);
      }
      db.prepare('INSERT INTO applications(id,job_id,payload_json,status,created_at,updated_at) VALUES(?,?,?,?,?,?)')
        .run('application-1', 'active', '{"jobId":"active"}', '已投递', 1000, 2000);
      const before = db.prepare('SELECT id,is_favorite,channel,revision,created_at,updated_at,deleted_at,deadline FROM jobs ORDER BY id').all();
      const applications = db.prepare('SELECT * FROM applications').all();

      db.exec(readFileSync(join(root, 'v20-remove-job-match-score.sql'), 'utf8'));

      expect(db.prepare('PRAGMA table_info(jobs)').all().map((column: { name: string }) => column.name)).not.toContain('match_score');
      expect(db.prepare('SELECT id,is_favorite,channel,revision,created_at,updated_at,deleted_at,deadline FROM jobs ORDER BY id').all()).toEqual(before);
      expect(db.prepare('SELECT * FROM applications').all()).toEqual(applications);
      for (const row of db.prepare('SELECT payload_json FROM jobs').all()) {
        const payload = JSON.parse(row.payload_json);
        expect(payload).not.toHaveProperty('matchScore');
        expect(payload).not.toHaveProperty('match_score');
        expect(payload).toMatchObject({ jd: '原始岗位正文', note: '用户备注', favorite: true });
      }
      expect(db.pragma('foreign_key_check')).toEqual([]);
      const repository = new JobRepository({ db });
      expect(repository.Query({}).items.map(job => job.id)).toEqual(['active', 'unknown']);
      expect(repository.Query({ view: 'applied' }).items.map(job => job.id)).toEqual(['active']);
      expect(db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_jobs_%'").all().map((row: { name: string }) => row.name))
        .toEqual(expect.arrayContaining(['idx_jobs_deadline', 'idx_jobs_collection_identity', 'idx_jobs_collection_url']));

      const legacy = { id: 'restored', title: '恢复岗位', company: '企业', channel: 'company_website', matchScore: 99, match_score: 99 };
      repository.Upsert(legacy);
      expect(repository.FindById('restored')).not.toHaveProperty('matchScore');
      expect(JSON.parse(db.prepare('SELECT payload_json FROM jobs WHERE id=?').get('restored').payload_json)).not.toHaveProperty('matchScore');
      expect(legacy.matchScore).toBe(99);
      // 旧备份再次带入字段时，读取不泄漏，收藏写回也不能复活退役字段。
      db.prepare("UPDATE jobs SET payload_json=json_set(payload_json,'$.matchScore',99) WHERE id='restored'").run();
      expect(repository.FindById('restored')).not.toHaveProperty('matchScore');
      repository.SetFavorite('restored', true, 1);
      expect(JSON.parse(db.prepare('SELECT payload_json FROM jobs WHERE id=?').get('restored').payload_json)).not.toHaveProperty('matchScore');
    } finally { db.close(); }
  });

  it('写契约和枚举转换剔除旧字段，保留其余字段并且不改变输入对象', () => {
    const input = { id: 'legacy', title: '产品经理', channel: 'company_website', matchScore: 90, match_score: 90, sourceId: 'source-1' };
    const before = structuredClone(input);
    for (const output of [JobUpsertSchema.parse(input), JobToStorage(input), JobToDisplay(input)]) {
      expect(output).not.toHaveProperty('matchScore');
      expect(output).not.toHaveProperty('match_score');
      expect(output).toMatchObject({ id: 'legacy', title: '产品经理', sourceId: 'source-1' });
    }
    expect(input).toEqual(before);
  });
});
