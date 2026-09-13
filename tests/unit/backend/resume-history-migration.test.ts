import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const migration = require('../../../migrations/business/v11-resume-three-version-history.cjs') as { up: (db: any) => void };

describe('v11 简历三版本迁移', () => {
  it('丢弃旧版本和旧投递版本指针，只以当前简历重建基线', () => {
    const db = new Database(':memory:');
    db.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE resumes (id TEXT PRIMARY KEY, document_json TEXT NOT NULL, revision INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER);
      CREATE TABLE resume_revisions (id TEXT PRIMARY KEY, resume_id TEXT NOT NULL REFERENCES resumes(id), revision INTEGER NOT NULL, document_json TEXT NOT NULL, source TEXT NOT NULL, is_pinned INTEGER, is_protected INTEGER, created_at INTEGER NOT NULL);
      CREATE TABLE applications (id TEXT PRIMARY KEY, resume_revision_id TEXT REFERENCES resume_revisions(id));
    `);
    const current = JSON.stringify({ id: 'resume-1', name: '当前简历', content: '当前正文', updatedAt: 400 });
    db.prepare('INSERT INTO resumes(id, document_json, revision, updated_at) VALUES(?, ?, ?, ?)').run('resume-1', current, 4, 400);
    for (let revision = 1; revision <= 4; revision += 1) {
      db.prepare('INSERT INTO resume_revisions(id, resume_id, revision, document_json, source, is_pinned, is_protected, created_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?)')
        .run(`revision-${revision}`, 'resume-1', revision, JSON.stringify({ id: 'resume-1', name: '旧简历', content: `旧正文${revision}` }), 'user', 1, 1, revision);
    }
    db.prepare('INSERT INTO applications(id, resume_revision_id) VALUES(?, ?)').run('application-1', 'revision-1');

    migration.up(db);

    expect(db.prepare('SELECT resume_revision_id FROM applications WHERE id = ?').get('application-1')).toEqual({ resume_revision_id: null });
    const revisions = db.prepare('SELECT resume_id, revision, document_json, source FROM resume_revisions').all();
    expect(revisions).toHaveLength(1);
    expect(revisions[0]).toMatchObject({ resume_id: 'resume-1', revision: 4, document_json: current, source: 'user' });
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'application_resume_evidence'").get()).toEqual({ name: 'application_resume_evidence' });
  });
});
