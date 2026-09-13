import { GetNow, CreateId, WriteAudit, AssertRevision } from './helpers';
import { NormalizeEpochMs } from './enum-map';

/** 当前版本与最近两份历史版本构成简历的全部可恢复范围。 */
const RetainedRevisionCount = 3;

/** 生成排除展示时间字段的正文键，用于识别真实内容变化，避免每次落库因 updatedAt 不同而虚增版本。 */
function ContentKey(resume: any): string {
  const { updatedAt, ...content } = resume;
  return JSON.stringify(content);
}

/** 简历及其版本快照的独立事实源；正文变动提升 revision 并追加版本，删除走逻辑墓碑。 */
export class ResumeRepository {
  private db: any;
  private attachmentLifecycle: any;

  constructor({ db, attachmentLifecycle }: { db: any; attachmentLifecycle: any }) {
    this.db = db;
    this.attachmentLifecycle = attachmentLifecycle;
  }

  /** 读取全部未删除简历，按最近更新倒序；document_json 即页面 Resume ViewModel，revision 供外部冲突校验。 */
  ListAll(): any[] {
    return this.db.prepare('SELECT document_json, revision FROM resumes WHERE deleted_at IS NULL ORDER BY updated_at DESC').all()
      .map((row: any) => ({ ...JSON.parse(row.document_json), revision: row.revision }));
  }

  /** 创建或更新简历；已存在时校验期望版本，正文变化提升 revision 并追加不可变快照。 */
  Upsert(resume: any, expectedRevision?: number): any {
    const run = this.db.transaction(() => {
      const result = this.UpsertRecord(resume, expectedRevision);
      this.attachmentLifecycle.ReplaceLinks('resume', resume.id, resume);
      return result;
    });
    return run();
  }

  private UpsertRecord(resume: any, expectedRevision?: number): any {
    if (!resume || typeof resume !== 'object') throw new Error('Resume is invalid.');
    if (typeof resume.id !== 'string' || resume.id.length === 0 || resume.id.length > 200) throw new Error('Resume id is invalid.');
    if (typeof resume.name !== 'string' || resume.name.length === 0 || resume.name.length > 200) throw new Error('Resume name is invalid.');
    const now = GetNow();
    const normalizedResume = { ...resume, updatedAt: NormalizeEpochMs(resume.updatedAt, now) };
    const document = JSON.stringify(normalizedResume);
    const documentKey = ContentKey(normalizedResume);
    const existing = this.db.prepare('SELECT revision, document_json FROM resumes WHERE id = ?').get(resume.id);
    if (!existing) {
      this.db.prepare('INSERT INTO resumes(id, name, document_json, revision, created_at, updated_at) VALUES(?, ?, ?, 1, ?, ?)').run(resume.id, resume.name, document, now, now);
      this.db.prepare('INSERT INTO resume_revisions(id, resume_id, revision, document_json, source, created_at) VALUES(?, ?, 1, ?, ?, ?)').run(CreateId(), resume.id, document, 'user', now);
      WriteAudit(this.db, 'user', 'save', 'resume', resume.id, {});
      return { id: resume.id, revision: 1 };
    }
    AssertRevision(existing, expectedRevision, 'resume', resume.id);
    if (ContentKey(JSON.parse(existing.document_json)) !== documentKey) {
      const nextRevision = existing.revision + 1;
      this.db.prepare('UPDATE resumes SET name = ?, document_json = ?, revision = ?, updated_at = ?, deleted_at = NULL WHERE id = ?').run(resume.name, document, nextRevision, now, resume.id);
      this.db.prepare('INSERT INTO resume_revisions(id, resume_id, revision, document_json, source, created_at) VALUES(?, ?, ?, ?, ?, ?)').run(CreateId(), resume.id, nextRevision, document, 'user', now);
      this.PruneRevisions(resume.id);
      WriteAudit(this.db, 'user', 'save', 'resume', resume.id, {});
      return { id: resume.id, revision: nextRevision };
    }
    this.db.prepare('UPDATE resumes SET name = ?, updated_at = ?, deleted_at = NULL WHERE id = ?').run(resume.name, now, resume.id);
    WriteAudit(this.db, 'user', 'save', 'resume', resume.id, {});
    return { id: resume.id, revision: existing.revision };
  }

  /** 仅更新简历名称与最近更新时间；校验期望版本但不产生内容版本快照。 */
  Rename(id: string, name: string, expectedRevision?: number): any {
    if (typeof id !== 'string' || id.length === 0 || id.length > 200) throw new Error('Resume id is invalid.');
    if (typeof name !== 'string' || name.length === 0 || name.length > 200) throw new Error('Resume name is invalid.');
    const existing = this.db.prepare('SELECT revision FROM resumes WHERE id = ?').get(id);
    if (!existing) throw new Error('Resume was not found.');
    AssertRevision(existing, expectedRevision, 'resume', id);
    const result = this.db.prepare('UPDATE resumes SET name = ?, updated_at = ? WHERE id = ?').run(name, GetNow(), id);
    if (!result.changes) throw new Error('Resume was not found.');
    WriteAudit(this.db, 'user', 'rename', 'resume', id, {});
    return { id, name, revision: existing.revision };
  }

  /** 逻辑删除简历；被投递引用时保留墓碑以维持历史快照。 */
  Delete(id: string): any {
    if (typeof id !== 'string' || id.length === 0 || id.length > 200) throw new Error('Resume id is invalid.');
    const run = this.db.transaction(() => {
      this.db.prepare('UPDATE resumes SET deleted_at = ?, updated_at = ? WHERE id = ?').run(GetNow(), GetNow(), id);
      this.attachmentLifecycle.RemoveLinks('resume', id);
      WriteAudit(this.db, 'user', 'delete', 'resume', id, {});
    });
    run();
    return { id };
  }

  /** 返回当前版本与最多两份历史版本；历史只提供元数据，正文需经独立只读接口取得。 */
  GetRevisions(resumeId: string): any[] {
    if (typeof resumeId !== 'string' || resumeId.length === 0 || resumeId.length > 200) throw new Error('Resume id is invalid.');
    const current = this.db.prepare('SELECT revision FROM resumes WHERE id = ? AND deleted_at IS NULL').get(resumeId);
    if (!current) throw new Error('Resume was not found.');
    return this.db.prepare('SELECT id, revision, source, created_at FROM resume_revisions WHERE resume_id = ? ORDER BY revision DESC').all(resumeId)
      .map((row: any) => ({ id: row.id, revision: row.revision, source: row.source, createdAt: row.created_at, isCurrent: row.revision === current.revision }));
  }

  /** 返回指定历史版本的不可变正文；调用方只能预览、导出或发起还原。 */
  GetRevision(resumeId: string, revisionId: string): any {
    if (typeof resumeId !== 'string' || resumeId.length === 0 || resumeId.length > 200) throw new Error('Resume id is invalid.');
    if (typeof revisionId !== 'string' || revisionId.length === 0 || revisionId.length > 200) throw new Error('Resume revision id is invalid.');
    const current = this.db.prepare('SELECT revision FROM resumes WHERE id = ? AND deleted_at IS NULL').get(resumeId);
    if (!current) throw new Error('Resume was not found.');
    const row = this.db.prepare('SELECT id, revision, document_json, source, created_at FROM resume_revisions WHERE id = ? AND resume_id = ?').get(revisionId, resumeId);
    if (!row) throw new Error('Resume revision was not found.');
    return {
      id: row.id,
      revision: row.revision,
      source: row.source,
      createdAt: row.created_at,
      isCurrent: row.revision === current.revision,
      document: { ...JSON.parse(row.document_json), revision: row.revision },
    };
  }

  /** 从指定历史快照生成新的当前版本；版本号只增不减，避免把还原误判为旧数据覆盖。 */
  RestoreRevision(resumeId: string, revisionId: string, expectedRevision?: number): any {
    if (typeof resumeId !== 'string' || resumeId.length === 0 || resumeId.length > 200) throw new Error('Resume id is invalid.');
    if (typeof revisionId !== 'string' || revisionId.length === 0 || revisionId.length > 200) throw new Error('Resume revision id is invalid.');
    const run = this.db.transaction(() => {
      const current = this.db.prepare('SELECT revision, document_json FROM resumes WHERE id = ? AND deleted_at IS NULL').get(resumeId);
      if (!current) throw new Error('Resume was not found.');
      AssertRevision(current, expectedRevision, 'resume', resumeId);
      const target = this.db.prepare('SELECT revision, document_json FROM resume_revisions WHERE id = ? AND resume_id = ?').get(revisionId, resumeId);
      if (!target) throw new Error('Resume revision was not found.');
      const now = GetNow();
      const restored = { ...JSON.parse(target.document_json), id: resumeId, updatedAt: now };
      if (typeof restored.name !== 'string' || restored.name.length === 0 || restored.name.length > 200) throw new Error('Resume revision document is invalid.');
      const nextRevision = current.revision + 1;
      const document = JSON.stringify(restored);
      this.db.prepare('UPDATE resumes SET name = ?, document_json = ?, revision = ?, updated_at = ? WHERE id = ?').run(restored.name, document, nextRevision, now, resumeId);
      this.db.prepare('INSERT INTO resume_revisions(id, resume_id, revision, document_json, source, created_at) VALUES(?, ?, ?, ?, ?, ?)').run(CreateId(), resumeId, nextRevision, document, 'restore', now);
      this.PruneRevisions(resumeId);
      this.attachmentLifecycle.ReplaceLinks('resume', resumeId, restored);
      WriteAudit(this.db, 'user', 'restore', 'resume', resumeId, { restoredFromRevision: target.revision });
      return { id: resumeId, revision: nextRevision, restoredFromRevision: target.revision, resume: { ...restored, revision: nextRevision } };
    });
    return run();
  }

  /** 删除一份历史快照；当前版本始终是可编辑事实源，不能通过该接口删除。 */
  DeleteRevision(resumeId: string, revisionId: string): any {
    if (typeof resumeId !== 'string' || resumeId.length === 0 || resumeId.length > 200) throw new Error('Resume id is invalid.');
    if (typeof revisionId !== 'string' || revisionId.length === 0 || revisionId.length > 200) throw new Error('Resume revision id is invalid.');
    const current = this.db.prepare('SELECT revision FROM resumes WHERE id = ? AND deleted_at IS NULL').get(resumeId);
    if (!current) throw new Error('Resume was not found.');
    const target = this.db.prepare('SELECT revision FROM resume_revisions WHERE id = ? AND resume_id = ?').get(revisionId, resumeId);
    if (!target) throw new Error('Resume revision was not found.');
    if (target.revision === current.revision) throw new Error('The current resume revision cannot be deleted.');
    this.db.prepare('DELETE FROM resume_revisions WHERE id = ?').run(revisionId);
    WriteAudit(this.db, 'user', 'delete', 'resume_revision', revisionId, { revision: target.revision });
    return { id: revisionId };
  }

  /** 仅清理超出当前加两份历史上限的版本；投递凭证存于独立表，不再阻止版本裁剪。 */
  PruneRevisions(resumeId: string): void {
    const removable = this.db.prepare('SELECT id FROM resume_revisions WHERE resume_id = ? ORDER BY revision DESC').all(resumeId).slice(RetainedRevisionCount);
    if (!removable.length) return;
    const placeholders = removable.map(() => '?').join(',');
    this.db.prepare(`DELETE FROM resume_revisions WHERE id IN (${placeholders})`).run(...removable.map((revision: any) => revision.id));
  }
}
