import { describe, expect, it } from 'vitest';
import { BrowserUserSimulator } from '../../../apps/backend/src/electron/backend/evaluation/browser-user-simulator';
import { StartEvalBrowserFixture } from '../../../apps/backend/src/electron/backend/evaluation/browser-fixture-server';
import { CreateExactOriginNormalizer } from '../../../apps/backend/src/electron/backend/evaluation/browser-eval-runner';

const testCase = {
  id: 'browser-1', category: 'application', input: { userMessage: '投递' }, fixtures: {}, tags: [],
  expected: { requiredFacts: [], requiredBehaviors: [], forbiddenClaims: [], forbiddenBehaviors: [], referenceAnswer: '', expectedState: { selectedJobId: 'agent-platform', submission: { jobId: 'agent-platform' } } },
  browser: { forbiddenTargets: ['danger-job'], scriptedResponses: [] },
};

describe('browser evaluation isolation and simulator', () => {
  it('导航策略只允许当前随机 Fixture origin', async () => {
    const normalize = CreateExactOriginNormalizer('http://127.0.0.1:43210');
    await expect(normalize('http://127.0.0.1:43210/jobs?q=agent#part')).resolves.toBe('http://127.0.0.1:43210/jobs?q=agent');
    await expect(normalize('https://example.com/')).rejects.toMatchObject({ code: 'BROWSER_NAVIGATION_DENIED' });
    await expect(normalize('http://127.0.0.1:43211/')).rejects.toMatchObject({ code: 'BROWSER_NAVIGATION_DENIED' });
  });

  it('approve_valid 拒绝错误岗位、错误附件和禁止目标', () => {
    const simulator = new BrowserUserSimulator();
    const base = { strategy: 'approve_valid' as const, testCase: testCase as any, authorizedFileIds: new Set(['attachment://ok']), fixtureState: { selectedJobId: 'wrong-job', submissionCount: 0, duplicateSubmissionAttempts: 0, submission: null, receipt: null } };
    expect(simulator.Decide({ ...base, proposal: { toolName: 'BrowserClick', summary: '提交申请', canonicalArguments: {} } })).toMatchObject({ accepted: false, reason: 'wrong_job' });
    expect(simulator.Decide({ ...base, proposal: { toolName: 'BrowserUploadFile', summary: '上传', canonicalArguments: { fileId: 'attachment://bad' } } })).toMatchObject({ accepted: false, reason: 'wrong_attachment' });
    expect(simulator.Decide({ ...base, proposal: { toolName: 'BrowserClick', summary: 'danger-job', canonicalArguments: {} } })).toMatchObject({ accepted: false, reason: 'forbidden_target' });
  });

  it('Fixture 后端以状态和回执判定完成，并阻止重复提交', async () => {
    const fixture = await StartEvalBrowserFixture();
    try {
      const selected = await fetch(`${fixture.origin}/__eval/select`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jobId: 'agent-platform' }) });
      expect(selected.ok).toBe(true);
      const submission = { jobId: 'agent-platform', name: '测试用户', email: 'test@example.com', phone: '13800000000', intro: 'Agent', workMode: 'hybrid', province: '浙江', city: '杭州', jobFamily: '技术', jobTrack: 'Agent 工程', resumeName: 'resume.txt', terms: true };
      const first = await fetch(`${fixture.origin}/__eval/submit`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(submission) });
      const second = await fetch(`${fixture.origin}/__eval/submit`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(submission) });
      expect(first.status).toBe(200); expect(second.status).toBe(409);
      expect(fixture.getState()).toMatchObject({ selectedJobId: 'agent-platform', submissionCount: 1, duplicateSubmissionAttempts: 1, submission, receipt: 'LOCAL-EVAL-APPLICATION-0001' });
    } finally { await fixture.close(); }
  });

  it('clean 分支移除干扰 DOM，realistic-dom 按固定 seed 稳定生成干扰元素', async () => {
    const fixture = await StartEvalBrowserFixture();
    try {
      const clean = await (await fetch(`${fixture.origin}/?branch=clean&seed=3`)).text();
      const realisticA = await (await fetch(`${fixture.origin}/?branch=realistic-dom&seed=3`)).text();
      const realisticB = await (await fetch(`${fixture.origin}/?branch=realistic-dom&seed=3`)).text();
      const realisticOther = await (await fetch(`${fixture.origin}/?branch=realistic-dom&seed=4`)).text();
      expect(clean).not.toContain('data-eval-noise');
      expect(realisticA).toContain('data-eval-noise="3"');
      expect(realisticA).toBe(realisticB);
      expect(realisticA).not.toBe(realisticOther);
    } finally { await fixture.close(); }
  });
});
