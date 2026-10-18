import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const { CreateBusinessStoreClient } = require('../apps/backend/dist/infra/business-store-client.js');
const { JobCollectionService } = require('../apps/backend/dist/electron/backend/job-collection-service.js');
const output = resolve(process.argv[2] ?? `artifacts/ats-storage/${new Date().toISOString().replace(/[:.]/g, '-')}`);
await mkdir(dirname(output), { recursive: true });
// 独占测试目录，禁止覆盖旧证据或接入真实用户数据目录。
await mkdir(output);
const workspacePath = resolve(output, 'user-data');
const sessionId = 'ats-real-storage-verification';
const report = { schemaVersion: 1, workspacePath, startedAt: new Date().toISOString(), checks: {} };
let client;
let service;
const Open = async () => {
  client = CreateBusinessStoreClient({ workspacePath });
  await client.ready;
  service = new JobCollectionService({
    browser: { EvaluateTrustedPage: async () => { throw new Error('ATS storage verification must not use a browser.'); } },
    loadViewModel: () => client.LoadViewModel(), saveJob: (input) => client.SaveTrackedJob(input),
    atsStorePath: resolve(workspacePath, 'ats-facts.json'),
  });
};
const Close = async () => {
  service?.Close();
  if (!client) return;
  const current = client;
  client = undefined;
  await current.Close();
  const exited = new Promise((done) => current.onExit(done));
  current.close();
  await exited;
};
const Collect = () => service.Collect({
  sessionId, platforms: ['beisen'], sources: [{ company: '科大讯飞', url: 'https://iflytek.zhiye.com/', maxPages: 20 }],
  queries: [{ keyword: '算法', city: '合肥' }], maxResults: 3, sort: 'relevance',
});
try {
  await Open();
  await client.CreateConversation({ id: sessionId, title: 'ATS 真实存储验证', scenarioId: 'application' });
  const collection = await Collect();
  assert.ok(collection.matching.processed > 0);
  assert.ok(collection.candidates.length >= 2, 'At least two live candidates are required to verify repeated saves within one cache.');
  assert.equal((await client.LoadViewModel()).jobs.length, 0, 'Collection must not automatically save jobs.');
  const input = { sessionId, collectionId: collection.collectionId, candidateId: collection.candidates[0].candidateId };
  const saved = await service.SaveCandidate(input);
  const repeated = await service.SaveCandidate(input);
  assert.equal(saved.jobId, repeated.jobId);
  let view = await client.LoadViewModel();
  assert.equal(view.jobs.length, 1);
  assert.equal(view.jobs[0].channel, 'company_website');
  report.checks.explicitSave = true;
  report.checks.repeatedSaveNoDuplicate = true;
  report.jobId = saved.jobId;
  report.candidateTitle = collection.candidates[0].title;
  await Close();
  await Open();
  view = await client.LoadViewModel();
  assert.equal(view.jobs.length, 1);
  assert.equal(view.jobs[0].id, saved.jobId);
  report.checks.workerRestartReadback = true;
  await assert.rejects(service.SaveCandidate(input), { code: 'JOB_COLLECTION_EXPIRED' });
  report.checks.restartCacheInvalidation = true;
  const second = await Collect();
  assert.equal(second.matching.processed, 0, 'Unchanged jobs must reuse persisted matching results after restart.');
  assert.ok(second.matching.reused > 0);
  report.checks.matchingRestartReuse = true;
  const secondInput = { sessionId, collectionId: second.collectionId, candidateId: second.candidates[0].candidateId };
  await client.DeleteConversation(sessionId);
  service.DeleteSession(sessionId);
  await assert.rejects(service.SaveCandidate(secondInput), { code: 'JOB_COLLECTION_EXPIRED' });
  view = await client.LoadViewModel();
  assert.equal(view.conversations.length, 0);
  assert.equal(view.jobs.length, 1);
  report.checks.sessionDeletionInvalidatesCache = true;
  report.checks.savedJobSurvivesDeletion = true;
  report.passed = true;
} catch (error) {
  report.passed = false;
  report.error = { message: error.message, stack: error.stack };
  process.exitCode = 1;
} finally {
  await Close();
  report.finishedAt = new Date().toISOString();
  await writeFile(resolve(output, 'report.json'), JSON.stringify(report, null, 2), 'utf8');
}
console.log(JSON.stringify({ output, ...report }));
