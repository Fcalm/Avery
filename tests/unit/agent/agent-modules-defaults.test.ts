import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentMessage, ReasoningEffort, ToolLedgerEntry, ToolReceipt } from '../../../packages/agent-sdk/src/index';
import { CreateCompactionModule, SplitTurnGroups } from '../../../packages/agent-modules-defaults/src/compaction';
import { CreateContextBuilderModule } from '../../../packages/agent-modules-defaults/src/context';
import { CreateInteractionModule } from '../../../packages/agent-modules-defaults/src/interaction';
import { CreateObservabilityModule } from '../../../packages/agent-modules-defaults/src/observability';
import { ApplicationScenario, ApplicationScenarioPlaceholder, BuildApplicationCompiledInstructions, BuildDefaultCompiledInstructions, BuildDefaultPromptFragments, DefaultScenario } from '../../../packages/agent-modules-defaults/src/prompts';
import { CreateToolsModule } from '../../../packages/agent-modules-defaults/src/tools';
import type { AgentDefaultPorts } from '../../../packages/agent-modules-defaults/src/ports';
import { CreateRegisteredTool, CreateToolContext } from './test-helpers';

function CreatePorts(overrides: Partial<AgentDefaultPorts> = {}): AgentDefaultPorts {
  return {
    getConfig: vi.fn(async () => null),
    saveConfig: vi.fn(async () => undefined),
    getStoredSettings: vi.fn(async () => ({})),
    ...overrides,
  };
}

function SseResponse(lines: unknown[]): Response {
  const body = lines.map((line) => line === '[DONE]' ? 'data: [DONE]\n\n' : `data: ${typeof line === 'string' ? line : JSON.stringify(line)}\n\n`).join('');
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('agent-modules-defaults', () => {
  it('上下文自动限制默认 256K，并在模型能力更小时取模型上限', async () => {
    const { DefaultContextLimit, ResolveContextLimit, ResolveDeepSeekReasoningEffort } = await import('../../../packages/agent-modules-defaults/src/provider');

    expect(DefaultContextLimit).toBe(256_000);
    expect(ResolveContextLimit({ mode: 'default' })).toBe(256_000);
    expect(ResolveContextLimit({ mode: 'default', modelMaximum: 128_000 })).toBe(128_000);
    expect(ResolveContextLimit({ mode: 'default', modelMaximum: 1_000_000 })).toBe(256_000);
    const efforts: ReasoningEffort[] = ['low', 'medium', 'high', 'xhigh', 'max'];
    expect(efforts.map(ResolveDeepSeekReasoningEffort))
      .toEqual(['low', 'high', 'high', 'high', 'max']);
  });

  it('Provider 保存自定义上下文限制，并拒绝超过已知模型上限的值', async () => {
    let persisted: any = null;
    const saveConfig = vi.fn(async () => undefined);
    const { CreateProviderModule } = await import('../../../packages/agent-modules-defaults/src/provider');
    const provider = CreateProviderModule(CreatePorts({ saveConfig }));

    await provider.Configure({
      provider: 'DeepSeek', model: 'deepseek-v4-flash', apiKey: 'test-key', thinkingEnabled: false,
      contextLimitMode: 'custom', contextLength: '128K', compressionThreshold: 80,
    });

    expect(provider.GetRuntimeLimits()).toEqual({ contextLimit: 128_000, threshold: 80 });
    await expect(provider.GetStatus()).resolves.toMatchObject({
      provider: 'DeepSeek', model: 'deepseek-v4-flash', contextLimit: 128_000, contextLimitMode: 'custom', compressionThreshold: 80,
    });
    expect(saveConfig).toHaveBeenCalledWith(expect.objectContaining({ contextLimit: 128_000, contextLimitMode: 'custom' }));
    persisted = saveConfig.mock.calls[0][0];
    const reloaded = CreateProviderModule(CreatePorts({ getConfig: vi.fn(async () => persisted) }));
    await expect(reloaded.GetStatus()).resolves.toMatchObject({ contextLimit: 128_000, contextLimitMode: 'custom' });
    await expect(provider.Configure({
      provider: 'DeepSeek', model: 'deepseek-v4-flash', apiKey: 'test-key', thinkingEnabled: false,
      contextLimitMode: 'custom', contextLength: '1001K', compressionThreshold: 80,
    })).rejects.toThrow(/不能超过当前模型/);
  });

  it('旧 DeepSeek 64K 配置迁移为自动 256K，旧自定义 Provider 保留原限制', async () => {
    const { CreateProviderModule } = await import('../../../packages/agent-modules-defaults/src/provider');
    const legacyDeepSeek = CreateProviderModule(CreatePorts({
      getConfig: vi.fn(async () => ({ provider: 'DeepSeek', baseUrl: 'https://api.deepseek.com', model: 'deepseek-v4-flash', thinkingEnabled: false, contextLimit: 64_000, compressionThreshold: 80, apiKey: 'test-key' })),
    }));
    const legacyCustom = CreateProviderModule(CreatePorts({
      getConfig: vi.fn(async () => ({ provider: '自定义', baseUrl: 'https://example.com/v1', model: 'custom-model', thinkingEnabled: false, contextLimit: 96_000, compressionThreshold: 80, apiKey: 'test-key' })),
    }));

    await legacyDeepSeek.GetStatus();
    await legacyCustom.GetStatus();

    expect(legacyDeepSeek.GetRuntimeLimits().contextLimit).toBe(256_000);
    expect(legacyCustom.GetRuntimeLimits().contextLimit).toBe(96_000);
  });

  it('Z.AI 配置固定使用官方端点与 glm-5.3-flash，并加密持久化用户 Key', async () => {
    const saveConfig = vi.fn(async () => undefined);
    const { CreateProviderModule, DefaultZaiBaseUrl, GlmFlashModel } = await import('../../../packages/agent-modules-defaults/src/provider');
    const provider = CreateProviderModule(CreatePorts({ saveConfig }));

    expect(DefaultZaiBaseUrl).toBe('https://open.bigmodel.cn/api/paas/v4');

    await provider.Configure({
      provider: 'Z.AI', model: '被忽略的模型', baseUrl: 'https://untrusted.example/v1', apiKey: 'zai-user-key', thinkingEnabled: false,
      contextLimitMode: 'default', contextLength: '64K', compressionThreshold: 80,
    });

    await expect(provider.GetStatus()).resolves.toMatchObject({
      provider: 'Z.AI', model: GlmFlashModel, baseUrl: DefaultZaiBaseUrl, contextLimit: 256_000,
    });
    expect(saveConfig).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'Z.AI', model: GlmFlashModel, baseUrl: DefaultZaiBaseUrl, apiKey: 'zai-user-key', thinkingEnabled: true,
    }));
    await expect(provider.GetModels()).resolves.toEqual({ models: [GlmFlashModel] });
  });

  it('加载旧 GLM 配置时自动从国际站迁移到智谱中国区端点', async () => {
    const { CreateProviderModule, DefaultZaiBaseUrl } = await import('../../../packages/agent-modules-defaults/src/provider');
    const provider = CreateProviderModule(CreatePorts({
      getConfig: vi.fn(async () => ({ provider: 'Z.AI', baseUrl: 'https://api.z.ai/api/paas/v4', model: 'glm-5.3-flash', thinkingEnabled: true, contextLimit: 256_000, contextLimitMode: 'default', compressionThreshold: 80, apiKey: 'bigmodel-key' })),
    }));

    await expect(provider.GetStatus()).resolves.toMatchObject({ provider: 'Z.AI', baseUrl: DefaultZaiBaseUrl, model: 'glm-5.3-flash' });
  });

  it('切换到 Z.AI 时不复用其他供应商已保存的 API Key', async () => {
    const { CreateProviderModule } = await import('../../../packages/agent-modules-defaults/src/provider');
    const provider = CreateProviderModule(CreatePorts({
      getConfig: vi.fn(async () => ({ provider: 'DeepSeek', baseUrl: 'https://api.deepseek.com', model: 'deepseek-v4-flash', thinkingEnabled: true, contextLimit: 256_000, contextLimitMode: 'default', compressionThreshold: 80, apiKey: 'deepseek-key' })),
    }));

    await expect(provider.Configure({ provider: 'Z.AI', apiKey: '', contextLimitMode: 'default', compressionThreshold: 80 }))
      .rejects.toThrow(/API Key is required/);
  });

  it('Z.AI 连接测试使用 Chat Completion，不依赖未声明的 models 接口', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => new Response(JSON.stringify({ choices: [{ message: { content: 'OK' } }] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    vi.resetModules();
    const { CreateProviderModule, DefaultZaiBaseUrl, GlmFlashModel } = await import('../../../packages/agent-modules-defaults/src/provider');
    const provider = CreateProviderModule(CreatePorts());

    await expect(provider.TestConnection({ provider: 'Z.AI', apiKey: 'zai-user-key', model: '', baseUrl: '', contextLimitMode: 'default' }))
      .resolves.toEqual({ connected: true, provider: 'Z.AI', baseUrl: DefaultZaiBaseUrl });

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][0]).toBe(`${DefaultZaiBaseUrl}/chat/completions`);
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toMatchObject({
      model: GlmFlashModel, stream: false, max_tokens: 1, thinking: { type: 'enabled' },
    });
  });

  it('默认场景暴露 18 个 PascalCase 本地工具，网络与投递能力不混入白名单', () => {
    const tools = CreateToolsModule(CreatePorts()).GetToolDefinitions();
    const names = tools.map((tool) => tool.definition.function.name);

    expect(new Set(names)).toEqual(new Set(DefaultScenario.toolNames));
    expect(names).toHaveLength(18);
    expect(names).toContain('DeleteTodo');
    expect(names.every((name) => /^[A-Z][A-Za-z0-9]{0,63}$/.test(name))).toBe(true);
    expect(names).not.toEqual(expect.arrayContaining(['SearchJobs', 'ReadUrl', 'Shell', 'Browser', 'SubmitApplication']));
    expect(DefaultScenario.budgets?.maxModelTurns).toBe(30);
    expect(ApplicationScenarioPlaceholder.budgets?.maxModelTurns).toBe(100);
    expect(ApplicationScenarioPlaceholder.enabled).toBe(true);
    const applicationNames = CreateToolsModule(CreatePorts()).GetToolDefinitions('application').map((tool) => tool.definition.function.name);
    expect(new Set(applicationNames)).toEqual(new Set(ApplicationScenario.toolNames));
    expect(applicationNames).toHaveLength(30);
    expect(applicationNames).toContain('DeleteTodo');
    expect(applicationNames).toEqual(expect.arrayContaining(['CreateCronTask', 'ReadCronTask', 'UpdateCronTask', 'DeleteCronTask', 'ReadApplicationStatus', 'UpdateApplicationStatus']));
    expect(applicationNames).not.toEqual(expect.arrayContaining(['CreateResume', 'UpdateResume', 'UpdateProfile', 'SearchJobs']));
    const instructions = BuildApplicationCompiledInstructions('application-tools');
    expect(instructions.compiled).toContain('BrowserSelect');
    expect(instructions.compiled).toContain('invalidate all refs');
    expect(instructions.compiled).toContain('next Run must also start browser work with a fresh BrowserSnapshot');
    expect(instructions.compiled).toContain('exact attachment path shown in runtime-context');
    expect(instructions.compiled).toContain('last and only browser action');
    expect(instructions.compiled).toContain('ReadApplicationStatus');
    const applicationDefinitions = CreateToolsModule(CreatePorts()).GetToolDefinitions('application');
    expect(applicationDefinitions.find((tool) => tool.definition.function.name === 'BrowserWait')?.definition.function.description).toContain('domcontentloaded');
    expect(applicationDefinitions.find((tool) => tool.definition.function.name === 'BrowserUploadFile')?.definition.function.description).toContain('attachment path exposed in runtime-context');
    const fillForm = applicationDefinitions.find((tool) => tool.definition.function.name === 'BrowserFillForm');
    expect(fillForm?.definition.function.description).toContain('1 to 30 ordinary input fields');
    expect((fillForm?.definition.function.parameters.properties?.fields as { maxItems?: number })?.maxItems).toBe(30);
    expect(names).not.toContain('BrowserFillForm');
  });

  it('工具模块拒绝直接猜测未启用的网络工具名', async () => {
    const search = vi.fn(async () => ({ items: [], hasMore: false }));
    const context = CreateToolContext({
      ports: { ...CreateToolContext().ports, jobSearch: { Search: search } },
    });

    const result = await CreateToolsModule(CreatePorts()).ExecuteToolCall({
      id: 'search-1', type: 'function', function: { name: 'SearchJobs', arguments: '{"query":"agent"}' },
    }, context);

    expect(search).not.toHaveBeenCalled();
    expect(JSON.parse(result.content)).toMatchObject({ ok: false, code: 'TOOL_NOT_ALLOWED' });
  });

  it('BrowserFillForm 只在投递场景接受非空字段并复用浏览器执行端口', async () => {
    const prepare = vi.fn(async ({ toolName, arguments: args }: any) => ({
      proposalHash: 'fill-form-hash', toolName, canonicalArguments: args, summary: '填写 2 个输入框', risk: 'medium' as const,
      forceConfirmation: false, pageRevision: 3, resourceIds: ['browser:offerget-default'],
    }));
    const execute = vi.fn(async () => ({ status: 'succeeded' as const, data: { filledCount: 2, pageRevision: 3 } }));
    const applicationContext = CreateToolContext({
      scenarioId: 'application', confirmationMode: 'fully_trusted',
      ports: { ...CreateToolContext().ports, browser: { Prepare: prepare, Execute: execute } },
    });
    const defaultContext = CreateToolContext({
      scenarioId: 'default',
      ports: { ...CreateToolContext().ports, browser: { Prepare: prepare, Execute: execute } },
    });
    const module = CreateToolsModule(CreatePorts());
    const call = {
      id: 'fill-form-1', type: 'function' as const,
      function: { name: 'BrowserFillForm', arguments: JSON.stringify({ pageRevision: 3, fields: [{ ref: '@e1', text: '张三' }, { ref: '@e2', text: 'x@example.com' }] }) },
    };

    const denied = await module.ExecuteToolCall(call, defaultContext);
    const empty = await module.ExecuteToolCall({ ...call, id: 'fill-form-empty', function: { ...call.function, arguments: JSON.stringify({ pageRevision: 3, fields: [] }) } }, applicationContext);
    const succeeded = await module.ExecuteToolCall(call, applicationContext);

    expect(JSON.parse(denied.content)).toMatchObject({ ok: false, code: 'TOOL_NOT_ALLOWED' });
    expect(JSON.parse(empty.content)).toMatchObject({ ok: false, code: 'INVALID_TOOL_ARGUMENTS' });
    expect(prepare).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledOnce();
    expect(JSON.parse(succeeded.content)).toMatchObject({ ok: true, data: { filledCount: 2, pageRevision: 3 } });
  });

  it('定时投递缺少授权附件时转为人工接管，不尝试绕过上传授权', async () => {
    const prepare = vi.fn();
    const context = CreateToolContext({
      scenarioId: 'application', unattended: true, attachments: [],
      ports: { ...CreateToolContext().ports, browser: { Prepare: prepare, Execute: vi.fn() } },
    });

    const result = await CreateToolsModule(CreatePorts()).ExecuteToolCall({
      id: 'scheduled-upload-1', type: 'function',
      function: { name: 'BrowserUploadFile', arguments: JSON.stringify({ ref: '@e1', pageRevision: 1, fileId: 'D:\\\\resume.pdf' }) },
    }, context);

    expect(prepare).not.toHaveBeenCalled();
    expect(JSON.parse(result.content)).toMatchObject({ ok: false, code: 'BROWSER_FILE_NOT_AUTHORIZED' });
    expect(result.disposition).toBe('wait_user_input');
    expect(context.emit).toHaveBeenCalledWith(expect.objectContaining({ type: 'browser_user_action' }));
  });

  it('投递防重读取把目标公司、岗位和 URL 传给持久化检索端口', async () => {
    const read = vi.fn(async () => ({ jobs: [], applications: [], truncated: false }));
    const context = CreateToolContext({
      scenarioId: 'application',
      ports: { ...CreateToolContext().ports, applicationTracking: { Read: read, Update: vi.fn() } },
    });

    const result = await CreateToolsModule(CreatePorts()).ExecuteToolCall({
      id: 'read-application-1', type: 'function',
      function: { name: 'ReadApplicationStatus', arguments: JSON.stringify({ company: '示例科技', title: 'Agent 工程师', url: 'https://jobs.example.com/42' }) },
    }, context);

    expect(read).toHaveBeenCalledWith({ company: '示例科技', title: 'Agent 工程师', url: 'https://jobs.example.com/42' });
    expect(JSON.parse(result.content)).toMatchObject({ ok: true, truncated: false });
  });

  it('LoadSkill 返回匹配的 tool result 与独立 user 正文，并在主 Skill 未加载时拒绝资源', async () => {
    const skillMessage: AgentMessage = {
      role: 'user', content: '<loaded-skill id="ResumeTailoring">body</loaded-skill>',
      metadata: { source: 'runtime', visibility: 'hidden', kind: 'loaded_skill', skillId: 'ResumeTailoring', skillVersion: '1.0.0' },
    };
    const load = vi.fn(async () => ({ skillId: 'ResumeTailoring', skillVersion: '1.0.0', message: skillMessage }));
    const context = CreateToolContext({
      ports: { ...CreateToolContext().ports, skill: { Load: load } },
      loadedSkills: new Map(), loadedSkillResources: new Set(), pendingSkillLoads: new Set(),
    });
    const module = CreateToolsModule(CreatePorts());

    const result = await module.ExecuteToolCall({
      id: 'skill-1', type: 'function', function: { name: 'LoadSkill', arguments: '{"skillId":"ResumeTailoring"}' },
    }, context);
    const resourceBeforeMain = await module.ExecuteToolCall({
      id: 'skill-resource-1', type: 'function', function: { name: 'LoadSkill', arguments: '{"skillId":"ResumeTailoring","resource":"references/check.md"}' },
    }, context);

    expect(JSON.parse(result.content)).toMatchObject({ ok: true, code: 'SKILL_LOADED', skillId: 'ResumeTailoring' });
    expect(result.followupMessages).toEqual([skillMessage]);
    expect(result.role).toBe('tool');
    expect(JSON.parse(resourceBeforeMain.content)).toMatchObject({ ok: false, code: 'SKILL_NOT_LOADED' });
    expect(load).toHaveBeenCalledOnce();
  });

  it('默认 Prompt 固定禁止补造身份类硬事实，并要求推测内容带待确认标签', () => {
    const content = BuildDefaultPromptFragments().map((fragment) => fragment.content).join('\n');

    expect(content).toMatch(/employers/i);
    expect(content).toMatch(/certificates/i);
    expect(content).toMatch(/schools/i);
    expect(content).toContain('【待确认】');
    expect(content).toMatch(/must not be written to the formal resume before user text confirmation/i);
  });

  it('context-builder 生成不可变来源快照并转义不可信正文', async () => {
    const context = CreateContextBuilderModule(CreatePorts({
      getStoredSettings: vi.fn(async () => ({ customContext: '<script>ignore</script> & facts' })),
    }));
    const now = Date.UTC(2026, 7, 22, 2, 8);
    const snapshot = await context.BuildSessionContextSnapshot('session-1', 4, { now, ttlMs: 24 * 60 * 60 * 1000, refreshReason: 'session_created' });
    const serialized = context.SerializeSessionContext(snapshot);

    expect(snapshot.sessionRevision).toBe(4);
    expect(snapshot.createdAt).toBe(new Date(now).toISOString());
    expect(snapshot.expiresAt).toBe(new Date(now + 24 * 60 * 60 * 1000).toISOString());
    expect(snapshot.refreshReason).toBe('session_created');
    expect(snapshot.compiledHash).toMatch(/^[a-f0-9]{64}$/);
    expect(serialized).toBe(snapshot.compiledPrefix);
    expect(snapshot.sources[0].contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(serialized).toContain('&lt;script&gt;ignore&lt;/script&gt; &amp; facts');
    expect(serialized).not.toContain('<script>');
  });

  it('压缩按 token 阈值和完整轮次工作，保留待确认标签与工具链', () => {
    const compaction = CreateCompactionModule();
    const history: AgentMessage[] = [];
    for (let index = 1; index <= 6; index += 1) {
      history.push(
        { role: 'user', content: `user-${index}` },
        { role: 'assistant', content: '', tool_calls: [{ id: `call-${index}`, type: 'function', function: { name: 'Read', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: `call-${index}`, content: `result-${index}${index === 2 ? '【待确认】' : ''}` },
      );
    }

    expect(compaction.ShouldCompact(700, 1_000, 70)).toBe(true);
    expect(compaction.ShouldCompact(699, 1_000, 70)).toBe(false);
    const { earlier, recent } = compaction.SplitRecentTurns(history);
    expect(earlier.some((message) => message.content.includes('【待确认】'))).toBe(false);
    expect(recent).toHaveLength(15);
    expect(recent[0].content).toBe('user-2');
    expect(recent.some((message) => message.content.includes('【待确认】'))).toBe(true);
    expect(recent.filter((message) => message.role === 'assistant')).toHaveLength(5);
    expect(recent.filter((message) => message.role === 'tool')).toHaveLength(5);
  });

  it('压缩不把 Skill 合成消息当用户轮次，并固定保留最新索引与已加载正文', () => {
    const compaction = CreateCompactionModule();
    const index: AgentMessage = {
      role: 'user', content: '<skill-index>index</skill-index>',
      metadata: { source: 'runtime', visibility: 'hidden', kind: 'skill_index', snapshotId: 'snapshot-1', sessionRevision: 1 },
    };
    const loaded: AgentMessage = {
      role: 'user', content: '<loaded-skill>body</loaded-skill>',
      metadata: { source: 'runtime', visibility: 'hidden', kind: 'loaded_skill', skillId: 'ResumeTailoring', skillVersion: '1.0.0' },
    };
    const history: AgentMessage[] = [index];
    for (let turn = 1; turn <= 7; turn += 1) history.push({ role: 'user', content: `user-${turn}` }, { role: 'assistant', content: `answer-${turn}` });
    history.splice(5, 0, loaded);

    expect(SplitTurnGroups(history)).toHaveLength(7);
    const { earlier, recent } = compaction.SplitRecentTurns(history);

    expect(earlier).not.toContain(index);
    expect(earlier).not.toContain(loaded);
    expect(recent.slice(0, 2)).toEqual([index, loaded]);
    expect(recent.filter((message) => message.role === 'user' && message.metadata?.source !== 'runtime')).toHaveLength(5);
  });

  it('确认阶段重新加锁并校验冻结 revision，等待期间不持锁', async () => {
    const acquire = vi.fn(async () => ({ acquired: true as const, lock: { resumeId: 'resume-1', owner: 'agent' as const, ownerId: 'owner-1', acquiredAt: 1, leaseExpiresAt: 2 } }));
    const release = vi.fn(async () => undefined);
    const save = vi.fn(async () => ({ id: 'resume-1', revision: 8 }));
    const context = CreateToolContext({
      confirmationMode: 'always_confirm',
      resumeSnapshot: { id: 'resume-1', name: '简历', content: '旧内容', updatedAt: '', revision: 7 },
      ports: {
        ...CreateToolContext().ports,
        resumeWrite: { AcquireLock: acquire, ReleaseLock: release, Save: save },
      },
    });
    context.pendingEdits.set('confirmation-1', {
      kind: 'edit', resumeId: 'resume-1', content: '新内容', reason: '优化', baseRevision: 7,
      ownerId: 'owner-1', proposalHash: 'hash-1', canonicalArguments: {}, idempotencyKey: 'idem-1',
      resume: context.resumeSnapshot,
    });

    expect(acquire).not.toHaveBeenCalled();
    const result = await CreateInteractionModule().ConfirmResumeEdit('confirmation-1', true, context);

    expect(result).toEqual({ applied: true });
    expect(acquire).toHaveBeenCalledWith({ resumeId: 'resume-1', owner: 'agent', ownerId: 'owner-1', baseRevision: 7 });
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ baseRevision: 7 }));
    expect(release).toHaveBeenCalledWith('resume-1', 'owner-1');
    expect(context.pendingEdits.has('confirmation-1')).toBe(false);
  });

  it('持久化 ledger 可在工具模块重建后按业务幂等键回放写结果', async () => {
    const entries = new Map<string, ToolLedgerEntry>();
    const ledger = {
      Start: vi.fn((entry: Omit<ToolLedgerEntry, 'status' | 'receipt' | 'errorCode' | 'finishedAt'>) => entries.set(entry.ledgerId, { ...entry, status: 'started' })),
      Finish: vi.fn((ledgerId: string, status: ToolLedgerEntry['status'], extra?: { receipt?: ToolReceipt; errorCode?: string; finishedAt?: number }) => {
        const current = entries.get(ledgerId);
        if (current) entries.set(ledgerId, { ...current, status, ...extra });
      }),
      FindByIdempotencyKey: vi.fn((key: string) => [...entries.values()].find((entry) => entry.idempotencyKey === key && entry.status !== 'started')),
    };
    const saveProfile = vi.fn(async () => ({ count: 1, revision: 2 }));
    const context = CreateToolContext({
      ledger,
      ports: { ...CreateToolContext().ports, profileWrite: { Save: saveProfile } },
    });
    const call = {
      id: 'provider-call-1', type: 'function' as const,
      function: { name: 'UpdateProfile', arguments: JSON.stringify({ items: [{ id: 'p1', category: 'work', title: 'title', content: 'content' }] }) },
    };

    const first = await CreateToolsModule(CreatePorts()).ExecuteToolCall(call, context);
    const replay = await CreateToolsModule(CreatePorts()).ExecuteToolCall({ ...call, id: 'provider-call-after-restart' }, context);

    expect(JSON.parse(first.content)).toMatchObject({ ok: true, saved: true });
    expect(JSON.parse(replay.content)).toMatchObject({ ok: true, saved: true, replayed: true });
    expect(saveProfile).toHaveBeenCalledOnce();
    expect(replay.receipt?.idempotencyKey).toBeTruthy();
  });

  it('DeleteTodo 删除当前 Run 条目、通知界面并支持幂等重放', async () => {
    const context = CreateToolContext();
    context.tasks.set('todo-1', { id: 'todo-1', title: '过期步骤', description: '不再属于当前范围', status: 'pending' });
    const tools = CreateToolsModule(CreatePorts());
    const first = await tools.ExecuteToolCall({
      id: 'delete-todo-1', type: 'function', function: { name: 'DeleteTodo', arguments: '{"todoId":"todo-1"}' },
    }, context);
    const replay = await tools.ExecuteToolCall({
      id: 'delete-todo-replay', type: 'function', function: { name: 'DeleteTodo', arguments: '{"todoId":"todo-1"}' },
    }, context);

    expect(JSON.parse(first.content)).toMatchObject({ ok: true, deletedTodoId: 'todo-1', tasks: [] });
    expect(JSON.parse(replay.content)).toMatchObject({ ok: true, replayed: true, deletedTodoId: 'todo-1', tasks: [] });
    expect(context.tasks.has('todo-1')).toBe(false);
    expect(context.persistSessionState).toHaveBeenCalledOnce();
    expect(context.emit).toHaveBeenCalledWith(expect.objectContaining({ type: 'task_deleted', task: expect.objectContaining({ id: 'todo-1' }) }));
  });

  it('CreateCronTask 只生成待确认提案，确认前不执行持久化写入', async () => {
    const prepare = vi.fn(async () => ({ confirmationId: 'cron-confirmation-1', summary: '无人值守授权', scenarioId: 'default' as const }));
    const events: any[] = [];
    const base = CreateToolContext();
    const context = CreateToolContext({ ports: { ...base.ports, cronTask: { PrepareCreate: prepare, Read: vi.fn(), Update: vi.fn(), Delete: vi.fn() } }, emit: (event) => events.push(event) });
    const result = await CreateToolsModule(CreatePorts()).ExecuteToolCall({
      id: 'cron-create-1', type: 'function', function: { name: 'CreateCronTask', arguments: JSON.stringify({ title: '晨间复盘', message: '总结岗位进展', scenarioId: 'default', schedule: { type: 'once', executeAt: '2030-01-01T09:00:00+08:00', timeZone: 'Asia/Shanghai' } }) },
    }, context);
    expect(prepare).toHaveBeenCalledOnce();
    expect(JSON.parse(result.content)).toMatchObject({ ok: false, code: 'CONFIRMATION_REQUIRED', confirmationId: 'cron-confirmation-1' });
    expect(result.disposition).toBe('wait_confirmation');
    expect(events).toContainEqual(expect.objectContaining({ type: 'cron_task_confirmation', confirmationId: 'cron-confirmation-1' }));
  });

  it('无人值守 Run 即使旧快照含 Cron 工具，执行入口仍拒绝递归调度', async () => {
    const prepare = vi.fn();
    const base = CreateToolContext();
    const context = CreateToolContext({ unattended: true, ports: { ...base.ports, cronTask: { PrepareCreate: prepare, Read: vi.fn(), Update: vi.fn(), Delete: vi.fn() } } });
    const result = await CreateToolsModule(CreatePorts()).ExecuteToolCall({
      id: 'cron-recursive-1', type: 'function', function: { name: 'CreateCronTask', arguments: JSON.stringify({ title: '递归', message: '再次创建', scenarioId: 'default', schedule: { type: 'once', executeAt: '2030-01-01T09:00:00+08:00', timeZone: 'Asia/Shanghai' } }) },
    }, context);
    expect(prepare).not.toHaveBeenCalled();
    expect(JSON.parse(result.content)).toMatchObject({ ok: false, code: 'TOOL_NOT_ALLOWED' });
  });

  it('写工具缺少持久化 ledger 时安全暂停且不执行底层写入', async () => {
    const saveProfile = vi.fn(async () => ({ count: 1, revision: 2 }));
    const context = CreateToolContext({
      ledger: undefined,
      ports: { ...CreateToolContext().ports, profileWrite: { Save: saveProfile } },
    });

    const result = await CreateToolsModule(CreatePorts()).ExecuteToolCall({
      id: 'profile-write-1', type: 'function',
      function: { name: 'UpdateProfile', arguments: JSON.stringify({ items: [{ id: 'p1', category: 'work', title: 'title', content: 'content' }] }) },
    }, context);

    expect(saveProfile).not.toHaveBeenCalled();
    expect(result.disposition).toBe('pause');
    expect(JSON.parse(result.content)).toMatchObject({ ok: false, code: 'PERSISTENT_LEDGER_REQUIRED' });
  });

  it('工具进入时 Run 已取消则立即返回 CANCELLED，且不调用底层端口', async () => {
    const controller = new AbortController();
    controller.abort(new Error('cancelled by test'));
    const filePort = {
      ...CreateToolContext().ports.file,
      ResolveProjectPath: vi.fn(() => 'D:\\project\\resume.md'),
      ReadAuthorizedFile: vi.fn(async () => ({ content: 'should not be read', truncated: false })),
    };
    const context = CreateToolContext({
      signal: controller.signal,
      projectRoot: 'D:\\project',
      ports: { ...CreateToolContext().ports, file: filePort },
    });

    const result = await CreateToolsModule(CreatePorts({ file: filePort })).ExecuteToolCall({
      id: 'cancelled-read-1', type: 'function', function: { name: 'Read', arguments: '{"path":"resume.md"}' },
    }, context);

    expect(JSON.parse(result.content)).toMatchObject({ ok: false, code: 'CANCELLED' });
    expect(filePort.ResolveProjectPath).not.toHaveBeenCalled();
    expect(filePort.ReadAuthorizedFile).not.toHaveBeenCalled();
  });

  it('含【待确认】的简历草稿即使在无需确认模式也等待文本确认且不得直接写入', async () => {
    const save = vi.fn(async () => ({ id: 'resume-1', revision: 8 }));
    const context = CreateToolContext({
      confirmationMode: 'fully_trusted',
      resumeSnapshot: { id: 'resume-1', name: '简历', content: '旧内容', updatedAt: '', revision: 7 },
      ports: {
        ...CreateToolContext().ports,
        resumeWrite: {
          AcquireLock: vi.fn(async () => ({ acquired: true as const, lock: { resumeId: 'resume-1', owner: 'agent' as const, ownerId: 'owner-1', acquiredAt: 1, leaseExpiresAt: 2 } })),
          ReleaseLock: vi.fn(async () => undefined),
          Save: save,
        },
      },
    });

    const result = await CreateToolsModule(CreatePorts()).ExecuteToolCall({
      id: 'update-1', type: 'function',
      function: { name: 'UpdateResume', arguments: JSON.stringify({ resumeId: 'resume-1', content: '将响应时间降低 30%【待确认】', reason: '强化成果' }) },
    }, context);

    expect(save).not.toHaveBeenCalled();
    expect(JSON.parse(result.content)).toMatchObject({ ok: false, code: 'CONFIRMATION_REQUIRED' });
    expect(result.disposition).toBe('wait_user_input');
    expect(context.emit).toHaveBeenCalledWith(expect.objectContaining({ type: 'question_requested' }));
  });

  it('Provider 使用编译后的 Prompt、解析流式正文，并只接受服务端真实 usage', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { messages: Array<{ role: string; content: string; metadata?: unknown }>; stream_options?: { include_usage?: boolean } };
      expect(body.messages[0]).toEqual({ role: 'system', content: 'compiled prompt' });
      expect(body.messages[1]).toEqual({ role: 'user', content: 'runtime status' });
      expect(body.messages[1]).not.toHaveProperty('metadata');
      expect(body.stream_options).toEqual({ include_usage: true });
      return SseResponse([
        { choices: [{ delta: { content: 'hello ' } }] },
        { choices: [{ delta: { reasoning_content: 'reason' } }] },
        { choices: [], usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 } },
        '[DONE]',
      ]);
    });
    vi.stubGlobal('fetch', fetchMock);
    vi.resetModules();
    const { CreateProviderModule } = await import('../../../packages/agent-modules-defaults/src/provider');
    const provider = CreateProviderModule(CreatePorts());
    const deltas: Array<{ reasoning: string; content: string }> = [];
    const onRequest = vi.fn();

    const result = await provider.StreamCompletion({
      requestId: 'request-1', model: 'deepseek-v4-flash', history: [{ role: 'user', content: 'runtime status', metadata: { source: 'runtime', visibility: 'hidden', kind: 'runtime_reminder', reminderRevision: 1, injectedAtTurn: 0 } }], tools: [], signal: new AbortController().signal,
      instructions: { ...BuildDefaultCompiledInstructions(), compiled: 'compiled prompt' },
      onRequest,
      onDelta: (delta) => deltas.push(delta),
    });

    expect(result).toMatchObject({ content: 'hello ', reasoningContent: 'reason', usage: { promptTokens: 11, completionTokens: 7, totalTokens: 18 } });
    expect(deltas).toEqual([{ reasoning: '', content: 'hello ' }, { reasoning: 'reason', content: '' }]);
    expect(onRequest).toHaveBeenCalledOnce();
    expect(onRequest).toHaveBeenCalledWith({
      kind: 'completion', model: 'deepseek-v4-flash', toolCount: 0,
      messages: [{ role: 'system', content: 'compiled prompt' }, { role: 'user', content: 'runtime status' }],
    });
  });

  it('DeepSeek 按官方协议映射会话思考强度，并在关闭思考时不发送 effort', async () => {
    const requestBodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      requestBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return SseResponse([{ choices: [{ delta: { content: '完成' } }] }, '[DONE]']);
    }));
    vi.resetModules();
    const { CreateProviderModule } = await import('../../../packages/agent-modules-defaults/src/provider');
    const baseConfig = { provider: 'DeepSeek', baseUrl: 'https://api.deepseek.com', model: 'deepseek-v4-flash', contextLimit: 256_000, contextLimitMode: 'default' as const, compressionThreshold: 80, apiKey: 'test-key' };
    const enabled = CreateProviderModule(CreatePorts({ getConfig: vi.fn(async () => ({ ...baseConfig, thinkingEnabled: true })) }));
    const disabled = CreateProviderModule(CreatePorts({ getConfig: vi.fn(async () => ({ ...baseConfig, thinkingEnabled: false })) }));
    const common = { requestId: 'reasoning-request', model: 'deepseek-v4-flash', history: [], tools: [], signal: new AbortController().signal, instructions: BuildDefaultCompiledInstructions(), onDelta: vi.fn() };

    await enabled.StreamCompletion({ ...common, reasoningEffort: 'xhigh' });
    await disabled.StreamCompletion({ ...common, requestId: 'reasoning-disabled', reasoningEffort: 'max' });

    expect(requestBodies[0]).toMatchObject({ thinking: { type: 'enabled' }, reasoning_effort: 'high' });
    expect(requestBodies[1]).toMatchObject({ thinking: { type: 'disabled' } });
    expect(requestBodies[1]).not.toHaveProperty('reasoning_effort');
  });

  it('GLM-5.3-Flash 按官方参数流式输出思考、工具调用与真实 usage', async () => {
    let requestBody: Record<string, unknown> = {};
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return SseResponse([
        { choices: [{ delta: { reasoning_content: '分析' } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, id: 'glm-call-1', type: 'function', function: { name: 'Read', arguments: '{"path":"README.md"}' } }] } }] },
        { choices: [{ finish_reason: 'tool_calls', delta: {} }], usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } },
        '[DONE]',
      ]);
    }));
    vi.resetModules();
    const { CreateProviderModule, DefaultZaiBaseUrl } = await import('../../../packages/agent-modules-defaults/src/provider');
    const provider = CreateProviderModule(CreatePorts({
      getConfig: vi.fn(async () => ({ provider: 'Z.AI', baseUrl: DefaultZaiBaseUrl, model: 'glm-5.3-flash', thinkingEnabled: true, contextLimit: 256_000, contextLimitMode: 'default', compressionThreshold: 80, apiKey: 'zai-key' })),
    }));

    const result = await provider.StreamCompletion({
      requestId: 'glm-request', model: 'glm-5.3-flash', reasoningEffort: 'xhigh', history: [{ role: 'user', content: '读取文件' }],
      tools: [CreateRegisteredTool('Read')],
      signal: new AbortController().signal, instructions: BuildDefaultCompiledInstructions(), onDelta: vi.fn(),
    });

    expect(requestBody).toMatchObject({
      model: 'glm-5.3-flash', stream: true, tool_stream: true, temperature: 1, top_p: 0.95,
      thinking: { type: 'enabled', clear_thinking: false }, reasoning_effort: 'high',
    });
    expect(requestBody).not.toHaveProperty('stream_options');
    expect(result).toMatchObject({
      reasoningContent: '分析', usage: { promptTokens: 20, completionTokens: 10, totalTokens: 30 },
      toolCalls: [{ id: 'glm-call-1', type: 'function', function: { name: 'Read', arguments: '{"path":"README.md"}' } }],
    });
  });

  it('Provider 按 DeepSeek 官方协议发送视觉内容块且不透传宿主附件元数据', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { messages: Array<Record<string, unknown>> };
      expect(body.messages[1]).toEqual({
        role: 'user',
        content: [
          { type: 'text', text: '识别图片' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=', detail: 'auto' } },
        ],
      });
      expect(body.messages[1]).not.toHaveProperty('providerContent');
      expect(body.messages[1]).not.toHaveProperty('imageAttachments');
      return SseResponse([{ choices: [{ delta: { content: '图片内容' } }] }, '[DONE]']);
    });
    vi.stubGlobal('fetch', fetchMock);
    vi.resetModules();
    const { CreateProviderModule } = await import('../../../packages/agent-modules-defaults/src/provider');
    const provider = CreateProviderModule(CreatePorts());

    const result = await provider.StreamCompletion({
      requestId: 'request-vision', model: 'deepseek-v4-flash-vision-exp', tools: [], signal: new AbortController().signal,
      history: [{
        role: 'user', content: '识别图片',
        imageAttachments: [{ uri: 'attachment://image/test.png', mimeType: 'image/png', detail: 'auto' }],
        providerContent: [
          { type: 'text', text: '识别图片' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=', detail: 'auto' } },
        ],
      }],
      instructions: BuildDefaultCompiledInstructions(), onDelta: vi.fn(),
    });

    expect(result.content).toBe('图片内容');
  });

  it('视觉 token 估算不按 Base64 字符长度误触发文本压缩', async () => {
    vi.resetModules();
    const { CreateProviderModule } = await import('../../../packages/agent-modules-defaults/src/provider');
    const provider = CreateProviderModule(CreatePorts());
    const base64 = 'A'.repeat(1024 * 1024);

    const estimate = provider.EstimateTokens({ messages: [{
      role: 'user', content: '识别', providerContent: [
        { type: 'text', text: '识别' },
        { type: 'image_url', image_url: { url: `data:image/png;base64,${base64}`, detail: 'auto' } },
      ],
    }] });

    expect(estimate).toBeGreaterThanOrEqual(384);
    expect(estimate).toBeLessThan(1_000);
  });

  it('DeepSeek 终止 choice 携带 usage 时接受真实数值且不产生空正文增量', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => SseResponse([
      { choices: [{ delta: { content: '完成', role: 'assistant' }, finish_reason: null, index: 0 }], usage: null },
      {
        choices: [{ delta: { content: '', role: null }, finish_reason: 'stop', index: 0 }],
        usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
      },
      '[DONE]',
    ])));
    vi.resetModules();
    const { CreateProviderModule } = await import('../../../packages/agent-modules-defaults/src/provider');
    const provider = CreateProviderModule(CreatePorts());
    const onDelta = vi.fn();

    const result = await provider.StreamCompletion({
      requestId: 'request-terminal-usage', model: 'deepseek-v4-flash', history: [], tools: [], signal: new AbortController().signal,
      instructions: BuildDefaultCompiledInstructions(), onDelta,
    });

    expect(result).toMatchObject({ content: '完成', usage: { promptTokens: 11, completionTokens: 7, totalTokens: 18 } });
    expect(onDelta).toHaveBeenCalledOnce();
  });

  it('Provider 缺失 usage 时保持 undefined，不用本地估算冒充', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => SseResponse([{ choices: [{ delta: { content: 'hello' } }] }, '[DONE]'])));
    vi.resetModules();
    const { CreateProviderModule } = await import('../../../packages/agent-modules-defaults/src/provider');
    const provider = CreateProviderModule(CreatePorts());

    const result = await provider.StreamCompletion({
      requestId: 'request-1', model: 'deepseek-v4-flash', history: [], tools: [], signal: new AbortController().signal,
      instructions: BuildDefaultCompiledInstructions(),
      onDelta: vi.fn(),
    });

    expect(result.usage).toBeUndefined();
  });

  it.each([
    ['数字字符串', { prompt_tokens: '11', completion_tokens: '7', total_tokens: '18' }],
    ['null 字段', { prompt_tokens: null, completion_tokens: 7, total_tokens: 7 }],
    ['总数不等于输入输出之和', { prompt_tokens: 11, completion_tokens: 7, total_tokens: 19 }],
  ])('Provider 拒绝%s usage，不把协议异常冒充为真实值', async (_name, usage) => {
    vi.stubGlobal('fetch', vi.fn(async () => SseResponse([{ choices: [], usage }, '[DONE]'])));
    vi.resetModules();
    const { CreateProviderModule } = await import('../../../packages/agent-modules-defaults/src/provider');
    const provider = CreateProviderModule(CreatePorts());

    const result = await provider.StreamCompletion({
      requestId: 'request-invalid-usage', model: 'deepseek-v4-flash', history: [], tools: [], signal: new AbortController().signal,
      instructions: BuildDefaultCompiledInstructions(), onDelta: vi.fn(),
    });

    expect(result.usage).toBeUndefined();
  });

  it('DeepSeek 流出现两个非空 usage 块时按协议错误失败，不取最后一个覆盖', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => SseResponse([
      { choices: [], usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 } },
      { choices: [], usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 } },
      '[DONE]',
    ])));
    vi.resetModules();
    const { CreateProviderModule } = await import('../../../packages/agent-modules-defaults/src/provider');
    const provider = CreateProviderModule(CreatePorts());

    await expect(provider.StreamCompletion({
      requestId: 'request-duplicate-usage', model: 'deepseek-v4-flash', history: [], tools: [], signal: new AbortController().signal,
      instructions: BuildDefaultCompiledInstructions(), onDelta: vi.fn(),
    })).rejects.toThrow(/PROTOCOL_DUPLICATE_USAGE/);
  });

  it('DeepSeek usage 不得与真实正文或工具增量混在同一块', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => SseResponse([
      { choices: [{ delta: { content: 'unexpected' }, finish_reason: 'stop', index: 0 }], usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 } },
      '[DONE]',
    ])));
    vi.resetModules();
    const { CreateProviderModule } = await import('../../../packages/agent-modules-defaults/src/provider');
    const provider = CreateProviderModule(CreatePorts());

    await expect(provider.StreamCompletion({
      requestId: 'request-invalid-usage-chunk', model: 'deepseek-v4-flash', history: [], tools: [], signal: new AbortController().signal,
      instructions: BuildDefaultCompiledInstructions(), onDelta: vi.fn(),
    })).rejects.toThrow(/PROTOCOL_INVALID_USAGE_CHUNK/);
  });

  it('畸形 SSE 数据块显式失败，不静默忽略', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => SseResponse(['{malformed-json', '[DONE]'])));
    vi.resetModules();
    const { CreateProviderModule } = await import('../../../packages/agent-modules-defaults/src/provider');
    const provider = CreateProviderModule(CreatePorts());

    await expect(provider.StreamCompletion({
      requestId: 'request-1', model: 'deepseek-v4-flash', history: [], tools: [], signal: new AbortController().signal,
      instructions: BuildDefaultCompiledInstructions(),
      onDelta: vi.fn(),
    })).rejects.toThrow(/PROTOCOL_INVALID_SSE_JSON/);
  });

  it('工具自身超时会中止传给底层端口的 AbortSignal', async () => {
    vi.useFakeTimers();
    let receivedSignal: AbortSignal | undefined;
    const filePort = {
      ...CreateToolContext().ports.file,
      ResolveProjectPath: vi.fn(() => 'D:\\project\\resume.md'),
      ReadAuthorizedFile: vi.fn((_path: string, _source?: string, execution?: { signal?: AbortSignal }) => {
        const { signal } = execution ?? {};
        receivedSignal = signal;
        return new Promise<never>(() => undefined);
      }),
    };
    const context = CreateToolContext({
      projectRoot: 'D:\\project',
      ports: { ...CreateToolContext().ports, file: filePort },
    });
    const execution = CreateToolsModule(CreatePorts({ file: filePort })).ExecuteToolCall({
      id: 'read-1', type: 'function', function: { name: 'Read', arguments: '{"path":"resume.md"}' },
    }, context);

    await vi.advanceTimersByTimeAsync(20_000);
    await execution;

    expect(receivedSignal?.aborted).toBe(true);
  });

  it('写工具超时写入 status_unknown 账本并暂停等待对账', async () => {
    vi.useFakeTimers();
    const baseContext = CreateToolContext();
    const context = CreateToolContext({
      resumeSnapshot: { id: 'resume-1', name: '简历', content: '旧内容', updatedAt: '', revision: 7 },
      ports: {
        ...baseContext.ports,
        resumeWrite: {
          AcquireLock: vi.fn(async () => ({ acquired: true as const, lock: { resumeId: 'resume-1', owner: 'agent' as const, ownerId: 'owner-1', acquiredAt: 1, leaseExpiresAt: 2 } })),
          ReleaseLock: vi.fn(async () => undefined),
          Save: vi.fn(() => new Promise<never>(() => undefined)),
        },
      },
    });
    const execution = CreateToolsModule(CreatePorts()).ExecuteToolCall({
      id: 'update-timeout-1', type: 'function',
      function: { name: 'UpdateResume', arguments: JSON.stringify({ resumeId: 'resume-1', content: '已确认的新内容', reason: '优化表达' }) },
    }, context);

    await vi.advanceTimersByTimeAsync(10_000);
    const result = await execution;

    expect(result.disposition).toBe('pause');
    expect(JSON.parse(result.content)).toMatchObject({ ok: false, code: 'STATUS_UNKNOWN' });
    expect(context.ledger?.Finish).toHaveBeenCalledWith(expect.any(String), 'status_unknown', expect.objectContaining({ errorCode: 'TIMEOUT' }));
  });

  it('默认 observability 写入日志前脱敏密钥与绝对路径', () => {
    const observability = CreateObservabilityModule(CreatePorts());

    observability.RecordLog('ERROR', 'provider.failed', 'Authorization: Bearer secret C:\\Users\\alice\\resume.md');

    expect(observability.SnapshotLocalLogs()[0].detail).not.toMatch(/secret|C:\\Users\\alice/);
  });
});
