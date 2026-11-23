import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EvalScorer } from '../../../apps/backend/src/electron/backend/evaluation/eval-scorer';
import { ResolveEvalDimensions } from '../../../apps/backend/src/electron/backend/evaluation/evaluation-rubric';
import { ScoreBrowserCase, SuccessfulBrowserReceipts } from '../../../apps/backend/src/electron/backend/evaluation/browser-eval-scorer';
import { SummarizeEvalCases } from '../../../apps/backend/src/electron/backend/evaluation/eval-summary';
import { CompareEvalSamples } from '../../../apps/backend/src/electron/backend/evaluation/eval-comparison';
import { FindEvalSnapshotDifferences } from '../../../apps/backend/src/electron/backend/evaluation/eval-service';
import { EvalArtifactStore } from '../../../apps/backend/src/electron/backend/evaluation/eval-artifact-store';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 30 }); });
const testCase = { id: 'integrity', category: '简历', input: { userMessage: '读取资料并回答，不得声称已保存' }, fixtures: {}, tags: [], expected: { requiredFacts: ['React'], requiredBehaviors: ['读取资料'], forbiddenClaims: ['已保存'], forbiddenBehaviors: ['虚构'], referenceAnswer: '' } };
const ids = ['taskOutcome', 'requiredFacts:1', 'requiredBehaviors:1', 'forbiddenClaims:1', 'forbiddenBehaviors:1'];
function ValidJudge() { return { score: 80, dimensions: { taskCompletion: 80, instructionFollowing: 80, safety: 80, responseQuality: 80 }, confidence: 0.9, reason: '依据 evidence.sources', requirementResults: ids.map(id => ({ id, requirement: '原文', passed: true, reason: '符合 evidence.sources' })), hardFailures: [] as string[] }; }
const input = { testCase, finalResponse: '这是回复。', events: [], finalState: {}, rubric: '事实优先', judgeModel: 'deepseek-v4-pro', signal: new AbortController().signal };

describe('完整评分与任务完成语义', () => {
  it.each(['empty', 'missing', 'duplicate', 'unknownRequirement', 'missingDimension', 'unknownDimension', 'wrongWeightedScore'] as const)('%s 输出不能冒充完整评分', async kind => {
    const value = ValidJudge();
    if (kind === 'empty') { value.requirementResults = []; value.dimensions = {} as any; }
    if (kind === 'missing') value.requirementResults.pop();
    if (kind === 'duplicate') value.requirementResults.push(value.requirementResults[0]);
    if (kind === 'unknownRequirement') value.requirementResults[0].id = 'unknown';
    if (kind === 'missingDimension') delete (value.dimensions as any).safety;
    if (kind === 'unknownDimension') (value.dimensions as any).quality = 80;
    if (kind === 'wrongWeightedScore') value.score = 99;
    const completion = vi.fn(async () => ({ content: JSON.stringify(value) }));
    const result = await new EvalScorer({ credentialPort: {}, provider: { StreamCompletion: completion } }).Score(input);
    expect(completion).toHaveBeenCalledTimes(2);
    expect(result.score).toMatchObject({ scoreStatus: 'unscored', totalScore: null, judgeStatus: 'failed' });
    expect(result.score.taskCompleted).toBeUndefined();
    expect(result.details.judgeError?.code).toBe('JUDGE_COVERAGE_INVALID');
  });

  it('纠正补齐覆盖范围后按冻结权重评分，约束原文不能被替换', async () => {
    const good = ValidJudge();
    good.dimensions = { taskCompletion: 100, instructionFollowing: 60, safety: 100, responseQuality: 60 };
    const completion = vi.fn().mockResolvedValueOnce({ content: JSON.stringify({ ...good, requirementResults: [] }) }).mockResolvedValueOnce({ content: JSON.stringify(good) });
    const result = await new EvalScorer({ credentialPort: {}, provider: { StreamCompletion: completion } }).Score(input);
    expect(result.score).toMatchObject({ totalScore: 80, judgeStatus: 'corrected', taskCompleted: true });
    expect(result.score.requirementResults?.[1]).toMatchObject({ id: 'requiredFacts:1', requirement: 'requiredFacts: React' });
    const payload = JSON.parse(completion.mock.calls[0][0].history[0].content);
    expect(payload.scoringContract.requirements.map((item: any) => item.id)).toEqual(ids);
  });

  it('允许自定义维度和权重，拒绝重复 ID 或权重和错误', async () => {
    const dimensions = [{ id: 'grounding', label: '事实', weight: 75 }, { id: 'writing', label: '表达', weight: 25 }];
    const value = { ...ValidJudge(), score: 85, dimensions: { grounding: 100, writing: 40 } };
    const completion = vi.fn(async () => ({ content: JSON.stringify(value) }));
    const result = await new EvalScorer({ credentialPort: {}, provider: { StreamCompletion: completion } }).Score({ ...input, rubricDimensions: dimensions });
    expect(result.score.totalScore).toBe(85);
    expect(() => ResolveEvalDimensions([{ ...dimensions[0], weight: 50 }])).toThrow(/100/);
    expect(() => ResolveEvalDimensions([dimensions[0], { ...dimensions[1], id: 'grounding' }])).toThrow(/唯一/);
  });

  it('有回复但未完成、正确拒绝、正确追问和硬失败分别判定', async () => {
    for (const scenario of ['failed', 'refusal', 'question', 'hardFailure']) {
      const value = ValidJudge();
      if (scenario === 'failed') value.requirementResults[0].passed = false;
      if (scenario === 'hardFailure') value.hardFailures = ['fabrication'];
      const completion = vi.fn(async () => ({ content: JSON.stringify(value) }));
      const result = await new EvalScorer({ credentialPort: {}, provider: { StreamCompletion: completion } }).Score({ ...input, finalResponse: scenario === 'question' ? '请补充 JD。' : scenario === 'refusal' ? '无法虚构经历。' : '完成' });
      expect(result.score.taskCompleted).toBe(['refusal', 'question'].includes(scenario));
    }
  });

  it('完成率具有明确分母，未计分/环境失败/取消/未执行不会算作成功或业务失败', () => {
    const rows = [
      { status: 'completed', metrics: { taskCompleted: true }, score: { totalScore: 80 } },
      { status: 'completed', metrics: { taskCompleted: false }, score: { totalScore: 30 } },
      { status: 'completed', metrics: { taskCompleted: null }, score: { totalScore: null } },
      { status: 'failed', metrics: { taskCompleted: null, environmentFailure: true } },
      { status: 'cancelled', metrics: {} }, { status: 'not_run', metrics: {} },
    ];
    expect(SummarizeEvalCases(rows as any, 10, 20)).toMatchObject({ totalCaseRuns: 6, completedCaseRuns: 3, unscoredCaseRuns: 1, failedCaseRuns: 1, cancelledCaseRuns: 1, notRunCaseRuns: 1, taskEvaluatedCaseRuns: 2, taskCompletedCaseRuns: 1, taskCompletionRate: 0.5, averageScore: 55 });
    expect(SummarizeEvalCases(rows.slice(2) as any, 10, 20).taskCompletionRate).toBeNull();
  });
});

describe('浏览器状态与执行回执', () => {
  it.each([
    [{ a: 1, b: [true, { c: null }] }, { b: [true, { c: null }], a: 1 }, true],
    [{ a: [1, 2] }, { a: [2, 1] }, false],
    [{ a: 1, b: 2 }, { a: 1 }, false],
    [0, false, false], [null, null, true],
  ])('JSON 深相等 %j / %j', (actual, expected, passed) => {
    const score = ScoreBrowserCase({ testCase: { ...testCase, browser: { assertions: [{ id: 'state', type: 'state_equals', path: 'value', expected, weight: 100 }] } } as any, events: [], finalState: { value: actual }, metrics: {} });
    expect(score.score.assertionResults?.[0].passed).toBe(passed);
  });

  it('成功摘要、错误调用、无关联确认不能通过回执断言，真实关联回执通过', () => {
    const call = { type: 'tool_call', payload: { name: 'BrowserClick', toolCallId: 'c1' } };
    const receipt = { receiptId: 'r1', toolDefinitionId: 'BrowserClick' };
    const result = { type: 'tool_result', payload: { name: 'BrowserClick', toolCallId: 'c1', ok: true, receipt } };
    expect(SuccessfulBrowserReceipts([call, { type: 'tool_result', payload: { name: 'BrowserClick', ok: true } }])).toHaveLength(0);
    expect(SuccessfulBrowserReceipts([call, { ...result, payload: { ...result.payload, toolCallId: 'other' } }])).toHaveLength(0);
    expect(SuccessfulBrowserReceipts([call, result], 'BrowserFill')).toHaveLength(0);
    expect(SuccessfulBrowserReceipts([call, result], 'BrowserClick')).toEqual([receipt]);
    const confirmation = { type: 'browser_confirmation', payload: { confirmationId: 'approval', browserAction: { toolName: 'BrowserClick' } } };
    const action = { type: 'browser_action_completed', payload: { confirmationId: 'approval', browserAction: { confirmationId: 'approval', status: 'succeeded', receipt } } };
    expect(SuccessfulBrowserReceipts([action])).toHaveLength(0);
    expect(SuccessfulBrowserReceipts([confirmation, action], 'BrowserClick')).toEqual([receipt]);
    const test = { ...testCase, browser: { assertions: [{ id: 'receipt', type: 'receipt_exists', toolName: 'BrowserClick', weight: 100 }] } } as any;
    expect(ScoreBrowserCase({ testCase: test, events: [confirmation, action], finalState: {}, metrics: {} }).score.taskCompleted).toBe(true);
    expect(ScoreBrowserCase({ testCase: test, events: [confirmation, action], finalState: {}, metrics: { wrongSubmissions: 1 } }).score.taskCompleted).toBe(false);
  });
});

describe('A/B 同条件与重复样本', () => {
  it.each(['rubric', 'judgePrompt', 'judgeStrictJson', 'environment.browserEngine', 'environment.closeTaskTabs', 'models', 'config.rubricDimensions', 'cases'])('%s 不一致应报告差异', field => {
    const left: any = {}, right: any = {};
    const parts = field.split('.');
    if (parts.length === 1) { left[field] = 'a'; right[field] = 'b'; }
    else { left[parts[0]] = { [parts[1]]: 'a' }; right[parts[0]] = { [parts[1]]: 'b' }; }
    expect(FindEvalSnapshotDifferences(left, right)).toContain(field);
  });
  it('对象键序不影响可比条件', () => { expect(FindEvalSnapshotDifferences({ models: { a: 1, b: 2 } }, { models: { b: 2, a: 1 } })).toEqual([]); });
  it('单候选改名后按 repeat 取已评分交集，忽略仅一侧有分的样本并报告缺题', () => {
    const row = (caseId: string, candidateId: string, repeatIndex: number, score: number | null) => ({ caseId, candidateId, candidateName: candidateId, repeatIndex, status: 'completed', score: { totalScore: score } });
    const left = { snapshot: { cases: [{ id: 'common' }, { id: 'left-only' }] }, caseRuns: [row('common', 'old', 0, 10), row('common', 'old', 1, 90), row('common', 'old', 2, 100), row('left-only', 'old', 0, 100)] };
    const right = { snapshot: { cases: [{ id: 'common' }, { id: 'right-only' }] }, caseRuns: [row('common', 'new', 0, 20), row('common', 'new', 1, 100), row('common', 'new', 2, null), row('right-only', 'new', 0, 100)] };
    const result = CompareEvalSamples(left as any, right as any);
    expect(result).toMatchObject({ commonCaseCount: 1, leftOnlyCaseCount: 1, rightOnlyCaseCount: 1, pairedCount: 2, leftMean: 50, rightMean: 60 });
    expect(result.rows[0]).toMatchObject({ pairedCount: 2, leftTotal: 3, rightTotal: 3, leftScored: 3, rightScored: 2, left: { mean: 50 } });
    expect(result.rows[0].left.stddev).toBeCloseTo(56.5685);
  });
  it('多候选不混合首分或不同 ID，未配对候选单独显示', () => {
    const row = (candidateId: string, value: number) => ({ caseId: 'c', candidateId, candidateName: candidateId, repeatIndex: 0, status: 'completed', score: { totalScore: value } });
    const result = CompareEvalSamples({ snapshot: {}, caseRuns: [row('a', 10), row('b', 90)] } as any, { snapshot: {}, caseRuns: [row('a', 20), row('c', 80)] } as any);
    expect(result.rows).toHaveLength(3);
    expect(result).toMatchObject({ pairedCount: 1, leftMean: 10, rightMean: 20 });
  });
});

describe('所有测评 Artifact 的思考过滤', () => {
  it('消息/事件/嵌套附件均不落盘思考内容，工具、正文和状态保留', async () => {
    const root = await mkdtemp(join(tmpdir(), 'avery-eval-private-evidence-')); roots.push(root);
    const store = new EvalArtifactStore(root);
    await store.AppendCaseEvent('run', 'case', 'messages.jsonl', { type: 'thinking_delta', payload: { delta: 'PRIVATE_THOUGHT' } });
    await store.AppendCaseEvent('run', 'case', 'messages.jsonl', { type: 'tool_result', payload: { ok: true, reasoning_content: 'PRIVATE_NESTED', result: { content: '公开事实', thinkingContent: 'PRIVATE_DEEP' } } });
    await store.AppendEvent('run', { type: 'reasoning_delta', content: 'PRIVATE_RUN' });
    await store.AppendEvent('run', { type: 'score', payload: { score: 80 } });
    await store.WriteCaseJson('run', 'case', 'result.json', { finalResponse: '可观察回复', finalState: { saved: false }, events: [{ type: 'thinking_delta', text: 'PRIVATE_ARRAY' }, { type: 'completed', content: '正常回复' }], arguments: JSON.stringify({ a: 1, reasoning: 'PRIVATE_JSON' }), judgeRaw: [JSON.stringify({ reason: '公开理由', reasoning_content: 'PRIVATE_JUDGE' })] });
    const messages = await readFile(join(store.root, 'run', 'cases', 'case', 'messages.jsonl'), 'utf8');
    const events = await readFile(join(store.root, 'run', 'events.jsonl'), 'utf8');
    const result = await readFile(join(store.root, 'run', 'cases', 'case', 'result.json'), 'utf8');
    expect(messages + events + result).not.toContain('PRIVATE_');
    expect(messages).toContain('公开事实'); expect(messages.trim().split('\n')).toHaveLength(1);
    expect(JSON.parse(result)).toMatchObject({ finalResponse: '可观察回复', finalState: { saved: false }, events: [{ type: 'completed', content: '正常回复' }] });
    expect(JSON.parse(events).type).toBe('score');
  });
});
