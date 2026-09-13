import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { ApplicationRepository } from '../../../apps/backend/src/electron/repositories/application-repository';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

function CreateRepository() {
  const db = new Database(':memory:');
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE applications (id TEXT PRIMARY KEY, job_id TEXT, payload_json TEXT, status TEXT, revision INTEGER, created_at INTEGER, updated_at INTEGER);
    CREATE TABLE application_events (id TEXT, application_id TEXT, event_type TEXT, from_status TEXT, to_status TEXT, payload_json TEXT, created_at INTEGER);
    CREATE TABLE application_resume_evidence (application_id TEXT PRIMARY KEY REFERENCES applications(id) ON DELETE CASCADE, resume_id TEXT NOT NULL, resume_revision INTEGER NOT NULL, document_json TEXT NOT NULL, content_hash TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE audit_events (id TEXT, actor_type TEXT, action TEXT, entity_type TEXT, entity_id TEXT, metadata_json TEXT, created_at INTEGER);
  `);
  db.prepare('INSERT INTO applications(id, job_id, payload_json, status, revision, created_at, updated_at) VALUES(?, ?, ?, ?, ?, ?, ?)')
    .run('application-1', 'job-1', '{}', '已投递', 1, 1, 1);
  return { db, repository: new ApplicationRepository({ db }) };
}

describe('ApplicationRepository 投递简历凭证', () => {
  it('冻结首次成功投递使用的完整简历快照，后续状态更新不能覆盖它', () => {
    const { db, repository } = CreateRepository();
    const first = repository.RecordResumeEvidence('application-1', {
      resumeId: 'resume-1', revision: 4,
      document: { id: 'resume-1', name: '产品简历', targetRoles: ['产品经理'], summary: '摘要', content: '已提交的正文', updatedAt: 123 },
    });
    const repeated = repository.RecordResumeEvidence('application-1', {
      resumeId: 'resume-1', revision: 5,
      document: { id: 'resume-1', name: '已修改名称', content: '后续修改的正文' },
    });

    const stored = db.prepare('SELECT resume_id, resume_revision, document_json, content_hash FROM application_resume_evidence WHERE application_id = ?').get('application-1');
    expect(first).toMatchObject({ created: true, revision: 4 });
    expect(repeated).toMatchObject({ created: false, revision: 4, contentHash: first.contentHash });
    expect(stored).toMatchObject({ resume_id: 'resume-1', resume_revision: 4, content_hash: first.contentHash });
    expect(JSON.parse(stored.document_json)).toMatchObject({ name: '产品简历', content: '已提交的正文' });
  });
});
