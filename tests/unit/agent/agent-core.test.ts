import { describe, expect, it, vi } from 'vitest';
import type { ModelDelta, ToolCallFragment } from '../../../packages/agent-sdk/src/index';
import { RunAgentLoop } from '../../../packages/agent-core/src/kernel';
import { CreateKernelHarness, CreateRegisteredTool } from './test-helpers';

function ToolCall(id: string, name: string): ToolCallFragment {
  return { id, type: 'function', function: { name, arguments: '{}' } };
}

describe('agent-core RunAgentLoop', () => {
  it('只产生 completed 终态，并把缺失 Provider usage 原样报告为 unavailable', async () => {
    const harness = CreateKernelHarness({ completions: [{ content: '完成', toolCalls: [] }] });

    const result = await RunAgentLoop(harness.input);

    expect(result.outcome).toBe('completed');
    expect(result.disposition).toBe('completed');
    expect(harness.usages).toEqual([{ source: 'unavailable', promptTokens: 0, completionTokens: 0, totalTokens: 0 }]);
    expect(harness.events.map((event) => event.type)).toEqual(['content_delta', 'completed']);
    expect(harness.events).not.toContainEqual(expect.objectContaining({ type: 'cancelled' }));
    expect(harness.trace.finish).toHaveBeenCalledOnce();
    expect(harness.trace.finish).toHaveBeenCalledWith('request-1', 'completed', expect.any(String));
  });

  it('把 Provider 返回的真实 usage 规范化为唯一 provider 事实', async () => {
    const harness = CreateKernelHarness({
      completions: [{ content: '完成', toolCalls: [], usage: { promptTokens: 11, completionTokens: 7, totalTokens: 18 } }],
    });

    await RunAgentLoop(harness.input);

    expect(harness.usages).toEqual([{ source: 'provider', promptTokens: 11, completionTokens: 7, totalTokens: 18 }]);
  });

  it('自定义 Provider 越过 Adapter 返回矛盾 usage 时仍降级为 unavailable', async () => {
    const harness = CreateKernelHarness({
      completions: [{ content: '完成', toolCalls: [], usage: { promptTokens: 11, completionTokens: 7, totalTokens: 19 } }],
    });

    await RunAgentLoop(harness.input);

    expect(harness.usages).toEqual([{ source: 'unavailable', promptTokens: 0, completionTokens: 0, totalTokens: 0 }]);
  });

  it('工具进入等待状态后停止请求模型，并跳过批次中的后续工具', async () => {
    const ask = CreateRegisteredTool('AskUserQuestion', { isConcurrencySafe: false });
    const read = CreateRegisteredTool('ReadProfile');
    const execute = vi.fn(async (call: ToolCallFragment) => call.function.name === 'AskUserQuestion'
      ? { role: 'tool' as const, tool_call_id: call.id, content: '{"ok":true,"awaitingUser":true}', disposition: 'wait_user_input' as const }
      : { role: 'tool' as const, tool_call_id: call.id, content: '{"ok":true}' });
    const harness = CreateKernelHarness({
      tools: [ask, read],
      executeTool: execute,
      completions: [{ content: '', toolCalls: [ToolCall('ask-1', 'AskUserQuestion'), ToolCall('read-1', 'ReadProfile')] }],
    });

    const result = await RunAgentLoop(harness.input);

    expect(result.outcome).toBe('waiting_user_input');
    expect(result.disposition).toBe('waiting_user_input');
    expect(harness.modules.modelProvider.StreamCompletion).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledOnce();
    expect(result.transcript.at(-1)?.content).toContain('SKIPPED_AFTER_WAIT');
    expect(harness.events.at(-1)?.type).toBe('waiting_user_input');
  });

  it('只读工具并行执行，写工具与后续阶段形成屏障', async () => {
    let activeReads = 0;
    let maxActiveReads = 0;
    const order: string[] = [];
    const tools = [
      CreateRegisteredTool('ReadA'),
      CreateRegisteredTool('ReadB'),
      CreateRegisteredTool('Write', { isConcurrencySafe: false, sideEffect: 'local_write' }),
      CreateRegisteredTool('ReadAfter'),
    ];
    const execute = vi.fn(async (call: ToolCallFragment) => {
      order.push(`start:${call.function.name}`);
      if (call.function.name.startsWith('Read')) {
        activeReads += 1;
        maxActiveReads = Math.max(maxActiveReads, activeReads);
        await new Promise<void>((resolve) => setTimeout(resolve, 5));
        activeReads -= 1;
      }
      order.push(`end:${call.function.name}`);
      return { role: 'tool' as const, tool_call_id: call.id, content: '{"ok":true}' };
    });
    const harness = CreateKernelHarness({
      tools,
      executeTool: execute,
      completions: [
        { content: '', toolCalls: [ToolCall('1', 'ReadA'), ToolCall('2', 'ReadB'), ToolCall('3', 'Write'), ToolCall('4', 'ReadAfter')] },
        { content: 'done', toolCalls: [] },
      ],
    });

    await RunAgentLoop(harness.input);

    expect(maxActiveReads).toBe(2);
    expect(order.indexOf('start:Write')).toBeGreaterThan(order.indexOf('end:ReadB'));
    expect(order.indexOf('start:ReadAfter')).toBeGreaterThan(order.indexOf('end:Write'));
  });

  it('取消后 1 秒内进入可见 cancelled 终态', async () => {
    const controller = new AbortController();
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const harness = CreateKernelHarness({
      signal: controller.signal,
      streamCompletion: vi.fn(({ signal }) => new Promise((_, reject) => {
        markStarted?.();
        signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      })),
    });
    const running = RunAgentLoop(harness.input);
    await started;
    const startedAt = performance.now();

    controller.abort();
    const result = await running;

    expect(performance.now() - startedAt).toBeLessThan(1_000);
    expect(result.outcome).toBe('cancelled');
    expect(harness.events.map((event) => event.type)).toEqual(['cancelled']);
    expect(harness.trace.finish).toHaveBeenCalledWith('request-1', 'cancelled', expect.any(String));
  });

  it('取消完成后忽略迟到的 Provider 增量', async () => {
    const controller = new AbortController();
    let lateDelta: ((delta: ModelDelta) => void) | undefined;
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const harness = CreateKernelHarness({
      signal: controller.signal,
      streamCompletion: vi.fn(({ signal, onDelta }) => new Promise((_, reject) => {
        lateDelta = onDelta;
        markStarted?.();
        signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      })),
    });
    const running = RunAgentLoop(harness.input);
    await started;
    controller.abort();
    await running;
    const eventCount = harness.events.length;

    lateDelta?.({ reasoning: '', content: 'late event' });

    expect(harness.events).toHaveLength(eventCount);
  });

  it('Provider 忽略取消并迟到返回写工具 completion 时不得记录 Usage、历史或执行工具', async () => {
    const controller = new AbortController();
    const update = CreateRegisteredTool('UpdateProfile', { isConcurrencySafe: false, sideEffect: 'local_write' });
    const execute = vi.fn(async (call: ToolCallFragment) => ({ role: 'tool' as const, tool_call_id: call.id, content: '{"ok":true}' }));
    let resolveCompletion: ((completion: {
      content: string;
      toolCalls: ToolCallFragment[];
      usage: { promptTokens: number; completionTokens: number; totalTokens: number };
    }) => void) | undefined;
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const completion = new Promise<{
      content: string;
      toolCalls: ToolCallFragment[];
      usage: { promptTokens: number; completionTokens: number; totalTokens: number };
    }>((resolve) => { resolveCompletion = resolve; });
    const harness = CreateKernelHarness({
      signal: controller.signal,
      tools: [update],
      executeTool: execute,
      streamCompletion: vi.fn(async () => {
        markStarted?.();
        return await completion;
      }),
    });
    const running = RunAgentLoop(harness.input);
    await started;

    controller.abort(new Error('cancelled by test'));
    resolveCompletion?.({
      content: '',
      toolCalls: [ToolCall('late-write-1', 'UpdateProfile')],
      usage: { promptTokens: 11, completionTokens: 7, totalTokens: 18 },
    });
    const result = await running;

    expect(result.outcome).toBe('cancelled');
    expect(result.disposition).toBe('cancelled');
    expect(harness.usages).toEqual([]);
    expect(execute).not.toHaveBeenCalled();
    expect(result.transcript.some((message) => message.role === 'assistant' || message.role === 'tool')).toBe(false);
    expect(harness.events.map((event) => event.type)).toEqual(['cancelled']);
    expect(harness.trace.finish).toHaveBeenCalledOnce();
    expect(harness.trace.finish).toHaveBeenCalledWith('request-1', 'cancelled', 'Cancelled by user.');
  });

  it('多模态用户消息进入 Provider，但历史快照只保留受控附件引用', async () => {
    const streamCompletion = vi.fn(async ({ history }) => {
      const message = history.find((item) => item.content === '识别图片');
      expect(message?.providerContent?.[1]).toMatchObject({ type: 'image_url' });
      return { content: 'identified', toolCalls: [] };
    });
    const harness = CreateKernelHarness({ streamCompletion });
    harness.input.userMessage = {
      role: 'user', content: '识别图片',
      imageAttachments: [{ uri: 'attachment://image/test.png', mimeType: 'image/png', detail: 'auto' }],
      providerContent: [
        { type: 'text', text: '识别图片' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=', detail: 'auto' } },
      ],
    };

    const result = await RunAgentLoop(harness.input);
    const storedUserMessage = result.transcript.find((message) => message.content === '识别图片');

    expect(storedUserMessage?.providerContent).toBeUndefined();
    expect(storedUserMessage?.imageAttachments).toEqual([{ uri: 'attachment://image/test.png', mimeType: 'image/png', detail: 'auto' }]);
  });

  it('压缩连续失败时熔断并记录 circuit_open，不留下 running Trace', async () => {
    const history = [{ role: 'user' as const, content: 'old turn' }, { role: 'assistant' as const, content: 'old answer' }];
    const harness = CreateKernelHarness({
      history,
      shouldCompact: true,
      createSummary: vi.fn(async () => { throw new Error('summary unavailable'); }),
      splitRecentTurns: vi.fn((candidate) => ({ earlier: candidate.slice(0, 1), recent: candidate.slice(1) })),
      dropOldestTurns: vi.fn((candidate) => candidate),
    });

    await expect(RunAgentLoop(harness.input)).rejects.toThrow(/compression failed/i);
    expect(harness.modules.modelProvider.CreateSummary).toHaveBeenCalledTimes(4);
    expect(harness.trace.finish).toHaveBeenCalledWith('request-1', 'circuit_open', 'compression_retry_exhausted');
    expect(harness.events.at(-1)).toEqual(expect.objectContaining({ type: 'error' }));
  });

  it('场景白名单外的已注册工具不得进入工具模块', async () => {
    const update = CreateRegisteredTool('UpdateProfile', { isConcurrencySafe: false, sideEffect: 'local_write' });
    const execute = vi.fn(async (call: ToolCallFragment) => ({ role: 'tool' as const, tool_call_id: call.id, content: '{"ok":true}' }));
    const harness = CreateKernelHarness({
      tools: [update],
      scenarioToolNames: ['ReadProfile'],
      executeTool: execute,
      completions: [
        { content: '', toolCalls: [ToolCall('write-1', 'UpdateProfile')] },
        { content: 'done', toolCalls: [] },
      ],
    });

    await RunAgentLoop(harness.input);

    expect(execute).not.toHaveBeenCalled();
  });

  it('运行状态提醒以 user 角色追加且旧提醒在后续轮次保持不变', async () => {
    const read = CreateRegisteredTool('Read');
    const histories: Array<Array<{ role: string; content: string; metadata?: { kind?: string; injectedAtTurn?: number } }>> = [];
    let callIndex = 0;
    const harness = CreateKernelHarness({
      tools: [read],
      streamCompletion: vi.fn(async ({ history }) => {
        histories.push(history.map((message) => ({ role: message.role, content: message.content, metadata: message.metadata })));
        callIndex += 1;
        return callIndex < 6
          ? { content: '', toolCalls: [ToolCall(`read-${callIndex}`, 'Read')] }
          : { content: 'done', toolCalls: [] };
      }),
    });
    harness.input.maxTurns = 6;
    harness.input.scenario.budgets = { maxModelTurns: 6, maxToolCalls: 12 };

    const result = await RunAgentLoop(harness.input);

    expect(result.outcome).toBe('completed');
    const finalReminders = histories.at(-1)?.filter((message) => message.metadata?.kind === 'runtime_reminder') ?? [];
    expect(finalReminders).toHaveLength(2);
    expect(finalReminders.map((message) => message.metadata?.injectedAtTurn)).toEqual([0, 5]);
    expect(finalReminders.every((message) => message.role === 'user')).toBe(true);
    expect(histories[0].find((message) => message.metadata?.kind === 'runtime_reminder')?.content).toBe(finalReminders[0].content);
    expect(finalReminders[1].content).toContain('Do not start new tool calls.');
  });

  it('确认权限变化时在下一模型轮次追加提醒并更新工具上下文', async () => {
    const read = CreateRegisteredTool('Read');
    let mode: 'always_confirm' | 'fully_trusted' = 'always_confirm';
    let callIndex = 0;
    const harness = CreateKernelHarness({
      tools: [read],
      executeTool: vi.fn(async (call, context) => {
        mode = 'fully_trusted';
        context.confirmationMode = mode;
        return { role: 'tool', tool_call_id: call.id, content: '{"ok":true}' };
      }),
      streamCompletion: vi.fn(async () => {
        callIndex += 1;
        return callIndex === 1 ? { content: '', toolCalls: [ToolCall('read-1', 'Read')] } : { content: 'done', toolCalls: [] };
      }),
    });
    harness.input.runtimeReminder.confirmationMode = 'always_confirm';
    harness.input.runtimeReminder.getConfirmationMode = () => mode;

    const result = await RunAgentLoop(harness.input);

    const reminders = result.transcript.filter((message) => message.metadata?.kind === 'runtime_reminder');
    expect(reminders).toHaveLength(2);
    expect(reminders[1].content).toContain('Current confirmation mode: fully trusted.');
    expect(harness.input.toolContext.confirmationMode).toBe('fully_trusted');
  });

  it('BrowserFillForm 的 Trace 保留字段结构但逐项移除输入正文', async () => {
    const tool = CreateRegisteredTool('BrowserFillForm', { sideEffect: 'external_action', isConcurrencySafe: false });
    const secretName = '张三-敏感姓名';
    const secretEmail = 'private@example.com';
    const harness = CreateKernelHarness({
      tools: [tool],
      completions: [
        { content: '', toolCalls: [{ id: 'fill-form-1', type: 'function', function: { name: 'BrowserFillForm', arguments: JSON.stringify({ pageRevision: 2, fields: [{ ref: '@e1', text: secretName }, { ref: '@e2', text: secretEmail }] }) } }] },
        { content: 'done', toolCalls: [] },
      ],
    });

    await RunAgentLoop(harness.input);

    const traceCall = harness.trace.append.mock.calls.find((call) => call[1] === 'tool_call');
    const serialized = JSON.stringify(traceCall?.[2]);
    expect(serialized).toContain('@e1');
    expect(serialized).toContain('[REDACTED_BROWSER_INPUT]');
    expect(serialized).not.toContain(secretName);
    expect(serialized).not.toContain(secretEmail);
  });

  it('最后一轮返回工具调用时不执行工具并显式暂停', async () => {
    const write = CreateRegisteredTool('UpdateProfile', { isConcurrencySafe: false, sideEffect: 'local_write' });
    const execute = vi.fn(async (call: ToolCallFragment) => ({ role: 'tool' as const, tool_call_id: call.id, content: '{"ok":true}' }));
    const harness = CreateKernelHarness({
      tools: [write],
      executeTool: execute,
      completions: [{ content: '', toolCalls: [ToolCall('write-final', 'UpdateProfile')] }],
    });
    harness.input.maxTurns = 1;
    harness.input.scenario.budgets = { maxModelTurns: 1, maxToolCalls: 12 };

    const result = await RunAgentLoop(harness.input);

    expect(result.outcome).toBe('circuit_open');
    expect(execute).not.toHaveBeenCalled();
    expect(result.transcript.at(-1)?.content).toContain('TURN_BUDGET_EXHAUSTED');
    expect(harness.events.at(-1)).toMatchObject({ type: 'error' });
  });
});
