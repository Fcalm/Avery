import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { JobCollectionInputSchema, type CollectedJob, type JobCollectionTask, type JobImportResult, type RecruitmentSource } from '@avery/contracts';
import { JobRepository } from '../../../apps/backend/src/electron/repositories/job-repository';
import { JobLibraryCollectionService, NormalizeCollectedAtsJob } from '../../../apps/backend/src/electron/backend/job-library-collection-service';
import { BuiltinRecruitmentSources } from '../../../apps/backend/src/electron/backend/recruitment-sources';
import { CollectBossJobsToLibrary } from '../../../apps/backend/src/electron/backend/job-collection-service';
import { CreateBackend, ReadOnlyChannels, WriteCommandChannels } from '../../../apps/backend/src/router';
import type { AtsSource, NormalizedJob, SourceResult } from '../../../apps/backend/src/electron/backend/ats/types';

const Database = createRequire(import.meta.url)('better-sqlite3');
const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
function Repository() {
  const db = new Database(':memory:'); cleanup.push(() => db.close());
  db.exec(`CREATE TABLE jobs(id TEXT PRIMARY KEY, payload_json TEXT NOT NULL, is_favorite INTEGER NOT NULL, channel TEXT NOT NULL, match_score REAL, deadline INTEGER, revision INTEGER, created_at INTEGER, updated_at INTEGER, deleted_at INTEGER);
    CREATE TABLE applications(id TEXT PRIMARY KEY, job_id TEXT, status TEXT);
    CREATE TABLE audit_events(id TEXT PRIMARY KEY, actor_type TEXT, action TEXT, entity_type TEXT, entity_id TEXT, metadata_json TEXT, created_at INTEGER);`);
  return { db, repo: new JobRepository({ db }) };
}
function Job(id = '1', sourceId = BuiltinRecruitmentSources[0].sourceId): NormalizedJob {
  return { id: `beisen:tenant:${id}`, ats: 'beisen', tenant: 'tenant', atsJobId: id, sourceId,
    title: `开发工程师 ${id}`, company: '测试企业', sourceUrl: 'https://test.zhiye.com/', applicationUrl: `https://test.zhiye.com/job/${id}`,
    locations: ['上海'], description: '开发业务系统', requirements: '本科', salary: '20-30K', experience: '1-3年',
    rawHash: id, firstSeenAt: '2026-10-11T00:00:00Z', lastSeenAt: '2026-10-11T00:00:00Z', status: 'open' };
}
function Result(jobs: NormalizedJob[], extra: Partial<SourceResult> = {}): SourceResult {
  return { sourceId: jobs[0]?.sourceId ?? BuiltinRecruitmentSources[0].sourceId, ats: 'beisen', health: 'healthy', snapshotStatus: 'complete', transport: 'public_api',
    jobs, quarantine: [], errors: [], startedAt: '2026-10-11T00:00:00Z', finishedAt: '2026-10-11T00:00:01Z', durationMs: 1000, requestCount: 1, receivedCount: jobs.length, ...extra };
}
async function Service(overrides: Partial<ConstructorParameters<typeof JobLibraryCollectionService>[0]> = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'avery-collection-')); cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const { repo, db } = Repository();
  const run = vi.fn(async () => Result(Array.from({ length: 50 }, (_, i) => Job(String(i)))));
  const service = new JobLibraryCollectionService({ workspacePath: directory, sources: [BuiltinRecruitmentSources[0]], runner: { Run: run },
    importJobs: async (batch) => repo.ImportCollectedJobs(batch), collectBoss: async () => { throw new Error('测试不调用浏览器'); }, ...overrides });
  cleanup.push(() => service.Close());
  await service.Initialize();
  return { service, directory, repo, db, run };
}
async function Finished(service: JobLibraryCollectionService) {
  // 多来源用例逐段真实落盘；等待异步收尾而非用默认1秒给业务任务设额外期限。
  await vi.waitFor(async () => expect((await service.GetJobCollectionTask())?.status).not.toBe('running'), { timeout: 5000 });
  return (await service.GetJobCollectionTask())!;
}

describe('批量采集入库', () => {
  it('ATS正文保留纯文本换行及HTML段落/列表分行，不输出原始HTML或脚本', () => {
    const job = Job('formatted');
    job.description = '<p>岗位职责</p><ul><li>设计产品<br>跟进研发</li><li>沟通协作</li></ul><script>不要显示</script>';
    job.requirements = '任职要求\r\n1. 本科在读\r\n2. 熟悉产品设计';
    const jd = NormalizeCollectedAtsJob(job).job.jd;
    expect(jd).toContain('岗位职责\n'); expect(jd).toContain('设计产品\n跟进研发');
    expect(jd).toContain('任职要求\n1. 本科在读\n2. 熟悉产品设计');
    expect(jd).not.toContain('<'); expect(jd).not.toContain('不要显示');
    const { repo } = Repository(); repo.ImportCollectedJobs([NormalizeCollectedAtsJob(job)]);
    expect(repo.Query({}).items[0].jd).toBe(jd);
  });
  it('超过10个岗位直接落盘，重复采集不新增，未投递视图一致，无简历或模型依赖', async () => {
    const { service, repo } = await Service();
    await service.StartJobCollection({ channel: 'company_website', targetCount: 37 });
    expect(await Finished(service)).toMatchObject({ status: 'completed', collected: 37, inserted: 37, existing: 0 });
    expect(repo.Query({ view: 'pending', pageSize: 100 }).total).toBe(37);
    await service.StartJobCollection({ channel: 'company_website', targetCount: 37 });
    expect(await Finished(service)).toMatchObject({ collected: 37, inserted: 0, existing: 37 });
    expect(repo.ListAll()).toHaveLength(37);
  });
  it('更新来源事实，保留收藏、分数、用户编辑、备注及已投递状态，墓碑不复活', () => {
    const { repo, db } = Repository();
    const entry = NormalizeCollectedAtsJob(Job()); repo.ImportCollectedJobs([entry]);
    const old = repo.FindById(entry.job.id);
    repo.Upsert({ ...old, title: '用户标题', jd: '', favorite: true, matchScore: 95, note: '用户备注', contactStatus: 'contacted' }, old.revision);
    db.prepare('INSERT INTO applications VALUES (?, ?, ?)').run('a', entry.job.id, '已投递');
    const updated = { ...entry, job: { ...entry.job, title: '来源新标题', city: '北京', jd: '来源新JD' } };
    expect(repo.ImportCollectedJobs([updated]).items[0].status).toBe('existing');
    expect(repo.FindById(entry.job.id)).toMatchObject({ title: '用户标题', jd: '', city: '北京', favorite: true, matchScore: 95, note: '用户备注', contactStatus: 'contacted' });
    expect(repo.Query({ view: 'applied' }).total).toBe(1);
    // 来源偶然与用户标题同值也不会解除用户编辑保护。
    repo.ImportCollectedJobs([{ ...updated, job: { ...updated.job, title: '用户标题' } }]);
    repo.ImportCollectedJobs([updated]); expect(repo.FindById(entry.job.id).title).toBe('用户标题');
    repo.Delete(entry.job.id); expect(repo.ImportCollectedJobs([updated]).items[0].status).toBe('deleted');
    expect(repo.Query({}).total).toBe(0);
  });
  it('兼容旧URL身份，隔离坏记录，不推测缺失字段，同岗位跨来源去重', () => {
    const { repo } = Repository(); const entry = NormalizeCollectedAtsJob(Job());
    repo.Upsert({ ...entry.job, id: 'legacy-job', title: '旧用户标题', note: '旧备注' });
    const invalid = { ...entry, identity: 'bad', job: { ...entry.job, id: 'bad', title: '' } };
    const imported = repo.ImportCollectedJobs([entry, invalid]);
    expect(imported.items.map((item) => item.status)).toEqual(['existing', 'failed']);
    expect(imported.items[0].jobId).toBe('legacy-job');
    expect(repo.ListAll()[0]).toMatchObject({ title: '旧用户标题', note: '旧备注' });
    const nextSource = { ...entry, sourceId: 'source-other', job: { ...entry.job, id: 'different-generated-id', url: 'https://test.zhiye.com/another' } };
    expect(repo.ImportCollectedJobs([nextSource]).items[0].jobId).toBe('legacy-job');
    expect(repo.ListAll()).toHaveLength(1);
    expect(repo.ListAll()[0].jobSeekingType).toBeUndefined();
    repo.Delete('legacy-job'); expect(repo.ImportCollectedJobs([entry]).items[0].status).toBe('deleted');
  });
  it('连续分段自动续跑，累计返回去重；关键词筛选不改变来源快照', async () => {
    const jobs = Array.from({ length: 40 }, (_, i) => Job(String(i)));
    const first = Result(jobs.slice(0, 12), { snapshotStatus: 'partial', continuation: { signature: 'x', startedAt: new Date().toISOString(), firstPageHash: 'x', nextPage: 2, receivedCount: 12, jobs: jobs.slice(0, 12) } });
    const run = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(Result(jobs));
    const { service, repo } = await Service({ runner: { Run: run } });
    await service.StartJobCollection({ channel: 'company_website', keyword: '开发', targetCount: 31 });
    expect(await Finished(service)).toMatchObject({ status: 'completed', collected: 31, inserted: 31 });
    expect(run).toHaveBeenCalledTimes(2); expect(repo.Query({}).total).toBe(31); expect(first.snapshotStatus).toBe('partial');
  });
  it.each(['company_website', 'boss_zhipin'] as const)('%s 入库前按求职类型和学历 AND 筛选，跳过的岗位不占目标数量', async (channel) => {
    const jobs: NormalizedJob[] = [
      { ...Job('0'), jobType: 'intern', education: '本科' },
      { ...Job('1'), jobType: 'campus_recruitment', education: '硕士' },
      { ...Job('2'), education: '本科', description: '校招本科岗位' },
      { ...Job('3'), jobType: 'campus_recruitment', education: undefined, requirements: '本科' },
      { ...Job('4'), jobType: 'social_recruitment', education: '本科' },
      { ...Job('5'), jobType: 'campus_recruitment', education: '本科及以上' },
      { ...Job('6'), jobType: 'campus_recruitment', education: 'bachelor' },
    ];
    const snapshot = Result(jobs);
    const original = structuredClone(snapshot);
    const { service, repo } = await Service({
      runner: { Run: async () => snapshot },
      collectBoss: async ({ accept }) => {
        for (const job of jobs) {
          const entry = NormalizeCollectedAtsJob(job);
          if (!await accept({ ...entry, platform: 'boss_zhipin', job: { ...entry.job, channel: 'boss_zhipin' } })) break;
        }
      },
    });
    const filters = { jobSeekingTypes: ['campus_recruitment'] as const, educations: ['bachelor'] as const };
    await service.StartJobCollection({ channel, keyword: '开发', targetCount: 2, jobSeekingTypes: [...filters.jobSeekingTypes], educations: [...filters.educations],
      ...(channel === 'boss_zhipin' ? { city: '全国' } : {}),
    });
    const task = await Finished(service);
    expect(task).toMatchObject({ status: 'completed', scanned: 7, collected: 2, inserted: 2,
      request: { jobSeekingTypes: ['campus_recruitment'], educations: ['bachelor'] } });
    expect(repo.ListAll().map((job) => job.title).sort()).toEqual(['开发工程师 5', '开发工程师 6']);
    expect(repo.Query({ channels: [channel], jobSeekingTypes: [...filters.jobSeekingTypes], educations: [...filters.educations] }).total).toBe(2);
    expect(task.warnings).toContain('检查过程筛除：关键词 0，求职类型 3（未知 1），学历 2（未知 1）。');
    expect(snapshot).toEqual(original);
  });
  it('BOSS筛选参数透传给平台，重复来源中的筛除项不会重复计数', async () => {
    const invalid = { ...Job('0'), jobType: 'intern' as const, education: '不限' };
    const run = vi.fn().mockResolvedValueOnce(Result([invalid], { snapshotStatus: 'partial', continuation: { signature: 'x', startedAt: new Date().toISOString(), firstPageHash: 'x', nextPage: 2, jobs: [invalid] } }))
      .mockResolvedValueOnce(Result([invalid, { ...Job('1'), jobType: 'intern', education: '本科' }]));
    const collectBoss = vi.fn(async () => undefined);
    const { service } = await Service({ runner: { Run: run }, collectBoss });
    await service.StartJobCollection({ channel: 'company_website', targetCount: 1, jobSeekingTypes: ['intern'], educations: ['bachelor'] });
    expect((await Finished(service)).warnings).toContain('检查过程筛除：关键词 0，求职类型 0（未知 0），学历 1（未知 1）。');
    await service.StartJobCollection({ channel: 'boss_zhipin', keyword: '产品', city: '广州', targetCount: 1, jobSeekingTypes: ['intern'], educations: ['bachelor'] });
    await Finished(service);
    expect(collectBoss).toHaveBeenCalledWith(expect.objectContaining({ jobSeekingTypes: ['intern'], educations: ['bachelor'] }));
  });
  it('求职类型或学历单独生效；同维度多选 OR，字段未知或不限时不猜测，默认保持不限', async () => {
    const jobs: NormalizedJob[] = [
      { ...Job('0'), jobType: 'intern', education: '专科及以上' },
      { ...Job('1'), jobType: 'campus_recruitment', education: '本科' },
      { ...Job('2'), jobType: 'social_recruitment', education: '硕士' },
      { ...Job('3'), education: '博士' },
      { ...Job('4'), jobType: 'campus_recruitment', education: '不限' },
    ];
    const { service, repo } = await Service({ runner: { Run: async () => Result(jobs) } });
    await service.StartJobCollection({ channel: 'company_website', targetCount: 10, jobSeekingTypes: ['intern', 'campus_recruitment'] });
    expect(await Finished(service)).toMatchObject({ status: 'completed_with_shortage', collected: 3 });
    expect(repo.ListAll().map((job) => job.title).sort()).toEqual(['开发工程师 0', '开发工程师 1', '开发工程师 4']);
    await service.StartJobCollection({ channel: 'company_website', targetCount: 10, educations: ['college', 'doctor'] });
    expect(await Finished(service)).toMatchObject({ status: 'completed_with_shortage', collected: 2, inserted: 1, existing: 1 });
    await service.StartJobCollection({ channel: 'company_website', targetCount: 10 });
    expect(await Finished(service)).toMatchObject({ collected: 5, inserted: 1, existing: 4, request: { jobSeekingTypes: [], educations: [] } });
    expect(repo.ListAll()).toHaveLength(5);
  });
  it('不限制10个企业来源，一个来源失败不丢已落盘批次，来源耗尽给出不足摘要', async () => {
    const sources = Array.from({ length: 12 }, (_, i) => ({ ...BuiltinRecruitmentSources[0], sourceId: `source-${i}`, company: `企业${i}` }));
    const run = vi.fn(async (source: AtsSource) => {
      if (source.id === 'source-1') throw new Error('来源访问失败');
      return Result([Job(source.id, source.id)]);
    });
    const { service, repo } = await Service({ sources, runner: { Run: run } });
    await service.StartJobCollection({ channel: 'company_website', targetCount: 20 });
    expect(await Finished(service)).toMatchObject({ status: 'completed_with_shortage', collected: 11, inserted: 11 });
    expect(repo.Query({}).total).toBe(11); expect(run).toHaveBeenCalledTimes(12);
  });
  it('取消等待在途写入计数完成，不回滚已提交批次，禁止重复启动', async () => {
    let started!: () => void, release!: () => void;
    const inWrite = new Promise<void>((resolve) => { started = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const writes: CollectedJob[] = [];
    const { service } = await Service({ importJobs: async (batch) => { started(); await gate; writes.push(...batch); return { items: batch.map((entry) => ({ identity: entry.identity, jobId: entry.job.id, status: 'inserted' })) }; } });
    const task = await service.StartJobCollection({ channel: 'company_website', targetCount: 40 });
    await inWrite;
    await expect(service.StartJobCollection({ channel: 'company_website' })).rejects.toMatchObject({ code: 'RESOURCE_LOCKED' });
    const cancel = service.CancelJobCollection(task.taskId); release();
    expect(await cancel).toMatchObject({ status: 'cancelled', inserted: 25, collected: 25 });
    expect(writes).toHaveLength(25);
  });
  it('最终记录尚未保存时不发布终态，紧接着启动等待旧任务收尾而不是误报占用', async () => {
    const { service } = await Service();
    let started!: () => void, release!: () => void;
    const finalizing = new Promise<void>((resolve) => { started = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const internal = service as unknown as { Update(task: JobCollectionTask): Promise<void> };
    const originalUpdate = internal.Update.bind(service);
    let first = true;
    vi.spyOn(internal, 'Update').mockImplementation(async (task) => {
      if (first && task.status !== 'running') { first = false; started(); await gate; }
      await originalUpdate(task);
    });
    const old = await service.StartJobCollection({ channel: 'company_website', targetCount: 1 });
    await finalizing;
    let published = false;
    const reading = service.GetJobCollectionTask(old.taskId).then((task) => { published = true; return task; });
    const next = service.StartJobCollection({ channel: 'company_website', targetCount: 1 });
    await Promise.resolve(); expect(published).toBe(false);
    release();
    expect(await reading).toMatchObject({ status: 'completed', collected: 1 });
    expect((await next).taskId).not.toBe(old.taskId);
    expect(await Finished(service)).toMatchObject({ status: 'completed', inserted: 0, existing: 1 });
  });
  it('BOSS 后续失败时保存不足一个批次的已确认岗位，错误不冒充采集完成', async () => {
    const { service, repo } = await Service({ collectBoss: async ({ accept }) => {
      for (let index = 0; index < 5; index++) await accept(NormalizeCollectedAtsJob(Job(String(index))));
      throw new Error('BOSS 登录失效');
    } });
    await service.StartJobCollection({ channel: 'boss_zhipin', keyword: '开发', city: '全国', targetCount: 30 });
    const task = await Finished(service);
    expect(task).toMatchObject({ status: 'failed', inserted: 5, collected: 5 });
    expect(task.sources[0]).toMatchObject({ status: 'failed', received: 5 }); expect(repo.ListAll()).toHaveLength(5);
  });
  it('单条坏记录隔离后由更多有效岗位补足目标，数量达到时不误报不足', async () => {
    const { service, repo } = await Service({ runner: { Run: async () => Result([{ ...Job('0'), company: '' }, Job('1'), Job('2')]) } });
    await service.StartJobCollection({ channel: 'company_website', targetCount: 2 });
    expect(await Finished(service)).toMatchObject({ status: 'completed', collected: 2, failedWrites: 1 });
    expect(repo.ListAll()).toHaveLength(2);
  });
  it('持久保存来源启停，重启恢复结果；异常退出任务标记中断', async () => {
    const { service, directory } = await Service();
    await service.SetRecruitmentSourceEnabled(BuiltinRecruitmentSources[0].sourceId, false);
    await expect(service.StartJobCollection({ channel: 'company_website' })).rejects.toThrow('没有可用');
    await service.SetRecruitmentSourceEnabled(BuiltinRecruitmentSources[0].sourceId, true);
    await service.StartJobCollection({ channel: 'company_website', targetCount: 12 }); await Finished(service); await service.Close();
    const path = join(directory, 'job-collection', 'state.json'); const state = JSON.parse(await readFile(path, 'utf8'));
    state.tasks[0].status = 'running'; await writeFile(path, JSON.stringify(state));
    const restarted = new JobLibraryCollectionService({ workspacePath: directory, importJobs: async () => ({ items: [] }), collectBoss: async () => undefined });
    cleanup.push(() => restarted.Close());
    expect(await restarted.GetJobCollectionTask()).toMatchObject({ status: 'interrupted', collected: 12 });
    expect((await restarted.ListRecruitmentSources())[0].enabled).toBe(true);
  });
  it('总期限中止无进展来源，不产生后台静默写入', async () => {
    const run = vi.fn(async (_source, signal: AbortSignal): Promise<SourceResult> => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('超时')), { once: true })));
    const write = vi.fn(async (): Promise<JobImportResult> => ({ items: [] }));
    const { service } = await Service({ runner: { Run: run }, importJobs: write, taskTimeoutMs: () => 20 });
    await service.StartJobCollection({ channel: 'company_website' });
    expect(await Finished(service)).toMatchObject({ status: 'timed_out', inserted: 0 }); expect(write).not.toHaveBeenCalled();
  });
  it('连续三段检查点不变停止；空岗位完成不足，所有来源失败不伪报成功', async () => {
    const partial = Result([Job()], { snapshotStatus: 'partial', continuation: { signature: 'x', firstPageHash: 'x', startedAt: new Date().toISOString(), nextPage: 2, jobs: [Job()] } });
    const { service } = await Service({ runner: { Run: async () => partial } });
    await service.StartJobCollection({ channel: 'company_website' });
    await vi.waitFor(async () => expect((await service.GetJobCollectionTask())?.status).toBe('completed_with_shortage'), { timeout: 5000 });
    expect((await service.GetJobCollectionTask())?.sources[0].error).toContain('三段');
    const empty = await Service({ runner: { Run: async () => Result([]) } });
    await empty.service.StartJobCollection({ channel: 'company_website' }); expect((await Finished(empty.service)).status).toBe('completed_with_shortage');
    const failed = await Service({ runner: { Run: async () => { throw new Error('不支持'); } } });
    await failed.service.StartJobCollection({ channel: 'company_website' }); expect((await Finished(failed.service)).status).toBe('failed');
  });
  it('IPC Schema、写命令幂等标记与只读进度保持一致', async () => {
    expect(JobCollectionInputSchema.safeParse({ channel: 'boss_zhipin', keyword: '研发' }).success).toBe(false);
    expect(JobCollectionInputSchema.safeParse({ channel: 'company_website', targetCount: 1001 }).success).toBe(false);
    expect(WriteCommandChannels.has('workspace:job-collection-start')).toBe(true);
    expect(ReadOnlyChannels.has('workspace:job-collection-task')).toBe(true);
    const call = vi.fn(); const backend = CreateBackend({ container: { jobCollection: { StartJobCollection: call } } });
    expect((await backend.HandleCommand('workspace:job-collection-start', 'invalid', undefined, { channel: 'company_website', targetCount: '100' })).ok).toBe(false);
    expect(call).not.toHaveBeenCalled();
    expect(BuiltinRecruitmentSources.map((source) => source.platform)).toEqual(expect.arrayContaining(['beisen', 'moka', 'hotjob']));
  });
  it('新增条件使用岗位库枚举，非法格式在 IPC 入口拒绝；旧请求默认不限', async () => {
    expect(JobCollectionInputSchema.parse({ channel: 'company_website' })).toMatchObject({ jobSeekingTypes: [], educations: [] });
    const call = vi.fn();
    const backend = CreateBackend({ container: { jobCollection: { StartJobCollection: call } } });
    for (const filters of [{ jobSeekingTypes: ['full_time'] }, { jobSeekingTypes: 'intern' }, { educations: ['本科'] }, { educations: null }]) {
      const result = await backend.HandleCommand('workspace:job-collection-start', 'invalid-filter', undefined, { channel: 'company_website', ...filters });
      expect(result).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } });
    }
    expect(call).not.toHaveBeenCalled();
  });
  it('BOSS 页面采集复用浏览器只读提取与导航，不发送消息，不走候选缓存', async () => {
    const accepts: CollectedJob[] = [];
    const browser = { Prepare: vi.fn(async (input) => ({ toolName: input.toolName })), Execute: vi.fn(async () => ({ status: 'succeeded' })),
      EvaluateTrustedPage: vi.fn(async ({ expression }) => expression.includes('risk: null') ? { risk: null }
        : expression.includes('job-card-wrap') ? [{ title: '开发', company: '企业', url: '/job_detail/id1.html' }]
          : { title: '开发', company: '企业', jd: '开发岗位说明', url: 'https://www.zhipin.com/job_detail/id1.html' }) };
    await CollectBossJobsToLibrary(browser as never, { keyword: '开发', city: '全国', deadline: Date.now() + 10000, signal: new AbortController().signal,
      accept: async (entry) => { accepts.push(entry); return false; } });
    expect(accepts).toHaveLength(1); expect(accepts[0].job.id).toBe('job-boss-id1');
    expect(browser.Prepare.mock.calls.every(([input]) => input.toolName === 'BrowserNavigate')).toBe(true);
  });
  it('BOSS 超过单页使用回退保留列表状态，再通过新快照分页，不假设 URL page 参数', async () => {
    let page = 1, detail = false;
    const browser = {
      Prepare: vi.fn(async (input) => ({ toolName: input.toolName, canonicalArguments: input.arguments })),
      Execute: vi.fn(async ({ proposal }) => {
        if (proposal.toolName === 'BrowserNavigate') detail = String(proposal.canonicalArguments.url).includes('job_detail');
        if (proposal.toolName === 'BrowserGoBack') detail = false;
        if (proposal.toolName === 'BrowserClick') { expect(proposal.canonicalArguments).toMatchObject({ ref: 'e2', pageRevision: 1 }); page = 2; }
        return { status: 'succeeded', data: proposal.toolName === 'BrowserSnapshot' ? { pageRevision: 1, refs: { e2: { role: 'button', name: '2' } } } : {} };
      }),
      EvaluateTrustedPage: vi.fn(async ({ expression }) => expression.includes('risk: null') ? { risk: null }
        : expression.includes('job-card-wrap') ? Array.from({ length: 15 }, (_, i) => ({ title: '开发', company: '企业', url: `/job_detail/id${page}-${i}.html` }))
          : expression.includes('.options-pages') ? { hasNext: true }
          : (expect(detail).toBe(true), { title: '开发', company: '企业', jd: '开发岗位说明' })),
    };
    const accepted: CollectedJob[] = [];
    await CollectBossJobsToLibrary(browser as never, { keyword: '开发', city: '全国', deadline: Date.now() + 10000, signal: new AbortController().signal,
      accept: async (entry) => { accepted.push(entry); return accepted.length < 20; } });
    expect(accepted).toHaveLength(20); expect(new Set(accepted.map((entry) => entry.identity)).size).toBe(20);
    expect(browser.Prepare.mock.calls.some(([input]) => input.toolName === 'BrowserClick')).toBe(true);
  });
});
