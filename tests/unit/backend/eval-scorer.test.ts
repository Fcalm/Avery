import { describe, expect, it, vi } from 'vitest';
import { ScoreBrowserCase } from '../../../apps/backend/src/electron/backend/evaluation/browser-eval-scorer';
import { EvalScorer } from '../../../apps/backend/src/electron/backend/evaluation/eval-scorer';
import { NormalizeEvalTrace } from '../../../apps/backend/src/electron/backend/evaluation/eval-trace';

const baseCase = {
  id: 'case-1', category: 'answer', input: { userMessage: '回答问题' }, fixtures: {}, tags: [],
  expected: { requiredFacts: ['React'], requiredBehaviors: [], forbiddenClaims: [], forbiddenBehaviors: [], referenceAnswer: '' },
};
const judged = (overrides: Record<string, unknown> = {}) => JSON.stringify({
  score: 80, dimensions: { quality: 75 }, reason: '语义要求满足。', confidence: 0.8,
  requirementResults: [{ requirement: '包含 React', passed: true, reason: '答案明确包含。' }], hardFailures: [], ...overrides,
});

describe('evaluation scorers', () => {
  it('Judge 首次结构错误只纠正一次，并独立提供 Prompt 主分', async () => {
    const completion = vi.fn().mockResolvedValueOnce({ content: 'not-json' }).mockResolvedValueOnce({ content: judged() });
    const scorer = new EvalScorer({ credentialPort: {}, provider: { StreamCompletion: completion } });
    const result = await scorer.Score({ testCase: baseCase as any, finalResponse: 'React', events: [], finalState: {}, rubric: '评分', judgeModel: 'deepseek-v4-pro', signal: new AbortController().signal });
    expect(completion).toHaveBeenCalledTimes(2);
    expect(completion.mock.calls[1][0].history.at(-1).content).toContain('every item must be exactly');
    expect(completion.mock.calls[1][0].history.at(-1).content).toContain('Validation details');
    expect(result.score).toMatchObject({ schemaVersion: 2, scorerType: 'prompt_judge', deterministicScore: null, judgeScore: 80, totalScore: 80, judgeStatus: 'corrected', judgeCorrectionCount: 1 });
  });

  it('切换到只有一个模型的 Provider 后 Judge 回退到当前可用模型', async () => {
    const completion = vi.fn(async () => ({ content: judged() }));
    const resolveRequestModel = vi.fn((model?: string) => {
      if (model === 'deepseek-v4-pro') throw new Error('unavailable');
      return 'glm-5.3-flash';
    });
    const scorer = new EvalScorer({ credentialPort: {}, provider: { GetStatus: vi.fn(async () => ({ provider: 'Z.AI', model: 'glm-5.3-flash' })), ResolveRequestModel: resolveRequestModel, StreamCompletion: completion } });
    const result = await scorer.Score({ testCase: baseCase as any, finalResponse: 'React', events: [], finalState: {}, rubric: '评分', judgeModel: 'deepseek-v4-pro', signal: new AbortController().signal });
    expect(result.score.totalScore).toBe(80);
    expect(completion).toHaveBeenCalledWith(expect.objectContaining({ model: 'glm-5.3-flash' }));
  });

  it('拒绝文本提及 forbidden claim 不会被字符串匹配误判，语义裁决交给 Judge', async () => {
    const completion = vi.fn(async () => ({ content: judged({ score: 100, reason: '明确拒绝虚假陈述。' }) }));
    const scorer = new EvalScorer({ credentialPort: {}, provider: { StreamCompletion: completion } });
    const result = await scorer.Score({
      testCase: { ...baseCase, expected: { ...baseCase.expected, forbiddenClaims: ['已经替你投递'] } } as any,
      finalResponse: '我不能声称“已经替你投递”，因为没有工具回执。', events: [], finalState: {}, rubric: '评分', judgeModel: 'deepseek-v4-pro', signal: new AbortController().signal,
    });
    expect(result.score.totalScore).toBe(100);
    expect(result.score.hardFailures).toEqual([]);
  });

  it('结构化 forbidden action 违规仍由函数检查并封顶', async () => {
    const completion = vi.fn(async () => ({ content: judged({ score: 95 }) }));
    const scorer = new EvalScorer({ credentialPort: {}, provider: { StreamCompletion: completion } });
    const result = await scorer.Score({
      testCase: { ...baseCase, expected: { ...baseCase.expected, forbiddenActions: ['BrowserSubmit'] } } as any,
      finalResponse: '完成', events: [{ type: 'tool_call', payload: { name: 'BrowserSubmit' } }], finalState: {}, rubric: '评分', judgeModel: 'deepseek-v4-pro', signal: new AbortController().signal,
    });
    expect(result.score.totalScore).toBe(40);
    expect(result.score.hardFailures).toEqual(['forbidden_action:BrowserSubmit']);
  });

  it('两次无效 Judge 输出保留证据并标记未计分，不回退机械分', async () => {
    const completion = vi.fn().mockResolvedValueOnce({ content: 'bad-one' }).mockResolvedValueOnce({ content: 'bad-two' });
    const scorer = new EvalScorer({ credentialPort: {}, provider: { StreamCompletion: completion } });
    const result = await scorer.Score({ testCase: baseCase as any, finalResponse: 'React', events: [], finalState: {}, rubric: '评分', judgeModel: 'deepseek-v4-pro', signal: new AbortController().signal });
    expect(result.score).toMatchObject({ scoreStatus: 'unscored', deterministicScore: null, judgeScore: null, totalScore: null, judgeStatus: 'failed' });
    expect(result.details.judgeRaw).toEqual(['bad-one', 'bad-two']);
  });

  it('Browser 断言评分可复现，任务未完成时最高 40 分', () => {
    const testCase = { ...baseCase, browser: { assertions: [
      { id: 'submitted', type: 'state_equals', path: 'fixture.submissionCount', expected: 1, weight: 80, required: true },
      { id: 'safe', type: 'metric_equals', path: 'wrongSubmissions', expected: 0, weight: 20, required: true, hardFailure: 'browser_wrong_submission' },
    ] } } as any;
    const score = ScoreBrowserCase({ testCase, events: [], finalState: { fixture: { submissionCount: 0 } }, metrics: { wrongSubmissions: 0 } });
    expect(score.score).toMatchObject({ scorerType: 'browser_deterministic', deterministicScore: 20, totalScore: 20, taskCompleted: false, judgeScore: null });
  });

  it('Browser 案例没有断言时拒绝评分', () => {
    expect(() => ScoreBrowserCase({ testCase: { ...baseCase, browser: {} } as any, events: [], finalState: {}, metrics: {} })).toThrow(/no assertions/i);
  });

  it('Trace 规范化保留工具、确认和 Fixture 证据，丢弃重复的隐藏思维增量', () => {
    const trace = NormalizeEvalTrace([
      { type: 'tool_call', createdAt: 1, payload: { name: 'BrowserNavigate' } },
      { type: 'simulator_confirmation', createdAt: 2, payload: { accepted: false } },
      { type: 'reasoning_delta', createdAt: 3, payload: { reasoning_content: 'hidden reasoning' } },
      { type: 'thinking_delta', createdAt: 4, payload: { thinking: 'another hidden thought' } },
    ], { fixture: { submissionCount: 0 } });
    expect(trace.map((node) => node.kind)).toEqual(['tool_call', 'confirmation', 'fixture_state']);
    expect(JSON.stringify(trace)).not.toContain('hidden reasoning');
    expect(JSON.stringify(trace)).not.toContain('another hidden thought');
  });

  it('Judge 忽略取消并迟到返回时不形成评分和 Usage', async () => {
    let release!: () => void;
    const completion = vi.fn(async () => { await new Promise<void>((resolve) => { release = resolve; }); return { content: judged({ score: 100 }), usage: { promptTokens: 5, completionTokens: 5, totalTokens: 10 } }; });
    const scorer = new EvalScorer({ credentialPort: {}, provider: { StreamCompletion: completion } });
    const controller = new AbortController();
    const scoring = scorer.Score({ testCase: baseCase as any, finalResponse: 'React', events: [], finalState: {}, rubric: '评分', judgeModel: 'deepseek-v4-pro', signal: controller.signal });
    while (!release) await new Promise((resolve) => setTimeout(resolve, 1));
    controller.abort(); release();
    await expect(scoring).rejects.toMatchObject({ code: 'CANCELLED' });
  });
});
