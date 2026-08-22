import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentMessage, ToolLedgerEntry, ToolReceipt } from '../../../packages/agent-sdk/src/index';
import { CreateCompactionModule } from '../../../packages/agent-modules-defaults/src/compaction';
import { CreateContextBuilderModule } from '../../../packages/agent-modules-defaults/src/context';
import { CreateInteractionModule } from '../../../packages/agent-modules-defaults/src/interaction';
import { CreateObservabilityModule } from '../../../packages/agent-modules-defaults/src/observability';
import { ApplicationScenarioPlaceholder, BuildDefaultCompiledInstructions, BuildDefaultPromptFragments, DefaultScenario } from '../../../packages/agent-modules-defaults/src/prompts';
import { CreateToolsModule } from '../../../packages/agent-modules-defaults/src/tools';
import type { AgentDefaultPorts } from '../../../packages/agent-modules-defaults/src/ports';
import { CreateToolContext } from './test-helpers';

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
  it('0.2 默认场景只暴露 12 个 PascalCase 本地工具，网络与投递能力不混入白名单', () => {
    const tools = CreateToolsModule(CreatePorts()).GetToolDefinitions();
    const names = tools.map((tool) => tool.definition.function.name);

    expect(new Set(names)).toEqual(new Set(DefaultScenario.toolNames));
    expect(names).toHaveLength(12);
    expect(names.every((name) => /^[A-Z][A-Za-z0-9]{0,63}$/.test(name))).toBe(true);
    expect(names).not.toEqual(expect.arrayContaining(['SearchJobs', 'ReadUrl', 'Shell', 'Browser', 'SubmitApplication']));
    expect(DefaultScenario.budgets?.maxModelTurns).toBe(30);
    expect(ApplicationScenarioPlaceholder.budgets?.maxModelTurns).toBe(100);
    expect(ApplicationScenarioPlaceholder.enabled).toBe(false);
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

    const result = await provider.StreamCompletion({
      requestId: 'request-1', model: 'deepseek-v4-flash', history: [{ role: 'user', content: 'runtime status', metadata: { source: 'runtime', visibility: 'hidden', kind: 'runtime_reminder', reminderRevision: 1, injectedAtTurn: 0 } }], tools: [], signal: new AbortController().signal,
      instructions: { ...BuildDefaultCompiledInstructions(), compiled: 'compiled prompt' },
      onDelta: (delta) => deltas.push(delta),
    });

    expect(result).toMatchObject({ content: 'hello ', reasoningContent: 'reason', usage: { promptTokens: 11, completionTokens: 7, totalTokens: 18 } });
    expect(deltas).toEqual([{ reasoning: '', content: 'hello ' }, { reasoning: 'reason', content: '' }]);
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
