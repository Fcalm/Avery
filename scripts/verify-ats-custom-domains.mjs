import { createRequire } from 'node:module';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const { AtsSourceRunner, AtsFactStore, CreateSource } = require('../apps/backend/dist/electron/backend/ats/source-runner.js');
const output = resolve(process.argv[2] ?? `artifacts/ats-custom-domains/${new Date().toISOString().replace(/[:.]/g, '-')}`);
await mkdir(dirname(output), { recursive: true });
await mkdir(output);
const fixture = JSON.parse(await readFile('tests/fixtures/ats-custom-domains.json', 'utf8'));
const sources = fixture.sources.map((source) => CreateSource(source));
const runs = await new AtsSourceRunner(undefined, new AtsFactStore(resolve(output, 'facts.json'))).RunBatch(sources);
const report = { generatedAt: new Date().toISOString(), passed: false, sources: runs.map((run, index) => ({ company: sources[index].company, url: sources[index].url, expected: fixture.sources[index].expected, ats: run.ats, health: run.health, snapshotStatus: run.snapshotStatus, jobs: run.jobs.length, errors: run.errors, applicationUrl: run.jobs[0]?.applicationUrl })) };
try {
  assert.equal(runs[0].ats, 'moka');
  assert.ok(runs[0].errors.some((error) => error.code === 'SOURCE_ACCESS_DENIED'));
  assert.ok(runs[1].errors.some((error) => error.code === 'SOURCE_MULTIPLE_PORTALS'));
  // 不能为匿名访问失败补 Cookie 或把零结果宣称采集成功。
  assert.equal(runs[2].jobs.length, 0);
  assert.ok(runs[2].errors.length > 0);
  assert.equal(runs[3].ats, 'moka');
  assert.ok(runs[3].jobs.length > 0);
  assert.ok(runs[3].jobs.every((job) => job.sourceUrl === sources[3].url && new URL(job.applicationUrl).hostname === 'app.mokahr.com'));
  report.passed = true;
} catch (error) { report.failure = error.message; process.exitCode = 1; }
await writeFile(resolve(output, 'report.json'), JSON.stringify(report, null, 2), 'utf8');
console.log(JSON.stringify({ output, ...report }));
