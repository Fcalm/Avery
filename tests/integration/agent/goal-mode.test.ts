import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import { AgentHost } from '../../../apps/backend/src/electron/backend/agent-host';
import { AgentRunService } from '../../../apps/backend/src/electron/backend/services/agent-run-service';
import { CreateBackend } from '../../../apps/backend/src/router';
import type { AgentStreamEvent, BrowserAutomationPort } from '../../../packages/agent-sdk/src';
import { CreateConversationPresentation, GetConversationResult } from '../../../packages/agent-sdk/src';
import { EvaluationTestCredentials } from '../../fixtures/evaluation-credentials';

const low = { provider: 'DeepSeek' as const, baseUrl: 'https://api.deepseek.com', model: 'deepseek-v4-flash' };
const high = { ...low, model: 'deepseek-v4-pro' };
const middle = { provider: 'MIMO' as const, baseUrl: 'https://api.xiaomimimo.com/v1', model: 'mimo-v2.6-flash' };
const goalInput = { requestId: 'goal-run', sessionId: 'goal-session', content: '交付包含背景与结果的产品项目经历。', provider: high.provider, model: high.model, goal: 'start' as const };
const finalDraft = '背景：面向校园活动建立报名流程。结果：交付了报名原型。';
const verdict = (status: 'achieved' | 'continue', evidenceIds = ['candidate'], kind = 'text') => JSON.stringify({
  status, reason: status === 'achieved' ? '已交付背景和结果' : '缺少项目结果',
  checks: [{ requirement: '交付项目结果', kind, met: status === 'achieved', evidenceIds }],
  nextStep: status === 'continue' ? '补齐项目结果' : '',
});
function Sse(content: string, tool?: { name: string; id: string; args?: Record<string, unknown> }) {
  const delta = tool ? { tool_calls: [{ index: 0, id: tool.id, type: 'function', function: { name: tool.name, arguments: JSON.stringify(tool.args ?? {}) } }] } : { content };
  return new Response([
    { choices: [{ index: 0, delta, finish_reason: tool ? 'tool_calls' : 'stop' }] },
    { choices: [], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } },
  ].map(value => 'data: ' + JSON.stringify(value) + '\n\n').join('') + 'data: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
}

type Request = { model: string; messages: Array<{ role: string; content: string }>; tools: unknown[]; reasoning_effort?: string; thinking?: { type: string } };

async function Fixture(handler: (request: Request, signal?: AbortSignal | null) => Response | Promise<Response>, browserRuntime?: NonNullable<ConstructorParameters<typeof AgentHost>[0]['browserRuntime']>) {
  const root = await mkdtemp(join(tmpdir(), 'avery-goal-'));
  const events: AgentStreamEvent[] = [];
  const requests: Request[] = [];
  const trace: Array<{ requestId: string; type: string; data: unknown }> = [];
  const presentations = new Map<string, ReturnType<typeof CreateConversationPresentation>>();
  const options: ConstructorParameters<typeof AgentHost>[0] = {
    userDataPath: root, workspacePath: join(root, 'workspace'), credentialPort: EvaluationTestCredentials(),
    observability: { AppendTraceEvent: (requestId: string, type: string, data: unknown) => trace.push({ requestId, type, data }) },
    Emit: event => events.push(event as AgentStreamEvent), browserRuntime,
    business: {
      GetProfiles: async () => ({ items: [] }),
      GetStoredSettings: async () => ({}),
      GetConversationPresentations: async () => [...presentations.values()],
      SaveConversationPresentation: async (_session: string, presentation: ReturnType<typeof CreateConversationPresentation>) => {
        presentations.set(presentation.requestId, presentation);
        return { saved: true };
      },
    },
    providerFetch: async (_url, init) => {
      const body: Request = JSON.parse(String(init?.body));
      requests.push(body);
      return handler(body, init?.signal);
    },
  };
  const hosts: AgentHost[] = [];
  const open = () => { const host = new AgentHost(options); hosts.push(host); return host; };
  return { events, requests, trace, presentations, host: open(), open, async closeHost(host: AgentHost) {
    await host.Close();
    hosts.splice(hosts.indexOf(host), 1);
  }, async close() {
    for (const host of hosts.reverse()) await host.Close();
    await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 40 });
  } };
}

describe('Goal 的生产 Host、Kernel、Provider 与持久化链路', () => {
  it('经桌面路由保存档次后只用次级模型审核，缺口反馈触发同一 Run 续跑', async () => {
    let reviews = 0;
    const f = await Fixture(body => {
      if (body.model === low.model) {
        expect(body.tools).toEqual([]);
        expect(body.thinking?.type === 'disabled' || body.reasoning_effort === 'low').toBe(true);
        const request = JSON.parse(body.messages[1].content);
        expect(request).toMatchObject({ phase: 'stop', objective: goalInput.content,
          candidate: { id: 'candidate', text: reviews ? finalDraft : '背景：面向校园活动建立报名流程。' } });
        return Sse(verdict(reviews++ === 0 ? 'continue' : 'achieved'));
      }
      const feedback = body.messages.filter(message => message.content?.startsWith('<goal-review>'));
      if (reviews) expect(feedback).toEqual([expect.objectContaining({ role: 'user', content: expect.stringContaining('补齐项目结果') })]);
      return Sse(reviews ? finalDraft : '背景：面向校园活动建立报名流程。');
    });
    try {
      const backend = CreateBackend({ container: { agent: new AgentRunService({ agentHost: f.host }) } });
      const readTiers = () => backend.HandleCommand('agent:get-goal-model-tiers', 'read-tiers', undefined);
      await expect(readTiers()).resolves.toMatchObject({ ok: true, data: { revision: 0, tiers: [] } });
      await expect(backend.HandleCommand('agent:save-goal-model-tiers', 'save-tiers', undefined, { tiers: [low, high], expectedRevision: 0 }))
        .resolves.toMatchObject({ ok: true, data: { revision: 1, tiers: [low, high] } });
      await f.host.Send(goalInput);
      expect(f.requests.map(request => request.model), JSON.stringify(f.events.filter(event => event.type === 'paused' || event.type === 'error'))).toEqual([high.model, low.model, high.model, low.model]);
      expect(f.events.filter(event => event.type === 'completed')).toEqual([expect.objectContaining({ content: finalDraft, requestId: goalInput.requestId })]);
      expect(f.events.filter(event => event.type === 'goal_updated').map(event => event.goal?.status)).toEqual(['running', 'reviewing', 'running', 'reviewing', 'achieved', 'achieved']);
      const hooks = f.trace.filter(event => event.type.startsWith('lifecycle_hook') || event.type === 'goal_review');
      expect(hooks.map(event => event.type)).toEqual([
        'lifecycle_hook_started', 'goal_review', 'lifecycle_hook_finished',
        'lifecycle_hook_started', 'goal_review', 'lifecycle_hook_finished',
      ]);
      expect(hooks.filter(event => event.type === 'lifecycle_hook_finished').map(event => event.data)).toEqual([
        expect.objectContaining({ hook: 'stop', decision: 'continue' }),
        expect.objectContaining({ hook: 'stop', decision: 'achieved' }),
      ]);
      expect(f.presentations.get(goalInput.requestId)?.parts.filter(part => part.type === 'goal_review')).toEqual([
        expect.objectContaining({ phase: 'stop', status: 'continue', summary: '缺少项目结果' }),
        expect.objectContaining({ phase: 'stop', status: 'achieved', summary: '已交付背景和结果' }),
      ]);
      expect(GetConversationResult(f.presentations.get(goalInput.requestId)!)).toBe(finalDraft);
      expect((await f.host.GetSessionAssistantState(goalInput.sessionId)).goal).toMatchObject({ status: 'achieved', reviewCount: 2, reviewTokens: 240, reviewer: { model: low.model } });
      await expect(readTiers()).resolves.toMatchObject({ ok: true, data: { revision: 1, tiers: [low, high] } });
      await expect(f.host.SaveGoalModelTiers({ tiers: [low, high], expectedRevision: 0 })).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
      await expect(backend.HandleCommand('agent:save-goal-model-tiers', 'save-shared-model', undefined, { tiers: [low, low], expectedRevision: 1 }))
        .resolves.toMatchObject({ ok: true, data: { revision: 2, tiers: [low, low] } });
      await expect(readTiers()).resolves.toMatchObject({ ok: true, data: { revision: 2, tiers: [low, low] } });
    } finally { await f.close(); }
  });

  it.each([
    { name: '引用不存在的证据', reply: verdict('achieved', ['receipt:invented']) },
    { name: '用执行者自述证明已写入', reply: verdict('achieved', ['candidate'], 'external') },
    { name: '审核 JSON 无效', reply: '已通过' },
  ])('$name 时暂停并保留进度', async ({ reply }) => {
    const f = await Fixture(body => Sse(body.model === low.model ? reply : '我已保存简历。'));
    try {
      await f.host.SaveGoalModelTiers({ tiers: [low, high], expectedRevision: 0 });
      await f.host.Send(goalInput);
      expect(f.requests.map(request => request.model)).toEqual([high.model, low.model]);
      expect(f.events.some(event => event.type === 'completed')).toBe(false);
      expect((await f.host.GetSessionAssistantState(goalInput.sessionId)).goal).toMatchObject({ status: 'paused', reviewCount: 1 });
    } finally { await f.close(); }
  });

  it('在原 Run 结算确认，观察超时及回读未通过后继续，审核完成后清理浏览器', async () => {
    let clicked = 0, snapshots = 0, validations = 0, reviews = 0;
    const calls: string[] = [];
    const browser: BrowserAutomationPort & { Close(): Promise<void>; CloseTask(): Promise<void> } = {
      async Prepare({ toolName, arguments: args }) {
        return { toolName, canonicalArguments: args, proposalId: 'proposal-' + toolName, proposalHash: 'hash-' + toolName,
          risk: toolName === 'BrowserClick' ? 'high' : 'low', forceConfirmation: toolName === 'BrowserClick',
          pageRevision: 1, resourceIds: ['browser:own'], summary: toolName, url: 'https://example.invalid/form' };
      },
      async Execute({ proposal }) {
        calls.push(proposal.toolName);
        if (proposal.toolName === 'BrowserClick') clicked += 1;
        if (proposal.toolName === 'BrowserSnapshot' && ++snapshots === 1) {
          throw Object.assign(new Error('The browser observation timed out.'), { code: 'BROWSER_COMMAND_TIMEOUT' });
        }
        if (proposal.toolName === 'BrowserValidateForm') {
          const valid = ++validations >= 2;
          return { status: 'succeeded', data: { valid, businessValid: valid, fieldChecks: [{ label: '籍贯', status: valid ? 'matched' : 'mismatch', actual: '不应发送的真实值' }] } };
        }
        return { status: 'succeeded', data: { currentUrl: 'https://example.invalid/form', pageRevision: 1, refs: {} } };
      },
      GetStatus: async () => ({ available: true, running: true, pageRevision: 1 }),
      GetBrowserTaskId: () => 'owned-task', ResetPageReferences() {}, async Close() {}, async CloseTask() { calls.push('close'); },
    };
    const f = await Fixture(body => {
      if (body.model === low.model) {
        expect(calls).not.toContain('close');
        const evidence = JSON.parse(body.messages[1].content).evidence;
        const validation = [...evidence].reverse().find(entry => entry.tool === 'BrowserValidateForm');
        expect(validation.facts.fieldChecks[0]).not.toHaveProperty('actual');
        expect(validation.facts.valid).toBe(reviews === 1);
        return Sse(verdict(reviews++ ? 'achieved' : 'continue', [validation.id], 'external'));
      }
      const has = (id: string) => body.messages.some(message => (message as { tool_call_id?: string }).tool_call_id === id);
      if (!has('confirmed')) return Sse('', { name: 'BrowserClick', id: 'confirmed', args: { ref: '@e1', pageRevision: 1 } });
      if (!has('observation')) return Sse('', { name: 'BrowserSnapshot', id: 'observation' });
      if (!has('observation-retry')) {
        expect(body.messages.find(message => (message as { tool_call_id?: string }).tool_call_id === 'observation')?.content).toContain('BROWSER_COMMAND_TIMEOUT');
        return Sse('', { name: 'BrowserSnapshot', id: 'observation-retry' });
      }
      if (!has('validation')) return Sse('', { name: 'BrowserValidateForm', id: 'validation' });
      if (body.messages.some(message => message.content?.includes('<goal-review>')) && !has('validation2')) {
        return Sse('', { name: 'BrowserValidateForm', id: 'validation2' });
      }
      return Sse('已核对表单字段。');
    }, browser);
    try {
      await f.host.SaveGoalModelTiers({ tiers: [low, high], expectedRevision: 0 });
      await f.host.Send({ ...goalInput, scenarioId: 'application', confirmationMode: 'always_confirm', content: '确认后打开表单并核对籍贯。' });
      const prompt = f.events.find(event => event.type === 'browser_confirmation');
      expect(prompt?.confirmationId, JSON.stringify(f.events.filter(event => event.type === 'error'))).toBeTruthy();
      expect(reviews).toBe(0);
      expect(f.trace.filter(event => event.type === 'lifecycle_hook_started')).toHaveLength(0);
      expect(clicked).toBe(0);
      expect(calls).not.toContain('close');
      await f.host.RespondToInteraction({ kind: 'approval', requestId: goalInput.requestId, sessionId: goalInput.sessionId, interactionId: prompt!.confirmationId!, approved: true });
      expect(calls).toEqual(['BrowserClick', 'BrowserSnapshot', 'BrowserSnapshot', 'BrowserValidateForm', 'BrowserValidateForm', 'close']);
      expect(f.events.filter(event => event.type === 'completed')).toHaveLength(1);
      expect((await f.host.GetSessionAssistantState(goalInput.sessionId)).goal).toMatchObject({ status: 'achieved', reviewCount: 2 });
    } finally { await f.close(); }
  });

  it('审核取消后丢弃迟到结果，重开 Host 可读到目标终态', async () => {
    let release!: (response: Response) => void;
    let entered!: () => void;
    const inReview = new Promise<void>(resolve => { entered = resolve; });
    const f = await Fixture(body => {
      if (body.model !== low.model) return Sse(finalDraft);
      return new Promise<Response>(resolve => { release = resolve; entered(); });
    });
    try {
      await f.host.SaveGoalModelTiers({ tiers: [low, high], expectedRevision: 0 });
      const run = f.host.Send(goalInput);
      await inReview;
      await f.host.Cancel(goalInput.requestId);
      release(Sse(verdict('achieved')));
      await run;
      expect(f.events.some(event => event.type === 'completed')).toBe(false);
      expect(f.events.filter(event => event.type === 'cancelled')).toHaveLength(1);
      expect(f.trace.filter(event => event.type === 'goal_review')).toHaveLength(0);
      expect(f.trace.filter(event => event.type === 'lifecycle_hook_finished').map(event => event.data))
        .toEqual([expect.objectContaining({ hook: 'stop', decision: 'interrupted' })]);
      expect(f.presentations.get(goalInput.requestId)?.parts).toContainEqual(expect.objectContaining({ type: 'goal_review', status: 'interrupted' }));
      await f.closeHost(f.host);
      const reopened = f.open();
      expect((await reopened.GetSessionAssistantState(goalInput.sessionId)).goal).toMatchObject({ status: 'cancelled', reviewCount: 1 });
    } finally { await f.close(); }
  });

  it('从面板暂停时累计用时定格，编辑后继续使用新目标，删除后重启仍已移除', async () => {
    let reviews = 0;
    let enterReview!: () => void;
    let finishReview!: (response: Response) => void;
    const reviewing = new Promise<void>(resolve => { enterReview = resolve; });
    const objective = '将项目经历整理成两条。';
    const f = await Fixture(body => {
      if (body.model !== low.model) {
        if (reviews) {
          expect(body.messages.filter(message => message.content?.startsWith('<goal-context>'))).toHaveLength(1);
          expect(body.messages.some(message => message.content === '继续当前目标')).toBe(false);
          expect(body.messages.some(message => message.content?.startsWith('<goal-review>') && message.content.includes('补齐项目结果'))).toBe(true);
        }
        return Sse(finalDraft);
      }
      if (++reviews === 1) return new Promise<Response>(resolve => { finishReview = resolve; enterReview(); });
      const reviewInput = JSON.parse(body.messages[1].content);
      expect(reviewInput.objective).toBe(objective);
      expect(reviewInput.clarifications).not.toContain(goalInput.content);
      if (reviewInput.phase === 'resume') {
        expect(reviewInput.candidate).toBeUndefined();
        return Sse(verdict('continue', []));
      }
      return Sse(verdict('achieved'));
    });
    try {
      const backend = CreateBackend({ container: { agent: new AgentRunService({ agentHost: f.host }) } });
      await f.host.SaveGoalModelTiers({ tiers: [low, high], expectedRevision: 0 });
      const identity = { sessionId: goalInput.sessionId, requestId: goalInput.requestId };
      const run = f.host.Send(goalInput);
      await reviewing;
      const running = (await f.host.GetSessionAssistantState(identity.sessionId)).goal;
      expect(running).toMatchObject({ status: 'reviewing', activeSince: expect.any(Number) });
      await expect(backend.HandleCommand('agent:change-goal', 'pause-goal', undefined, { ...identity, action: 'pause' }))
        .resolves.toMatchObject({ ok: true, data: { goal: { status: 'paused', canContinue: true } } });
      finishReview(Sse(verdict('achieved')));
      await run;
      const paused = (await f.host.GetSessionAssistantState(identity.sessionId)).goal;
      expect(paused.activeMs).toBeGreaterThanOrEqual(running.activeMs);
      expect(paused.activeSince).toBeUndefined();
      expect(f.events.some(event => event.type === 'completed' || event.type === 'cancelled')).toBe(false);

      await expect(backend.HandleCommand('agent:change-goal', 'edit-goal', undefined, { ...identity, action: 'edit', objective }))
        .resolves.toMatchObject({ ok: true, data: { goal: { objective, status: 'paused' } } });
      await expect(backend.HandleCommand('agent:send', 'stale-resume', undefined, {
        ...goalInput, requestId: 'stale-resume', goal: 'continue', goalRequestId: 'old-goal', content: '',
      })).resolves.toMatchObject({ ok: false, error: { code: 'REVISION_CONFLICT' } });
      const nextId = 'goal-after-edit';
      await expect(backend.HandleCommand('agent:send', 'resume-goal', undefined, { ...goalInput, requestId: nextId, goal: 'continue', goalRequestId: identity.requestId, content: '' }))
        .resolves.toMatchObject({ ok: true });
      expect(f.requests.slice(2).map(request => request.model)).toEqual([low.model, high.model, low.model]);
      expect((await f.host.GetSessionAssistantState(identity.sessionId)).goal).toMatchObject({ objective, status: 'achieved', reviewCount: 3 });
      await expect(f.host.ChangeGoal({ ...identity, action: 'delete' })).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
      await expect(backend.HandleCommand('agent:change-goal', 'delete-goal', undefined, { ...identity, requestId: nextId, action: 'delete' }))
        .resolves.toMatchObject({ ok: true });
      expect(f.presentations.get(nextId)?.parts.filter(part => part.type === 'goal_review')).toEqual([
        expect.objectContaining({ phase: 'resume', status: 'continue' }),
        expect.objectContaining({ phase: 'stop', status: 'achieved' }),
      ]);
      expect(f.events.at(-1)).toMatchObject({ type: 'goal_updated', requestId: nextId });
      await f.closeHost(f.host);
      expect((await f.open().GetSessionAssistantState(identity.sessionId)).goal).toBeUndefined();
    } finally { await f.close(); }
  });

  it('连续三次相同缺口后停下，不把不同的答复措辞当作进展', async () => {
    let turn = 0;
    const f = await Fixture(body => Sse(body.model === low.model ? verdict('continue') : '仍在整理，进展编号 ' + ++turn));
    try {
      await f.host.SaveGoalModelTiers({ tiers: [low, high], expectedRevision: 0 });
      await f.host.Send(goalInput);
      expect(turn).toBe(3);
      expect(f.events.some(event => event.type === 'completed')).toBe(false);
      expect((await f.host.GetSessionAssistantState(goalInput.sessionId)).goal).toMatchObject({ status: 'paused', reviewCount: 3, reason: expect.stringContaining('连续三次') });
    } finally { await f.close(); }
  });

  it('重启后保留审核次数与冻结模型，调整档次只影响新目标', async () => {
    let reviews = 0;
    const f = await Fixture(body => {
      if (body.model !== low.model) return Sse(finalDraft);
      const input = JSON.parse(body.messages[1].content);
      if (input.phase === 'resume') {
        expect(input.candidate).toEqual({ id: 'candidate', text: finalDraft });
        expect(input.clarifications).toEqual(['项目结果已确认，请继续。']);
        reviews += 1;
        return Sse(verdict('continue'));
      }
      return Sse(++reviews === 1 ? JSON.stringify({
        status: 'needs_user', reason: '请确认项目结果', checks: [{ requirement: '核对项目结果', kind: 'text', met: false, evidenceIds: ['candidate'] }], nextStep: '',
      }) : verdict('achieved'));
    });
    try {
      await f.host.SaveGoalModelTiers({ tiers: [low, high], expectedRevision: 0 });
      await f.host.Send(goalInput);
      expect((await f.host.GetSessionAssistantState(goalInput.sessionId)).goal).toMatchObject({ status: 'waiting', canContinue: true, reviewCount: 1 });
      await f.closeHost(f.host);
      const reopened = f.open();
      await reopened.SaveGoalModelTiers({ tiers: [middle, high], expectedRevision: 1 });
      await reopened.Send({ ...goalInput, requestId: 'goal-resumed', goal: 'continue', content: '项目结果已确认，请继续。' });
      expect(f.requests.map(request => request.model)).toEqual([high.model, low.model, low.model, high.model, low.model]);
      expect(f.requests[3].messages.filter(message => message.content?.startsWith('<goal-context>'))).toHaveLength(1);
      expect(f.requests[3].messages.filter(message => message.content === '项目结果已确认，请继续。')).toHaveLength(1);
      expect((await reopened.GetSessionAssistantState(goalInput.sessionId)).goal).toMatchObject({ status: 'achieved', requestId: 'goal-resumed', reviewCount: 3, reviewTokens: 360 });
      await reopened.Send({ ...goalInput, requestId: 'ordinary', goal: undefined, content: '普通对话' });
      expect(f.requests.at(-1)?.messages.some(message => message.content?.includes('<goal-context>') || message.content?.includes('<goal-review>'))).toBe(false);
    } finally { await f.close(); }
  });

  it('未设置模型档次时用本轮执行模型独立审核，普通对话无需审核', async () => {
    const f = await Fixture(body => Sse(body.tools.length === 0 ? verdict('achieved') : finalDraft));
    try {
      await f.host.Send(goalInput);
      expect(f.requests.map(request => request.model)).toEqual([high.model, high.model]);
      expect(f.requests[1].tools).toEqual([]);
      expect(f.requests[1].messages[0].content).toContain('fragment:goal-review@');
      expect(JSON.parse(f.requests[1].messages[1].content).objective).toBe(goalInput.content);
      expect((await f.host.GetSessionAssistantState(goalInput.sessionId)).goal).toMatchObject({ status: 'achieved', reviewCount: 1, reviewer: { provider: high.provider, model: high.model } });
      await f.host.Send({ ...goalInput, requestId: 'normal-run', goal: undefined });
      expect(f.requests.map(request => request.model)).toEqual([high.model, high.model, high.model]);
      expect(f.events.filter(event => event.type === 'completed')).toHaveLength(2);
    } finally { await f.close(); }
  });

  it('目标暂停后显式继续，复用相同写操作的既有回执', async () => {
    let writes = 0, reviews = 0;
    let browserConnected = false;
    const browser: NonNullable<ConstructorParameters<typeof AgentHost>[0]['browserRuntime']> = {
      async Prepare({ toolName, arguments: args }) {
        return { toolName, canonicalArguments: args, proposalId: 'proposal-' + toolName, proposalHash: 'same-' + toolName,
          risk: 'low', forceConfirmation: false, pageRevision: 1, resourceIds: ['browser:own'], summary: toolName };
      },
      async Execute({ proposal }) {
        if (proposal.toolName === 'BrowserClick') writes += 1;
        return { status: 'succeeded', data: { pageRevision: 1, refs: {} } };
      },
      GetStatus: async () => ({ available: true, running: true, pageRevision: 1, engine: 'chrome',
        extension: { connected: browserConnected, state: browserConnected ? 'online' : 'offline' } }),
      GetBrowserTaskId: () => 'owned-task', ResetPageReferences() {}, async Close() {},
    };
    const f = await Fixture(body => {
      if (body.model === low.model) {
        const reviewInput = JSON.parse(body.messages[1].content);
        const evidence = reviewInput.evidence;
        const receipt = evidence.find(item => item.id.startsWith('receipt:'));
        expect(receipt).toBeDefined();
        if (reviewInput.phase === 'resume') {
          expect(reviewInput.browserConnection).toMatchObject({ connected: true, state: 'online' });
          reviews += 1;
          return Sse(verdict('continue', [receipt.id], 'external'));
        }
        if (++reviews === 1) return Sse(JSON.stringify({
          status: 'needs_user', reason: '需用户确认页面已显示', checks: [{ requirement: '核对页面', kind: 'external', met: false, evidenceIds: [receipt.id] }], nextStep: '',
        }));
        return Sse(verdict('achieved', [receipt.id], 'external'));
      }
      const has = (id: string) => body.messages.some(message => (message as { tool_call_id?: string }).tool_call_id === id);
      if (reviews && !has('observe-again')) return Sse('', { name: 'BrowserSnapshot', id: 'observe-again' });
      const id = reviews ? 'click-again' : 'click-first';
      if (!has(id)) return Sse('', { name: 'BrowserClick', id, args: { ref: '@e1', pageRevision: 1 } });
      if (reviews) {
        const result = body.messages.find(message => (message as { tool_call_id?: string }).tool_call_id === id);
        expect(JSON.parse(result!.content)).toMatchObject({ ok: true, replayed: true });
      }
      return Sse('页面已打开。');
    }, browser);
    try {
      await f.host.SaveGoalModelTiers({ tiers: [low, high], expectedRevision: 0 });
      const input = { ...goalInput, scenarioId: 'application' as const, confirmationMode: 'fully_trusted' as const, content: '打开并核对当前表单。' };
      await f.host.Send(input);
      expect(writes).toBe(1);
      browserConnected = true;
      await f.host.Send({ ...input, requestId: 'goal-next-run', goal: 'continue', content: '页面已经显示，请继续核对。' });
      expect(writes).toBe(1);
      expect((await f.host.GetSessionAssistantState(input.sessionId)).goal).toMatchObject({ status: 'achieved', reviewCount: 3 });
    } finally { await f.close(); }
  });

  it('用量达到上限的模型回复不能启动新的工具动作', async () => {
    const f = await Fixture(() => {
      const delta = { tool_calls: [{ index: 0, id: 'over-budget', type: 'function', function: { name: 'AskUserQuestion', arguments: '{"questions":[{"id":"q","question":"还要继续吗？","options":["继续","停止"]}]}' } }] };
      const choice = { choices: [{ index: 0, delta, finish_reason: 'tool_calls' }] };
      const usage = { choices: [], usage: { prompt_tokens: 19_999_999, completion_tokens: 1, total_tokens: 20_000_000 } };
      return new Response('data: ' + JSON.stringify(choice) + '\n\ndata: ' + JSON.stringify(usage) + '\n\ndata: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
    });
    try {
      await f.host.SaveGoalModelTiers({ tiers: [low, high], expectedRevision: 0 });
      await f.host.Send(goalInput);
      expect(f.requests).toHaveLength(1);
      expect(f.events.some(event => event.type === 'question_requested' || event.type === 'completed')).toBe(false);
      expect((await f.host.GetSessionAssistantState(goalInput.sessionId)).goal).toMatchObject({ status: 'paused', canContinue: false, reason: expect.stringContaining('2,000 万 Token') });
    } finally { await f.close(); }
  });

  it('剩余一次审核时暂停目标，不用完最终验收所需的额度', async () => {
    let reviews = 0;
    const f = await Fixture(body => {
      if (body.model !== low.model) return Sse(finalDraft);
      const review = ++reviews;
      return Sse(JSON.stringify({
        status: review === 5 ? 'needs_user' : 'continue',
        reason: '待补充的细节', nextStep: '核对本条记录',
        checks: [{ requirement: '要求 ' + review, kind: 'text', met: false, evidenceIds: ['candidate'] }],
      }));
    });
    try {
      await f.host.SaveGoalModelTiers({ tiers: [low, high], expectedRevision: 0 });
      await f.host.Send(goalInput);
      expect((await f.host.GetSessionAssistantState(goalInput.sessionId)).goal).toMatchObject({ status: 'waiting', reviewCount: 5, canContinue: false });
      await expect(f.host.Send({ ...goalInput, requestId: 'budget-resume', goal: 'continue', content: '' }))
        .rejects.toMatchObject({ code: 'GOAL_BUDGET_EXHAUSTED' });
      expect(reviews).toBe(5);
    } finally { await f.close(); }
  });
});
