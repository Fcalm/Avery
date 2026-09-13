import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { ResumeRepository } from '../../../apps/backend/src/electron/repositories/resume-repository';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

function createRepository(): { repository: ResumeRepository; db: import('better-sqlite3').Database } {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE resumes (id TEXT PRIMARY KEY, name TEXT, document_json TEXT, revision INTEGER, created_at INTEGER, updated_at INTEGER, deleted_at INTEGER);
    CREATE TABLE resume_revisions (id TEXT PRIMARY KEY, resume_id TEXT, revision INTEGER, document_json TEXT, source TEXT, is_pinned INTEGER DEFAULT 0, is_protected INTEGER DEFAULT 0, created_at INTEGER);
    CREATE TABLE audit_events (id TEXT, actor_type TEXT, action TEXT, entity_type TEXT, entity_id TEXT, metadata_json TEXT, created_at INTEGER);
  `);
  return { repository: new ResumeRepository({ db, attachmentLifecycle: { ReplaceLinks: () => undefined, RemoveLinks: () => undefined } }), db };
}

describe('ResumeRepository revision', () => {
  it('拒绝过期 revision，避免覆盖已保存的内容', () => {
    const { repository } = createRepository();
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

  it('只保留当前与两份历史，并将还原写为新的递增版本', () => {
    const { repository } = createRepository();
    repository.Upsert({ id: 'resume-1', name: '简历', content: '第一版' });
    repository.Upsert({ id: 'resume-1', name: '简历', content: '第二版' }, 1);
    repository.Upsert({ id: 'resume-1', name: '简历', content: '第三版' }, 2);
    repository.Upsert({ id: 'resume-1', name: '简历', content: '第四版' }, 3);

    const beforeRestore = repository.GetRevisions('resume-1');
    expect(beforeRestore.map((item) => item.revision)).toEqual([4, 3, 2]);
    expect(beforeRestore[0]).toMatchObject({ isCurrent: true });
    const second = beforeRestore.find((item) => item.revision === 2);
    expect(repository.GetRevision('resume-1', second.id)).toMatchObject({ isCurrent: false, document: { content: '第二版', revision: 2 } });

    const restored = repository.RestoreRevision('resume-1', second.id, 4);
    expect(restored).toMatchObject({ id: 'resume-1', revision: 5, restoredFromRevision: 2, resume: { content: '第二版', revision: 5 } });
    const afterRestore = repository.GetRevisions('resume-1');
    expect(afterRestore.map((item) => item.revision)).toEqual([5, 4, 3]);
    expect(afterRestore[0]).toMatchObject({ isCurrent: true, source: 'restore' });

    const history = afterRestore.find((item) => item.revision === 4);
    expect(repository.DeleteRevision('resume-1', history.id)).toEqual({ id: history.id });
    expect(repository.GetRevisions('resume-1').map((item) => item.revision)).toEqual([5, 3]);
    const current = repository.GetRevisions('resume-1')[0];
    expect(() => repository.DeleteRevision('resume-1', current.id)).toThrow('current resume revision');
  });

  it('删除简历时连同样本版本行一并从数据库移除', () => {
    const { repository, db } = createRepository();
    repository.Upsert({ id: 'resume-1', name: '简历', content: '第一版' });
    repository.Upsert({ id: 'resume-1', name: '简历', content: '第二版' }, 1);
    expect(repository.Delete('resume-1')).toEqual({ id: 'resume-1' });
    // 硬删除而非墓碑：正文与历史版本都不允许在库中残留。
    expect(db.prepare('SELECT COUNT(*) AS count FROM resumes').get()).toMatchObject({ count: 0 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM resume_revisions').get()).toMatchObject({ count: 0 });
    expect(() => repository.GetRevisions('resume-1')).toThrow('not found');
    // 删除动作留审计痕迹，便于排查误删。
    expect(db.prepare("SELECT COUNT(*) AS count FROM audit_events WHERE action = 'delete' AND entity_type = 'resume'").get()).toMatchObject({ count: 1 });
  });
});
