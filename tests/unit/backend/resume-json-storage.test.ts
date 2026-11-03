import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CreateEmptyResumeData, ResumeDataToText } from '@avery/contracts';
import { ResumeRepository } from '../../../apps/backend/src/electron/repositories/resume-repository';
import { ResumeDocumentFiles } from '../../../apps/backend/src/electron/repositories/resume-document-files';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const cleanups: Array<() => void> = [];
afterEach(() => { vi.restoreAllMocks(); cleanups.splice(0).reverse().forEach((cleanup) => cleanup()); });
function Fixture() {
  const root = mkdtempSync(join(tmpdir(), 'avery-resume-json-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const db = new Database(':memory:');
  cleanups.push(() => db.close());
  db.exec(`CREATE TABLE resumes (id TEXT PRIMARY KEY, name TEXT, document_json TEXT, revision INTEGER, created_at INTEGER, updated_at INTEGER, deleted_at INTEGER);
    CREATE TABLE resume_revisions (id TEXT PRIMARY KEY, resume_id TEXT, revision INTEGER, document_json TEXT, source TEXT, created_at INTEGER);
    CREATE TABLE audit_events (id TEXT, actor_type TEXT, action TEXT, entity_type TEXT, entity_id TEXT, metadata_json TEXT, created_at INTEGER);`);
  const options = { db, workspacePath: root, attachmentLifecycle: { ReplaceLinks() {}, RemoveLinks() {} } };
  const repository = new ResumeRepository(options);
  const data = CreateEmptyResumeData();
  data.personal = { name: '测试姓名', phone: '13800000000', email: 'candidate@example.com', github: '' };
  const resume = { id: '../../同名/C:简历', name: '简历', targetRoles: [], summary: '', content: ResumeDataToText(data), data, templateId: 'classic' };
  const Read = () => JSON.parse(readFileSync(new ResumeDocumentFiles(root).Path(resume.id), 'utf8')).resume;
  return { db, root, options, repository, resume, Read };
}
describe('独立简历 JSON 与版本事务', () => {
  it('独立保存，切换模板复用数据，重启可读；ID 不得逃逸目录', () => {
    const { repository, resume, Read, root, options } = Fixture();
    repository.Upsert(resume);
    expect(readdirSync(join(root, 'resumes'))).toEqual([expect.stringMatching(/^[a-f0-9]{64}\.json$/)]);
    const current = repository.ListAll()[0];
    repository.Upsert({ ...current, templateId: 'compact' }, 1);
    expect(Read()).toMatchObject({ data: resume.data, templateId: 'compact', revision: 2 });
    expect(new ResumeRepository(options).ListAll()[0]).toMatchObject({ data: resume.data, templateId: 'compact', revision: 2 });
    expect(readdirSync(join(root, 'resumes'))).toHaveLength(1);
    // 页面回传 revision 或只有更新时间变化，不得创建虚假版本。
    expect(repository.Upsert({ ...repository.ListAll()[0], updatedAt: Date.now() }, 2).revision).toBe(2);
  });
  it('迁移旧库原文并保留未知字段，数据库历史和原始快照不改写', () => {
    const { db, options, root } = Fixture();
    const old = { id: 'old', name: '旧版', content: '旧简历\n# 核心能力\n多段旧经历', customUnknown: ['不能丢失'] };
    const original = JSON.stringify(old);
    db.prepare('INSERT INTO resumes VALUES(?, ?, ?, 7, 1, 1, NULL)').run(old.id, old.name, original);
    const migrated = new ResumeRepository(options).ListAll()[0];
    expect(migrated).toMatchObject({ ...old, revision: 7, data: { mode: 'legacy', legacyContent: old.content } });
    expect(JSON.parse(readFileSync(new ResumeDocumentFiles(root).Path('old'), 'utf8')).resume).toEqual(migrated);
    expect(db.prepare('SELECT document_json FROM resumes WHERE id = ?').get('old').document_json).toBe(original);
  });
  it('写盘失败回滚版本、正文和附件事务', () => {
    const { repository, resume, Read, db } = Fixture();
    repository.Upsert(resume);
    const before = Read();
    vi.spyOn(ResumeDocumentFiles.prototype, 'Write').mockImplementationOnce(() => { throw new Error('disk full'); });
    expect(() => repository.Upsert({ ...repository.ListAll()[0], templateId: 'compact' }, 1)).toThrow('disk full');
    expect(Read()).toEqual(before);
    expect(repository.ListAll()[0].revision).toBe(1);
    expect(db.prepare('SELECT COUNT(*) AS count FROM resume_revisions').get().count).toBe(1);
  });
  it('数据库提交失败恢复已替换文件，不留下伪保存结果', () => {
    const { repository, resume, Read, db } = Fixture();
    repository.Upsert(resume);
    const before = Read();
    const transaction = db.transaction.bind(db);
    db.transaction = (action: () => void) => transaction(() => { action(); throw new Error('commit failed'); });
    expect(() => repository.Upsert({ ...repository.ListAll()[0], templateId: 'compact' }, 1)).toThrow('commit failed');
    expect(Read()).toEqual(before);
    expect(repository.ListAll()[0].revision).toBe(1);
  });
  it('版本冲突与校验失败不会改写 JSON 文件', () => {
    const { repository, resume, Read } = Fixture();
    repository.Upsert(resume); const before = Read();
    expect(() => repository.Upsert({ ...resume, templateId: 'compact' }, 0)).toThrow();
    expect(() => repository.Upsert({ ...resume, data: { ...resume.data, personal: { ...resume.data.personal, name: '' } } }, 1)).toThrow('填写不完整');
    expect(Read()).toEqual(before);
  });
  it('还原、重命名、删除同步当前文件，保留历史数据', () => {
    const { repository, resume, Read, root } = Fixture();
    repository.Upsert(resume);
    const revision1 = repository.GetRevisions(resume.id)[0];
    repository.Upsert({ ...repository.ListAll()[0], templateId: 'compact' }, 1);
    repository.RestoreRevision(resume.id, revision1.id, 2);
    expect(Read()).toMatchObject({ templateId: 'classic', data: resume.data, revision: 3 });
    repository.Rename(resume.id, '重命名简历', 3); expect(Read().name).toBe('重命名简历');
    repository.Delete(resume.id);
    expect(readdirSync(join(root, 'resumes'))).toEqual([]);
  });
  it('意外磁盘差异先保留副本，再恢复已提交版本', () => {
    const { repository, resume, Read, root, options } = Fixture();
    repository.Upsert(resume);
    const interrupted = '{"unexpected":"未提交内容"}';
    writeFileSync(new ResumeDocumentFiles(root).Path(resume.id), interrupted);
    new ResumeRepository(options);
    expect(Read()).toMatchObject({ data: resume.data, revision: 1 });
    const recovered = readdirSync(join(root, 'resumes')).find((name) => name.includes('.recovered-'))!;
    expect(readFileSync(join(root, 'resumes', recovered), 'utf8')).toBe(interrupted);
  });
  it('Agent 的普通全文改动保持结构化，格式不兼容时保存完整原文并保留模板', () => {
    const { repository, resume, Read } = Fixture();
    repository.Upsert(resume);
    const current = repository.ListAll()[0];
    repository.Upsert({ ...current, content: current.content.replace('测试姓名', '新姓名') }, 1);
    expect(Read()).toMatchObject({ data: { mode: 'structured', personal: { name: '新姓名' } } });
    repository.Upsert({ ...repository.ListAll()[0], content: '新的自由格式简历，必须完整保留' }, 2);
    expect(Read()).toMatchObject({ data: { mode: 'legacy', legacyContent: '新的自由格式简历，必须完整保留' }, templateId: 'classic' });
    expect(repository.GetRevision(resume.id, repository.GetRevisions(resume.id)[1].id).document.data.personal.name).toBe('新姓名');
  });
});
