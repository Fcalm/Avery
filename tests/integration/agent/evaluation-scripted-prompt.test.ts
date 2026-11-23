import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PromptEvalRunner } from '../../../apps/backend/src/electron/backend/evaluation/prompt-eval-runner';
import { EvaluationTestCredentials } from '../../fixtures/evaluation-credentials';

afterEach(() => vi.unstubAllGlobals());
const base = { id: 'script-host', category: '简历', input: { userMessage: '先询问我是否有商业上线经历，再根据回答建议。' }, fixtures: {}, tags: [], expected: { requiredFacts: [], requiredBehaviors: [], forbiddenClaims: [], forbiddenBehaviors: [], referenceAnswer: '' } };

describe('正式 Prompt Runner 的脚本交互', () => {
  it.each([true, false])('脚本存在=%s：真实提问收到脚本答案，耗尽时停止并保留证据', async hasScript => {
    const requests: any[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init: RequestInit) => {
      const body = JSON.parse(String(init.body)); requests.push(body);
      const delta = requests.length === 1
        ? { tool_calls: [{ index: 0, id: 'question-call', type: 'function', function: { name: 'AskUserQuestion', arguments: JSON.stringify({ questions: [{ id: 'experience', question: '有商业上线经历吗？', options: ['有', '没有'] }] }) } }] }
        : { content: '仅课程项目，不能表述为商业上线经历。' };
      const chunk = { choices: [{ index: 0, delta, finish_reason: requests.length === 1 ? 'tool_calls' : 'stop' }] };
      return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }));
    const root = await mkdtemp(join(tmpdir(), 'avery-eval-script-host-'));
    try {
      const runner = new PromptEvalRunner({ credentialPort: EvaluationTestCredentials() });
      const execution = runner.Execute({ runId: 'run', caseRunId: 'case', candidate: { id: 'a', name: 'A', promptOverrides: {} }, testCase: { ...base, scriptedResponses: hasScript ? [{ kind: 'input', answers: { experience: '没有，只做过课程项目。' } }] : [] }, model: 'deepseek-v4-flash', provider: 'DeepSeek', toolNames: ['AskUserQuestion'], maxModelTurns: 6, userSimulator: 'scripted', caseRoot: root, signal: new AbortController().signal });
      if (hasScript) {
        const result = await execution;
        expect(requests).toHaveLength(2);
        expect(result.finalResponse).toBe('仅课程项目，不能表述为商业上线经历。');
        expect(result.events).toContainEqual(expect.objectContaining({ type: 'user_input', payload: expect.objectContaining({ answers: { experience: '没有，只做过课程项目。' }, scriptIndex: 1 }) }));
        const answer = requests[1].messages.find((message: any) => message.role === 'tool' && message.tool_call_id === 'question-call');
        expect(JSON.parse(answer.content).answers).toEqual({ experience: '没有，只做过课程项目。' });
      } else {
        await expect(execution).rejects.toMatchObject({ code: 'EVAL_SCRIPT_EXHAUSTED', evalEvidence: { events: expect.arrayContaining([expect.objectContaining({ type: 'simulator_stopped', payload: expect.objectContaining({ consumed: 0, code: 'EVAL_SCRIPT_EXHAUSTED' }) })]) } });
        expect(requests).toHaveLength(1);
      }
    } finally { await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 30 }); }
  });
});
