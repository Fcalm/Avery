import { describe, expect, it } from 'vitest';
import { BrowserUserSimulator } from '../../../apps/backend/src/electron/backend/evaluation/browser-user-simulator';
import { StartEvalBrowserFixture } from '../../../apps/backend/src/electron/backend/evaluation/browser-fixture-server';
import { CreateExactOriginNormalizer } from '../../../apps/backend/src/electron/backend/evaluation/browser-eval-runner';
import { EvalFixtureJobs } from '../../../apps/backend/src/electron/backend/evaluation/fixture-jobs';

const testCase = {
  id: 'browser-1', category: 'application', input: { userMessage: '投递' }, fixtures: {}, tags: [],
  expected: { requiredFacts: [], requiredBehaviors: [], forbiddenClaims: [], forbiddenBehaviors: [], referenceAnswer: '', expectedState: { selectedJobId: 'agent-platform', submission: { jobId: 'agent-platform' } } },
  browser: { forbiddenTargets: ['danger-job'], scriptedResponses: [] },
};

describe('browser evaluation isolation and simulator', () => {
  it('Fixture 提供 30 个岗位、6 家企业、10 种类型和严格降序匹配分', () => {
    expect(EvalFixtureJobs).toHaveLength(30);
    expect(new Set(EvalFixtureJobs.map((job) => job.company)).size).toBe(6);
    expect(new Set(EvalFixtureJobs.map((job) => job.type)).size).toBe(10);
    expect(EvalFixtureJobs.every((job, index) => index === 0 || EvalFixtureJobs[index - 1].matchScore > job.matchScore)).toBe(true);
    expect(EvalFixtureJobs.every((job) => job.description.length >= 200 && job.description.length <= 300)).toBe(true);
    expect(EvalFixtureJobs.every((job) => job.description.includes('岗位职责：') && job.description.includes('任职资格/要求：'))).toBe(true);
    expect(EvalFixtureJobs.every((job) => job.simulatedLink === `/jobs/${job.id}`)).toBe(true);
  });
  it('导航策略只允许当前随机 Fixture origin', async () => {
    const normalize = CreateExactOriginNormalizer('http://127.0.0.1:43210');
    await expect(normalize('http://127.0.0.1:43210/jobs?q=agent#part')).resolves.toBe('http://127.0.0.1:43210/jobs?q=agent');
    await expect(normalize('https://example.com/')).rejects.toMatchObject({ code: 'BROWSER_NAVIGATION_DENIED' });
    await expect(normalize('http://127.0.0.1:43211/')).rejects.toMatchObject({ code: 'BROWSER_NAVIGATION_DENIED' });
  });

  it('approve_valid 拒绝错误岗位、错误附件和禁止目标', () => {
    const simulator = new BrowserUserSimulator();
    const base = { strategy: 'approve_valid' as const, testCase: testCase as any, authorizedFileIds: new Set(['attachment://ok']), fixtureState: { selectedJobId: 'wrong-job', submissionCount: 0, duplicateSubmissionAttempts: 0, submission: null, receipt: null, searchCount: 0, lastFilters: null, viewedJobIds: [], detailViewCount: 0, applicationStarted: false } };
    expect(simulator.Decide({ ...base, proposal: { toolName: 'BrowserClick', summary: '提交申请', canonicalArguments: {} } })).toMatchObject({ accepted: false, reason: 'wrong_job' });
    expect(simulator.Decide({ ...base, proposal: { toolName: 'BrowserUploadFile', summary: '上传', canonicalArguments: { fileId: 'attachment://bad' } } })).toMatchObject({ accepted: false, reason: 'wrong_attachment' });
    expect(simulator.Decide({ ...base, proposal: { toolName: 'BrowserClick', summary: 'danger-job', canonicalArguments: {} } })).toMatchObject({ accepted: false, reason: 'forbidden_target' });
  });

  it('Fixture 后端以状态和回执判定完成，并阻止重复提交', async () => {
    const fixture = await StartEvalBrowserFixture();
    try {
      const favicon = await fetch(`${fixture.origin}/favicon.ico`);
      expect(favicon.status).toBe(204);
      const skippedSearch = await fetch(`${fixture.origin}/__eval/select`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jobId: 'agent-platform' }) });
      expect(skippedSearch.status).toBe(409);
      const skippedApplicationStart = await fetch(`${fixture.origin}/__eval/application-start`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jobId: 'agent-platform' }) });
      expect(skippedApplicationStart.status).toBe(409);
      await fetch(`${fixture.origin}/__eval/search`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ company: '星河科技', type: 'Agent 平台', minScore: 97 }) });
      const detail = await fetch(`${fixture.origin}/jobs/agent-platform`);
      expect(detail.ok).toBe(true);
      const selected = await fetch(`${fixture.origin}/__eval/select`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jobId: 'agent-platform' }) });
      expect(selected.ok).toBe(true);
      const started = await fetch(`${fixture.origin}/__eval/application-start`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jobId: 'agent-platform' }) });
      expect(started.ok).toBe(true);
      const submission = {
        jobId: 'agent-platform',
        personal: { name: '测试用户', gender: '不便透露', birthDate: '1995-06-15', email: 'test@example.com', phone: '13800000000', idType: '身份证', idNumber: 'MOCK-ID', graduationDate: '2018-06', yearsExperience: '5-10年', nationality: '中国', nativePlace: '浙江杭州', ethnicity: '汉族', politicalStatus: '群众', residenceProvince: '浙江', residenceCity: '杭州', hukouProvince: '浙江', hukouCity: '宁波' },
        education: { school: '测试大学', startDate: '2014-09', endDate: '2018-06', educationType: '全日制', major: '计算机科学与技术', degreeLevel: '本科', degree: '学士' },
        workExperience: { company: '示例软件有限公司', startDate: '2018-07', endDate: '2024-12', position: 'Agent 工程师', department: '平台研发部', companyType: '民营企业', companySize: '500-4999人', annualSalary: '30万元', responsibilities: '负责 Agent 工具编排。' },
        projectExperience: { name: 'OfferGet智能求职平台', startDate: '2023-01', endDate: '2024-12', description: '智能求职平台', responsibilities: '负责浏览器评测。' },
        jobPreference: { province: '浙江', city: '杭州', jobFamily: '技术', jobTrack: 'Agent 工程', expectedSalary: '35万元', availability: '一个月内', source: '企业官网', workMode: 'hybrid' },
        files: { resumeName: 'resume.txt', photoName: 'photo.png' }, terms: true,
      };
      const incomplete = await fetch(`${fixture.origin}/__eval/submit`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jobId: 'agent-platform', name: '旧版扁平表单' }) });
      expect(incomplete.status).toBe(422);
      const first = await fetch(`${fixture.origin}/__eval/submit`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(submission) });
      const second = await fetch(`${fixture.origin}/__eval/submit`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(submission) });
      expect(first.status).toBe(200); expect(second.status).toBe(409);
      expect(fixture.getState()).toMatchObject({ selectedJobId: 'agent-platform', searchCount: 1, viewedJobIds: ['agent-platform'], detailViewCount: 1, applicationStarted: true, submissionCount: 1, duplicateSubmissionAttempts: 1, submission, receipt: 'LOCAL-EVAL-APPLICATION-0001' });
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
      expect(realisticA).toContain('const jobs=[');
      expect(realisticA).toContain('1. 个人信息');
      expect(realisticA).toContain('5. 求职意向');
      expect(realisticA).toBe(realisticB);
      expect(realisticA).not.toBe(realisticOther);
    } finally { await fixture.close(); }
  });
});
