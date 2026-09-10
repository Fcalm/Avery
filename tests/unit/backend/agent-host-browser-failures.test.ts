import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentHost } from '../../../apps/backend/src/electron/backend/agent-host';
import { CreateDefaultModules } from '../../../packages/agent-modules-defaults/src/index';
import type { BrowserActionProposal, BrowserAutomationPort, ModelCompletion } from '../../../packages/agent-sdk/src/index';

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
    proposalHash: `${toolName}:${JSON.stringify(canonicalArguments)}`, toolName, canonicalArguments,
    summary: toolName, risk: toolName === 'BrowserClick' ? 'medium' : 'low', forceConfirmation: false,
    pageRevision: 1, url: 'https://example.test/jobs', resourceIds: ['browser:test'],
  };
}

async function CreateHost(provider: ReturnType<typeof CreateProvider>, browser: BrowserAutomationPort & { Close(): Promise<void> }, storedSettings: Record<string, unknown> = {}) {
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
    RevokeCronTaskBrowserAuthorization: vi.fn(async (id: string) => ({ id, browserAuthorized: false })),
    ReadCronTask: vi.fn(async (input: { cronTaskId?: string }) => input.cronTaskId
      ? { task: { id: input.cronTaskId, title: '工作日投递', scenarioId: 'application', state: 'active', nextRunAt: Date.now() + 60_000, browserAuthorized: true } }
      : { tasks: [{ id: 'cron-1', title: '工作日投递', scenarioId: 'application', state: 'active', nextRunAt: Date.now() + 60_000, browserAuthorized: true }] }),
  };
  const host = new AgentHost({
    userDataPath: join(root, 'user-data'), workspacePath: root, Emit: (event) => events.push(event), browserRuntime: browser as any,
    observability, credentialPort: { Load: vi.fn(async () => null), Save: vi.fn() },
    business,
    createDefaultModules: (ports) => ({ ...CreateDefaultModules(ports), modelProvider: provider }),
  });
  return { host, events, business };
}

function Send(host: AgentHost, requestId: string, content: string) {
  return host.Send({ requestId, sessionId: 'failure-session', scenarioId: 'application', confirmationMode: 'fully_trusted', content });
}

describe('AgentHost 浏览器失败与用户接管', () => {
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
    expect(business.CreateCronTask).toHaveBeenCalledWith(input, { browserAuthorized: true });
    await host.Close();
  });

  it('测评取消贯穿确认后的浏览器执行，迟到结果只能记为状态未知', async () => {
    const provider = CreateProvider(() => ({ content: 'unused', toolCalls: [] }));
    let release!: () => void;
    const browser = {
      Prepare: vi.fn(), Execute: vi.fn(async () => { await new Promise<void>((resolve) => { release = resolve; }); return { status: 'succeeded' as const, data: {} }; }),
      GetStatus: vi.fn(), ClearProfile: vi.fn(), ResetPageReferences: vi.fn(), Close: vi.fn(async () => undefined),
    };
    const { host } = await CreateHost(provider, browser as any);
    const proposal = Proposal('BrowserClick', { ref: '@e1', pageRevision: 1 });
    (host as any).pendingBrowserActions.set('cancel-confirmation', {
      confirmationId: 'cancel-confirmation', proposal, idempotencyKey: 'cancel-idempotency', requestId: 'cancel-request', runId: 'cancel-run', toolCallId: 'cancel-tool', createdAt: Date.now(),
    });
    const controller = new AbortController();
    const pending = host.ConfirmBrowserAction('cancel-confirmation', true, { signal: controller.signal });
    while (!release) await new Promise((resolve) => setTimeout(resolve, 1));
    controller.abort(); release();
    await expect(pending).resolves.toMatchObject({ status: 'status_unknown', code: 'CANCELLED' });
    expect(browser.Execute).toHaveBeenCalledWith(expect.objectContaining({ signal: controller.signal }));
    expect([...((host as any).toolLedger.values())]).toContainEqual(expect.objectContaining({ status: 'status_unknown', errorCode: 'CANCELLED' }));
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
      requestId: 'fill-form-request', runId: 'fill-form-run', toolCallId: 'fill-form-tool', createdAt: Date.now(),
    });
    const startedAt = Date.now();

    await expect(host.ConfirmBrowserAction('fill-form-confirmation', true)).resolves.toMatchObject({ status: 'succeeded' });
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
      confirmationId: 'stale-confirmation', proposal, idempotencyKey: 'stale-idempotency', requestId: 'stale-request', runId: 'stale-run', toolCallId: 'stale-tool', createdAt: Date.now(),
    });

    const result = await host.ConfirmBrowserAction('stale-confirmation', true);
    expect(result).toMatchObject({ status: 'failed', code: 'BROWSER_PROPOSAL_STALE' });
    expect(result.receipt).toBeUndefined();
    expect(events).toContainEqual(expect.objectContaining({ type: 'browser_action_completed', browserAction: expect.objectContaining({ status: 'failed', code: 'BROWSER_PROPOSAL_STALE' }) }));
    expect([...((host as any).toolLedger.values())]).toContainEqual(expect.objectContaining({ status: 'failed', errorCode: 'BROWSER_PROPOSAL_STALE' }));
    await host.Close();
  });

  it('登录或验证码暂停后，新 Run 必须先 Snapshot 才能恢复', async () => {
    const provider = CreateProvider((index) => {
      if (index === 0) return ToolCall(index, 'BrowserNavigate', { url: 'https://example.test/verification' });
      if (index === 1 || index === 2) return ToolCall(index, 'BrowserSnapshot');
      return { content: '人工验证完成后已重新读取页面。', toolCalls: [] };
    });
    let snapshotCount = 0;
    const browser = {
      Prepare: vi.fn(async ({ toolName, arguments: args }: any) => Proposal(toolName, args)),
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
    expect(provider.getCallCount()).toBe(2);

    await Send(host, 'verification-2', '我已完成人工验证，继续任务');
    expect(provider.getCallCount()).toBe(4);
    expect(browser.ResetPageReferences).toHaveBeenCalledTimes(2);
    expect(browser.Execute.mock.calls.map(([input]: any[]) => input.proposal.toolName)).toEqual(['BrowserNavigate', 'BrowserSnapshot', 'BrowserSnapshot']);
    expect(events).toContainEqual(expect.objectContaining({ type: 'completed', content: expect.stringContaining('重新读取页面') }));
    await host.Close();
  });

  it('外部动作 STATUS_UNKNOWN 后暂停且后续 Run 不自动重试', async () => {
    const provider = CreateProvider((index) => index === 0
      ? ToolCall(index, 'BrowserClick', { ref: '@e1', pageRevision: 1 })
      : { content: '提交结果未知，请先在目标网站核对，我不会自动重试。', toolCalls: [] });
    const browser = {
      Prepare: vi.fn(async ({ toolName, arguments: args }: any) => Proposal(toolName, args)),
      Execute: vi.fn(async () => ({ status: 'status_unknown' as const, data: { code: 'BROWSER_COMMAND_TIMEOUT' } })),
      GetStatus: vi.fn(), ClearProfile: vi.fn(), ResetPageReferences: vi.fn(), Close: vi.fn(async () => undefined),
    };
    const { host, events } = await CreateHost(provider, browser as any);

    await Send(host, 'unknown-1', '提交申请');
    expect(events).toContainEqual(expect.objectContaining({ type: 'paused' }));
    expect(browser.Execute).toHaveBeenCalledOnce();
    expect((host as any).histories.get('failure-session').at(-1).content).toContain('STATUS_UNKNOWN');

    await Send(host, 'unknown-2', '继续任务');
    expect(browser.Execute).toHaveBeenCalledOnce();
    expect(events).toContainEqual(expect.objectContaining({ type: 'completed', content: expect.stringContaining('不会自动重试') }));
    await host.Close();
  });
});
