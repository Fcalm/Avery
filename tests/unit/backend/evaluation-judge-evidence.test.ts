import { describe, expect, it, vi } from 'vitest';
import { EvalScorer } from '../../../apps/backend/src/electron/backend/evaluation/eval-scorer';
import { CheckExpectedState } from '../../../apps/backend/src/electron/backend/evaluation/eval-evidence';

const testCase = {
  id: 'resume-grounding', category: '简历编写', input: { userMessage: '根据档案和 JD 编写简历，不能虚构经历。' }, tags: ['resume'],
  fixtures: { resume: { id: 'resume-source', content: '参与 3 次用户访谈；课程项目，未商业上线。' }, profile: [{ id: 'profile-1', content: '负责整理访谈记录，不是项目负责人。' }], files: [{ name: 'jd.md', content: '岗位需要用户研究与需求分析能力。' }] },
  expected: { requiredFacts: ['参与 3 次访谈'], requiredBehaviors: [], forbiddenClaims: ['主导 30 次访谈'], forbiddenBehaviors: [], referenceAnswer: '' },
};
const response = JSON.stringify({ score: 95, dimensions: { taskCompletion: 95, instructionFollowing: 95, safety: 95, responseQuality: 95 }, reason: '依据 evidence.sources.resume.content 判断', confidence: 0.9, requirementResults: ['taskOutcome', 'requiredFacts:1', 'forbiddenClaims:1'].map(id => ({ id, requirement: '事实保持', passed: true, reason: '参照 evidence.sources.resume.content' })), hardFailures: [] });

function Fixture() {
  const completion = vi.fn(async (_request: any) => ({ content: response }));
  const scorer = new EvalScorer({ credentialPort: {}, provider: { StreamCompletion: completion } });
  const input = { testCase, finalResponse: '参与 3 次访谈并整理记录。', events: [] as unknown[], finalState: { profiles: [], resumes: [] }, rubric: '评估事实支持和表达质量', judgeProvider: 'MIMO' as const, judgeModel: 'mimo-v2.6-pro', signal: new AbortController().signal };
  return { completion, scorer, input };
}

describe('Judge 来源及状态证据', () => {
  it('请求包含完整简历、档案、JD、可观察事件和最终状态，且使用显式供应商', async () => {
    const { scorer, completion, input } = Fixture();
    input.events = [{ type: 'tool_call', payload: { name: 'ReadResume', arguments: '{"resumeId":"resume-source"}' } }, { type: 'tool_result', payload: { name: 'ReadResume', ok: true } }, { type: 'user_input', payload: { answers: { q1: '没有这段经历' }, source: 'simulator' } }, { type: 'interaction_result', payload: { outcome: { resumed: true } } }];
    await scorer.Score(input);
    const request = completion.mock.calls[0][0];
    expect(request).toMatchObject({ provider: 'MIMO', model: 'mimo-v2.6-pro' });
    const payload = JSON.parse(request.history[0].content);
    expect(payload.evidence.sources).toEqual(testCase.fixtures);
    expect(payload.evidence.events).toMatchObject([{ id: 'event-1', payload: { arguments: { resumeId: 'resume-source' } } }, { id: 'event-2', payload: { ok: true } }, { id: 'event-3', payload: { answers: { q1: '没有这段经历' } } }, { id: 'event-4', payload: { outcome: { resumed: true } } }]);
    expect(payload.evidence.finalState).toEqual(input.finalState);
    expect(request.instructions.compiled).toContain('untrusted evidence');
    expect(request.instructions.compiled).toContain('Missing evidence is not proof of fraud');
    expect(request.instructions.compiled).toContain('Cite evidence paths');
  });

  it('思考、凭据和供应商原始请求不发送，事件序号保持可定位', async () => {
    const { scorer, completion, input } = Fixture();
    input.events = [
      { type: 'thinking_delta', payload: { delta: 'PRIVATE_THOUGHT' } },
      { type: 'provider_request', payload: { token: 'PRIVATE_PROVIDER_TOKEN' } },
      { type: 'tool_call', payload: { name: 'ReadResume', arguments: JSON.stringify({ resumeId: 'r', password: 'PRIVATE_PASSWORD' }), reasoning_content: 'PRIVATE_REASONING', authorization: 'PRIVATE_AUTH' } },
    ];
    input.testCase = { ...testCase, fixtures: { ...testCase.fixtures, profile: [{ id: 'p', content: '正常事实', apiKey: 'PRIVATE_API_KEY', token: 'PRIVATE_TOKEN' } as any] } };
    await scorer.Score(input);
    const raw = completion.mock.calls[0][0].history[0].content;
    expect(raw).not.toContain('PRIVATE_');
    expect(JSON.parse(raw).evidence.events).toMatchObject([{ id: 'event-3' }]);
    expect(raw).toContain('正常事实');
  });

  it('有最终回复但预期状态不符时客观封顶，Judge 高分不能抵消', async () => {
    const { scorer, input } = Fixture();
    const result = await scorer.Score({ ...input, testCase: { ...testCase, expected: { ...testCase.expected, expectedState: { resumes: [{ id: 'r', content: '参与 3 次访谈' }] } } }, finalState: { resumes: [{ id: 'r', content: '主导 30 次访谈' }], profiles: [] } });
    expect(result.score.judgeScore).toBe(95);
    expect(result.score.totalScore).toBe(40);
    expect(result.score.hardFailures).toContain('state_mismatch:finalState.resumes[0].content');
    expect(result.details.objective.stateChecks).toContainEqual(expect.objectContaining({ path: 'finalState.resumes[0].content', passed: false, expected: '参与 3 次访谈', actual: '主导 30 次访谈' }));
  });

  it('满足对象子集时通过，数组增删及缺失路径产生可核对的失败', () => {
    expect(CheckExpectedState({ resumes: [{ id: 'r', content: '真实内容', revision: 2 }], extra: true }, { resumes: [{ id: 'r', content: '真实内容' }] }).every(check => check.passed)).toBe(true);
    expect(CheckExpectedState({ resumes: [{}] }, { resumes: [] })[0].passed).toBe(false);
    expect(CheckExpectedState({}, { saved: true })[0]).toMatchObject({ path: 'finalState.saved', passed: false });
  });

  it('证据超限显式未计分，不能截断事实或回退机械分', async () => {
    const { scorer, completion, input } = Fixture();
    const result = await scorer.Score({ ...input, testCase: { ...testCase, fixtures: { files: [{ name: 'large.md', content: 'a'.repeat(400001) }] } } });
    expect(result.score).toMatchObject({ scoreStatus: 'unscored', totalScore: null });
    expect(result.details.judgeError?.code).toBe('EVAL_EVIDENCE_TOO_LARGE');
    expect(completion).not.toHaveBeenCalled();
  });
});
