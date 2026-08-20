import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { ResumeRepository } from '../../../apps/backend/src/electron/repositories/resume-repository';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

function createRepository(): ResumeRepository {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE resumes (id TEXT PRIMARY KEY, name TEXT, document_json TEXT, revision INTEGER, created_at INTEGER, updated_at INTEGER, deleted_at INTEGER);
    CREATE TABLE resume_revisions (id TEXT PRIMARY KEY, resume_id TEXT, revision INTEGER, document_json TEXT, source TEXT, is_pinned INTEGER DEFAULT 0, is_protected INTEGER DEFAULT 0, created_at INTEGER);
    CREATE TABLE audit_events (id TEXT, actor_type TEXT, action TEXT, entity_type TEXT, entity_id TEXT, metadata_json TEXT, created_at INTEGER);
  `);
  return new ResumeRepository({ db, attachmentLifecycle: { ReplaceLinks: () => undefined, RemoveLinks: () => undefined } });
}

describe('ResumeRepository revision', () => {
  it('拒绝过期 revision，避免覆盖已保存的内容', () => {
    const repository = createRepository();
    expect(repository.Upsert({ id: 'resume-1', name: '初版', sections: [] })).toEqual({ id: 'resume-1', revision: 1 });
    expect(repository.Upsert({ id: 'resume-1', name: '二版', sections: [{ type: 'summary' }] }, 1)).toEqual({ id: 'resume-1', revision: 2 });

    let conflict: unknown;
    try {
      repository.Upsert({ id: 'resume-1', name: '过期覆盖', sections: [] }, 1);
    } catch (error) {
      conflict = error;
    }
    expect(conflict).toMatchObject({
      code: 'REVISION_CONFLICT', entityType: 'resume', entityId: 'resume-1', expectedRevision: 1, actualRevision: 2,
    });
  });
});
