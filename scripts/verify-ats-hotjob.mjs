import { createRequire } from 'node:module';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const { AtsSourceRunner, AtsFactStore, CreateSource } = require('../apps/backend/dist/electron/backend/ats/source-runner.js');
const { AtsPublicTransport } = require('../apps/backend/dist/electron/backend/ats/public-transport.js');
const fixture = JSON.parse(await readFile(new URL('../tests/fixtures/ats-hotjob-sources.json', import.meta.url), 'utf8'));
const output = resolve(`artifacts/ats-hotjob/${new Date().toISOString().replace(/[:.]/g, '-')}`);
await mkdir(output, { recursive: true });
const transport = new AtsPublicTransport();
const summaries = [];
for (const [index, item] of fixture.sources.entries()) {
  const file = resolve(output, `facts-${index}.json`);
  const source = CreateSource({ company: item.company, url: item.url, maxPages: 20 });
  for (let cycle = 1; cycle <= 20; cycle += 1) {
    // 每段重建存储，验证详情游标随事实库原子保存并可跨重启恢复。
    const result = await new AtsSourceRunner(transport, new AtsFactStore(file)).Run(source);
    await writeFile(resolve(output, `source-${index}-cycle-${cycle}.json`), JSON.stringify(result, null, 2));
    const fieldIssues = {};
    for (const job of result.jobs) for (const [field, reason] of Object.entries(job.fieldIssues ?? {})) fieldIssues[`${field}:${reason}`] = (fieldIssues[`${field}:${reason}`] ?? 0) + 1;
    const summary = { company: item.company, cycle, jobs: result.jobs.length, publicCount: result.publicJobCount, status: result.snapshotStatus, requests: result.requestCount, nextPage: result.continuation?.nextPage, pendingDetails: result.continuation?.pendingRows?.length, fieldIssues, errors: result.errors };
    summaries.push(summary); console.log(JSON.stringify(summary));
    assert(result.requestCount <= 30);
    if (item.expect !== 'complete') { assert(result.errors.some((error) => error.code === item.expect)); break; }
    if (result.snapshotStatus === 'complete') {
      assert(result.jobs.length > 0 && result.jobs.length === result.publicJobCount);
      assert(result.jobs.every((job) => job.title && job.atsJobId && job.company && job.applicationUrl.includes('/pb/posDetail.html?postId=')));
      for (const job of result.jobs) for (const field of ['description', 'requirements', 'locations']) {
        const value = job[field];
        if (!(Array.isArray(value) ? value.length : value)) assert(['source_missing', 'source_empty'].includes(job.fieldIssues[field]), `Unexplained missing field: ${job.atsJobId}/${field}`);
      }
      const stored = JSON.parse(await readFile(file, 'utf8'));
      assert(!stored.continuations[source.id]);
      break;
    }
    assert(result.continuation, 'Incomplete run must expose a resumable checkpoint.');
    assert(cycle < 20, 'Full traversal did not finish within 20 bounded segments.');
  }
}
await writeFile(resolve(output, 'report.json'), JSON.stringify({ schemaVersion: 1, output, sources: fixture.sources, summaries, passed: true }, null, 2));
console.log(JSON.stringify({ output, passed: true }));
