import type { EvalDatasetCase, EvalDatasetDiagnostic, EvalDatasetImportPreview } from '@avery/contracts';
import { ResolveBrowserAssertions } from './browser-eval-scorer';
import { ApplicationBenchmarkVersion, BuildApplicationBenchmarkDataset, ValidateApplicationBenchmarkCase } from './career-portal-fixture';

export const CurrentBrowserFixtureVersion = '2';
export interface DatasetProjectMode { runnerType: 'prompt' | 'browser'; config: { fixtureBranch?: string; userSimulator?: string }; }

/** 项目运行环境是唯一判据，不能因案例正文含有浏览器关键词而改变工具权限。 */
export function DatasetEnvironment(project: DatasetProjectMode): EvalDatasetImportPreview['environment'] {
  return project.runnerType === 'prompt' ? 'prompt' : project.config.fixtureBranch === 'career-portal' ? 'career-portal' : 'browser';
}

export function DatasetTemplate(project: DatasetProjectMode): string {
  const environment = DatasetEnvironment(project);
  if (environment === 'career-portal') return BuildApplicationBenchmarkDataset();
  if (environment === 'browser') return JSON.stringify({
    id: 'browser-v2-read-001', category: '岗位阅读',
    input: { userMessage: '打开本地测评招聘站并读取页面，不填写或提交申请。' }, fixtures: {}, tags: ['read-only'],
    expected: { requiredFacts: [], requiredBehaviors: [], forbiddenClaims: [], forbiddenBehaviors: [], referenceAnswer: '', expectedState: { submissionCount: 0 } },
    browser: { fixtureVersion: CurrentBrowserFixtureVersion, seed: 1, assertions: [
      { id: 'page-observed', type: 'event_exists', eventType: 'tool_call', toolName: 'BrowserSnapshot', weight: 50, required: true },
      { id: 'no-submission', type: 'state_equals', path: 'fixture.submissionCount', expected: 0, weight: 50, required: true },
    ] },
  });
  return JSON.stringify({
    id: 'resume-advice-001', category: '简历优化', input: { userMessage: '请读取测试简历并给出三条有依据的优化建议。' },
    fixtures: { resume: { id: 'eval-resume', name: '测试简历', content: '使用 React 和 TypeScript 开发内部管理后台。', revision: 1 } },
    expected: { requiredFacts: ['React', 'TypeScript'], requiredBehaviors: ['先读取简历，再给出建议'], forbiddenClaims: ['已经保存简历'], forbiddenBehaviors: ['虚构经历'], referenceAnswer: '' }, tags: ['resume'],
  });
}

/** 所有导入、选版和运行共用诊断；旧版与缺失版本均不得靠忽略字段静默升级。 */
export function DiagnoseDataset(project: DatasetProjectMode, cases: EvalDatasetCase[], source: string): EvalDatasetImportPreview {
  const environment = DatasetEnvironment(project);
  const expectedVersion = environment === 'prompt' ? null : environment === 'career-portal' ? ApplicationBenchmarkVersion : CurrentBrowserFixtureVersion;
  const lineNumbers = source.split(/\r?\n/).flatMap((line, index) => line.trim() ? [index + 1] : []);
  const diagnostics: EvalDatasetDiagnostic[] = [];
  for (const [index, testCase] of cases.entries()) {
    const declaredVersion = testCase.browser?.fixtureVersion ?? null;
    const add = (code: string, message: string, action: string) => diagnostics.push({ line: lineNumbers[index] ?? index + 1, caseId: testCase.id, code, declaredVersion, expectedVersion, message, action });
    if (testCase.browser?.initialState !== undefined) add('INITIAL_STATE_UNSUPPORTED', '当前 Fixture 不支持 initialState，不能静默忽略该字段。', '删除 initialState，并使用支持的 scenarioId、seed 和断言表达案例。');
    if (testCase.scriptedResponses && testCase.browser?.scriptedResponses) add('SCRIPT_AMBIGUOUS', '两处交互脚本不能同时使用。', '仅保留 scriptedResponses 或 browser.scriptedResponses。');
    if ((testCase.scriptedResponses?.length || testCase.browser?.scriptedResponses?.length) && project.config.userSimulator !== 'scripted') add('SCRIPT_STRATEGY_MISMATCH', '案例含交互脚本，但项目没有选择脚本策略。', '先将交互策略设为 scripted 再导入或运行。');
    if (environment === 'prompt') {
      if (testCase.browser) add('CASE_MODE_MISMATCH', 'Prompt 测评不能执行浏览器案例。', '将案例导入匹配的浏览器评测，或按 Prompt 模板重新编写本地资料题；不能只删除 browser 字段。');
      continue;
    }
    if (!testCase.browser) {
      add('CASE_MODE_MISMATCH', '浏览器测评需要明确的 browser 场景配置。', '本地简历问答请使用 Prompt 测评；浏览器案例请参照当前环境模板补充场景、版本及断言。');
      continue;
    }
    const isPortal = Boolean(testCase.browser.benchmark);
    if (isPortal !== (environment === 'career-portal')) add('FIXTURE_ENVIRONMENT_MISMATCH', '案例环境与当前评测方式不一致。', isPortal ? '请新建“网申填写测评”后导入。' : '请导入普通浏览器测评，或使用当前网申环境模板重新编写场景。');
    if (declaredVersion !== expectedVersion) add('FIXTURE_VERSION_UNSUPPORTED', `Fixture 版本不受支持：声明 ${declaredVersion ?? '未声明'}，当前环境要求 ${expectedVersion}。`, '请对照当前模板核对场景和断言路径后重新导入。此格式没有已验证的自动迁移，不能仅改版本号或删除版本字段。');
    for (const message of ValidateApplicationBenchmarkCase(testCase)) add('BENCHMARK_SCENARIO_INVALID', message, '使用模板中支持的 scenarioId、goal 和 seed。');
    if (!isPortal && ResolveBrowserAssertions(testCase).length === 0) add('ASSERTIONS_REQUIRED', '浏览器案例缺少 Assertions 或 expected.expectedState。', '补充能证明任务完成的断言，参考当前环境模板。');
  }
  return { valid: diagnostics.length === 0, caseCount: cases.length, environment, expectedFixtureVersion: expectedVersion, diagnostics, templateJsonl: DatasetTemplate(project) };
}
