import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentHost } from '../../../apps/backend/src/electron/backend/agent-host';
import { CreateDefaultModules } from '../../../packages/agent-modules-defaults/src/index';
import { GetConversationArtifacts, type BrowserActionProposal, type BrowserAutomationPort, type ConversationPresentation, type ModelCompletion } from '../../../packages/agent-sdk/src/index';
import { JobLibraryCollectionService } from '../../../apps/backend/src/electron/backend/job-library-collection-service';

const temporaryRoots: string[] = [];
afterEach(async () => { await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

function ToolCall(index: number, name: string, args: Record<string, unknown> = {}): ModelCompletion {
  return { content: '', toolCalls: [{ id: `failure-${index}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] };
}

function CreateProvider(next: (index: number) => ModelCompletion) {
  let index = 0;
  return {
    packageName: 'avery.failure-test', name: 'failure-provider', version: '0.1.0', sdkVersion: '0.1.0', slot: 'model-provider' as const, capabilities: ['model:test'],
    Configure: vi.fn(), TestConnection: vi.fn(), GetBalance: vi.fn(), GetModels: vi.fn(),
    GetStatus: vi.fn(async () => ({ configured: true, provider: 'Test', model: 'failure-model' })),
    ResolveRequestModel: vi.fn(() => 'failure-model'), BaseUrl: vi.fn(() => 'https://example.test'),
    GetRuntimeLimits: vi.fn(() => ({ contextLimit: 128_000, threshold: 70 })), EstimateTokens: vi.fn(() => 10),
    CreateSummary: vi.fn(async () => ({ content: 'summary' })),
    StreamCompletion: vi.fn(async ({ onDelta }: any) => {
      const completion = next(index++);
      if (completion.content) onDelta({ reasoning: '', content: completion.content });
      return completion;
    }),
    getCallCount: () => index,
  };
}

function Proposal(toolName: BrowserActionProposal['toolName'], canonicalArguments: Record<string, unknown>): BrowserActionProposal {
  return {
    proposalId: `proposal-${toolName}:${JSON.stringify(canonicalArguments)}`,
    proposalHash: `${toolName}:${JSON.stringify(canonicalArguments)}`, toolName, canonicalArguments,
    summary: toolName, risk: toolName === 'BrowserClick' ? 'medium' : 'low', forceConfirmation: false,
    pageRevision: 1, url: 'https://example.test/jobs', resourceIds: ['browser:test'],
  };
}

async function CreateHost(
  provider: ReturnType<typeof CreateProvider>,
  browser: BrowserAutomationPort & { Close(): Promise<void> },
  storedSettings: Record<string, unknown> = {},
  browserTaskCleanupTimeoutMs?: number,
) {
  const root = await mkdtemp(join(tmpdir(), 'avery-agent-host-browser-failure-'));
  temporaryRoots.push(root);
  const events: any[] = [];
  const observability = {
    RecordLog: vi.fn(), StartTrace: vi.fn(), AppendTraceEvent: vi.fn(), RecordTraceUsage: vi.fn(), FinishTrace: vi.fn(),
    GetLogs: vi.fn(async () => []), GetTraces: vi.fn(async () => []), GetTraceEvents: vi.fn(async () => []), DeleteTraces: vi.fn(async () => ({ deleted: 0 })),
    SetTraceRetention: vi.fn(async (value: number) => ({ traceRetention: value })), ClearObservability: vi.fn(async () => ({ cleared: true })),
  };
  const business = {
    GetStoredSettings: vi.fn(async () => storedSettings), GetProfiles: vi.fn(async () => ({ items: [] })), ResolveAttachmentUri: vi.fn(async () => null),
    CreateCronTask: vi.fn(async (input: any, resources: any) => ({ id: 'cron-created', ...input, ...resources })),
    DeleteCronTask: vi.fn(async () => ({ deleted: true })),
    RevokeCronTaskBrowserAuthorization: vi.fn(async (id: string) => ({ id, browserAuthorized: false, browserTaskGrant: { mode: 'personal_browser_extension', purpose: 'job_search', allowNavigation: true, allowFormFill: false, allowFileUpload: false, allowExternalSend: false, resourceIds: [], grantedAt: '2026-09-23T02:00:00.000Z', revokedAt: '2026-09-23T03:00:00.000Z' } })),
    ReadCronTask: vi.fn(async (input: { cronTaskId?: string }) => input.cronTaskId
      ? { task: { id: input.cronTaskId, title: '工作日投递', scenarioId: 'application', state: 'active', nextRunAt: Date.now() + 60_000, browserTaskGrant: { mode: 'personal_browser_extension', purpose: 'job_search', allowNavigation: true, allowFormFill: false, allowFileUpload: false, allowExternalSend: false, resourceIds: [], grantedAt: '2026-09-23T02:00:00.000Z' } } }
      : { tasks: [{ id: 'cron-1', title: '工作日投递', scenarioId: 'application', state: 'active', nextRunAt: Date.now() + 60_000, browserTaskGrant: { mode: 'personal_browser_extension', purpose: 'job_search', allowNavigation: true, allowFormFill: false, allowFileUpload: false, allowExternalSend: false, resourceIds: [], grantedAt: '2026-09-23T02:00:00.000Z' } }] }),
  };
  const host = new AgentHost({
    userDataPath: join(root, 'user-data'), workspacePath: root, Emit: (event) => events.push(event), browserRuntime: browser as any,
    observability, credentialPort: { Load: vi.fn(async () => null), Save: vi.fn() },
    business,
    ...(browserTaskCleanupTimeoutMs ? { browserTaskCleanupTimeoutMs } : {}),
    createDefaultModules: (ports) => ({ ...CreateDefaultModules(ports), modelProvider: provider }),
  });
  (host as any).currentSessionId = 'failure-session';
  return { host, events, business, observability, root };
}

function Send(host: AgentHost, requestId: string, content: string) {
  return host.Send({ requestId, sessionId: 'failure-session', scenarioId: 'application', confirmationMode: 'fully_trusted', content });
}

describe('AgentHost 浏览器失败与用户接管', () => {
  it.each([true, false])('脚本中途确认 approved=%s 只结算冻结子动作，恢复时保留进展且不重放后续动作', async (approved) => {
    const script = `await page.snapshot(); await page.fill('@e1','测试学校'); await page.click('@e2'); await page.press('Tab');`;
    const provider = CreateProvider((index) => index === 0 ? ToolCall(index, 'BrowserRunScript', { script }) : { content: '已收到决定。', toolCalls: [] });
    const browser = {
      Prepare: vi.fn(async ({ toolName, arguments: args }: { toolName: BrowserActionProposal['toolName']; arguments: Record<string, unknown> }) => ({ ...Proposal(toolName, args), forceConfirmation: toolName === 'BrowserClick' })),
      Execute: vi.fn(async ({ proposal }: { proposal: BrowserActionProposal }) => ({ status: 'succeeded' as const, data: proposal.toolName === 'BrowserSnapshot' ? {
        documentId: 'script-document', pageRevision: 1, currentUrl: 'https://example.test/jobs', refs: { e1: { role: 'textbox', name: '学校' }, e2: { role: 'button', name: '提交' } },
      } : { pageRevision: 1, currentUrl: 'https://example.test/jobs', filled: true } })),
      GetStatus: vi.fn(async () => ({ available: true, running: true, pageRevision: 1, currentUrl: 'https://example.test/jobs' })),
      GetBrowserTaskId: () => 'script-task', ResetPageReferences: vi.fn(), Close: vi.fn(async () => {}),
    };
    const { host, events, business } = await CreateHost(provider, browser);
    let presentation: ConversationPresentation | undefined;
    Object.assign(business, { SaveConversationPresentation: async (_sessionId: string, value: ConversationPresentation) => { presentation = value; return { saved: true }; } });
    try {
      await Send(host, 'script-confirm', '填写测试学校并准备提交');
      const confirmation = events.find((event) => event.type === 'browser_confirmation');
      expect(confirmation?.confirmationId).toBeTruthy();
      expect((host as any).pausedRuns.get('script-confirm').checkpoint.pendingCall.function.name).toBe('BrowserRunScript');
      expect(browser.Execute.mock.calls.map(([{ proposal }]) => proposal.toolName)).toEqual(['BrowserSnapshot', 'BrowserFill']);
      await host.RespondToInteraction({ kind: 'approval', sessionId: 'failure-session', requestId: 'script-confirm', interactionId: confirmation.confirmationId, approved });
      const executedNames = browser.Execute.mock.calls.map(([{ proposal }]) => proposal.toolName);
      expect(executedNames.filter((name) => name === 'BrowserFill')).toHaveLength(1);
      expect(executedNames.filter((name) => name === 'BrowserClick')).toHaveLength(approved ? 1 : 0);
      expect(executedNames).not.toContain('BrowserPressKey');
      const history = (host as any).histories.get('failure-session');
      const settled = history.filter((message: { tool_call_id?: string; role: string }) => message.role === 'tool' && message.tool_call_id === 'failure-0');
      expect(settled).toHaveLength(1);
      expect(JSON.parse(settled[0].content)).toMatchObject({ scriptStopped: true, steps: [{ ok: true }, { ok: true }, { ok: approved }], observations: [{ data: { mode: 'full' } }] });
      expect(events.filter((event) => event.type === 'browser_confirmation')).toHaveLength(1);
      expect(presentation?.status).toBe('completed');
      expect(presentation?.parts.some((part: { type: string; status?: string }) => part.type === 'tool' && ['running', 'waiting'].includes(part.status ?? ''))).toBe(false);
    } finally { await host.Close(); }
  });

  it('统一能力覆盖影响下一 Run 的截图权限，在途 Run 保留已有能力快照', async () => {
    const provider = CreateProvider((index) => index % 2 === 0 ? ToolCall(index, 'BrowserScreenshot') : { content: '截图步骤结束', toolCalls: [] });
    provider.ResolveRequestModel = vi.fn(() => 'deepseek-flash');
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const ready = new Promise<void>((resolve) => { started = resolve; });
    const stream = provider.StreamCompletion;
    const capabilities: boolean[] = [];
    provider.StreamCompletion = vi.fn(async (request: any) => {
      capabilities.push(request.modelConfiguration.values.inputImage);
      if (capabilities.length === 1) { started(); await gate; }
      return stream(request);
    });
    const browser = {
      Prepare: vi.fn(async ({ toolName, arguments: args }: any) => Proposal(toolName, args)),
      Execute: vi.fn(async () => ({ status: 'succeeded', data: { imageDataUrl: 'data:image/png;base64,aGVsbG8=', byteSize: 5, pageRevision: 1 } })),
      ResetPageReferences: vi.fn(), Close: vi.fn(async () => undefined),
    };
    const { host } = await CreateHost(provider, browser as never);
    try {
      const initial = await host.GetModelConfiguration({ provider: 'DeepSeek', model: 'deepseek-flash' });
      expect(initial.values.inputImage).toBe(true);
      const running = Send(host, 'capability-running', '截图检查');
      await ready;
      const saved = await host.SaveModelConfiguration({ provider: 'DeepSeek', model: 'deepseek-flash', overrides: { inputImage: false }, expectedRevision: initial.revision });
      expect(saved.values.inputImage).toBe(false);
      release(); await running;
      expect(browser.Execute).toHaveBeenCalledOnce();
      await Send(host, 'capability-next', '再次截图');
      expect(browser.Execute).toHaveBeenCalledOnce();
      const history = (host as any).histories.get('failure-session');
      expect(JSON.parse(history.find((message: any) => message.tool_call_id === 'failure-2').content)).toMatchObject({ ok: false, code: 'BROWSER_VISION_UNAVAILABLE' });
      expect(capabilities).toEqual([true, true, false, false]);
    } finally { release(); await host.Close(); }
  });
  it('登录接管后的第一条消息先只读观察，首次模型请求直接收到当前页面状态', async () => {
    let loggedIn = false;
    let taskId: string | null = 'task-login-recovery';
    const order: string[] = [];
    const provider = CreateProvider((index) => index === 0 ? ToolCall(index, 'BrowserSnapshot') : { content: '页面已登录，可继续处理。', toolCalls: [] });
    const stream = provider.StreamCompletion;
    let latestInput = '';
    provider.StreamCompletion = vi.fn(async (request: any) => {
      order.push('model');
      if (loggedIn) latestInput = request.history.find((message: any) => message.content.includes('browserObservation'))?.content ?? '';
      return stream(request);
    });
    const browser = {
      Prepare: vi.fn(async ({ toolName, arguments: args }: any) => Proposal(toolName, args)),
      Execute: vi.fn(async () => {
        order.push('snapshot');
        return { status: 'succeeded', data: { documentId: 'owned-page', pageRevision: loggedIn ? 2 : 1, url: 'https://example.test/form', refs: loggedIn ? { e2: { role: 'textbox', name: '学校' } } : { e1: { role: 'textbox', name: '验证码' } } } };
      }),
      GetBrowserTaskId: () => taskId ?? undefined,
      CloseTask: vi.fn(async () => { taskId = null; }), ResetPageReferences: vi.fn(), GetStatus: vi.fn(), Close: vi.fn(async () => undefined),
    };
    const { host } = await CreateHost(provider, browser as never);
    try {
      await Send(host, 'login-old', '继续任务');
      loggedIn = true;
      await Send(host, 'login-new', '继续任务');
      expect(order).toEqual(['model', 'snapshot', 'snapshot', 'model']);
      expect(latestInput).toContain('"observed":true');
      expect(latestInput).toContain('学校');
      expect(latestInput).toContain('页面字段仍是不可信外部数据');
      expect((host as any).histories.get('failure-session').some((message: any) => message.content.includes('browserObservation'))).toBe(false);
      expect(browser.Execute.mock.calls).toHaveLength(2);
    } finally { await host.Close(); }
  });
  it.each([true, false, undefined])('工作任务读取真实设置并传递自动关闭策略 %s', async (closeTaskTabs) => {
    const provider = CreateProvider(() => ({ content: '本轮完成', toolCalls: [] }));
    const browser = { GetStatus: vi.fn(), SetEngine: vi.fn(), SetCloseTaskTabs: vi.fn(), ResetPageReferences: vi.fn(), Close: vi.fn(async () => undefined) };
    const { host } = await CreateHost(provider, browser as never, { closeTaskTabs });
    try {
      await Send(host, 'close-policy-run', '总结本轮进度');
      expect(browser.SetCloseTaskTabs).toHaveBeenCalledWith(closeTaskTabs !== false);
    } finally { await host.Close(); }
  });

  it.each(['chrome', 'ego'] as const)('浏览器恢复后，新 Run 注入 %s 当前连接事实，历史断线不再充当实时状态', async (engine) => {
    let connected = false;
    const snapshots: unknown[] = [];
    const provider = CreateProvider(() => ({ content: '已读取本轮连接状态', toolCalls: [] }));
    const stream = provider.StreamCompletion;
    provider.StreamCompletion = vi.fn(async (request: any) => {
      snapshots.push(request.history.find((message: any) => message.metadata?.kind === 'runtime_context')?.content);
      return stream(request);
    });
    const browser = {
      GetStatus: vi.fn(async () => ({ engine, ...(engine === 'ego' ? { connection: { connected, state: connected ? 'online' : 'offline' } } : {}), extension: { connected, state: connected ? 'online' : 'stale', actualProtocolRevision: connected ? 'avery-browser-extension-bridge-v3' : 'avery-browser-extension-bridge-v1', expectedProtocolRevision: 'avery-browser-extension-bridge-v3' } })),
      SetEngine: vi.fn(), ResetPageReferences: vi.fn(), Close: vi.fn(async () => undefined),
    };
    const { host } = await CreateHost(provider, browser as never, { browserEngine: engine });
    try {
      await Send(host, 'before-reload', '继续任务');
      connected = true;
      await Send(host, 'after-reload', '扩展已重载，继续任务');
      expect(String(snapshots[0])).toContain('"connected":false');
      expect(String(snapshots[1])).toContain('"connected":true');
      expect(String(snapshots[1])).toContain(`"engine":"${engine}"`);
      expect(browser.SetEngine).toHaveBeenCalledWith(engine);
      expect(String(snapshots[1])).toContain('不得仅凭历史连接错误断言仍失败');
      expect(browser.GetStatus).toHaveBeenCalledWith(false);
    } finally { await host.Close(); }
  });
  it('压缩失败暂停时保留任务页，用户下一轮仍能继续并正常收尾', async () => {
    const provider = CreateProvider(() => ({ content: '继续核对完成', toolCalls: [] }));
    provider.EstimateTokens.mockReturnValue(200000);
    let taskId: string | null = 'compaction-page';
    const browser = {
      GetBrowserTaskId: vi.fn(() => taskId ?? undefined), CloseTask: vi.fn(async () => { taskId = null; }),
      ResetPageReferences: vi.fn(), Close: vi.fn(async () => undefined),
    };
    const { host, events } = await CreateHost(provider, browser as never);
    try {
      await Send(host, 'compression-pause', '继续核对，不能提交');
      expect(events).toContainEqual(expect.objectContaining({ type: 'paused', message: expect.stringContaining('压缩') }));
      expect(browser.CloseTask).not.toHaveBeenCalled();
      expect(taskId).toBe('compaction-page');
      expect(host.IsBusy()).toBe(false);
      provider.EstimateTokens.mockReturnValue(10);
      await Send(host, 'compression-resume', '缩小范围，只核对学校');
      expect(events).toContainEqual(expect.objectContaining({ type: 'completed', requestId: 'compression-resume' }));
      expect(browser.CloseTask).toHaveBeenCalledOnce();
    } finally { await host.Close(); }
  });

  it('卡片出现即提交也会等待 Host 检查点，不依赖旧 IPC 回执', async () => {
    const provider = CreateProvider((index) => index === 0 ? ToolCall(index, 'AskUserQuestion', { questions: [{ id: 'q', question: '选择', options: ['是'] }] }) : { content: '继续完成', toolCalls: [] });
    const { host } = await CreateHost(provider, { ResetPageReferences: vi.fn(), Close: vi.fn(async () => undefined) } as never);
    let response: Promise<unknown> | undefined;
    const emit = (host as any).Emit;
    (host as any).Emit = (event: any) => {
      emit(event);
      if (event.type === 'question_requested') response = host.RespondToInteraction({ kind: 'answer', sessionId: 'failure-session', requestId: 'early-answer', interactionId: event.confirmationId, answers: { q: '是' } });
    };
    try {
      await Send(host, 'early-answer', '询问我');
      await expect(response).resolves.toMatchObject({ accepted: true });
      expect(provider.getCallCount()).toBe(2);
    } finally { await host.Close(); }
  });

  it('问答等待检查点重启后仍可恢复，模型收到答案而非新增用户消息', async () => {
    const provider = CreateProvider((index) => index === 0 ? ToolCall(index, 'AskUserQuestion', { questions: [{ id: 'q', question: '选择', options: ['是'] }] }) : { content: '继续完成', toolCalls: [] });
    const browser = { ResetPageReferences: vi.fn(), Close: vi.fn(async () => undefined) };
    const first = await CreateHost(provider, browser as never);
    await Send(first.host, 'restart-answer', '询问我');
    const interactionId = first.events.find((event) => event.type === 'question_requested').confirmationId;
    await first.host.Close();
    const events: any[] = [];
    const host = new AgentHost({ userDataPath: join(first.root, 'user-data'), workspacePath: first.root, Emit: (event) => events.push(event), browserRuntime: browser as never, business: first.business, observability: first.observability,
      credentialPort: { Load: vi.fn(async () => null), Save: vi.fn() }, createDefaultModules: (ports) => ({ ...CreateDefaultModules(ports), modelProvider: provider }) });
    try {
      expect((await host.GetSessionAssistantState('failure-session')).pendingEvents).toContainEqual(expect.objectContaining({ confirmationId: interactionId }));
      await host.RespondToInteraction({ kind: 'answer', sessionId: 'failure-session', requestId: 'restart-answer', interactionId, answers: { q: '是' } });
      expect(events).toContainEqual(expect.objectContaining({ type: 'completed', requestId: 'restart-answer' }));
      expect((host as any).histories.get('failure-session').filter((message: any) => message.role === 'user' && message.metadata?.source !== 'runtime')).toHaveLength(1);
    } finally { await host.Close(); }
  });
  it.each([true, false])('浏览器审批 %s 后由后端续轮，重复提交不重复执行且无合成用户消息', async (approved) => {
    const provider = CreateProvider((index) => index === 0 ? ToolCall(index, 'BrowserClick', { ref: '@e1', pageRevision: 1 }) : { content: '已继续', toolCalls: [] });
    const browser = { Prepare: vi.fn(async ({ toolName, arguments: args }: any) => Proposal(toolName, args)), Execute: vi.fn(async () => ({ status: 'succeeded', data: { clicked: true } })), GetStatus: vi.fn(), ResetPageReferences: vi.fn(), Close: vi.fn(async () => undefined) };
    const { host, events, observability } = await CreateHost(provider, browser as never);
    try {
      await host.Send({ requestId: 'approval-run', sessionId: 'failure-session', scenarioId: 'application', confirmationMode: 'always_confirm', content: '点击按钮' });
      const interactionId = events.find((event) => event.type === 'browser_confirmation').confirmationId;
      const response = { kind: 'approval' as const, requestId: 'approval-run', sessionId: 'failure-session', interactionId, approved };
      await Promise.all([host.RespondToInteraction(response), host.RespondToInteraction(response)]);
      await expect(host.RespondToInteraction(response)).resolves.toMatchObject({ replayed: true });
      expect(browser.Execute).toHaveBeenCalledTimes(approved ? 1 : 0);
      expect(provider.getCallCount()).toBe(2);
      expect(observability.StartTrace).toHaveBeenCalledTimes(1);
      const history = (host as any).histories.get('failure-session');
      expect(history.filter((message: any) => message.role === 'user' && message.metadata?.source !== 'runtime')).toHaveLength(1);
      const results = history.filter((message: any) => message.role === 'tool');
      expect(results).toHaveLength(1);
      expect(JSON.parse(results[0].content)).toMatchObject(approved ? { ok: true, data: { clicked: true }, receipt: expect.any(Object) } : { ok: false, code: 'USER_REJECTED' });
      expect(events.filter((event) => event.type === 'completed').map((event) => event.requestId)).toEqual(['approval-run']);
      await expect(host.RespondToInteraction({ ...response, approved: !approved })).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
    } finally { await host.Close(); }
  });

  it.each(['页面已变', '提案过期', '任务页已关闭'])('拒绝浏览器确认不受%s影响，且不会执行原动作', async (condition) => {
    let taskId: string | undefined = 'rejection-task';
    const provider = CreateProvider((index) => index === 0 ? ToolCall(index, 'BrowserClick', { ref: '@e1', pageRevision: 1 }) : { content: '已取消该操作', toolCalls: [] });
    const browser = { Prepare: vi.fn(async ({ toolName, arguments: args }: any) => Proposal(toolName, args)), Execute: vi.fn(),
      GetBrowserTaskId: () => taskId, GetStatus: vi.fn(async () => ({ pageRevision: 1 })), ResetPageReferences: vi.fn(), Close: vi.fn(async () => undefined) };
    const { host, events } = await CreateHost(provider, browser as never);
    try {
      await host.Send({ requestId: 'reject-changed', sessionId: 'failure-session', scenarioId: 'application', confirmationMode: 'always_confirm', content: '点击按钮' });
      const interactionId = events.find((event) => event.type === 'browser_confirmation').confirmationId;
      if (condition === '页面已变') browser.GetStatus.mockResolvedValue({ pageRevision: 9 });
      if (condition === '提案过期') (host as any).pendingBrowserActions.get(interactionId).createdAt = 0;
      if (condition === '任务页已关闭') taskId = undefined;
      await host.RespondToInteraction({ kind: 'approval', requestId: 'reject-changed', sessionId: 'failure-session', interactionId, approved: false });
      expect(browser.Execute).not.toHaveBeenCalled();
      const history = (host as any).histories.get('failure-session');
      expect(JSON.parse(history.find((message: any) => message.tool_call_id === 'failure-0').content)).toMatchObject({ ok: false, code: 'USER_REJECTED' });
      expect((await host.GetSessionAssistantState('failure-session')).pendingEvents).toEqual([]);
    } finally { await host.Close(); }
  });

  it('批准操作仍校验真实页面版本，页面变化时不执行旧提案', async () => {
    const provider = CreateProvider((index) => index === 0 ? ToolCall(index, 'BrowserClick', { ref: '@e1', pageRevision: 1 }) : { content: '页面已变化，未执行', toolCalls: [] });
    const browser = { Prepare: vi.fn(async ({ toolName, arguments: args }: any) => Proposal(toolName, args)), Execute: vi.fn(),
      GetStatus: vi.fn(async () => ({ pageRevision: 1 })), ResetPageReferences: vi.fn(), Close: vi.fn(async () => undefined) };
    const { host, events } = await CreateHost(provider, browser as never);
    try {
      await host.Send({ requestId: 'approve-stale', sessionId: 'failure-session', scenarioId: 'application', confirmationMode: 'always_confirm', content: '点击按钮' });
      const interactionId = events.find((event) => event.type === 'browser_confirmation').confirmationId;
      browser.GetStatus.mockResolvedValue({ pageRevision: 9 });
      await host.RespondToInteraction({ kind: 'approval', requestId: 'approve-stale', sessionId: 'failure-session', interactionId, approved: true });
      expect(browser.Execute).not.toHaveBeenCalled();
      expect(JSON.parse((host as any).histories.get('failure-session').find((message: any) => message.tool_call_id === 'failure-0').content)).toMatchObject({ ok: false, code: 'BROWSER_CONFIRMATION_STALE' });
    } finally { await host.Close(); }
  });

  it('决定已处理但续轮初始化失败时提交真实结果并释放等待，下一条消息不再要求确认', async () => {
    const provider = CreateProvider((index) => index === 0 ? ToolCall(index, 'BrowserClick', { ref: '@e1', pageRevision: 1 }) : { content: '新任务完成', toolCalls: [] });
    const browser = { Prepare: vi.fn(async ({ toolName, arguments: args }: any) => Proposal(toolName, args)), Execute: vi.fn(),
      GetStatus: vi.fn(), ResetPageReferences: vi.fn(), Close: vi.fn(async () => undefined) };
    const { host, events, observability } = await CreateHost(provider, browser as never);
    try {
      await host.Send({ requestId: 'resume-init-error', sessionId: 'failure-session', scenarioId: 'application', confirmationMode: 'always_confirm', content: '点击按钮' });
      const interactionId = events.find((event) => event.type === 'browser_confirmation').confirmationId;
      provider.GetStatus.mockRejectedValueOnce(new Error('provider temporarily unavailable'));
      await expect(host.RespondToInteraction({ kind: 'approval', requestId: 'resume-init-error', sessionId: 'failure-session', interactionId, approved: false })).rejects.toThrow('provider temporarily unavailable');
      expect((await host.GetSessionAssistantState('failure-session')).pendingEvents).toEqual([]);
      expect(observability.FinishTrace).toHaveBeenLastCalledWith('resume-init-error', 'failed', expect.stringContaining('provider temporarily unavailable'));
      await expect(Send(host, 'after-resume-error', '先不点击，回答新问题')).resolves.toMatchObject({ accepted: true });
      expect(browser.Execute).not.toHaveBeenCalled();
      expect((host as any).histories.get('failure-session').filter((message: any) => message.tool_call_id === 'failure-0')).toHaveLength(1);
    } finally { await host.Close(); }
  });

  it.each([true, false])('重启后已保存的决定 %s 不再展示旧确认，新消息保留唯一结果且不重放动作', async (approved) => {
    const provider = CreateProvider((index) => index === 0 ? ToolCall(index, 'BrowserClick', { ref: '@e1', pageRevision: 1 }) : { content: '已处理新消息', toolCalls: [] });
    const browser = { Prepare: vi.fn(async ({ toolName, arguments: args }: any) => Proposal(toolName, args)), Execute: vi.fn(),
      GetStatus: vi.fn(), ResetPageReferences: vi.fn(), Close: vi.fn(async () => undefined) };
    const first = await CreateHost(provider, browser as never);
    await first.host.Send({ requestId: 'saved-decision', sessionId: 'failure-session', scenarioId: 'application', confirmationMode: 'always_confirm', content: '点击按钮' });
    const interactionId = first.events.find((event) => event.type === 'browser_confirmation').confirmationId;
    const paused = (first.host as any).pausedRuns.get('saved-decision');
    paused.status = 'ready';
    paused.result = { role: 'tool', tool_call_id: 'failure-0', content: JSON.stringify(approved ? { ok: true, receipt: { receiptId: 'already-executed' } } : { ok: false, code: 'BROWSER_CONFIRMATION_STALE' }) };
    (first.host as any).interactionDecisions.set(interactionId, { kind: 'approval', requestId: 'saved-decision', sessionId: 'failure-session', interactionId, approved });
    (first.host as any).SaveState();
    await first.host.Close();
    const host = new AgentHost({ userDataPath: join(first.root, 'user-data'), workspacePath: first.root, Emit: vi.fn(), browserRuntime: browser as never,
      business: first.business, observability: first.observability, credentialPort: { Load: vi.fn(async () => null), Save: vi.fn() },
      createDefaultModules: (ports) => ({ ...CreateDefaultModules(ports), modelProvider: provider }) });
    try {
      expect((await host.GetSessionAssistantState('failure-session')).pendingEvents).toEqual([]);
      await expect(Send(host, 'after-restart-decision', '取消原操作，处理新问题')).resolves.toMatchObject({ accepted: true });
      expect(browser.Execute).not.toHaveBeenCalled();
      const results = (host as any).histories.get('failure-session').filter((message: any) => message.tool_call_id === 'failure-0');
      expect(results).toHaveLength(1);
      expect(JSON.parse(results[0].content)).toMatchObject(approved ? { ok: true, receipt: { receiptId: 'already-executed' } } : { ok: false, code: 'USER_REJECTED' });
    } finally { await host.Close(); }
  });

  it('问答校验会话、类型和完整性，普通 Send 不能绕过待决交互', async () => {
    const provider = CreateProvider((index) => index === 0 ? ToolCall(index, 'AskUserQuestion', { questions: [{ id: 'a', question: '选择', options: ['甲', '乙'] }] }) : { content: '完成', toolCalls: [] });
    const { host, events } = await CreateHost(provider, { ResetPageReferences: vi.fn(), Close: vi.fn(async () => undefined) } as never);
    try {
      await Send(host, 'answer-validation', '需要选择时问我');
      const interactionId = events.find((event) => event.type === 'question_requested').confirmationId;
      const response = { kind: 'answer' as const, sessionId: 'failure-session', requestId: 'answer-validation', interactionId, answers: { a: '甲' } };
      await expect(host.RespondToInteraction({ ...response, sessionId: 'other' })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
      await expect(host.RespondToInteraction({ ...response, answers: {} })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
      await expect(host.RespondToInteraction({ ...response, answers: { a: '甲', extra: '乙' } })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
      await expect(host.RespondToInteraction({ ...response, kind: 'approval', answers: undefined, approved: true })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
      await expect(Send(host, 'bypass-answer', '我同意')).rejects.toMatchObject({ code: 'AGENT_BUSY' });
      expect(provider.getCallCount()).toBe(1);
      await host.RespondToInteraction(response);
      expect(provider.getCallCount()).toBe(2);
      expect((host as any).histories.get('failure-session').filter((message: any) => message.role === 'user' && message.metadata?.source !== 'runtime')).toHaveLength(1);
    } finally { await host.Close(); }
  });

  it('取消等待任务补全协议并禁止迟到确认复活', async () => {
    const provider = CreateProvider((index) => ToolCall(index, 'AskUserQuestion', { questions: [{ id: 'a', question: '选择', options: ['甲'] }] }));
    const { host, events } = await CreateHost(provider, { ResetPageReferences: vi.fn(), Close: vi.fn(async () => undefined) } as never);
    try {
      await Send(host, 'cancel-wait', '等待选择');
      const interactionId = events.find((event) => event.type === 'question_requested').confirmationId;
      await expect(host.Cancel('cancel-wait')).resolves.toEqual({ cancelled: true });
      await expect(host.RespondToInteraction({ kind: 'answer', requestId: 'cancel-wait', sessionId: 'failure-session', interactionId, answers: { a: '甲' } })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
      const history = (host as any).histories.get('failure-session');
      expect(JSON.parse(history.at(-1).content)).toMatchObject({ code: 'CANCELLED' });
      expect(provider.getCallCount()).toBe(1);
      expect((await host.GetSessionAssistantState('failure-session')).pendingEvents).toEqual([]);
    } finally { await host.Close(); }
  });

  it.each(['always_confirm', 'allow_low_risk'] as const)('CronTask 在 %s 下确认完成后继续，模型收到真实任务 ID', async (confirmationMode) => {
    const provider = CreateProvider((index) => index === 0 ? ToolCall(index, 'CreateCronTask', { title: '读资料', message: '读资料', scenarioId: 'default', schedule: { type: 'once', executeAt: '2030-01-01T09:00:00+08:00', timeZone: 'Asia/Shanghai' } }) : { content: '任务已创建', toolCalls: [] });
    const { host, events, business } = await CreateHost(provider, { ResetPageReferences: vi.fn(), Close: vi.fn(async () => undefined) } as never);
    try {
      await host.Send({ requestId: 'cron-interaction', sessionId: 'failure-session', scenarioId: 'application', confirmationMode, content: '创建任务' });
      const interactionId = events.find((event) => event.type === 'cron_task_confirmation').confirmationId;
      await host.RespondToInteraction({ kind: 'approval', requestId: 'cron-interaction', sessionId: 'failure-session', interactionId, approved: true });
      expect(business.CreateCronTask).toHaveBeenCalledOnce();
      const history = (host as any).histories.get('failure-session');
      expect(JSON.parse(history.find((message: any) => message.tool_call_id === 'failure-0').content)).toMatchObject({ ok: true, task: { id: 'cron-created' } });
      expect(events).toContainEqual(expect.objectContaining({ type: 'completed', requestId: 'cron-interaction' }));
    } finally { await host.Close(); }
  });
  it.each(['default', 'application'] as const)('完全信任直接创建 %s 定时任务，冻结授权后继续当前 Run', async (scenarioId) => {
    const provider = CreateProvider((index) => index === 0 ? ToolCall(index, 'CreateCronTask', { title: '定时读资料', message: '搜索岗位并读取 JD', scenarioId, schedule: { type: 'once', executeAt: '2030-01-01T09:00:00+08:00', timeZone: 'Asia/Shanghai' } }) : { content: '任务已创建', toolCalls: [] });
    const { host, events, business } = await CreateHost(provider, { ResetPageReferences: vi.fn(), Close: vi.fn(async () => undefined) } as never);
    const sync = vi.fn(async () => undefined);
    (host as any).onCronScheduleChanged = sync;
    const settle = vi.spyOn(host as any, 'SettleConversationInteraction');
    try {
      await Send(host, 'cron-direct', '创建定时任务');
      expect(business.CreateCronTask).toHaveBeenCalledOnce();
      expect(sync).toHaveBeenCalledOnce();
      expect(settle).not.toHaveBeenCalled();
      expect(events.some((event) => event.type === 'cron_task_confirmation')).toBe(false);
      expect((host as any).pendingCronTasks.size).toBe(0);
      expect(provider.getCallCount()).toBe(2);
      const history = (host as any).histories.get('failure-session');
      expect(JSON.parse(history.find((message: any) => message.tool_call_id === 'failure-0').content)).toMatchObject({ ok: true, created: true, task: { id: 'cron-created' } });
      if (scenarioId === 'application') expect(business.CreateCronTask).toHaveBeenCalledWith(expect.anything(), { browserTaskGrant: expect.objectContaining({ purpose: 'job_search', allowNavigation: true, allowFormFill: false, allowFileUpload: false, allowExternalSend: false, resourceIds: [] }) });
      else expect(business.CreateCronTask).toHaveBeenCalledWith(expect.anything(), {});
      expect(events).toContainEqual(expect.objectContaining({ type: 'completed', requestId: 'cron-direct' }));
    } finally { await host.Close(); }
  });
  it('完全信任创建任务注册调度失败时回滚，工具不报告创建成功', async () => {
    const provider = CreateProvider((index) => index === 0 ? ToolCall(index, 'CreateCronTask', { title: '定时读资料', message: '读资料', scenarioId: 'default', schedule: { type: 'once', executeAt: '2030-01-01T09:00:00+08:00', timeZone: 'Asia/Shanghai' } }) : { content: '创建失败', toolCalls: [] });
    const { host, business } = await CreateHost(provider, { ResetPageReferences: vi.fn(), Close: vi.fn(async () => undefined) } as never);
    (host as any).onCronScheduleChanged = vi.fn(async () => { throw new Error('wake registration failed'); });
    try {
      await Send(host, 'cron-direct-failure', '创建定时任务');
      expect(business.DeleteCronTask).toHaveBeenCalledWith('cron-created');
      const history = (host as any).histories.get('failure-session');
      expect(JSON.parse(history.find((message: any) => message.tool_call_id === 'failure-0').content)).toMatchObject({ ok: false, code: 'CRON_CREATION_FAILED' });
      expect((host as any).pendingCronTasks.size).toBe(0);
    } finally { await host.Close(); }
  });
  it('聊天发送给模型的工具均只读，工作包含档案写入且不影响确认策略', async () => {
    const provider = CreateProvider(() => ({ content: '完成', toolCalls: [] }));
    const { host } = await CreateHost(provider, { Close: vi.fn(async () => undefined), ResetPageReferences: vi.fn() } as never);
    try {
      await host.Send({ requestId: 'chat-policy', sessionId: 'chat-policy', scenarioId: 'default', confirmationMode: 'fully_trusted', content: '分析资料' });
      const chat = (host as any).runSnapshots.get('chat-policy');
      expect(chat.scenario.name).toBe('聊天');
      expect(chat.tools.every((tool: any) => tool.sideEffect === 'none')).toBe(true);
      expect(chat.instructions.compiled).toContain('Chat cannot change saved resumes');
      await Send(host, 'work-policy', '规划求职任务');
      const work = (host as any).runSnapshots.get('work-policy');
      expect(work.scenario.name).toBe('工作');
      expect(work.tools.map((tool: any) => tool.definition.function.name)).toContain('UpdateProfile');
    } finally { await host.Close(); }
  });

  it.each(['memory', 'database'])('旧场景 %s 快照必须显式重载，重载后同场景继续', async (source) => {
    const provider = CreateProvider(() => ({ content: '完成', toolCalls: [] }));
    const { host, business } = await CreateHost(provider, { Close: vi.fn(async () => undefined) } as never);
    const input = { sessionId: 'legacy-policy', scenarioId: 'default', content: '继续分析' };
    try {
      await host.Send({ ...input, requestId: 'policy-first' });
      const snapshots = (host as any).sessionSnapshots.get(input.sessionId);
      delete snapshots.tool.scenarioPolicyVersion;
      if (source === 'database') {
        (host as any).sessionSnapshots.delete(input.sessionId);
        Object.assign(business, { GetConversationSnapshots: vi.fn(async () => ({ sessionSnapshotJson: JSON.stringify(snapshots.session), toolSnapshotJson: JSON.stringify(snapshots) })) });
      }
      const callCount = provider.getCallCount();
      await expect(host.Send({ ...input, requestId: 'policy-stale' })).rejects.toMatchObject({ code: 'SCENARIO_RELOAD_REQUIRED' });
      expect(provider.getCallCount()).toBe(callCount);
      await expect(host.ReloadSession(input.sessionId)).resolves.toMatchObject({ reloaded: true });
      await host.Send({ ...input, requestId: 'policy-reloaded' });
      expect(provider.getCallCount()).toBe(callCount + 1);
    } finally { await host.Close(); }
  });

  it('工作模式读取简历后可生成局部编辑提案，确认保存一次后同会话继续', async () => {
    let resume = { id: 'resume-work', name: '产品经理', content: '# 核心能力\n- 原型生产：旧表述\n- 沟通协调\n# 教育经历\n南昌大学', revision: 10, updatedAt: '', targetRoles: [], summary: '' };
    const content = resume.content.replace('原型生产：旧表述', '原型生产：熟练使用 Figma 绘制产品原型');
    const provider = CreateProvider((index) => {
      if (index === 0) return ToolCall(index, 'ReadResume', { resumeId: resume.id });
      if (index === 1) return ToolCall(index, 'UpdateResume', { resumeId: resume.id, content, reason: '仅修改第一条核心能力' });
      return { content: '简历第一条已保存，其余内容保持原样。', toolCalls: [] };
    });
    const browser = { Close: vi.fn(async () => undefined), ResetPageReferences: vi.fn() };
    const { host, business, events } = await CreateHost(provider, browser as never);
    const save = vi.fn(async (next: typeof resume) => { resume = { ...next, revision: 11 }; return { id: resume.id, revision: 11 }; });
    Object.assign(business, { LoadViewModel: async () => ({ resumes: [resume] }), UpsertResume: save });
    try {
      await host.Send({ requestId: 'work-local-edit', sessionId: 'failure-session', scenarioId: 'application', confirmationMode: 'always_confirm', content: '只改核心能力第一条，直接帮我修改' });
      const confirmation = events.find((event) => event.type === 'resume_confirmation');
      expect(confirmation).toMatchObject({ sessionId: 'failure-session', resumeId: resume.id, content });
      expect(save).not.toHaveBeenCalled();
      expect(provider.getCallCount()).toBe(2);
      expect((await host.GetSessionAssistantState('other-session')).pendingEvents).toEqual([]);
      expect(await host.RespondToInteraction({ kind: 'approval', sessionId: 'failure-session', requestId: 'work-local-edit', interactionId: confirmation.confirmationId, approved: true })).toMatchObject({ accepted: true });
      expect(save).toHaveBeenCalledTimes(1);
      expect(resume.content).toBe(content);
      expect(events).toContainEqual(expect.objectContaining({ type: 'completed', requestId: 'work-local-edit' }));
      expect(save).toHaveBeenCalledTimes(1);
    } finally { await host.Close(); }
  });

  it('工作模式档案真实保存后发布产物，统计首尾差异并刷新原资料侧栏', async () => {
    let profiles = [{ id: 'profile-work', category: 'work', title: '工作经历', content: '第一行\n旧表述', updatedAt: '' }];
    const provider = CreateProvider((index) => {
      if (index === 0) return ToolCall(index, 'ReadProfile');
      if (index === 1 || index === 2) return ToolCall(index, 'UpdateProfile', {
        items: [{ ...profiles[0], content: index === 1 ? '第一行\n中间表述\n临时行' : '第一行\n最终表述' }].map(({ updatedAt, ...item }) => item),
      });
      return { content: '档案已保存。', toolCalls: [] };
    });
    const { host, business, events } = await CreateHost(provider, { Close: vi.fn(async () => undefined), ResetPageReferences: vi.fn() } as never);
    let presentation: ConversationPresentation | undefined;
    Object.assign(business, {
      GetProfiles: async () => ({ items: structuredClone(profiles) }),
      ReadProfilesSnapshot: async () => structuredClone(profiles),
      SaveProfiles: async (items: typeof profiles) => { profiles = structuredClone(items); return { count: profiles.length }; },
      SaveConversationPresentation: async (_id: string, value: ConversationPresentation) => { presentation = value; return { saved: true }; },
    });
    try {
      await host.Send({ requestId: 'profile-artifact', sessionId: 'profile-artifact-session', scenarioId: 'application', confirmationMode: 'fully_trusted', content: '请修改工作经历的第二行' });
      expect(profiles[0].content).toBe('第一行\n最终表述');
      expect(presentation?.status).toBe('completed');
      expect(GetConversationArtifacts(presentation!)).toEqual([{ kind: 'profile', id: 'profile-work', title: '工作经历', produced: true, lineChanges: { added: 1, removed: 1 } }]);
      expect(events.filter((event) => event.type === 'profile_updated')).toHaveLength(2);
      expect((host as any).documentChanges.Snapshot()).toEqual([]);
    } finally { await host.Close(); }
  });

  it('后台投递的运行快照不暴露简历写工具，前台工作快照保留写能力', async () => {
    const provider = CreateProvider(() => ({ content: '完成读取任务', toolCalls: [] }));
    const browser = { Close: vi.fn(async () => undefined), SetUnattended: vi.fn(), CloseTask: vi.fn(async () => undefined), ResetPageReferences: vi.fn() };
    const { host } = await CreateHost(provider, browser as never);
    try {
      await Send(host, 'foreground-tools', '普通工作会话');
      await host.SendScheduled({ requestId: 'background-tools', sessionId: 'cron-work', scenarioId: 'application', content: '只读取已授权岗位' });
      const foreground = (host as any).runSnapshots.get('foreground-tools');
      const background = (host as any).runSnapshots.get('background-tools');
      expect(foreground.scenario.toolNames).toEqual(expect.arrayContaining(['CreateResume', 'UpdateResume']));
      expect(background.scenario.toolNames).not.toContain('CreateResume');
      expect(background.scenario.toolNames).not.toContain('UpdateResume');
      expect(background.scenario.toolNames).not.toContain('UpdateProfile');
      expect(background.tools.map((tool: any) => tool.definition.function.name)).not.toContain('UpdateResume');
    } finally { await host.Close(); }
  });

  it('后台定时会话同样保存有序过程，且在 SendScheduled 返回前发布终态', async () => {
    const provider = CreateProvider(() => ({ content: '后台任务最终结果', toolCalls: [] }));
    const browser = { Close: vi.fn(async () => undefined), SetUnattended: vi.fn(), CloseTask: vi.fn(async () => undefined) };
    const { host, business, events } = await CreateHost(provider, browser as never);
    const snapshots: any[] = [];
    const save = vi.fn(async (owner: string, presentation: unknown) => { expect(owner).toBe('cron-session'); snapshots.push(presentation); return { saved: true }; });
    Object.assign(business, { SaveConversationPresentation: save });
    try {
      const result = await host.SendScheduled({ requestId: 'cron-request1', sessionId: 'cron-session', scenarioId: 'default', content: '执行后台任务' });
      expect(result.content).toBe('后台任务最终结果');
      expect(snapshots.at(-1)).toMatchObject({ requestId: 'cron-request1', status: 'completed', parts: expect.arrayContaining([expect.objectContaining({ type: 'text', text: '后台任务最终结果' })]) });
      expect(events.filter((event) => event.type === 'conversation_updated').at(-1)).toMatchObject({ sessionId: 'cron-session', presentation: { status: 'completed' } });
    } finally { await host.Close(); }
  });

  it('Agent运行中可调用共享BOSS采集并读取已入库岗位，不重入页面独占锁或要求简历', async () => {
    const provider = CreateProvider((index) => index === 0 ? ToolCall(0, 'CollectJobs', { channel: 'boss_zhipin', keyword: '产品', city: '广州', targetCount: 1 })
      : index === 1 ? ToolCall(1, 'ReadJobs', { channel: 'boss_zhipin' }) : { content: '岗位已入库', toolCalls: [] });
    const browser = {
      Prepare: vi.fn(async ({ toolName, arguments: args }) => Proposal(toolName, args)),
      Execute: vi.fn(async () => ({ status: 'succeeded' as const, data: {} })),
      EvaluateTrustedPage: vi.fn(async ({ expression }) => expression.includes("risk: 'verification'") ? { risk: null }
        : expression.includes('const pageText') ? { title: '产品经理', company: '测试企业', jd: '负责产品设计', url: 'https://www.zhipin.com/job_detail/one.html' }
          : [{ title: '产品经理', company: '测试企业', url: 'https://www.zhipin.com/job_detail/one.html' }]),
      GetStatus: vi.fn(async () => ({ engine: 'chrome', state: 'running' })), SetEngine: vi.fn(), SetUnattended: vi.fn(),
      CloseTask: vi.fn(async () => undefined), ResetPageReferences: vi.fn(), Close: vi.fn(async () => undefined),
    };
    const { host, business, root } = await CreateHost(provider, browser as never, { browserEngine: 'chrome' });
    const rows: any[] = [];
    const read = vi.fn(async () => ({ items: rows, total: rows.length, page: 1, pageSize: 20, pageCount: 1 }));
    Object.assign(business, { ReadJobLibrary: read });
    const service = new JobLibraryCollectionService({ workspacePath: root,
      importJobs: async (batch) => { rows.push(...batch.map((entry) => entry.job)); return { items: batch.map((entry) => ({ identity: entry.identity, jobId: entry.job.id, status: 'inserted' as const })) }; },
      collectBoss: async () => { throw new Error('不能进入页面独占采集流程'); },
    });
    host.SetJobLibraryCollectionService(service);
    const exclusive = vi.spyOn(host, 'WithCollectionBrowser');
    try {
      await Send(host, 'agent-collection', '采集1个产品岗位');
      expect(provider.getCallCount()).toBe(3); expect(rows).toHaveLength(1); expect(rows[0].id).toBe('job-boss-one');
      expect(read).toHaveBeenCalledOnce(); expect(exclusive).not.toHaveBeenCalled();
      expect((await service.GetJobCollectionTask())?.status).toBe('completed');
      host.DeleteSessionResources('failure-session');
      expect(rows).toHaveLength(1); expect((await service.GetJobCollectionTask())?.collected).toBe(1);
    } finally { await service.Close(); await host.Close(); }
  });

  it('岗位页采集同步占用浏览器互斥锁，阻止 Agent 导航，失败后释放而不关闭共享 Bridge', async () => {
    const provider = CreateProvider(() => ({ content: 'unused', toolCalls: [] }));
    const browser = { Prepare: vi.fn(), Execute: vi.fn(), GetStatus: vi.fn(), SetEngine: vi.fn(), SetUnattended: vi.fn(),
      CloseTask: vi.fn(async () => undefined), ResetPageReferences: vi.fn(), Close: vi.fn(async () => undefined) };
    const { host } = await CreateHost(provider, browser as never, { browserEngine: 'chrome' });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const work = host.WithCollectionBrowser('collection-1', async () => { await gate; throw new Error('采集失败'); });
    expect(host.IsBusy()).toBe(true);
    await expect(Send(host, 'agent-during-collection', '搜索岗位')).rejects.toMatchObject({ code: 'AGENT_BUSY' });
    await expect(host.WithCollectionBrowser('collection-2', async () => undefined)).rejects.toMatchObject({ code: 'AGENT_BUSY' });
    release(); await expect(work).rejects.toThrow('采集失败');
    expect(host.IsBusy()).toBe(false); expect(browser.Close).not.toHaveBeenCalled();
    expect(browser.SetUnattended).toHaveBeenCalledWith(false);
    await host.Close();
  });
  it('按已保存设置同步浏览器引擎后再返回运行状态', async () => {
    const provider = CreateProvider(() => ({ content: 'unused', toolCalls: [] }));
    const browser = {
      Prepare: vi.fn(), Execute: vi.fn(), SetEngine: vi.fn(),
      GetStatus: vi.fn(async () => ({ engine: 'chrome', state: 'stopped' })),
      ClearProfile: vi.fn(), ResetPageReferences: vi.fn(), Close: vi.fn(async () => undefined),
    };
    const { host } = await CreateHost(provider, browser as any, { browserEngine: 'chrome' });

    await expect(host.GetBrowserRuntimeStatus(true)).resolves.toMatchObject({ engine: 'chrome' });
    expect(browser.SetEngine).toHaveBeenCalledWith('chrome');
    expect(browser.GetStatus).toHaveBeenCalledWith(true);
    browser.SetEngine.mockClear();
    (host as any).browserRunId = 'active-application-run';
    await host.GetBrowserRuntimeStatus();
    expect(browser.SetEngine).not.toHaveBeenCalled();
    expect(browser.GetStatus).toHaveBeenLastCalledWith(false);
    await expect(host.GetBrowserRuntimeStatus('true' as any)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    (host as any).browserRunId = null;
    await host.Close();
  });

  it('浏览器引擎同步在首个 Run 前失败时仍收回已存在 task 并发布 run_released', async () => {
    const provider = CreateProvider(() => ({ content: '不会进入模型。', toolCalls: [] }));
    let browserTaskId: string | null = 'task-sync-failure';
    const browser = {
      Prepare: vi.fn(), Execute: vi.fn(), SetEngine: vi.fn(async () => { throw new Error('browser engine sync failed'); }),
      GetBrowserTaskId: vi.fn(() => browserTaskId ?? undefined),
      CloseTask: vi.fn(async () => {
        browserTaskId = null;
        return { status: 'confirmed' as const, browserTaskId: 'task-sync-failure', closedTabs: 1, unknownTabs: 0 };
      }),
      GetStatus: vi.fn(), ClearProfile: vi.fn(), ResetPageReferences: vi.fn(), Close: vi.fn(async () => undefined),
    };
    const { host, events } = await CreateHost(provider, browser as any, { browserEngine: 'chrome' });

    await expect(Send(host, 'sync-failure-cleanup', '启动浏览器任务')).rejects.toThrow('browser engine sync failed');
    expect(browser.CloseTask).toHaveBeenCalledOnce();
    expect(events).toContainEqual(expect.objectContaining({
      type: 'run_released', requestId: 'sync-failure-cleanup',
      cleanupOutcomes: [expect.objectContaining({ status: 'confirmed', browserTaskId: 'task-sync-failure' })],
    }));
    expect((host as any).browserRunId).toBeNull();
    await host.Close();
  });

  it('设置页只读取并撤销创建时持久化的任务级浏览器授权', async () => {
    const provider = CreateProvider(() => ({ content: 'unused', toolCalls: [] }));
    const browser = {
      Prepare: vi.fn(), Execute: vi.fn(), SetEngine: vi.fn(),
      GetStatus: vi.fn(), ClearProfile: vi.fn(), ResetPageReferences: vi.fn(), Close: vi.fn(async () => undefined),
    };
    const { host, business } = await CreateHost(provider, browser as any, { browserEngine: 'chrome' });

    await expect(host.GetCronBrowserAccess()).resolves.toMatchObject({ tasks: [{ id: 'cron-1', title: '工作日投递', browserAuthorized: true }] });
    await expect(host.RevokeCronBrowserAccess({ cronTaskId: 'cron-1' })).resolves.toMatchObject({ revoked: true });
    expect(business.RevokeCronTaskBrowserAuthorization).toHaveBeenCalledWith('cron-1');

    (host as any).browserRunId = 'active-application-run';
    await expect(host.RevokeCronBrowserAccess({ cronTaskId: 'cron-1' })).rejects.toMatchObject({ code: 'AGENT_BUSY' });
    (host as any).browserRunId = null;
    await host.Close();
  });

  it('纯岗位搜索的投递 CronTask 无需绑定简历即可创建', async () => {
    const provider = CreateProvider(() => ({ content: 'unused', toolCalls: [] }));
    const browser = {
      Prepare: vi.fn(), Execute: vi.fn(), GetStatus: vi.fn(), ClearProfile: vi.fn(), ResetPageReferences: vi.fn(), Close: vi.fn(async () => undefined),
    };
    const { host, business } = await CreateHost(provider, browser as any);
    const input = {
      title: '读取 BOSS 岗位', message: '在 BOSS 搜索 Agent 岗位并读取 JD', scenarioId: 'application',
      schedule: { type: 'once', executeAt: '2030-01-01T09:00:00+08:00', timeZone: 'Asia/Shanghai' },
    };

    const proposal = (host as any).PrepareCronTask(input, { requestId: 'cron-without-resume' });
    expect(proposal.summary).toContain('当前未绑定简历');
    await expect(host.ConfirmCronTask(proposal.confirmationId, true)).resolves.toMatchObject({ created: true, task: { id: 'cron-created' } });
    expect(business.CreateCronTask).toHaveBeenCalledWith(input, { browserTaskGrant: expect.objectContaining({
      mode: 'personal_browser_extension', purpose: 'job_search', allowNavigation: true, allowFormFill: false,
      allowFileUpload: false, allowExternalSend: false, resourceIds: [], grantedAt: expect.any(String),
    }) });
    await host.Close();
  });

  it('CronTask 确认时按任务意图冻结最小权限和持久资源', async () => {
    const provider = CreateProvider(() => ({ content: 'unused', toolCalls: [] }));
    const browser = {
      Prepare: vi.fn(), Execute: vi.fn(), GetStatus: vi.fn(), ClearProfile: vi.fn(), ResetPageReferences: vi.fn(), Close: vi.fn(async () => undefined),
    };
    const { host, business } = await CreateHost(provider, browser as any);
    const schedule = { type: 'once', executeAt: '2030-01-01T09:00:00+08:00', timeZone: 'Asia/Shanghai' };

    const application = (host as any).PrepareCronTask({
      title: '企业官网投递', message: '打开企业官网，填写并提交申请表单', scenarioId: 'application', schedule,
    }, { requestId: 'cron-application', resumeId: 'resume-7', profileIds: ['profile-a', 'profile-b', 'profile-a'] });
    await host.ConfirmCronTask(application.confirmationId, true);
    expect(business.CreateCronTask).toHaveBeenLastCalledWith(expect.anything(), { resumeId: 'resume-7', browserTaskGrant: expect.objectContaining({
      purpose: 'job_application', allowNavigation: true, allowFormFill: true,
      allowFileUpload: false, allowExternalSend: true,
      resourceIds: ['resume:resume-7', 'profile:profile-a', 'profile:profile-b'],
    }) });

    const boss = (host as any).PrepareCronTask({
      title: 'BOSS 打招呼', message: '在 BOSS 直聘联系招聘者并发送消息', scenarioId: 'application', schedule,
    }, { requestId: 'cron-boss', resumeId: 'resume-7', profileIds: ['profile-a'] });
    await host.ConfirmCronTask(boss.confirmationId, true);
    expect(business.CreateCronTask).toHaveBeenLastCalledWith(expect.anything(), { resumeId: 'resume-7', browserTaskGrant: expect.objectContaining({
      purpose: 'boss_contact', allowNavigation: true, allowFormFill: true,
      allowFileUpload: false, allowExternalSend: true,
      resourceIds: ['resume:resume-7', 'profile:profile-a'],
    }) });
    expect(boss.summary).toContain('BOSS 沟通');
    expect(boss.summary).toContain('网页要求上传文件时会标记为需要你接管');
    await host.Close();
  });

  it('测评取消贯穿确认后的浏览器执行，迟到结果只能记为状态未知', async () => {
    const provider = CreateProvider(() => ({ content: 'unused', toolCalls: [] }));
    let release!: () => void;
    const browser = {
      Prepare: vi.fn(), Execute: vi.fn(async () => { await new Promise<void>((resolve) => { release = resolve; }); return { status: 'succeeded' as const, data: {} }; }),
      GetStatus: vi.fn(), ClearProfile: vi.fn(), ResetPageReferences: vi.fn(), Close: vi.fn(async () => undefined),
    };
    const { host, events } = await CreateHost(provider, browser as any);
    const proposal = Proposal('BrowserClick', { ref: '@e1', pageRevision: 1 });
    (host as any).pendingBrowserActions.set('cancel-confirmation', {
      confirmationId: 'cancel-confirmation', proposal, idempotencyKey: 'cancel-idempotency', sessionId: 'failure-session', browserTaskId: null, requestId: 'cancel-request', runId: 'cancel-run', toolCallId: 'cancel-tool', createdAt: Date.now(), bindingVersion: 1,
      binding: { sessionId: 'failure-session', browserTaskId: null, runId: 'cancel-run', proposalId: proposal.proposalId, proposalHash: proposal.proposalHash, pageRevision: proposal.pageRevision, ref: '@e1' },
    });
    const controller = new AbortController();
    const pending = host.ConfirmBrowserAction('cancel-confirmation', true, { signal: controller.signal, sessionId: 'failure-session' });
    while (!release) await new Promise((resolve) => setTimeout(resolve, 1));
    controller.abort(); release();
    await expect(pending).resolves.toMatchObject({ status: 'status_unknown', code: 'CANCELLED' });
    expect(browser.Execute).toHaveBeenCalledWith(expect.objectContaining({ signal: controller.signal }));
    expect([...((host as any).toolLedger.values())]).toContainEqual(expect.objectContaining({ status: 'status_unknown', errorCode: 'CANCELLED' }));
    await host.Close();
  });

  it('底层浏览器超时标记状态未知时，确认结果与账本保持一致', async () => {
    const provider = CreateProvider(() => ({ content: 'unused', toolCalls: [] }));
    const browser = {
      Prepare: vi.fn(),
      Execute: vi.fn(async () => {
        throw Object.assign(new Error('browser command timed out'), {
          code: 'BROWSER_COMMAND_TIMEOUT', statusUnknown: true,
        });
      }),
      GetStatus: vi.fn(), ClearProfile: vi.fn(), ResetPageReferences: vi.fn(), Close: vi.fn(async () => undefined),
    };
    const { host } = await CreateHost(provider, browser as any);
    const proposal = Proposal('BrowserClick', { ref: '@e1', pageRevision: 1 });
    (host as any).pendingBrowserActions.set('timeout-confirmation', {
      confirmationId: 'timeout-confirmation', proposal, idempotencyKey: 'timeout-idempotency',
      sessionId: 'failure-session', browserTaskId: null, requestId: 'timeout-request', runId: 'timeout-run', toolCallId: 'timeout-tool', createdAt: Date.now(), bindingVersion: 1,
      binding: { sessionId: 'failure-session', browserTaskId: null, runId: 'timeout-run', proposalId: proposal.proposalId, proposalHash: proposal.proposalHash, pageRevision: proposal.pageRevision, ref: '@e1' },
    });

    const result = await host.ConfirmBrowserAction('timeout-confirmation', true, { sessionId: 'failure-session' });
    const ledgerEntries = [...((host as any).toolLedger.values())];
    expect({ result, ledgerEntries }).toMatchObject({
      result: { status: 'status_unknown', code: 'BROWSER_COMMAND_TIMEOUT' },
      ledgerEntries: [expect.objectContaining({ status: 'status_unknown', errorCode: 'BROWSER_COMMAND_TIMEOUT' })],
    });
    await host.Close();
  });

  it('并发 application Send 在同步期间拒绝第二个，并在首个失败后释放占用', async () => {
    const provider = CreateProvider(() => { throw new Error('forced model failure'); });
    const browser = {
      Prepare: vi.fn(), Execute: vi.fn(), SetEngine: vi.fn(),
      GetStatus: vi.fn(), ClearProfile: vi.fn(), ResetPageReferences: vi.fn(), Close: vi.fn(async () => undefined),
    };
    const { host } = await CreateHost(provider, browser as any);
    let releaseSync!: () => void;
    let markSyncStarted!: () => void;
    const syncStarted = new Promise<void>((resolve) => { markSyncStarted = resolve; });
    const syncGate = new Promise<void>((resolve) => { releaseSync = resolve; });
    let syncCalls = 0;
    (host as any).SyncBrowserEngine = vi.fn(async () => {
      syncCalls += 1;
      if (syncCalls === 1) {
        markSyncStarted();
        await syncGate;
      }
    });

    const first = Send(host, 'first-application-run', 'first run');
    await syncStarted;
    const second = Send(host, 'second-application-run', 'second run');
    await expect(second).rejects.toMatchObject({ code: 'AGENT_BUSY' });
    releaseSync();
    await expect(first).rejects.toThrow('forced model failure');
    expect((host as any).browserRunId).toBeNull();
    await host.Close();
  });

  it('取消后的迟到模型 completion 不写 assistant history/usage，也不进入工具', async () => {
    const provider = CreateProvider(() => ({ content: 'unused', toolCalls: [] }));
    let releaseCompletion!: () => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const completionGate = new Promise<void>((resolve) => { releaseCompletion = resolve; });
    provider.StreamCompletion = vi.fn(async () => {
      markStarted();
      await completionGate;
      return {
        ...ToolCall(1, 'BrowserClick', { ref: '@e1', pageRevision: 1 }),
        content: '迟到的助手回复',
        usage: { promptTokens: 12, completionTokens: 4, totalTokens: 16, cachedInputTokens: 0 },
      } as any;
    }) as any;
    const browser = {
      Prepare: vi.fn(async ({ toolName, arguments: args }: any) => Proposal(toolName, args)),
      Execute: vi.fn(async () => ({ status: 'succeeded' as const, data: {} })),
      CloseTask: vi.fn(async () => ({ status: 'confirmed' as const, browserTaskId: 'task-late', closedTabs: 1, unknownTabs: 0 })),
      GetStatus: vi.fn(), ClearProfile: vi.fn(), ResetPageReferences: vi.fn(), Close: vi.fn(async () => undefined),
    };
    const { host, events } = await CreateHost(provider, browser as any);
    const pending = host.Send({ requestId: 'late-completion-cancel', sessionId: 'failure-session', scenarioId: 'application', confirmationMode: 'fully_trusted', content: '开始一次会取消的操作' });
    await started;
    expect(await host.Cancel('late-completion-cancel')).toEqual({ cancelled: true });
    releaseCompletion();
    await expect(pending).resolves.toMatchObject({ accepted: true, cancelled: true });

    const history = (host as any).histories.get('failure-session') as Array<{ role: string; content: string }>;
    expect(history.some((message) => message.content === '开始一次会取消的操作')).toBe(true);
    expect(history.some((message) => message.content === '迟到的助手回复')).toBe(false);
    expect(browser.Prepare).not.toHaveBeenCalled();
    expect(browser.Execute).not.toHaveBeenCalled();
    expect(browser.CloseTask).toHaveBeenCalledOnce();
    expect(events).toContainEqual(expect.objectContaining({
      type: 'run_released', requestId: 'late-completion-cancel',
      cleanupOutcomes: [expect.objectContaining({ status: 'confirmed', browserTaskId: 'task-late', closedTabs: 1, unknownTabs: 0 })],
    }));
    expect((host as any).sessionUsage.has('failure-session')).toBe(false);
    await host.Close();
  });

  it('hung task cleanup is visible as status_unknown, releases Host lock, and allows a fresh task without replaying actions', async () => {
    const provider = CreateProvider((index) => index === 0 || index === 2
      ? ToolCall(index, 'BrowserClick', { ref: `@e${index}`, pageRevision: 1 })
      : { content: '本轮已完成。', toolCalls: [] });
    let taskId: string | null = null;
    let taskSequence = 0;
    let releaseFirstClose!: () => void;
    const firstCloseGate = new Promise<void>((resolve) => { releaseFirstClose = resolve; });
    const browser = {
      Prepare: vi.fn(async ({ toolName, arguments: args }: any) => {
        taskId ??= `task-${++taskSequence}`;
        return Proposal(toolName, args);
      }),
      Execute: vi.fn(async () => ({ status: 'succeeded' as const, data: { clicked: true } })),
      GetBrowserTaskId: vi.fn(() => taskId ?? undefined),
      CloseTask: vi.fn(({ deadline }: { deadline: number }) => {
        const closingId = taskId;
        taskId = null;
        if (closingId === 'task-1') return firstCloseGate.then(() => ({
          status: 'status_unknown' as const, browserTaskId: closingId, code: 'BROWSER_COMMAND_TIMEOUT', closedTabs: 0, unknownTabs: 3,
        }));
        expect(deadline).toBeGreaterThan(Date.now());
        return Promise.resolve({ status: 'confirmed' as const, browserTaskId: closingId, closedTabs: 1, unknownTabs: 0 });
      }),
      GetStatus: vi.fn(async () => ({ engine: 'electron', state: 'stopped' })),
      ClearProfile: vi.fn(), ResetPageReferences: vi.fn(), Close: vi.fn(async () => undefined),
    };
    const { host, events, observability } = await CreateHost(provider, browser as any, {}, 50);

    await expect(Send(host, 'cleanup-unknown-1', '执行一次点击后结束')).resolves.toMatchObject({ accepted: true });
    const firstRelease = events.find((event) => event.type === 'run_released' && event.requestId === 'cleanup-unknown-1');
    expect(firstRelease?.cleanupOutcomes).toEqual([expect.objectContaining({
      status: 'status_unknown', browserTaskId: 'task-1', code: 'BROWSER_COMMAND_TIMEOUT', unknownTabs: null,
    })]);
    expect((host as any).browserRunId).toBeNull();
    expect([...((host as any).toolLedger.values())]).toContainEqual(expect.objectContaining({
      toolName: 'BrowserTaskCleanup', status: 'status_unknown', cleanupOutcome: expect.objectContaining({ browserTaskId: 'task-1' }),
    }));
    expect(observability.AppendTraceEvent).toHaveBeenCalledWith('cleanup-unknown-1', 'browser_task_cleanup', expect.objectContaining({ browserTaskId: 'task-1' }), 0);

    await expect(Send(host, 'cleanup-unknown-2', '开始独立的新任务')).resolves.toMatchObject({ accepted: true });
    expect(browser.Execute).toHaveBeenCalledTimes(2);
    expect(browser.Prepare).toHaveBeenCalledTimes(2);
    expect(browser.GetBrowserTaskId()).toBeUndefined();
    expect((host as any).browserRunId).toBeNull();
    expect(events).toContainEqual(expect.objectContaining({
      type: 'run_released', requestId: 'cleanup-unknown-2',
      cleanupOutcomes: [expect.objectContaining({ status: 'confirmed', browserTaskId: 'task-2', closedTabs: 1 })],
    }));
    // Completing the timed-out close has no path back to business actions or task 2.
    releaseFirstClose();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(browser.Execute).toHaveBeenCalledTimes(2);
    await host.Close();
  });

  it('模型失败终态也把 failed cleanup 写入 run_released 与账本', async () => {
    const provider = CreateProvider(() => { throw new Error('provider failed before browser work'); });
    const browser = {
      Prepare: vi.fn(), Execute: vi.fn(),
      CloseTask: vi.fn(async () => ({ status: 'failed' as const, browserTaskId: 'task-failed-cleanup', code: 'BROWSER_TASK_CLEANUP_FAILED', message: 'close failed', closedTabs: 0, unknownTabs: 1 })),
      GetStatus: vi.fn(async () => ({ engine: 'electron', state: 'stopped' })), ClearProfile: vi.fn(), ResetPageReferences: vi.fn(), Close: vi.fn(async () => undefined),
    };
    const { host, events } = await CreateHost(provider, browser as any);

    await expect(Send(host, 'cleanup-failed-run', '模型失败')).rejects.toThrow('provider failed before browser work');
    expect(events).toContainEqual(expect.objectContaining({
      type: 'run_released', requestId: 'cleanup-failed-run',
      cleanupOutcomes: [expect.objectContaining({ status: 'failed', browserTaskId: 'task-failed-cleanup', unknownTabs: 1 })],
    }));
    expect([...((host as any).toolLedger.values())]).toContainEqual(expect.objectContaining({
      toolName: 'BrowserTaskCleanup', status: 'failed', errorCode: 'BROWSER_TASK_CLEANUP_FAILED',
    }));
    expect((host as any).browserRunId).toBeNull();
    await host.Close();
  });

  it('旧会话 pending browser confirmation 在新 task 建立后 fail closed，当前 task 可正常确认续接', async () => {
    const provider = CreateProvider((index) => index < 2
      ? ToolCall(index, 'BrowserClick', { ref: '@e1', pageRevision: 1 })
      : { content: '已根据确认继续处理。', toolCalls: [] });
    let browserTaskId: string | null = null;
    let taskSequence = 0;
    const closedTasks: string[] = [];
    const browser = {
      Prepare: vi.fn(async ({ toolName, arguments: args }: any) => Proposal(toolName, args)),
      Execute: vi.fn(async () => ({ status: 'succeeded' as const, data: { clicked: true } })),
      GetBrowserTaskId: vi.fn(() => browserTaskId ?? undefined),
      CloseTask: vi.fn(async () => { if (browserTaskId) closedTasks.push(browserTaskId); browserTaskId = null; }),
      GetStatus: vi.fn(), ClearProfile: vi.fn(),
      ResetPageReferences: vi.fn(() => { if (!browserTaskId) browserTaskId = `task-${++taskSequence}`; }),
      Close: vi.fn(async () => undefined),
    };
    const { host, events } = await CreateHost(provider, browser as any);
    await host.Send({ requestId: 'session-a-confirm', sessionId: 'session-a', scenarioId: 'application', confirmationMode: 'always_confirm', content: '请准备一个需要确认的操作' });
    const confirmationA = events.find((event) => event.type === 'browser_confirmation' && event.requestId === 'session-a-confirm')?.confirmationId;
    expect(confirmationA).toBeTruthy();
    expect((host as any).pendingBrowserActions.get(confirmationA)).toMatchObject({ sessionId: 'session-a', browserTaskId: 'task-1' });

    await host.Send({ requestId: 'session-b-confirm', sessionId: 'session-b', scenarioId: 'application', confirmationMode: 'always_confirm', content: '在另一个会话准备新操作' });
    const confirmationB = events.find((event) => event.type === 'browser_confirmation' && event.requestId === 'session-b-confirm')?.confirmationId;
    expect(confirmationB).toBeTruthy();
    expect(closedTasks).toEqual(['task-1']);
    expect((host as any).pendingBrowserActions.get(confirmationB)).toMatchObject({ sessionId: 'session-b', browserTaskId: 'task-2' });

    await expect(host.ConfirmBrowserAction(confirmationA, true, { sessionId: 'session-a' })).rejects.toMatchObject({ code: 'BROWSER_CONFIRMATION_SESSION_MISMATCH' });
    expect(browser.Execute).not.toHaveBeenCalled();
    expect(browserTaskId).toBe('task-2');
    await expect(host.RespondToInteraction({ kind: 'approval', sessionId: 'session-b', requestId: 'session-b-confirm', interactionId: confirmationB, approved: true })).resolves.toMatchObject({ accepted: true });
    expect(browser.Execute).toHaveBeenCalledOnce();

    expect(events).toContainEqual(expect.objectContaining({ type: 'completed', requestId: 'session-b-confirm', content: expect.stringContaining('已根据确认继续处理') }));
    expect(closedTasks).toEqual(['task-1', 'task-2']);
    await host.Close();
  });

  it('切到 default 场景的另一会话也会收回旧 browser task 并拒绝其确认', async () => {
    const provider = CreateProvider((index) => index === 0
      ? ToolCall(index, 'BrowserClick', { ref: '@e1', pageRevision: 1 })
      : { content: 'default 会话已继续。', toolCalls: [] });
    let browserTaskId: string | null = null;
    const closedTasks: string[] = [];
    const browser = {
      Prepare: vi.fn(async ({ toolName, arguments: args }: any) => Proposal(toolName, args)),
      Execute: vi.fn(async () => ({ status: 'succeeded' as const, data: {} })),
      GetBrowserTaskId: vi.fn(() => browserTaskId ?? undefined),
      CloseTask: vi.fn(async () => { if (browserTaskId) closedTasks.push(browserTaskId); browserTaskId = null; }),
      GetStatus: vi.fn(), ClearProfile: vi.fn(), ResetPageReferences: vi.fn(() => { browserTaskId ??= 'task-a'; }),
      Close: vi.fn(async () => undefined),
    };
    const { host, events } = await CreateHost(provider, browser as any);
    await host.Send({ requestId: 'app-waiting', sessionId: 'app-session', scenarioId: 'application', confirmationMode: 'always_confirm', content: '准备浏览器操作' });
    const confirmationId = events.find((event) => event.type === 'browser_confirmation' && event.requestId === 'app-waiting')?.confirmationId;
    expect((host as any).pendingBrowserActions.get(confirmationId)).toMatchObject({ sessionId: 'app-session', browserTaskId: 'task-a' });

    await host.Send({ requestId: 'default-session-switch', sessionId: 'default-session', scenarioId: 'default', confirmationMode: 'always_confirm', content: '切换到普通会话' });
    expect(closedTasks).toEqual(['task-a']);
    await expect(host.ConfirmBrowserAction(confirmationId, true, { sessionId: 'app-session' })).rejects.toMatchObject({ code: 'BROWSER_CONFIRMATION_SESSION_MISMATCH' });
    expect(browser.Execute).not.toHaveBeenCalled();
    await host.Close();
  });

  it('确认后的 BrowserFillForm 使用完整 120 秒执行预算', async () => {
    const provider = CreateProvider(() => ({ content: 'unused', toolCalls: [] }));
    let receivedDeadline = 0;
    const browser = {
      Prepare: vi.fn(),
      Execute: vi.fn(async ({ deadline }: { deadline?: number }) => {
        receivedDeadline = deadline ?? 0;
        return { status: 'succeeded' as const, data: {} };
      }),
      GetStatus: vi.fn(), ClearProfile: vi.fn(), ResetPageReferences: vi.fn(), Close: vi.fn(async () => undefined),
    };
    const { host } = await CreateHost(provider, browser as any);
    const proposal = Proposal('BrowserFillForm', { planId: 'plan-1' });
    (host as any).pendingBrowserActions.set('fill-form-confirmation', {
      confirmationId: 'fill-form-confirmation', proposal, idempotencyKey: 'fill-form-idempotency',
      sessionId: 'failure-session', browserTaskId: null, requestId: 'fill-form-request', runId: 'fill-form-run', toolCallId: 'fill-form-tool', createdAt: Date.now(), bindingVersion: 1,
      binding: { sessionId: 'failure-session', browserTaskId: null, runId: 'fill-form-run', proposalId: proposal.proposalId, proposalHash: proposal.proposalHash, pageRevision: proposal.pageRevision },
    });
    const startedAt = Date.now();

    await expect(host.ConfirmBrowserAction('fill-form-confirmation', true, { sessionId: 'failure-session' })).resolves.toMatchObject({ status: 'succeeded' });
    expect(receivedDeadline).toBeGreaterThanOrEqual(startedAt + 119_900);
    expect(receivedDeadline).toBeLessThanOrEqual(Date.now() + 120_100);
    await host.Close();
  });

  it('确认后页面变化时拒绝旧 proposal，且不会产生成功回执', async () => {
    const provider = CreateProvider(() => ({ content: 'unused', toolCalls: [] }));
    const staleError = Object.assign(new Error('page changed'), { code: 'BROWSER_PROPOSAL_STALE' });
    const browser = {
      Prepare: vi.fn(), Execute: vi.fn(async () => { throw staleError; }), GetStatus: vi.fn(), ClearProfile: vi.fn(), ResetPageReferences: vi.fn(), Close: vi.fn(async () => undefined),
    };
    const { host, events } = await CreateHost(provider, browser as any);
    const proposal = Proposal('BrowserClick', { ref: '@e1', pageRevision: 1 });
    (host as any).pendingBrowserActions.set('stale-confirmation', {
      confirmationId: 'stale-confirmation', proposal, idempotencyKey: 'stale-idempotency', sessionId: 'failure-session', browserTaskId: null, requestId: 'stale-request', runId: 'stale-run', toolCallId: 'stale-tool', createdAt: Date.now(), bindingVersion: 1,
      binding: { sessionId: 'failure-session', browserTaskId: null, runId: 'stale-run', proposalId: proposal.proposalId, proposalHash: proposal.proposalHash, pageRevision: proposal.pageRevision, ref: '@e1' },
    });

    const result = await host.ConfirmBrowserAction('stale-confirmation', true, { sessionId: 'failure-session' });
    expect(result).toMatchObject({ status: 'failed', code: 'BROWSER_PROPOSAL_STALE' });
    expect(result.receipt).toBeUndefined();
    expect(events).toContainEqual(expect.objectContaining({ type: 'browser_action_completed', browserAction: expect.objectContaining({ status: 'failed', code: 'BROWSER_PROPOSAL_STALE' }) }));
    expect([...((host as any).toolLedger.values())]).toContainEqual(expect.objectContaining({ status: 'failed', errorCode: 'BROWSER_PROPOSAL_STALE' }));
    await host.Close();
  });

  it('InspectPendingBrowserAction 只使用显式 proposalId，hash-only pending fail closed', async () => {
    const provider = CreateProvider(() => ({ content: 'unused', toolCalls: [] }));
    const browser = {
      Prepare: vi.fn(), Execute: vi.fn(), GetStatus: vi.fn(), ClearProfile: vi.fn(), ResetPageReferences: vi.fn(), Close: vi.fn(async () => undefined),
    };
    const { host } = await CreateHost(provider, browser as any);
    const proposal = Proposal('BrowserClick', { ref: '@e1', pageRevision: 1 });
    (host as any).pendingBrowserActions.set('inspect-valid', {
      confirmationId: 'inspect-valid', proposal, idempotencyKey: 'inspect-valid-idempotency', sessionId: 'failure-session', browserTaskId: null,
      requestId: 'inspect-valid-request', runId: 'inspect-valid-run', toolCallId: 'inspect-valid-tool', createdAt: Date.now(), bindingVersion: 1,
      binding: { sessionId: 'failure-session', browserTaskId: null, runId: 'inspect-valid-run', proposalId: proposal.proposalId, proposalHash: proposal.proposalHash, pageRevision: proposal.pageRevision, ref: '@e1' },
    });
    expect(host.InspectPendingBrowserAction('inspect-valid')).toMatchObject({
      proposalId: proposal.proposalId,
      proposal: { proposalId: proposal.proposalId, proposalHash: proposal.proposalHash },
    });

    const hashOnlyProposal = { ...proposal, proposalId: undefined } as any;
    (host as any).pendingBrowserActions.set('inspect-hash-only', {
      confirmationId: 'inspect-hash-only', proposal: hashOnlyProposal, idempotencyKey: 'inspect-hash-only-idempotency', sessionId: 'failure-session', browserTaskId: null,
      requestId: 'inspect-hash-only-request', runId: 'inspect-hash-only-run', toolCallId: 'inspect-hash-only-tool', createdAt: Date.now(), bindingVersion: 1,
      binding: { sessionId: 'failure-session', browserTaskId: null, runId: 'inspect-hash-only-run', proposalId: undefined, proposalHash: proposal.proposalHash, pageRevision: proposal.pageRevision, ref: '@e1' },
    });
    expect(host.InspectPendingBrowserAction('inspect-hash-only')).toBeNull();
    await host.Close();
  });

  it('上传确认绑定 session/task/pageRevision/fileId，旧 revision 或不同文件 fail closed', async () => {
    const provider = CreateProvider(() => ({ content: 'unused', toolCalls: [] }));
    let pageRevision = 1;
    const browserTaskId = 'task-upload-binding';
    const browser = {
      Prepare: vi.fn(),
      Execute: vi.fn(async () => ({ status: 'succeeded' as const, data: { uploaded: true } })),
      GetBrowserTaskId: vi.fn(() => browserTaskId),
      GetStatus: vi.fn(async () => ({ pageRevision, currentUrl: 'https://example.test/application' })),
      ClearProfile: vi.fn(), ResetPageReferences: vi.fn(), Close: vi.fn(async () => undefined),
    };
    const { host } = await CreateHost(provider, browser as any);
    const proposal = Proposal('BrowserUploadFile', { ref: '@e1', pageRevision: 1, fileId: 'attachment://pb03/resume.pdf' });
    (host as any).pendingBrowserActions.set('upload-binding-stale', {
      confirmationId: 'upload-binding-stale', proposal, idempotencyKey: 'upload-stale', sessionId: 'failure-session', browserTaskId,
      requestId: 'upload-stale-request', runId: 'upload-stale-run', toolCallId: 'upload-stale-tool', createdAt: Date.now(), bindingVersion: 1,
      binding: { sessionId: 'failure-session', browserTaskId, runId: 'upload-stale-run', proposalId: proposal.proposalId, proposalHash: proposal.proposalHash, pageRevision: 1, ref: '@e1', fileId: 'attachment://pb03/resume.pdf' },
    });
    pageRevision = 2;
    await expect(host.ConfirmBrowserAction('upload-binding-stale', true, { sessionId: 'failure-session' }))
      .rejects.toMatchObject({ code: 'BROWSER_CONFIRMATION_STALE' });
    expect(browser.Execute).not.toHaveBeenCalled();

    pageRevision = 1;
    const wrongFile = { ...proposal, canonicalArguments: { ...proposal.canonicalArguments, fileId: 'attachment://pb03/other.pdf' } };
    (host as any).pendingBrowserActions.set('upload-binding-file', {
      confirmationId: 'upload-binding-file', proposal: wrongFile, idempotencyKey: 'upload-file', sessionId: 'failure-session', browserTaskId,
      requestId: 'upload-file-request', runId: 'upload-file-run', toolCallId: 'upload-file-tool', createdAt: Date.now(), bindingVersion: 1,
      binding: { sessionId: 'failure-session', browserTaskId, runId: 'upload-file-run', proposalId: wrongFile.proposalId, proposalHash: proposal.proposalHash, pageRevision: 1, ref: '@e1', fileId: 'attachment://pb03/resume.pdf' },
    });
    await expect(host.ConfirmBrowserAction('upload-binding-file', true, { sessionId: 'failure-session' }))
      .rejects.toMatchObject({ code: 'BROWSER_CONFIRMATION_BINDING_MISMATCH' });

    const valid = { ...proposal, proposalHash: 'upload-valid-hash' };
    (host as any).pendingBrowserActions.set('upload-binding-valid', {
      confirmationId: 'upload-binding-valid', proposal: valid, idempotencyKey: 'upload-valid', sessionId: 'failure-session', browserTaskId,
      requestId: 'upload-valid-request', runId: 'upload-valid-run', toolCallId: 'upload-valid-tool', createdAt: Date.now(), bindingVersion: 1,
      binding: { sessionId: 'failure-session', browserTaskId, runId: 'upload-valid-run', proposalId: valid.proposalId, proposalHash: 'upload-valid-hash', pageRevision: 1, ref: '@e1', fileId: 'attachment://pb03/resume.pdf' },
    });
    await expect(host.ConfirmBrowserAction('upload-binding-valid', true, { sessionId: 'failure-session' }))
      .resolves.toMatchObject({ status: 'succeeded' });
    expect(browser.Execute).toHaveBeenCalledOnce();
    await host.Close();
  });

  it('登录或验证码暂停后，新 Run 必须先 Snapshot 才能恢复', async () => {
    const provider = CreateProvider((index) => {
      if (index === 0) return ToolCall(index, 'BrowserNavigate', { url: 'https://example.test/verification' });
      if (index === 1 || index === 2) return ToolCall(index, 'BrowserSnapshot');
      return { content: '人工验证完成后已重新读取页面。', toolCalls: [] };
    });
    let snapshotCount = 0;
    let browserTaskId: string | null = 'task-verification';
    const browser = {
      Prepare: vi.fn(async ({ toolName, arguments: args }: any) => Proposal(toolName, args)),
      GetBrowserTaskId: vi.fn(() => browserTaskId ?? undefined),
      CloseTask: vi.fn(async () => { browserTaskId = null; }),
      Execute: vi.fn(async ({ proposal }: any) => {
        if (proposal.toolName !== 'BrowserSnapshot') return { status: 'succeeded' as const, data: { currentUrl: 'https://example.test/verification' } };
        snapshotCount += 1;
        return snapshotCount === 1
          ? { status: 'succeeded' as const, data: { snapshot: 'Password input CAPTCHA 人机验证', refs: { e1: { type: 'password' } }, pageRevision: 1 } }
          : { status: 'succeeded' as const, data: { snapshot: 'Verification completed', refs: {}, pageRevision: 2 } };
      }),
      GetStatus: vi.fn(), ClearProfile: vi.fn(), ResetPageReferences: vi.fn(), Close: vi.fn(async () => undefined),
    };
    const { host, events } = await CreateHost(provider, browser as any);

    await Send(host, 'verification-1', '打开验证页并继续');
    expect(events).toContainEqual(expect.objectContaining({ type: 'browser_user_action' }));
    expect(events).toContainEqual(expect.objectContaining({ type: 'waiting_user_input' }));
    expect(browser.CloseTask).not.toHaveBeenCalled();
    expect(browserTaskId).toBe('task-verification');
    expect(provider.getCallCount()).toBe(2);

    await Send(host, 'verification-2', '我已完成人工验证，继续任务');
    expect(provider.getCallCount()).toBe(4);
    expect(browser.ResetPageReferences).toHaveBeenCalledTimes(2);
    expect(browser.Execute.mock.calls.map(([input]: any[]) => input.proposal.toolName)).toEqual(['BrowserNavigate', 'BrowserSnapshot', 'BrowserSnapshot', 'BrowserSnapshot']);
    expect(events).toContainEqual(expect.objectContaining({ type: 'completed', content: expect.stringContaining('重新读取页面') }));
    expect(browser.CloseTask).toHaveBeenCalledOnce();
    expect(browserTaskId).toBeNull();
    await host.Close();
  });

  it('AskUserQuestion 等待态释放资源，结构化答案恢复同一 Run 且不添加 user 消息', async () => {
    const provider = CreateProvider((index) => index === 0
      ? ToolCall(index, 'AskUserQuestion', { questions: [{ id: 'choice', question: '请选择方案', options: ['方案 A', '方案 B'] }] })
      : { content: '已收到方案 A，继续执行。', toolCalls: [] });
    const browser = {
      Prepare: vi.fn(), Execute: vi.fn(), GetStatus: vi.fn(), ClearProfile: vi.fn(), ResetPageReferences: vi.fn(), Close: vi.fn(async () => undefined),
    };
    const { host, events } = await CreateHost(provider, browser as any);

    await Send(host, 'question-1', '需要选择时询问我');
    const waitingIndex = events.findIndex((event) => event.type === 'waiting_user_input' && event.requestId === 'question-1');
    const releasedIndex = events.findIndex((event) => event.type === 'run_released' && event.requestId === 'question-1');
    expect(waitingIndex).toBeGreaterThanOrEqual(0);
    expect(releasedIndex).toBeGreaterThan(waitingIndex);
    expect((host as any).browserRunId).toBeNull();

    const question = events.find((event) => event.type === 'question_requested');
    await host.RespondToInteraction({ kind: 'answer', sessionId: 'failure-session', requestId: 'question-1', interactionId: question.confirmationId, answers: { choice: '方案 A' } });
    expect(events).toContainEqual(expect.objectContaining({ type: 'completed', requestId: 'question-1', content: expect.stringContaining('继续执行') }));
    const history = (host as any).histories.get('failure-session');
    expect(history.filter((message: any) => message.role === 'user' && message.metadata?.source !== 'runtime')).toHaveLength(1);
    expect(history.find((message: any) => message.tool_call_id === 'failure-0')?.content).toContain('方案 A');
    expect((host as any).pendingQuestions.has('failure-session')).toBe(false);
    await host.Close();
  });

  it('外部动作 STATUS_UNKNOWN 后暂停且后续 Run 不自动重试', async () => {
    const provider = CreateProvider((index) => index === 0
      ? ToolCall(index, 'BrowserClick', { ref: '@e1', pageRevision: 1 })
      : { content: '提交结果未知，请先在目标网站核对，我不会自动重试。', toolCalls: [] });
    let browserTaskId: string | null = 'task-unknown';
    const browser = {
      Prepare: vi.fn(async ({ toolName, arguments: args }: any) => Proposal(toolName, args)),
      Execute: vi.fn(async () => ({ status: 'status_unknown' as const, data: { code: 'BROWSER_COMMAND_TIMEOUT' } })),
      GetBrowserTaskId: vi.fn(() => browserTaskId ?? undefined),
      CloseTask: vi.fn(async () => { browserTaskId = null; }),
      GetStatus: vi.fn(), ClearProfile: vi.fn(), ResetPageReferences: vi.fn(() => { browserTaskId ??= 'task-unknown'; }), Close: vi.fn(async () => undefined),
    };
    const { host, events } = await CreateHost(provider, browser as any);

    await Send(host, 'unknown-1', '提交申请');
    expect(events).toContainEqual(expect.objectContaining({ type: 'paused' }));
    expect(browser.CloseTask).not.toHaveBeenCalled();
    expect(browserTaskId).toBe('task-unknown');
    expect(browser.Execute).toHaveBeenCalledOnce();
    expect((host as any).histories.get('failure-session').at(-1).content).toContain('STATUS_UNKNOWN');

    await Send(host, 'unknown-2', '继续任务');
    expect(browser.Execute.mock.calls.map(([input]: any[]) => input.proposal.toolName)).toEqual(['BrowserClick', 'BrowserSnapshot']);
    expect(events).toContainEqual(expect.objectContaining({ type: 'completed', content: expect.stringContaining('不会自动重试') }));
    expect(browser.CloseTask).toHaveBeenCalledOnce();
    expect(browserTaskId).toBeNull();
    await host.Close();
  });
});
