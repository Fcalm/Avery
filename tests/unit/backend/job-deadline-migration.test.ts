import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const MigrationRoot = join(process.cwd(), 'migrations', 'business');

/** 应用全部迁移：与运行时的 RunMigrations 一致，.sql 直接执行，.js 导出 up(db)。 */
function ApplyAllMigrations(db: any) {
  const manifest = JSON.parse(readFileSync(join(MigrationRoot, 'manifest.json'), 'utf8'));
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT, checksum TEXT, applied_at INTEGER)');
  for (const entry of manifest.migrations) {
    const path = join(MigrationRoot, entry.file);
    if (entry.kind === 'sql') db.exec(readFileSync(path, 'utf8'));
    else require(path).up(db);
    db.prepare('INSERT INTO schema_migrations(version, name, checksum, applied_at) VALUES(?, ?, ?, ?)')
      .run(entry.version, entry.name, entry.checksumSeed, Date.now());
  }
  return manifest;
}

describe('v13 岗位截止时间迁移', () => {
  it('为既有 jobs 表补 deadline 列与到期索引，存量行保持原值', () => {
    const db = new Database(':memory:');
    // 迁移前的最小 jobs 表：v1 建表时不包含 deadline，存量库需要靠本迁移补列。
    db.exec(`
      CREATE TABLE jobs(
        id TEXT PRIMARY KEY, payload_json TEXT NOT NULL, is_favorite INTEGER NOT NULL DEFAULT 0,
        channel TEXT NOT NULL, match_score REAL, revision INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER
      );
    `);
    db.prepare('INSERT INTO jobs(id, payload_json, is_favorite, channel, revision, created_at, updated_at) VALUES(?, ?, ?, ?, ?, ?, ?)')
      .run('job-1', '{"company":"示例科技"}', 0, 'BOSS直聘', 1, 1000, 2000);

    db.exec(readFileSync(join(MigrationRoot, 'v13-job-deadline.sql'), 'utf8'));

    const columns = db.prepare('PRAGMA table_info(jobs)').all().map((column: any) => column.name);
    expect(columns).toContain('deadline');
    expect(db.prepare('SELECT id, deadline, created_at, updated_at FROM jobs WHERE id = ?').get('job-1'))
      .toEqual({ id: 'job-1', deadline: null, created_at: 1000, updated_at: 2000 });
    // 部分索引必须可用：清理语句只命中到期且未删除的行。
    const plan = db.prepare('EXPLAIN QUERY PLAN SELECT id FROM jobs WHERE deleted_at IS NULL AND deadline IS NOT NULL AND deadline <= ?').all(3000);
    expect(JSON.stringify(plan)).toContain('idx_jobs_deadline');
    db.close();
  });

  it('manifest 从空库按顺序应用全部迁移，最新版本包含岗位截止时间索引', () => {
    const db = new Database(':memory:');
    const manifest = ApplyAllMigrations(db);

    expect(manifest.migrations.map((entry: any) => entry.version)).toEqual(
      Array.from({ length: manifest.migrations.length }, (_, index) => index + 1),
    );
    expect(db.prepare('PRAGMA table_info(jobs)').all().map((column: any) => column.name)).toContain('deadline');
    expect(db.prepare('PRAGMA table_info(cron_tasks)').all().map((column: any) => column.name)).toContain('browser_task_grant_json');
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_jobs_deadline'").get())
      .toEqual({ name: 'idx_jobs_deadline' });
    db.close();
  });
});
