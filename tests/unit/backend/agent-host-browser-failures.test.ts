import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentHost } from '../../../apps/backend/src/electron/backend/agent-host';
import { CreateDefaultModules } from '../../../packages/agent-modules-defaults/src/index';
import type { BrowserActionProposal, BrowserAutomationPort, ModelCompletion } from '../../../packages/agent-sdk/src/index';
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
    expect(host.Cancel('late-completion-cancel')).toEqual({ cancelled: true });
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
    await expect(host.ConfirmBrowserAction(confirmationB, true, { sessionId: 'session-b' })).resolves.toMatchObject({ status: 'succeeded' });
    expect(browser.Execute).toHaveBeenCalledOnce();

    // Renderer uses the same visible continuation path as AskUserQuestion after confirmation succeeds.
    await host.Send({ requestId: 'session-b-continuation', sessionId: 'session-b', scenarioId: 'application', confirmationMode: 'always_confirm', content: '我已确认上述浏览器操作，操作已执行成功。请重新读取当前页面状态并继续任务。' });
    expect(events).toContainEqual(expect.objectContaining({ type: 'completed', requestId: 'session-b-continuation', content: expect.stringContaining('已根据确认继续处理') }));
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
    expect(browser.Execute.mock.calls.map(([input]: any[]) => input.proposal.toolName)).toEqual(['BrowserNavigate', 'BrowserSnapshot', 'BrowserSnapshot']);
    expect(events).toContainEqual(expect.objectContaining({ type: 'completed', content: expect.stringContaining('重新读取页面') }));
    expect(browser.CloseTask).toHaveBeenCalledOnce();
    expect(browserTaskId).toBeNull();
    await host.Close();
  });

  it('AskUserQuestion 等待态之后释放 Host 运行资源，答案可以进入同一会话的新 Run', async () => {
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

    await Send(host, 'question-2', '【请选择方案】方案 A');
    expect(events).toContainEqual(expect.objectContaining({ type: 'completed', requestId: 'question-2', content: expect.stringContaining('继续执行') }));
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
    expect(browser.Execute).toHaveBeenCalledOnce();
    expect(events).toContainEqual(expect.objectContaining({ type: 'completed', content: expect.stringContaining('不会自动重试') }));
    expect(browser.CloseTask).toHaveBeenCalledOnce();
    expect(browserTaskId).toBeNull();
    await host.Close();
  });
});
