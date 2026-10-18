import { createRequire } from 'node:module';
import { mkdir, appendFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const { CreateBusinessStoreClient } = require('../apps/backend/dist/infra/business-store-client.js');
const { JobLibraryCollectionService } = require('../apps/backend/dist/electron/backend/job-library-collection-service.js');
const { BuiltinRecruitmentSources } = require('../apps/backend/dist/electron/backend/recruitment-sources.js');
const output = resolve(process.argv.slice(2).find((arg) => !arg.startsWith('--')) ?? `artifacts/job-library-collection/${new Date().toISOString().replace(/[:.]/g, '-')}`);
// 独占证据目录和隔离工作空间；禁止对用户数据库执行真实采集验证。
await mkdir(dirname(output), { recursive: true });
await mkdir(output);
const workspacePath = resolve(output, 'workspace');
const report = { schemaVersion: 1, startedAt: new Date().toISOString(), output, sources: [], checks: {} };
let business, service;
async function Record(event) {
  const value = { time: new Date().toISOString(), ...event };
  console.log(JSON.stringify(value));
  await appendFile(resolve(output, 'events.jsonl'), `${JSON.stringify(value)}\n`, 'utf8');
}
async function Open() {
  business = CreateBusinessStoreClient({ workspacePath }); await business.ready;
  service = new JobLibraryCollectionService({ workspacePath, importJobs: (batch) => business.ImportCollectedJobs(batch),
    collectBoss: async () => { throw new Error('企业官网回归不得调用浏览器或模型。'); } });
  await service.Initialize();
}
async function Close() {
  await service?.Close(); service = undefined;
  if (!business) return;
  await business.Close(); const current = business; business = undefined;
  const exited = new Promise((done) => current.onExit(done)); current.close(); await exited;
}
async function Collect(source, targetCount = 12) {
  const started = await service.StartJobCollection({ channel: 'company_website', targetCount, sourceIds: [source.sourceId] });
  await Record({ type: 'started', source: source.company, taskId: started.taskId, targetCount });
  let marker = '';
  while (true) {
    const task = await service.GetJobCollectionTask(started.taskId);
    const next = `${task.updatedAt}:${task.status}`;
    if (next !== marker) { await Record({ type: 'progress', task }); marker = next; }
    if (task.status !== 'running') return task;
    await new Promise((done) => setTimeout(done, 1000));
  }
}
try {
  await Open();
  const catalog = await service.ListRecruitmentSources();
  const sources = process.argv.includes('--all') ? catalog : [catalog.find((item) => item.companyId === 'iflytek'), catalog.find((item) => item.companyId === 'deli'), catalog.find((item) => item.companyId === 'crrc')];
  for (const source of sources) {
    const task = await Collect(source);
    report.sources.push({ company: source.company, platform: source.platform, url: source.url, task });
    assert.equal(task.status, 'completed', `${source.company}: ${task.warnings.join('；')}`);
    assert.equal(task.collected, 12); assert.equal(task.inserted, 12);
    assert.ok((await business.QueryJobs({ channels: ['company_website'], view: 'pending' })).total >= 12);
  }
  const expectedTotal = sources.length * 12;
  assert.equal((await business.QueryJobs({})).total, expectedTotal);
  report.checks.realThreePlatforms = true; report.checks.moreThanTenDirectImports = true;
  const source = BuiltinRecruitmentSources.find((item) => item.companyId === 'iflytek');
  const job = (await business.QueryJobs({ keyword: '科大讯飞', pageSize: 100 })).items[0];
  await business.UpsertJob({ ...job, favorite: true, title: '验证用户编辑保留', note: '验证备注' }, job.revision);
  const repeat = await Collect(source);
  assert.equal(repeat.existing, 12); assert.equal(repeat.inserted, 0);
  assert.equal((await business.QueryJobs({ view: 'favorites' })).items[0].title, '验证用户编辑保留');
  assert.equal((await business.QueryJobs({})).total, expectedTotal);
  report.checks.repeatNoDuplicates = true; report.checks.preserveUserChanges = true;
  await Close(); await Open();
  assert.equal((await business.QueryJobs({})).total, expectedTotal);
  assert.equal((await service.GetJobCollectionTask()).status, 'completed');
  report.checks.workerRestartReadback = true;
  report.passed = true;
} catch (error) {
  report.passed = false; report.error = { message: error.message, stack: error.stack }; process.exitCode = 1;
} finally {
  await Close(); report.finishedAt = new Date().toISOString();
  await writeFile(resolve(output, 'report.json'), JSON.stringify(report, null, 2), 'utf8');
  await Record({ type: 'finished', passed: report.passed, reportPath: resolve(output, 'report.json') });
}
