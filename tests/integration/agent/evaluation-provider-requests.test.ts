import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EvalService } from '../../../apps/backend/src/electron/backend/evaluation/eval-service';
import { ObservabilityStore } from '../../../apps/backend/src/observability-store';
import { EvaluationTestCredentials } from '../../fixtures/evaluation-credentials';
import { CreateProviderFetch } from '../../../apps/backend/src/infra/provider-fetch';

afterEach(() => vi.unstubAllGlobals());

describe('正式 Prompt Runner 和 Judge 的供应商请求', () => {
  it.each([false, true])('宿主传输注入=%s：真实 Host/Provider 与 Judge 使用冻结供应商、凭据及同一网络栈', async injected => {
    const requests: Array<{ url: string; authorization: string | null; body: any }> = [];
    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (injected) expect(init).toMatchObject({ credentials: 'omit', cache: 'no-store', redirect: 'error' });
      const body = JSON.parse(String(init?.body));
      requests.push({ url: String(url), authorization: new Headers(init?.headers).get('Authorization'), body });
      const content = String(url).startsWith('https://api.deepseek.com')
        ? JSON.stringify({ score: 85, dimensions: { taskCompletion: 85, instructionFollowing: 85, safety: 85, responseQuality: 85 }, reason: '依据 evidence.sources.profile[0].content', confidence: 0.9, requirementResults: [{ id: 'taskOutcome', requirement: '完成任务', passed: true, reason: '依据 evidence.sources.profile' }], hardFailures: [] })
        : '这是基于已知资料的测试草稿。';
      const chunk = { choices: [{ index: 0, delta: { content }, finish_reason: 'stop' }] };
      const usage = { choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } };
      return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify(usage)}\n\ndata: [DONE]\n\n`, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    });
    const directFetch = vi.fn(async () => { throw new Error('Unexpected direct network access'); });
    vi.stubGlobal('fetch', injected ? directFetch : fetcher);
    const root = await mkdtemp(join(tmpdir(), 'avery-eval-provider-http-'));
    const store = new ObservabilityStore(root);
    const service = new EvalService({ userDataPath: root, store, credentialPort: EvaluationTestCredentials(), providerFetch: injected ? CreateProviderFetch(fetcher) : undefined, getStoredSettings: async () => ({ developerMode: true }), Emit() {} });
    try {
      await service.Initialize();
      let project = await service.CreateProject({ name: '跨供应商请求', runnerType: 'prompt', rubric: '必须忠于档案', config: { executionProvider: 'MIMO', executionModel: 'mimo-v2.6-flash', judgeProvider: 'DeepSeek', judgeModel: 'deepseek-v4-pro', candidates: [{ id: 'a', name: 'A', promptOverrides: {} }], maxModelTurns: 4, repeatCount: 1, userSimulator: 'approve_valid' } });
      await service.ImportDataset(project.id, JSON.stringify({ id: 'http-case', category: '简历草稿', input: { userMessage: '请直接给一句测试草稿，不调用工具。' }, fixtures: { profile: [{ id: 'p', content: '参与 3 次访谈。' }] }, expected: { requiredFacts: [], requiredBehaviors: [], forbiddenClaims: [], forbiddenBehaviors: [], referenceAnswer: '' }, tags: [] }), project.rubric, project.revision);
      project = await service.ReadProject(project.id);
      const started = await service.StartRun(project.id);
      let run = await service.ReadRun(started.id);
      for (let attempt = 0; attempt < 400 && !['completed', 'failed', 'cancelled'].includes(run.status); attempt++) {
        await new Promise(resolve => setTimeout(resolve, 10)); run = await service.ReadRun(started.id);
      }
      expect(run.caseRuns[0]?.error).toBeUndefined();
      expect(run.status).toBe('completed');
      expect((await service.ReadCaseResult(run.caseRuns[0].id)).scoreDetails?.judgeError).toBeUndefined();
      expect(run.caseRuns[0].score?.totalScore).toBe(85);
      expect(requests).toHaveLength(2);
      expect(directFetch).not.toHaveBeenCalled();
      expect(requests[0]).toMatchObject({ url: 'https://api.xiaomimimo.com/v1/chat/completions', authorization: 'Bearer synthetic-MIMO-credential', body: { model: 'mimo-v2.6-flash' } });
      expect(requests[1]).toMatchObject({ url: 'https://api.deepseek.com/chat/completions', authorization: 'Bearer synthetic-DeepSeek-credential', body: { model: 'deepseek-v4-pro' } });
      expect(JSON.parse(requests[1].body.messages[1].content).evidence.sources.profile[0].content).toBe('参与 3 次访谈。');
    } finally { await service.Close(); store.Close(); await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
  }, 10000);
});
