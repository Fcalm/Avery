'use strict';

const { randomUUID } = require('node:crypto');

/**
 * 测试阶段不迁移旧版本留存语义：丢弃旧快照和旧投递版本指针，
 * 以当前简历正文重建单个基线版本。投递凭证从此迁移后首次验证成功的投递开始记录。
 */
exports.up = function up(db) {
  const run = db.transaction(() => {
    const applicationColumns = new Set(db.prepare('PRAGMA table_info(applications)').all().map((column) => column.name));
    if (applicationColumns.has('resume_revision_id')) db.exec('UPDATE applications SET resume_revision_id = NULL;');

    db.exec(`
      CREATE TABLE IF NOT EXISTS application_resume_evidence (
        application_id TEXT PRIMARY KEY REFERENCES applications(id) ON DELETE CASCADE,
        resume_id TEXT NOT NULL,
        resume_revision INTEGER NOT NULL,
        document_json TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_application_resume_evidence_resume ON application_resume_evidence(resume_id, resume_revision);
    `);

    db.exec('DELETE FROM resume_revisions;');
    const resumes = db.prepare('SELECT id, revision, document_json, updated_at FROM resumes WHERE deleted_at IS NULL').all();
    const insert = db.prepare('INSERT INTO resume_revisions(id, resume_id, revision, document_json, source, created_at) VALUES(?, ?, ?, ?, ?, ?)');
    for (const resume of resumes) {
      insert.run(randomUUID(), resume.id, resume.revision, resume.document_json, 'user', resume.updated_at);
    }
  });
  run();
};
