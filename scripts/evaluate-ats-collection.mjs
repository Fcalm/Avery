import { createRequire } from 'node:module';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { ValidateRegistry, ClassifyOutcome, JobCoverage, CoverageSummary, RegistryEligibility } from './ats-evaluation-report.mjs';

const require = createRequire(import.meta.url);
const { AtsSourceRunner, AtsFactStore, CreateSource } = require('../apps/backend/dist/electron/backend/ats/source-runner.js');
const args = process.argv.slice(2);
const positional = [];
const options = {};
for (let index = 0; index < args.length; index += 1) {
  if (!args[index].startsWith('--')) { positional.push(args[index]); continue; }
  const name = args[index].slice(2);
  if (!['cycles', 'fact-store', 'companies'].includes(name) || !args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`Invalid option: ${args[index]}`);
  options[name] = args[++index];
}
const cycles = Number(options.cycles ?? 1);
if (!Number.isInteger(cycles) || cycles < 1 || cycles > 100) throw new Error('--cycles must be an integer from 1 to 100.');
const fixturePath = resolve(positional[0] ?? 'tests/fixtures/ats-sources-50.json');
const output = resolve(positional[1] ?? `artifacts/ats-evaluation/${new Date().toISOString().replace(/[:.]/g, '-')}`);
const factStorePath = resolve(options['fact-store'] ?? resolve(output, 'facts.json'));
const fixtureText = await readFile(fixturePath, 'utf8');
const fixture = JSON.parse(fixtureText);
const baselineText = await readFile(new URL('../tests/fixtures/ats-sources-50.json', import.meta.url), 'utf8');
const baseline = JSON.parse(baselineText);
if (fixture.registryKind === 'coverage-100') {
  if (fixture.baselineSha256 !== createHash('sha256').update(baselineText).digest('hex')) throw new Error('The original 50-source baseline changed after the 100-source registry was frozen.');
  fixture.sources = [...baseline.sources, ...fixture.sources];
}
ValidateRegistry(fixture, baseline);
// 根目录独占创建，禁止覆盖旧报告；只有事实库允许显式跨运行复用。
await mkdir(dirname(output), { recursive: true });
await mkdir(output, { recursive: false });
const companies = options.companies?.split(',');
const selectedSources = fixture.sources.filter((source) => !companies || companies.includes(source.company));
if (!selectedSources.length || companies?.some((company) => !selectedSources.some((source) => source.company === company))) throw new Error('--companies contains an unknown company.');
const sources = selectedSources.map((source) => CreateSource({ ...source, maxPages: 20 }));
const ReadFacts = async () => {
  try { return JSON.parse(await readFile(factStorePath, 'utf8')).jobs; }
  catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
};
const cycleReports = [];
for (let cycle = 1; cycle <= cycles; cycle += 1) {
// 每轮重新实例化事实库，从磁盘加载上一轮结果，不依赖内存残留。
const before = await ReadFacts();
const runner = new AtsSourceRunner(undefined, new AtsFactStore(factStorePath));
const runs = await runner.RunBatch(sources);
const after = await ReadFacts();
const firstSeenViolations = Object.entries(before).filter(([key, job]) => after[key]?.firstSeenAt !== job.firstSeenAt).map(([key]) => key);
const diffViolations = [];
for (const run of runs) {
  for (const change of run.changes) {
    const key = `${run.sourceId}:${change.id}`;
    const old = before[key];
    const current = after[key];
    if (old && change.event === 'NEW') diffViolations.push(`${key}: repeated NEW`);
    if (old && current && old.rawHash === current.rawHash && old.status === current.status && change.event !== 'UNCHANGED') diffViolations.push(`${key}: unchanged job classified as ${change.event}`);
    if (change.event === 'CLOSED' && (run.snapshotStatus !== 'complete' || run.health !== 'healthy' || !run.jobs.length || run.errors.length || run.quarantine.length)) diffViolations.push(`${key}: unsafe closure`);
  }
}
const percentile = (values, fraction) => [...values].sort((a, b) => a - b)[Math.max(0, Math.ceil(values.length * fraction) - 1)] ?? 0;
const metrics = {};
for (const ats of [...new Set(runs.map((run) => run.ats ?? run.detectedPlatform ?? 'unknown'))]) {
  const selected = runs.filter((run) => (run.ats ?? run.detectedPlatform ?? 'unknown') === ats);
  const jobs = selected.flatMap((run) => run.jobs);
  const extracted = selected.filter((run) => run.jobs.length > 0).length;
  const errors = {};
  const fieldIssues = {};
  for (const job of jobs) for (const [field, reason] of Object.entries(job.fieldIssues ?? {})) {
    const key = `${field}:${reason}`;
    fieldIssues[key] = (fieldIssues[key] ?? 0) + 1;
  }
  const denominator = selected.length;
  if (!denominator) continue;
  for (const run of selected) for (const error of run.errors) errors[error.code] = (errors[error.code] ?? 0) + 1;
  metrics[ats] = { sources: denominator, extracted, extractionRate: extracted / denominator, jobs: jobs.length, fieldIssues,
    probeSuccessRate: selected.filter((run) => run.health === 'healthy' || run.health === 'empty' || (run.health === 'partial' && run.jobs.length > 0)).length / denominator,
    normalizationRate: jobs.length / (selected.reduce((sum, run) => sum + run.receivedCount, 0) || 1),
    partialRate: selected.filter((run) => run.snapshotStatus === 'partial').length / denominator,
    schemaErrorRate: selected.filter((run) => run.errors.some((error) => error.code === 'SOURCE_SCHEMA_CHANGED')).length / denominator,
    timeoutRate: selected.filter((run) => run.errors.some((error) => error.code === 'SOURCE_TIMEOUT')).length / denominator,
    latencyP50Ms: percentile(selected.map((run) => run.durationMs), 0.5), latencyP95Ms: percentile(selected.map((run) => run.durationMs), 0.95),
    fieldCompleteness: Object.fromEntries(['atsJobId', 'title', 'company', 'sourceUrl', 'description', 'requirements', 'updatedAt', 'locations'].map((field) => [field, jobs.filter((job) => Array.isArray(job[field]) ? job[field].length > 0 : Boolean(job[field])).length / (jobs.length || 1)])), errors };
}
const passed = companies ? null : ['beisen', 'moka'].every((ats) => runs.filter((run, index) => sources[index].ats === ats && run.jobs.length).length >= 15);
const registryEligibility = RegistryEligibility(fixture, baseline, runs.map((run, index) => ({ ...run, url: sources[index].url })));
const report = { schemaVersion: 2, cycle, generatedAt: new Date().toISOString(), fixturePath, fixtureSha256: createHash('sha256').update(fixtureText).digest('hex'), factStorePath,
  registryVersion: fixture.registryVersion ?? 1, previousRegistrySha256: fixture.previousRegistrySha256, registryEligibility,
  scope: companies ? 'subset' : fixture.registryKind === 'coverage-100' ? 'fixed-100' : 'fixed-50', firstSeenViolations, diffViolations, passedExtractionGate: passed, metrics, coverage: CoverageSummary(runs),
  sources: runs.map((run, index) => ({ company: sources[index].company, url: sources[index].url, sourceId: run.sourceId, ats: run.ats, detectedPlatform: run.detectedPlatform, outcome: ClassifyOutcome(run), jobCoverage: JobCoverage(run), health: run.health, snapshotStatus: run.snapshotStatus, transport: run.transport, jobs: run.jobs.length, received: run.receivedCount, nextPage: run.continuation?.nextPage, quarantine: run.quarantine.length, durationMs: run.durationMs, requests: run.requestCount, changes: Object.fromEntries(['NEW', 'UPDATED', 'UNCHANGED', 'CLOSED'].map((event) => [event, run.changes.filter((change) => change.event === event).length])), errors: run.errors })) };
const cycleOutput = cycles === 1 ? output : resolve(output, `cycle-${String(cycle).padStart(3, '0')}`);
if (cycles > 1) await mkdir(cycleOutput);
await writeFile(resolve(cycleOutput, 'report.json'), JSON.stringify(report, null, 2), 'utf8');
const markdown = ['# ATS 企业回归', '', `生成时间：${report.generatedAt}`, `提取率门槛：${passed === null ? '子集不评定' : passed ? '通过' : '未通过'}；快照安全和访问边界另以自动化测试验收。`, '',
  `事实库：${factStorePath}；第 ${cycle} 轮；首次发现时间异常：${firstSeenViolations.length}。`, `范围：${report.scope}；子集不评定固定 50 家门槛。`, '',
  '| 平台 | 成功来源 | 岗位数 | P50 / P95 (ms) |', '| --- | --- | --- | --- |', ...Object.entries(metrics).map(([ats, metric]) => `| ${ats} | ${metric.extracted}/${metric.sources} | ${metric.jobs} | ${metric.latencyP50Ms} / ${metric.latencyP95Ms} |`), '',
  `平台识别：${report.coverage.recognizedPlatforms}/${report.coverage.sources}；提取来源：${report.coverage.extractedSources}；完整快照：${report.coverage.completeSources}。`,
  ...(registryEligibility ? [`新增50家平台资格：${registryEligibility.passed ? '通过' : '未通过'}；已验证其他平台 ${registryEligibility.verifiedOtherSources}，资格矛盾 ${registryEligibility.contradictedSources}，未验证 ${registryEligibility.unverifiedSources}。`] : []),
  `来源结果：${JSON.stringify(report.coverage.outcomes)}。`, '平台未知的来源不视为已证明使用其他 ATS。', '',
  '| 新增适配优先级 | 已识别但未支持来源数 |', '| --- | --- |', ...report.coverage.adapterPriorities.map((item) => `| ${item.platform} | ${item.sources} |`), '',
  '| 企业 | URL | 平台 | 结果 | 健康 | 快照 | 岗位数 | 岗位覆盖对照 | 耗时(ms) | 错误 |', '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  ...report.sources.map((source) => `| ${source.company} | ${source.url} | ${source.ats ?? source.detectedPlatform ?? 'unknown'} | ${source.outcome} | ${source.health} | ${source.snapshotStatus} | ${source.jobs} | ${source.jobCoverage.status === 'measured' ? `${source.jobCoverage.extracted}/${source.jobCoverage.denominator} (public_api_count)` : 'unverified'} | ${source.durationMs} | ${source.errors.map((error) => error.code).join(', ')} |`), '',
  '| 平台 | 字段完整率 | 缺失原因计数 |', '| --- | --- | --- |', ...Object.entries(metrics).map(([ats, metric]) => `| ${ats} | ${JSON.stringify(metric.fieldCompleteness)} | ${JSON.stringify(metric.fieldIssues)} |`)];
await writeFile(resolve(cycleOutput, 'report.md'), `${markdown.join('\n')}\n`, 'utf8');
cycleReports.push({ cycle, output: cycleOutput, passedExtractionGate: passed, firstSeenViolations, diffViolations, metrics });
console.log(JSON.stringify(cycleReports.at(-1)));
if (passed === false || firstSeenViolations.length || diffViolations.length) process.exitCode = 1;
}
await writeFile(resolve(output, 'cycles.json'), JSON.stringify({ schemaVersion: 1, factStorePath, cycles: cycleReports }, null, 2), 'utf8');
