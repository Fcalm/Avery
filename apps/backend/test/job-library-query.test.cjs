const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, rm, mkdir, writeFile, readFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { CreateBusinessStoreClient } = require('../dist/infra/business-store-client.js');
const { CreateBackend } = require('../dist/router.js');

// 使用隔离临时工作空间验证生产 Worker 和真实迁移，不打开或修改用户数据库。
test('岗位分页 IPC 经生产业务 Worker 查询，写入与投递变更后可读取最新结果', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'avery-job-query-'));
  const business = CreateBusinessStoreClient({ workspacePath: directory });
  try {
    const { methods } = await business.ready;
    assert.ok(methods.includes('QueryJobs'));
    assert.ok(methods.includes('ReadJobLibrary'));
    assert.ok(methods.includes('DeleteJobs'));
    for (let i = 0; i < 23; i++) {
      await business.UpsertJob({ id: `job-${String(i).padStart(2, '0')}`, company: '测试企业', title: `Agent 工程师 ${i}`,
        city: '上海', salary: '25-35K', experience: '3-5年', education: '本科', companySize: '100-499人',
        channel: 'company_website', jobSeekingType: 'social_recruitment', jd: 'Agent 研发', favorite: false, matchScore: 80 });
    }
    const backend = CreateBackend({ container: { jobs: {
      QueryJobs: (input) => business.QueryJobs(input),
      DeleteJobs: (ids) => business.DeleteJobs(ids),
    } } });
    const first = await backend.HandleCommand('workspace:jobs-query', 'page-1', undefined, { keyword: 'agent', pageSize: 20 });
    const second = await backend.HandleCommand('workspace:jobs-query', 'page-2', undefined, { keyword: 'agent', pageSize: 20, page: 2 });
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.equal(first.data.total, 23);
    assert.equal(first.data.items.length, 20);
    assert.equal(second.data.items.length, 3);
    assert.equal(new Set([...first.data.items, ...second.data.items].map((job) => job.id)).size, 23);
    await business.SetJobFavorite('job-00', true, 1);
    assert.equal((await business.QueryJobs({ view: 'favorites' })).items[0].id, 'job-00');
    await business.UpsertResume({ id: 'resume-1', name: '测试简历', content: '测试经历', targetRoles: [], summary: '' });
    await business.UpsertApplication({ id: 'app-1', jobId: 'job-00', resumeId: 'resume-1', status: 'applied', note: '' });
    assert.equal((await business.QueryJobs({ view: 'applied' })).total, 1);
    assert.equal((await business.QueryJobs({ view: 'pending' })).total, 22);
    const agentDetail = await business.ReadJobLibrary({ jobId: 'job-00' });
    assert.equal(agentDetail.total, 1);
    assert.deepEqual(agentDetail.items[0].applicationStatuses, ['applied']);
    await business.DeleteJob('job-00');
    assert.equal((await business.ReadJobLibrary({ jobId: 'job-00' })).total, 0);
    assert.equal((await business.QueryJobs({})).total, 22);
    assert.equal((await business.QueryJobs({ view: 'applied' })).total, 0);
    const deleted = await backend.HandleCommand('workspace:jobs-delete-many', 'batch-delete', 'batch-key', ['job-01', 'job-02', 'job-01']);
    assert.equal(deleted.ok, true);
    assert.deepEqual(deleted.data.ids, ['job-01', 'job-02']);
    assert.equal((await business.QueryJobs({ page: 2 })).total, 20);
    assert.equal((await business.QueryJobs({ page: 2 })).page, 1);
    assert.deepEqual(await business.DeleteJobs(['job-01', 'job-02']), { ids: [] });
    assert.equal((await business.LoadViewModel()).applications.length, 1);
  } finally {
    // 显式关闭数据库后再结束 Worker，避免 Windows 上未释放数据库句柄。
    await business.call('Close');
    business.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('岗位筛选 IPC 保留多选条件与双向排序，跨页按完整岗位库顺序返回', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'avery-job-sort-'));
  const business = CreateBusinessStoreClient({ workspacePath: directory });
  try {
    await business.ready;
    const jobs = [
      { id: 'low', salary: '15-25K', matchScore: 20, companySize: '20-99人' },
      { id: 'high', salary: '3-4万/月', matchScore: 90, companySize: '100-499人' },
      { id: 'unknown', salary: '面议', companySize: '20-99人' },
      { id: 'excluded', salary: '50-60K', matchScore: 99, companySize: '1000人以上' },
    ];
    for (const job of jobs) await business.UpsertJob({ company: '测试企业', title: '工程师', city: '上海',
      experience: '', channel: 'company_website', jd: '', ...job });
    const backend = CreateBackend({ container: { jobs: { QueryJobs: (input) => business.QueryJobs(input) } } });
    const filters = { companySizes: ['20-99', '100-499'] };
    for (const sort of ['score', 'salary']) {
      for (const sortDirection of ['asc', 'desc']) {
        const ids = [];
        for (let page = 1; page <= 3; page++) {
          const result = await backend.HandleCommand('workspace:jobs-query', `${sort}-${sortDirection}-${page}`, undefined,
            { ...filters, sort, sortDirection, page, pageSize: 1 });
          assert.equal(result.ok, true);
          assert.equal(result.data.total, 3);
          ids.push(...result.data.items.map((job) => job.id));
        }
        assert.deepEqual(ids, sortDirection === 'asc' ? ['low', 'high', 'unknown'] : ['high', 'low', 'unknown']);
      }
    }
  } finally {
    await business.call('Close');
    business.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('批量采集经真实 Worker 幂等入库，墓碑不复活，迁移保留来源偏好和任务记录', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'avery-job-import-'));
  const destination = await mkdtemp(join(tmpdir(), 'avery-job-import-target-'));
  const business = CreateBusinessStoreClient({ workspacePath: directory });
  try {
    await business.ready;
    const entries = Array.from({ length: 35 }, (_, index) => ({ identity: `beisen:tenant:${index}`, platform: 'beisen', sourceId: 'test-source', originalJobId: String(index),
      sourceUrl: 'https://test.zhiye.com/', collectedAt: '2026-10-11T00:00:00Z',
      job: { id: `import-${index}`, company: '测试企业', title: `工程师${index}`, city: '上海', experience: '', channel: 'company_website', favorite: false, jd: '开发系统', url: `https://test.zhiye.com/job/${index}` } }));
    const first = await business.ImportCollectedJobs(entries.slice(0, 25));
    const second = await business.ImportCollectedJobs(entries.slice(25));
    assert.equal([...first.items, ...second.items].filter((entry) => entry.status === 'inserted').length, 35);
    assert.equal((await business.QueryJobs({ view: 'pending' })).total, 35);
    await business.DeleteJob('import-0');
    const repeat = await business.ImportCollectedJobs(entries.slice(0, 25));
    assert.equal(repeat.items[0].status, 'deleted');
    assert.equal(repeat.items.filter((entry) => entry.status === 'existing').length, 24);
    assert.equal((await business.QueryJobs({})).total, 34);
    await mkdir(join(directory, 'job-collection'));
    await writeFile(join(directory, 'job-collection', 'state.json'), JSON.stringify({ customSources: [], sourceOverrides: { test: { enabled: false } }, tasks: [{ status: 'completed' }] }));
    await business.CopyWorkspaceTo(destination);
    assert.deepEqual(JSON.parse(await readFile(join(destination, 'job-collection', 'state.json'), 'utf8')).sourceOverrides, { test: { enabled: false } });
  } finally {
    await business.call('Close'); business.close();
    await rm(directory, { recursive: true, force: true });
    await rm(destination, { recursive: true, force: true });
  }
});
