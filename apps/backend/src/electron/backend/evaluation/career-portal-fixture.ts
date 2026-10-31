import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { startServer } from '@avery/application-benchmark/server';
import { createClient, type SignedResult, type RunView } from '@avery/application-benchmark';
import { createScenario, definitions } from '@avery/application-benchmark/scenarios';
import type { EvalApplicationBenchmarkReport, EvalDatasetCase } from '@avery/contracts';
import type { AgentBrowserRuntime } from '../agent-browser-runtime';
import type { EvalBrowserFixtureState } from './browser-fixture-server';

export const ApplicationBenchmarkVersion = 'career-portal-2';

/** 每题冻结场景和完成目标；首版内置集合默认只填表，不进行本地模拟提交。 */
export function BuildApplicationBenchmarkDataset(): string {
  return definitions.map(definition => {
    const scenario = createScenario(definition.id, 'fill', 1);
    const profile = scenario.input.slice(scenario.input.indexOf('\n## '));
    const testCase: EvalDatasetCase = {
      id: `portal-${definition.id}`, category: '网申填写', input: { userMessage: `【${definition.title}】按本轮完成目标填写并核对合成资料。` },
      fixtures: { resume: { id: 'eval-resume', name: '合成候选人简历', content: profile }, profile: [{ id: 'benchmark-profile', category: 'personal', title: '本轮合成候选人资料', content: profile }] },
      expected: { requiredFacts: [], requiredBehaviors: [], forbiddenClaims: [], forbiddenBehaviors: [], referenceAnswer: '' }, tags: ['application-benchmark', definition.profile, definition.id],
      browser: { fixtureVersion: ApplicationBenchmarkVersion, seed: 1, benchmark: { scenarioId: definition.id, goal: 'fill' } },
    };
    return JSON.stringify(testCase);
  }).join('\n');
}

export function ValidateApplicationBenchmarkCase(testCase: EvalDatasetCase): string[] {
  const spec = testCase.browser?.benchmark;
  if (!spec) return [];
  try { createScenario(spec.scenarioId, spec.goal, testCase.browser?.seed ?? 1); return []; }
  catch { return [`${testCase.id} 的拟真平台场景、目标或 seed 无效。`]; }
}

/** 控制服务、令牌、评分答案和签名文件留在项目工作目录之外，只给 Agent 单轮 URL 和授权附件。 */
export async function StartApplicationBenchmark(caseRoot: string, testCase: EvalDatasetCase) {
  const spec = testCase.browser?.benchmark;
  if (!spec) throw new Error('缺少拟真平台案例配置');
  const dataRoot = join(caseRoot, 'benchmark-control');
  const service = await startServer({ dataRoot, port: 0 });
  const closeServer = async () => { service.store.close(); await new Promise<void>((resolve, reject) => service.server.close(error => error ? reject(error) : resolve())); };
  try {
    const client = await createClient({ baseUrl: service.baseUrl, token: service.store.adminToken });
    const task = await client.createRun({ scenarioId: spec.scenarioId, goal: spec.goal, seed: testCase.browser?.seed ?? 1 });
    let view = await client.getState(task.id);
    let result: SignedResult | undefined;
    const refresh = async () => { view = await client.getState(task.id); return view; };
    const getState = (): EvalBrowserFixtureState => ({
      selectedJobId: null, submissionCount: view.receipt ? 1 : 0, duplicateSubmissionAttempts: 0,
      submission: null, receipt: view.receipt?.id ?? null, searchCount: 0, lastFilters: null, viewedJobIds: [], detailViewCount: 0, applicationStarted: true,
    });
    return {
      origin: service.baseUrl, url: task.url, input: task.input,
      attachment: { name: task.attachmentName, bytes: await readFile(task.attachmentPath) },
      getState, refresh,
      async settle(runtime: Pick<AgentBrowserRuntime, 'FlushLocalEvaluationPage'>, metrics: Record<string, number | boolean | null>, signal: AbortSignal) {
        try {
          await runtime.FlushLocalEvaluationPage({ url: task.url, signal });
          await refresh();
          if (view.parserPending) throw new Error('解析尚未结束，不能生成最终测评成绩');
        } catch (error) {
          if (signal.aborted) throw error;
          await client.recordEnvironmentFailure(task.id, { code: 'BROWSER_SYNC_FAILED', message: error instanceof Error ? error.message.slice(0, 1000) : '页面同步失败' });
        }
        if (typeof metrics.promptTokens === 'number' && typeof metrics.completionTokens === 'number') {
          await client.addMetrics(task.id, { tokens: { input: metrics.promptTokens, output: metrics.completionTokens, ...(typeof metrics.cachedTokens === 'number' ? { cached: metrics.cachedTokens } : {}) } });
        }
        result = await client.endRun(task.id, { cleanup: true });
        return benchmarkState(result);
      },
      async fail(error: unknown, cancelled: boolean) {
        if (result) return;
        const failure = { code: cancelled ? 'CANCELLED' : 'AGENT_EXECUTION_ERROR', message: (error instanceof Error ? error.message : String(error)).slice(0, 1000) };
        if (cancelled || (error as { category?: unknown })?.category === 'environment') await client.recordEnvironmentFailure(task.id, failure);
        else await client.recordAgentFailure(task.id, failure);
        result = await client.endRun(task.id, { cleanup: true });
      },
      close: closeServer,
    };
  } catch (error) { await closeServer(); throw Object.assign(error instanceof Error ? error : new Error(String(error)), { category: 'environment' }); }
}

function benchmarkState(result: SignedResult): { report: EvalApplicationBenchmarkReport; manifest: SignedResult['payload']['manifest']; state: RunView['state'] } {
  const report = result.payload.report;
  const evidence = result.payload.evidence as { state: RunView['state'] };
  const scenario = result.payload.scenario as { expected: RunView['state'] };
  const checks = (report as typeof report & { checks: Array<{ path: string; pass: boolean }> }).checks;
  const value = (path: string) => path.split('.').reduce<unknown>((current, key) => current && typeof current === 'object' ? (current as Record<string, unknown>)[key] : undefined, scenario.expected);
  const fields = checks.filter(check => /^(personal|intention|additional|education|work|projects)\./.test(check.path) && value(check.path) !== undefined && value(check.path) !== '' && !check.path.endsWith('.length'));
  const fieldAccuracy = fields.length ? Number((fields.filter(check => check.pass).length / fields.length * 100).toFixed(2)) : null;
  const criticalErrors = report.issues.filter(issue => /^(personal\.(name|phone|email)|education\.\d+\.(school|degree|start|end)|work\.\d+\.(company|start|end)|projects\.\d+\.(name|start|end))$/.test(issue.path));
  return { report: { ...report, fieldAccuracy, criticalErrors }, manifest: result.payload.manifest, state: evidence.state };
}
