import { GetNow, CreateId, WriteAudit, AssertRevision } from './helpers';
import { NormalizeEpochMs } from './enum-map';

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

  /** 返回一份简历的最近版本与重要标记，供用户在简历详情中管理留存策略。 */
  GetRevisions(resumeId: string): any[] {
    if (typeof resumeId !== 'string' || resumeId.length === 0 || resumeId.length > 200) throw new Error('Resume id is invalid.');
    return this.db.prepare('SELECT id, revision, source, is_pinned, is_protected, created_at FROM resume_revisions WHERE resume_id = ? ORDER BY revision DESC').all(resumeId)
      .map((row: any) => ({ id: row.id, revision: row.revision, source: row.source, isPinned: Boolean(row.is_pinned), isProtected: Boolean(row.is_protected), createdAt: row.created_at }));
  }

  /** 标记或取消标记重要简历版本；重要版本不参与普通 100 条版本裁剪。 */
  SetRevisionPinned(revisionId: string, pinned: boolean): any {
    if (typeof revisionId !== 'string' || revisionId.length === 0 || revisionId.length > 200) throw new Error('Resume revision id is invalid.');
    const result = this.db.prepare('UPDATE resume_revisions SET is_pinned = ? WHERE id = ?').run(pinned ? 1 : 0, revisionId);
    if (!result.changes) throw new Error('Resume revision was not found.');
    WriteAudit(this.db, 'user', pinned ? 'pin' : 'unpin', 'resume_revision', revisionId, {});
    return { id: revisionId, isPinned: Boolean(pinned) };
  }

  /** 仅清理超出上限且未被标记重要/投递保护的普通简历修订。 */
  PruneRevisions(resumeId: string): void {
    const removable = this.db.prepare('SELECT id FROM resume_revisions WHERE resume_id = ? AND is_pinned = 0 AND is_protected = 0 ORDER BY created_at DESC').all(resumeId).slice(100);
    if (!removable.length) return;
    const placeholders = removable.map(() => '?').join(',');
    this.db.prepare(`DELETE FROM resume_revisions WHERE id IN (${placeholders})`).run(...removable.map((revision: any) => revision.id));
  }
}
