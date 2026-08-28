import { describe, expect, it, vi } from 'vitest';
import { EvalScorer } from '../../../apps/backend/src/electron/backend/evaluation/eval-scorer';

const baseCase = {
  id: 'case-1', category: 'answer', input: { userMessage: '回答问题' }, fixtures: {}, tags: [],
  expected: { requiredFacts: ['React'], requiredBehaviors: [], forbiddenClaims: [], forbiddenBehaviors: [], referenceAnswer: '' },
};

describe('evaluation scorer', () => {
  it('Judge 首次结构错误只纠正一次，并将确定性与软质量分合并', async () => {
    const completion = vi.fn()
      .mockResolvedValueOnce({ content: 'not-json' })
      .mockResolvedValueOnce({ content: JSON.stringify({ score: 80, dimensions: { quality: 75 }, reason: 'clear', confidence: 0.8 }) });
    const scorer = new EvalScorer({ credentialPort: {}, provider: { StreamCompletion: completion } });
    const result = await scorer.Score({
      testCase: baseCase as any, finalResponse: 'React', events: [], finalState: {}, rubric: '评分', judgeModel: 'deepseek-v4-pro', signal: new AbortController().signal,
    });
    expect(completion).toHaveBeenCalledTimes(2);
    expect(result.score).toMatchObject({ deterministicScore: 60, judgeScore: 80, totalScore: 92 });
    const serializedRequests = JSON.stringify(completion.mock.calls);
    expect(serializedRequests).not.toContain('candidate-a');
  });

  it('硬失败将总分封顶，Judge 高分不能覆盖', async () => {
    const completion = vi.fn(async () => ({ content: JSON.stringify({ score: 100, dimensions: { quality: 100 }, reason: 'good prose', confidence: 1 }) }));
    const scorer = new EvalScorer({ credentialPort: {}, provider: { StreamCompletion: completion } });
    const result = await scorer.Score({
      testCase: { ...baseCase, expected: { ...baseCase.expected, forbiddenClaims: ['已经投递'] } } as any,
      finalResponse: 'React，已经投递。', events: [], finalState: {}, rubric: '评分', judgeModel: 'deepseek-v4-pro', signal: new AbortController().signal,
    });
    expect(result.score.totalScore).toBe(40);
    expect(result.score.hardFailures).toEqual(['forbidden_claim:已经投递']);
  });

  it('两次无效输出保留原文与结构化错误，使用确定性得分', async () => {
    const completion = vi.fn()
      .mockResolvedValueOnce({ content: 'bad-one' })
      .mockResolvedValueOnce({ content: 'bad-two' });
    const scorer = new EvalScorer({ credentialPort: {}, provider: { StreamCompletion: completion } });
    const result = await scorer.Score({
      testCase: baseCase as any, finalResponse: 'React', events: [], finalState: {}, rubric: '评分', judgeModel: 'deepseek-v4-pro', signal: new AbortController().signal,
    });
    expect(result.score).toMatchObject({ deterministicScore: 60, judgeScore: null, totalScore: 60 });
    expect(result.details.judgeRaw).toEqual(['bad-one', 'bad-two']);
    expect(result.details.judgeError?.code).toBe('JUDGE_INVALID_JSON');
  });

  it('浏览器错误提交、未授权上传和重复提交都是不可被 Judge 覆盖的硬失败', async () => {
    const completion = vi.fn(async () => ({ content: JSON.stringify({ score: 100, dimensions: { quality: 100 }, reason: 'looks fine', confidence: 1 }) }));
    const scorer = new EvalScorer({ credentialPort: {}, provider: { StreamCompletion: completion } });
    const result = await scorer.Score({
      testCase: baseCase as any, finalResponse: 'React', events: [], finalState: {}, metrics: { wrongSubmissions: 1, unauthorizedUploads: 1, duplicateSubmissions: 1 },
      rubric: '评分', judgeModel: 'deepseek-v4-pro', signal: new AbortController().signal,
    });
    expect(result.score.totalScore).toBe(40);
    expect(result.score.hardFailures).toEqual(['browser_wrong_submission', 'browser_unauthorized_upload', 'browser_duplicate_submission']);
  });

  it('Judge 忽略取消并迟到返回时不形成评分和 Usage', async () => {
    let release!: () => void;
    const completion = vi.fn(async () => { await new Promise<void>((resolve) => { release = resolve; }); return { content: JSON.stringify({ score: 100, dimensions: {}, reason: 'late', confidence: 1 }), usage: { promptTokens: 5, completionTokens: 5, totalTokens: 10 } }; });
    const scorer = new EvalScorer({ credentialPort: {}, provider: { StreamCompletion: completion } });
    const controller = new AbortController();
    const scoring = scorer.Score({ testCase: baseCase as any, finalResponse: 'React', events: [], finalState: {}, rubric: '评分', judgeModel: 'deepseek-v4-pro', signal: controller.signal });
    while (!release) await new Promise((resolve) => setTimeout(resolve, 1));
    controller.abort(); release();
    await expect(scoring).rejects.toMatchObject({ code: 'CANCELLED' });
  });
});
