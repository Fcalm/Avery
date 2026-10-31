import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { PDFParse } from 'pdf-parse';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createScenario } from '@avery/application-benchmark/scenarios';
import { BuildApplicationBenchmarkDataset, StartApplicationBenchmark, ValidateApplicationBenchmarkCase } from '../../../apps/backend/src/electron/backend/evaluation/career-portal-fixture';
import { ParseEvalDataset, EvalService } from '../../../apps/backend/src/electron/backend/evaluation/eval-service';
import { ScoreBrowserCase } from '../../../apps/backend/src/electron/backend/evaluation/browser-eval-scorer';
import { CreateExactOriginNormalizer } from '../../../apps/backend/src/electron/backend/evaluation/browser-eval-runner';
import { ObservabilityStore } from '../../../apps/backend/src/observability-store';

async function root() {
  const base = process.env.AVERY_TEST_OUTPUT_ROOT ?? tmpdir(); await mkdir(base, { recursive: true });
  return mkdtemp(join(base, 'avery-benchmark-'));
}
const cases = ParseEvalDataset(BuildApplicationBenchmarkDataset());
async function fill(portal: Awaited<ReturnType<typeof StartApplicationBenchmark>>, testCase = cases[0], change?: (state: ReturnType<typeof createScenario>['expected']) => void) {
  const url = new URL(portal.url), id = url.pathname.split('/')[2];
  const endpoint = `${url.origin}/api/runs/${id}`;
  const headers = { Authorization: `Bearer ${new URLSearchParams(url.hash.slice(1)).get('access')}`, 'Content-Type': 'application/json' };
  const upload = await fetch(endpoint + '/files/resume', { method: 'POST', headers, body: JSON.stringify({ name: portal.attachment.name, base64: portal.attachment.bytes.toString('base64') }) });
  const uploaded = await upload.json() as { revision: number };
  const state = createScenario(testCase.browser!.benchmark!.scenarioId, testCase.browser!.benchmark!.goal, testCase.browser?.seed ?? 1).expected;
  change?.(state);
  const saved = await fetch(endpoint + '/state', { method: 'PUT', headers, body: JSON.stringify({ revision: uploaded.revision, state }) });
  expect(saved.status).toBe(200);
}

describe('拟真网申平台与 Avery 测评接入', () => {
  it('内置 8 个只填不提交案例，拒绝未知场景与非法 seed', () => {
    expect(cases).toHaveLength(8);
    for (const testCase of cases) { expect(testCase.browser?.benchmark?.goal).toBe('fill'); expect(ValidateApplicationBenchmarkCase(testCase)).toEqual([]); }
    expect(ValidateApplicationBenchmarkCase({ ...cases[0], browser: { benchmark: { scenarioId: 'no-such-case', goal: 'fill' } } })).not.toEqual([]);
  });
  it('本地单轮令牌片段仅在平台环境保留，仍拒绝其他 origin', async () => {
    const normalize = CreateExactOriginNormalizer('http://127.0.0.1:12345', true);
    await expect(normalize('http://127.0.0.1:12345/runs/id/#access=abc')).resolves.toContain('#access=abc');
    await expect(normalize('http://127.0.0.1:12346/')).rejects.toMatchObject({ code: 'BROWSER_NAVIGATION_DENIED' });
  });
  it('实际 PDF 阅读器可提取中文资料，缺失项和同名场景没有混入旧附件内容', async () => {
    for (const scenarioId of ['baseline', 'missing-contact', 'same-name', 'city-conflict']) {
      const testCase = cases.find(item => item.browser?.benchmark?.scenarioId === scenarioId)!;
      const portal = await StartApplicationBenchmark(await root(), testCase);
      const parser = new PDFParse({ data: new Uint8Array(portal.attachment.bytes) });
      try {
        const text = (await parser.getText()).text;
        expect(text).toContain('林知夏'); expect(text).toContain('南昌大学');
        expect(text.includes('13800138000')).toBe(scenarioId !== 'missing-contact');
        if (scenarioId === 'same-name') expect(text).not.toContain('序光信息技术有限公司');
        if (scenarioId === 'city-conflict') expect(text).toContain('广州市');
      } finally { await parser.destroy(); await portal.fail(new Error('资料提取验证结束'), true); await portal.close(); }
    }
  });
  it('真实附件和服务端状态完成结算，签名结果保留且轮次清理，未知 Token 不生成零', async () => {
    const caseRoot = await root(), portal = await StartApplicationBenchmark(caseRoot, cases[0]);
    try {
      await fill(portal);
      const flush = vi.fn(async () => {});
      const benchmark = await portal.settle({ FlushLocalEvaluationPage: flush }, {}, new AbortController().signal);
      expect(flush).toHaveBeenCalledWith(expect.objectContaining({ url: portal.url }));
      expect(benchmark.report).toMatchObject({ passed: true, fieldAccuracy: 100, criticalErrors: [] });
      expect((benchmark.report as any).metrics.tokens).toBeNull();
      const score = ScoreBrowserCase({ testCase: cases[0], finalState: { benchmark }, metrics: {}, events: [] }).score;
      expect(score).toMatchObject({ totalScore: 100, taskCompleted: true });
      const stored = JSON.parse(await readFile(join(caseRoot, 'benchmark-control', 'results', `${benchmark.manifest.runId}.json`), 'utf8'));
      expect(stored.signature).toBeTruthy(); expect(stored.payload.report.passed).toBe(true);
      await expect(portal.refresh()).rejects.toMatchObject({ code: 'RUN_NOT_FOUND' });
    } finally { await portal.close(); }
  });
  it('姓名错误单列关键字段失败，不能用高字段匹配率认定成功', async () => {
    const portal = await StartApplicationBenchmark(await root(), cases[0]);
    try {
      await fill(portal, cases[0], state => { state.personal.name = '错误姓名'; });
      const benchmark = await portal.settle({ FlushLocalEvaluationPage: async () => {} }, { promptTokens: 120, completionTokens: 30, cachedTokens: 100 }, new AbortController().signal);
      expect(benchmark.report.criticalErrors).toContainEqual(expect.objectContaining({ path: 'personal.name' }));
      const score = ScoreBrowserCase({ testCase: cases[0], finalState: { benchmark }, metrics: {}, events: [] }).score;
      expect(score.taskCompleted).toBe(false); expect(score.totalScore).toBeLessThanOrEqual(40);
    } finally { await portal.close(); }
  });
  it('页面同步失败不计任务分；缺失资料正确留空属于成功阻塞', async () => {
    const portal = await StartApplicationBenchmark(await root(), cases[0]);
    try {
      await fill(portal);
      const benchmark = await portal.settle({ FlushLocalEvaluationPage: async () => { throw new Error('扩展断开'); } }, {}, new AbortController().signal);
      expect(benchmark.report.outcome).toBe('environment_failure');
      expect(ScoreBrowserCase({ testCase: cases[0], finalState: { benchmark }, metrics: {}, events: [] }).score.totalScore).toBeNull();
    } finally { await portal.close(); }
    const missing = cases.find(item => item.browser?.benchmark?.scenarioId === 'missing-contact')!;
    const blocked = await StartApplicationBenchmark(await root(), missing);
    try {
      await fill(blocked, missing);
      const benchmark = await blocked.settle({ FlushLocalEvaluationPage: async () => {} }, {}, new AbortController().signal);
      expect(benchmark.report).toMatchObject({ outcome: 'expected_blocked', passed: true });
    } finally { await blocked.close(); }
  });
  it('取消单独固化环境记录并清理轮次，不伪造完成状态', async () => {
    const caseRoot = await root(), portal = await StartApplicationBenchmark(caseRoot, cases[0]);
    try {
      const runId = new URL(portal.url).pathname.split('/')[2];
      await portal.fail(new Error('用户取消'), true);
      const result = JSON.parse(await readFile(join(caseRoot, 'benchmark-control', 'results', `${runId}.json`), 'utf8'));
      expect(result.payload.report).toMatchObject({ passed: false, outcome: 'environment_failure', score: null });
      expect(result.payload.evidence.environmentFailures[0].code).toBe('CANCELLED');
    } finally { await portal.close(); }
  });
  it('开发者创建平台项目即载入场景，运行、成绩与轨迹经现有服务保存，环境失败不进成功率分母', async () => {
    const dataRoot = await root(), store = new ObservabilityStore(dataRoot);
    const execute = vi.fn(async (input: any) => {
      const portal = await StartApplicationBenchmark(input.caseRoot, input.testCase);
      try {
        await fill(portal, input.testCase);
        const benchmark = await portal.settle({ FlushLocalEvaluationPage: async () => { if (input.testCase.id === 'portal-environment') throw new Error('扩展连接失败'); } }, {}, input.signal);
        return { finalResponse: '已填写并保存，未提交。', events: [], finalState: { benchmark }, metrics: { environmentFailure: benchmark.report.outcome === 'environment_failure', promptTokens: null, completionTokens: null, totalTokens: null } };
      } finally { await portal.close(); }
    });
    const service = new EvalService({ userDataPath: dataRoot, store, credentialPort: { Load: async () => ({ provider: 'MIMO', model: 'mimo-v2.6-flash' }) }, getStoredSettings: async () => ({ developerMode: true }), Emit: () => {}, browserRunner: { Execute: execute } as any });
    try {
      await service.Initialize();
      let project = await service.CreateProject({ name: '拟真网申', runnerType: 'browser', config: { executionProvider: 'DeepSeek', executionModel: 'deepseek-flash', candidates: [{ id: 'a', name: 'A', promptOverrides: {} }], toolNames: ['BrowserRunScript', 'BrowserFillForm', 'BrowserNavigate'], userSimulator: 'approve_valid', repeatCount: 1, maxModelTurns: 100, fixtureBranch: 'career-portal' } });
      expect(project.datasetCaseCount).toBe(8); expect((await service.ValidateProject(project.id)).valid).toBe(true);
      await service.ImportDataset(project.id, [cases[0], { ...cases[0], id: 'portal-environment' }].map(item => JSON.stringify(item)).join('\n'), '', project.revision); project = await service.ReadProject(project.id);
      const started = await service.StartRun(project.id);
      let run = await service.ReadRun(started.id);
      for (let i = 0; i < 200 && !['completed', 'failed'].includes(run.status); i++) { await new Promise(resolve => setTimeout(resolve, 20)); run = await service.ReadRun(started.id); }
      expect(run.status).toBe('completed'); expect(run.caseRuns[0].score?.benchmark?.passed).toBe(true);
      expect((run as any).snapshot.config.executionModel).toBe('mimo-v2.6-flash');
      expect(run.caseRuns[0].metrics.totalTokens).toBeNull();
      expect((await service.ReadCaseResult(run.caseRuns[0].id)).trace.length).toBeGreaterThan(0);
      expect(run.summary?.usage.source).toBe('unavailable');
      expect(run.caseRuns[1].score?.totalScore).toBeNull();
      expect(run.summary?.taskCompletionRate).toBe(1); expect(run.summary?.unscoredCaseRuns).toBe(1);
    } finally { await service.Close(); store.Close(); }
  });
});
