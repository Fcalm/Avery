import { createRequire } from 'node:module';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ParseJobQuery, type JobQueryInput } from '@avery/contracts';
import { JobRepository } from '../../../apps/backend/src/electron/repositories/job-repository';
import { MonthlySalaryMinimum } from '../../../apps/backend/src/electron/repositories/job-query';
import { CreateBackend, ReadOnlyChannels, WriteCommandChannels } from '../../../apps/backend/src/router';

const Database = createRequire(import.meta.url)('better-sqlite3');
const databases: Array<{ close(): void }> = [];
afterEach(() => { databases.splice(0).forEach((db) => db.close()); });

/** 真实 SQLite 查询，覆盖存量字段与现有写链路；不修改用户的工作空间。 */
function Fixture() {
  const db = new Database(':memory:');
  databases.push(db);
  db.exec(`
    CREATE TABLE jobs(id TEXT PRIMARY KEY, payload_json TEXT NOT NULL, is_favorite INTEGER NOT NULL,
      channel TEXT NOT NULL, match_score REAL, deadline INTEGER, revision INTEGER, created_at INTEGER, updated_at INTEGER, deleted_at INTEGER);
    CREATE TABLE applications(id TEXT PRIMARY KEY, job_id TEXT, status TEXT);
    CREATE TABLE audit_events(id TEXT PRIMARY KEY, actor_type TEXT, action TEXT, entity_type TEXT, entity_id TEXT, metadata_json TEXT, created_at INTEGER);
  `);
  const repository = new JobRepository({ db });
  function Add(id: string, changes: Record<string, unknown> = {}) {
    const job = { id, company: 'Avery科技', title: '工程师', city: '上海市·浦东新区', salary: '25-35K·13薪',
      experience: '3 到 5 年', education: '本科及以上', companySize: '100-499人', channel: 'company_website',
      jobSeekingType: 'social_recruitment', favorite: false, jd: '负责 Agent 研发', ...changes };
    repository.Upsert(job);
    // 固定时间以证明同分同时间分页仍稳定。
    db.prepare('UPDATE jobs SET created_at = 1000 WHERE id = ?').run(id);
    return job;
  }
  const Ids = (input: JobQueryInput = {}) => repository.Query(input).items.map((job) => job.id);
  return { db, repository, Add, Ids };
}

describe('岗位库共享查询', () => {
  it('名称、企业与 JD 大小写不敏感，渠道与关键词 AND，空关键词不限制', () => {
    const { Add, Ids } = Fixture();
    Add('a', { channel: 'boss_zhipin' });
    Add('b', { title: 'Frontend', jd: '网页研发' });
    Add('c', { company: 'Other', title: '运营', jd: '运营职责' });
    expect(Ids({ keyword: ' aGeNt ', channels: ['boss_zhipin'] })).toEqual(['a']);
    expect(Ids({ keyword: 'FRONTEND' })).toEqual(['b']);
    expect(Ids({ keyword: 'AVERY' })).toEqual(['a', 'b']);
    expect(Ids({ keyword: '   ' })).toEqual(['a', 'b', 'c']);
    expect(Ids({ keyword: '不存在' })).toEqual([]);
    expect(Ids({ keyword: '上海' })).toEqual([]);
    expect(Ids({ keyword: '%' })).toEqual([]);
    expect(Ids({ keyword: "' OR 1=1 --" })).toEqual([]);
  });

  it('多选维度 OR，不同维度 AND，并识别来源字段与旧英文/中文枚举', () => {
    const { Add, Ids, db } = Fixture();
    Add('a', { channel: 'boss_zhipin', jobSeekingType: 'intern' });
    Add('b', { city: '深圳市', jobSeekingType: 'campus_recruitment', experience: '应届生' });
    Add('c', { channel: 'other', city: '杭州' });
    Add('legacy');
    const row = db.prepare('SELECT payload_json FROM jobs WHERE id = ?').get('legacy');
    const payload = JSON.parse(row.payload_json);
    delete payload.jobSeekingType;
    payload.employmentType = '正式工';
    db.prepare('UPDATE jobs SET channel = ?, payload_json = ? WHERE id = ?').run('company_website', JSON.stringify(payload), 'legacy');
    expect(Ids({ channels: ['boss_zhipin', 'company_website'], cities: ['上海', '深圳'], jobSeekingTypes: ['intern', 'campus_recruitment'] })).toEqual(['a', 'b']);
    expect(Ids({ experiences: ['fresh', '3-5'], educations: ['bachelor'], companySizes: ['100-499'] })).toEqual(['a', 'b', 'c', 'legacy']);
    expect(Ids({ jobSeekingTypes: ['social_recruitment'] })).toEqual(['c', 'legacy']);
  });

  it('条件开启时排除缺失字段，不从 JD 或其他岗位猜测；不筛选时保留旧岗位', () => {
    const { Add, Ids } = Fixture();
    Add('known');
    Add('unknown', { salary: undefined, city: '', education: undefined, companySize: undefined, experience: '', jd: '本科，1000人，上海，30K' });
    expect(Ids()).toEqual(['known', 'unknown']);
    for (const input of [{ minMonthlySalary: 15000 }, { cities: ['上海'] }, { experiences: ['3-5'] }, { educations: ['bachelor'] }, { companySizes: ['100-499'] }] as JobQueryInput[]) {
      expect(Ids(input)).toEqual(['known']);
    }
  });

  it('多选公司规模在同组取并集，并与学历条件取交集', () => {
    const { Add, Ids } = Fixture();
    Add('small', { companySize: '20-99人' });
    Add('medium', { companySize: '100-499人' });
    Add('large', { companySize: '1000人以上' });
    Add('other-education', { companySize: '20-99人', education: '硕士' });
    expect(Ids({ companySizes: ['20-99', '100-499'], educations: ['bachelor'] })).toEqual(['medium', 'small']);
  });

  it('只用可解析月薪下限，日薪/年薪/面议不满足薪资门槛', () => {
    const { Add, Ids } = Fixture();
    Add('a', { salary: '20-30K' });
    Add('b', { salary: '2.5-3.5万/月' });
    Add('c', { salary: '500元/天' });
    Add('d', { salary: '40万元/年' });
    Add('e', { salary: '面议' });
    expect(Ids({ minMonthlySalary: 25000 })).toEqual(['b']);
  });

  it('四种视图共享条件，收藏不等于投递，多份投递不重复，已打招呼计为已投递', () => {
    const { Add, Ids, db, repository } = Fixture();
    Add('applied', { favorite: true });
    Add('saved', { favorite: true });
    Add('pending');
    Add('boss', { contactStatus: 'contacted' });
    Add('irrelevant', { jd: '完全无关', company: '其他', title: '财务' });
    db.prepare('INSERT INTO applications VALUES (?, ?, ?)').run('app1', 'applied', '已投递');
    db.prepare('INSERT INTO applications VALUES (?, ?, ?)').run('app2', 'applied', 'interviewing');
    db.prepare('INSERT INTO applications VALUES (?, ?, ?)').run('app3', 'saved', '已收藏');
    expect(Ids({ view: 'all', keyword: 'agent' })).toEqual(['applied', 'boss', 'pending', 'saved']);
    expect(Ids({ view: 'favorites', keyword: 'agent' })).toEqual(['applied', 'saved']);
    expect(Ids({ view: 'pending', keyword: 'agent' })).toEqual(['pending', 'saved']);
    expect(Ids({ view: 'applied', keyword: 'agent' })).toEqual(['applied', 'boss']);
    repository.SetFavorite('pending', true, 1);
    expect(Ids({ view: 'favorites', keyword: 'agent' })).toEqual(['applied', 'pending', 'saved']);
    db.prepare('DELETE FROM applications WHERE job_id = ?').run('applied');
    expect(Ids({ view: 'applied' })).toEqual(['boss']);
  });

  it('同分同时间稳定分页，空末页回到有效页，不遗漏不重复', () => {
    const { Add, repository } = Fixture();
    for (let i = 24; i >= 0; i--) Add(`job-${String(i).padStart(2, '0')}`, { matchScore: 90 });
    const pages = [1, 2, 3].map((page) => repository.Query({ page, pageSize: 10 }));
    expect(pages.map((result) => [result.total, result.pageCount, result.items.length])).toEqual([[25, 3, 10], [25, 3, 10], [25, 3, 5]]);
    const ids = pages.flatMap((result) => result.items.map((job) => job.id));
    expect(ids).toEqual([...ids].sort());
    expect(new Set(ids).size).toBe(25);
    expect(repository.Query({ page: 999, pageSize: 10 }).page).toBe(3);
    ids.slice(20).forEach((id) => repository.Delete(id));
    expect(repository.Query({ page: 3, pageSize: 10 })).toMatchObject({ total: 20, page: 2, pageCount: 2 });
    expect(repository.Query({ keyword: 'no-result', page: 999 })).toMatchObject({ total: 0, items: [], page: 1, pageCount: 0 });
  });

  it('分数降序、未知分数置后，按入库时间排序；排除到期与已删除岗位', () => {
    const { Add, Ids, db, repository } = Fixture();
    Add('low', { matchScore: 20 });
    Add('high', { matchScore: 95 });
    Add('unknown');
    Add('expired', { deadline: Date.now() - 1000 });
    Add('deleted');
    repository.Delete('deleted');
    db.prepare('UPDATE jobs SET created_at = 2000 WHERE id = ?').run('unknown');
    expect(Ids()).toEqual(['high', 'low', 'unknown']);
    expect(Ids({ sort: 'created' })).toEqual(['unknown', 'high', 'low']);
    expect(repository.FindById('expired')).toMatchObject({ id: 'expired' });
  });

  it('筛选不改 payload、revision、收藏与投递；编辑后按最新事实查询且保持元数据', () => {
    const { Add, Ids, db, repository } = Fixture();
    Add('a', { favorite: true, platform: 'beisen', sourceId: 'source-a' });
    const before = db.prepare('SELECT * FROM jobs').all();
    repository.Query({ channels: ['company_website'], minMonthlySalary: 25000 });
    expect(db.prepare('SELECT * FROM jobs').all()).toEqual(before);
    repository.Upsert({ ...repository.FindById('a'), title: '设计师' }, 1);
    expect(Ids({ keyword: '设计师' })).toEqual(['a']);
    expect(repository.Query({ view: 'favorites' }).items[0]).toMatchObject({ favorite: true, sourceId: 'source-a', platform: 'beisen', revision: 2 });
    repository.Delete('a');
    expect(Ids()).toEqual([]);
  });

  it('分数与入库时间支持双向排序，未知分数始终置后，零分保持有效', () => {
    const { Add, Ids, db } = Fixture();
    Add('zero', { matchScore: 0 });
    Add('high', { matchScore: 95 });
    Add('unknown');
    db.prepare('UPDATE jobs SET created_at = 2000 WHERE id = ?').run('high');
    db.prepare('UPDATE jobs SET created_at = 3000 WHERE id = ?').run('unknown');
    expect(Ids({ sort: 'score', sortDirection: 'asc' })).toEqual(['zero', 'high', 'unknown']);
    expect(Ids({ sort: 'score', sortDirection: 'desc' })).toEqual(['high', 'zero', 'unknown']);
    expect(Ids({ sort: 'created', sortDirection: 'asc' })).toEqual(['zero', 'high', 'unknown']);
    expect(Ids({ sort: 'created', sortDirection: 'desc' })).toEqual(['unknown', 'high', 'zero']);
  });

  it('薪资按月薪下限全库排序后分页，同薪资结果稳定，非月薪与面议始终置后', () => {
    const { Add, Ids, repository } = Fixture();
    Add('low', { salary: '15-25K' });
    Add('high-a', { salary: '3-4万/月' });
    Add('high-b', { salary: '30000-40000元/月' });
    Add('daily', { salary: '500元/天' });
    Add('negotiable', { salary: '面议' });
    Add('annual', { salary: '40万元/年' });
    expect(Ids({ sort: 'salary', sortDirection: 'asc' })).toEqual(['low', 'high-a', 'high-b', 'annual', 'daily', 'negotiable']);
    const pages = [1, 2, 3].map((page) => repository.Query({ sort: 'salary', sortDirection: 'desc', page, pageSize: 2 }));
    expect(pages.flatMap((page) => page.items.map((job) => job.id))).toEqual(['high-a', 'high-b', 'low', 'annual', 'daily', 'negotiable']);
  });
});

describe('岗位库批量删除', () => {
  it('去重删除所选岗位、保留其他岗位与投递记录，并保留墓碑和审计', () => {
    const { Add, Ids, db, repository } = Fixture();
    Add('a'); Add('b'); Add('keep');
    db.prepare('INSERT INTO applications(id, job_id, status) VALUES (?, ?, ?)').run('application-a', 'a', '已投递');
    const beforeApplication = db.prepare('SELECT * FROM applications').all();
    expect(repository.DeleteMany(['a', 'a', 'b', 'missing'])).toEqual({ ids: ['a', 'b'] });
    expect(Ids()).toEqual(['keep']);
    expect(db.prepare('SELECT * FROM applications').all()).toEqual(beforeApplication);
    expect(db.prepare('SELECT deleted_at FROM jobs WHERE id = ?').get('a').deleted_at).toBeTypeOf('number');
    const audit = db.prepare("SELECT entity_id, metadata_json FROM audit_events WHERE action = 'delete' ORDER BY entity_id").all();
    expect(audit).toEqual([{ entity_id: 'a', metadata_json: '{"batch":true}' }, { entity_id: 'b', metadata_json: '{"batch":true}' }]);
    expect(repository.DeleteMany(['a', 'b'])).toEqual({ ids: [] });
  });

  it('非法参数整体拒绝，不删除有效前缀；删除全部后分页回到第1页', () => {
    const { Add, repository } = Fixture();
    for (let index = 0; index < 25; index += 1) Add(`job-${index}`);
    for (const ids of [[], ['job-0', ''], ['job-0', 1], ['x'.repeat(201)], Array(10001).fill('job-0'), null]) {
      expect(() => repository.DeleteMany(ids as string[])).toThrow('批量删除岗位参数无效');
      expect(repository.Query({}).total).toBe(25);
    }
    repository.DeleteMany(Array.from({ length: 25 }, (_, index) => `job-${index}`));
    expect(repository.Query({ page: 2 })).toMatchObject({ items: [], total: 0, page: 1, pageCount: 0 });
  });

  it('后续岗位删除失败时回滚整批，不留下部分删除或成功审计', () => {
    const { Add, Ids, db, repository } = Fixture();
    Add('a'); Add('b');
    db.exec(`CREATE TRIGGER reject_b BEFORE UPDATE OF deleted_at ON jobs WHEN NEW.id = 'b'
      BEGIN SELECT RAISE(ABORT, 'delete failed'); END;`);
    expect(() => repository.DeleteMany(['a', 'b'])).toThrow('delete failed');
    expect(Ids()).toEqual(['a', 'b']);
    expect(db.prepare("SELECT count(*) AS total FROM audit_events WHERE action = 'delete'").get().total).toBe(0);
  });

  it('批量删除IPC进入写协议，并在调用业务层前校验数组、ID及数量', async () => {
    const DeleteJobs = vi.fn((ids: string[]) => ({ ids }));
    const backend = CreateBackend({ container: { jobs: { DeleteJobs } } });
    expect(ReadOnlyChannels.has('workspace:jobs-delete-many')).toBe(false);
    expect(WriteCommandChannels.has('workspace:jobs-delete-many')).toBe(true);
    for (const args of [[], [[]], [['a', '']], [['a', 1]], [Array(10001).fill('a')], [['a'], 'extra']]) {
      expect(await backend.HandleCommand('workspace:jobs-delete-many', 'invalid', undefined, ...args)).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } });
    }
    expect(DeleteJobs).not.toHaveBeenCalled();
    expect(await backend.HandleCommand('workspace:jobs-delete-many', 'delete', 'delete-key', ['a', 'b'])).toMatchObject({ ok: true, data: { ids: ['a', 'b'] } });
    expect(DeleteJobs).toHaveBeenCalledWith(['a', 'b']);
  });
});

describe('月薪解析与岗位查询契约', () => {
  it.each([
    ['25k 到 40k', 25000], ['25-35K·13薪', 25000], ['2.5万/月', 25000], ['25000-30000元/月', 25000],
    ['月薪25,000元', 25000], ['15K以上', 15000], ['30K-20K', null], ['25000元', null],
    ['500元/天', null], ['30万/年', null], ['面议', null], ['', null], [undefined, null],
  ])('月薪 %s => %s', (input, expected) => expect(MonthlySalaryMinimum(input)).toBe(expected));

  it('查询有确定默认值，拒绝非法枚举、页码、页大小与未知字段', () => {
    expect(ParseJobQuery({})).toMatchObject({ page: 1, pageSize: 20, sort: 'score', sortDirection: 'desc', view: 'all', channels: [] });
    expect(() => ParseJobQuery({ sortDirection: 'DESC; DROP TABLE jobs' })).toThrow('岗位筛选参数无效');
    for (const input of [{ page: 0 }, { page: 1.5 }, { pageSize: 101 }, { channels: ['invalid'] }, { keyword: 5 }, { keyword: 'x'.repeat(501) }, { view: 'unknown' }, { sort: 'arbitrary SQL' }, { foo: true }]) {
      expect(() => ParseJobQuery(input)).toThrow('岗位筛选参数无效');
    }
  });

  it('IPC 查询只读、不进入写幂等协议；参数校验后才调用业务 Worker 门面', async () => {
    const QueryJobs = vi.fn(() => ({ items: [], total: 0, page: 1, pageSize: 20, pageCount: 0 }));
    const backend = CreateBackend({ container: { jobs: { QueryJobs } } });
    expect(ReadOnlyChannels.has('workspace:jobs-query')).toBe(true);
    expect(WriteCommandChannels.has('workspace:jobs-query')).toBe(false);
    expect(await backend.HandleCommand('workspace:jobs-query', 'read-1', undefined, {})).toMatchObject({ ok: true, data: { total: 0 } });
    expect(QueryJobs).toHaveBeenCalledWith(ParseJobQuery({}));
    for (const args of [[{ pageSize: 1000 }], [], [{}, {}]]) {
      expect(await backend.HandleCommand('workspace:jobs-query', 'bad', undefined, ...args)).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } });
    }
    expect(QueryJobs).toHaveBeenCalledTimes(1);
  });
});
