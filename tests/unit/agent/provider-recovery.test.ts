import { afterEach, describe, expect, it, vi } from 'vitest';
import { CreateProviderModule } from '../../../packages/agent-modules-defaults/src/provider';
import { DefaultProviderTransportPolicy, ProtocolError, WithProviderRecovery } from '../../../packages/agent-modules-defaults/src/provider-transport';
import { RunAgentLoop } from '../../../packages/agent-core/src/kernel';
import { ApplyConversationActivity, CreateConversationPresentation } from '../../../packages/agent-sdk/src/conversation';
import { CreateKernelHarness, CreateRegisteredTool } from './test-helpers';
import type { ModelProviderModule } from '../../../packages/agent-sdk/src';

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
const Sse = (content = '成功') => new Response(`data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
async function Fixture(fetcher: typeof fetch, options = {}) {
  vi.stubGlobal('fetch', fetcher);
  const provider = CreateProviderModule({ getConfig: async () => null, saveConfig: async () => undefined, getStoredSettings: async () => ({}) } as never,
    { initialDelayMs: 1, maxDelayMs: 5, ...options });
  await provider.Configure({ provider: 'MIMO', model: 'mimo-v2.6-flash', apiKey: 'fixture-secret', thinkingEnabled: true });
  const controller = new AbortController();
  const input: Parameters<ModelProviderModule['StreamCompletion']>[0] = { requestId: 'recovery', provider: 'MIMO', model: 'mimo-v2.6-flash', reasoningEffort: 'medium', history: [], tools: [], signal: controller.signal, onDelta: vi.fn(), instructions: { compiled: 'audit' } as never };
  return { provider, input, controller };
}

describe('模型连接恢复与流式降级', () => {
  it('退避为 1 秒、2 秒，取消可立即结束等待', async () => {
    vi.useFakeTimers(); const times: number[] = [], notices: unknown[] = [];
    const work = WithProviderRecovery(async () => { times.push(Date.now()); if (times.length < 3) throw ProtocolError('PROTOCOL_TEST', 'broken'); return 'ok'; },
      { stream: true, policy: DefaultProviderTransportPolicy, onRecovery: event => notices.push(event) });
    await vi.advanceTimersByTimeAsync(3000); await expect(work).resolves.toBe('ok');
    expect(times.map(time => time - times[0])).toEqual([0, 1000, 3000]);
    expect(notices).toMatchObject([{ attempt: 2, delayMs: 1000 }, { attempt: 3, delayMs: 2000, mode: 'nonstream' }]);
  });
  it('503 与 429 重试，认证或参数错误不重试，错误凭据被脱敏', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(new Response('{}', { status: 503 })).mockResolvedValueOnce(new Response('{}', { status: 429, headers: { 'Retry-After': '300' } })).mockImplementation(async () => Sse());
    const h = await Fixture(fetcher); const onRecovery = vi.fn();
    await expect(h.provider.StreamCompletion({ ...h.input, onRecovery })).resolves.toMatchObject({ content: '成功' });
    expect(fetcher).toHaveBeenCalledTimes(3); expect(onRecovery.mock.calls[1][0].delayMs).toBe(5);
    for (const status of [400, 401, 403]) {
      const denied = vi.fn(async () => new Response('{"error":{"message":"fixture-secret rejected"}}', { status }));
      const other = await Fixture(denied);
      const error = await other.provider.StreamCompletion(other.input).catch(error => error);
      expect(error.message).not.toContain('fixture-secret'); expect(error.status).toBe(status); expect(denied).toHaveBeenCalledOnce();
    }
  });
  it('流内 error 可恢复，不把错误块当作空成功', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(new Response('data: {"error":{"message":"busy"}}\n\n')).mockImplementation(async () => Sse());
    const h = await Fixture(fetcher);
    await expect(h.provider.StreamCompletion(h.input)).resolves.toMatchObject({ content: '成功' });
    expect(h.input.onDelta).toHaveBeenCalledOnce();
  });
  it('流内认证或参数错误不重试，畸形工具数组明确拒绝', async () => {
    const denied = vi.fn(async () => new Response('data: {"error":{"type":"invalid_request_error","message":"fixture-secret"}}\n\n'));
    const h = await Fixture(denied);
    await expect(h.provider.StreamCompletion(h.input)).rejects.toMatchObject({ code: 'PROVIDER_REQUEST_REJECTED', retryable: false });
    expect(denied).toHaveBeenCalledOnce();
    const malformed = await Fixture(vi.fn(async () => new Response('data: {"choices":[{"delta":{"content":"ok","tool_calls":{}}}]}\n\ndata: [DONE]\n\n')), { maxAttempts: 1 });
    await expect(malformed.provider.StreamCompletion(malformed.input)).rejects.toMatchObject({ code: 'PROTOCOL_INVALID_SSE_SHAPE' });
  });
  it('反复半截响应降级一次非流式，撤回半截文本，只执行完整工具一次', async () => {
    const modes: boolean[] = [];
    const fetcher = vi.fn(async (_url, init) => {
      const body = JSON.parse(String(init?.body)); modes.push(body.stream);
      if (modes.length < 3) return new Response('data: {"choices":[{"delta":{"content":"失败的半截"}}]}\n\n');
      if (modes.length === 3) return new Response(JSON.stringify({ choices: [{ message: { content: '', tool_calls: [{ id: 'read-complete', type: 'function', function: { name: 'Read', arguments: '{}' } }] }, finish_reason: 'tool_calls' }] }));
      return Sse('最终结果');
    });
    const h = await Fixture(fetcher); const kernel = CreateKernelHarness({ tools: [CreateRegisteredTool('Read')] });
    kernel.modules.modelProvider = h.provider; kernel.input.provider = 'MIMO'; kernel.input.model = 'mimo-v2.6-flash';
    await expect(RunAgentLoop(kernel.input)).resolves.toMatchObject({ outcome: 'completed' });
    expect(modes).toEqual([true, true, false, true]); expect(kernel.modules.tools.ExecuteToolCall).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls.map(([, init]) => JSON.parse(String(init?.body)).thinking)).toEqual(Array(4).fill({ type: 'enabled' }));
    const projected = kernel.events.filter(event => event.activity).reduce((value, event, index) => ApplyConversationActivity(value, event.activity!, index + 1, index), CreateConversationPresentation('request-1'));
    expect(JSON.stringify(projected)).not.toContain('失败的半截');
    expect(kernel.events.find(event => event.type === 'completed')?.content).toBe('最终结果');
    expect(kernel.trace.append.mock.calls.filter(([, kind]) => kind === 'provider_recovery')).toHaveLength(2);
  });
  it('连接和响应空闲均有截止时间，取消重连不再发请求', async () => {
    const connecting = await Fixture(vi.fn(() => new Promise(() => {})), { maxAttempts: 1, connectionTimeoutMs: 15 });
    await expect(connecting.provider.StreamCompletion(connecting.input)).rejects.toMatchObject({ code: 'PROVIDER_CONNECTION_TIMEOUT' });
    const stream = new ReadableStream({ start() {} });
    const idle = await Fixture(vi.fn(async () => new Response(stream)), { maxAttempts: 1, idleTimeoutMs: 15 });
    await expect(idle.provider.StreamCompletion(idle.input)).rejects.toMatchObject({ code: 'PROVIDER_IDLE_TIMEOUT' });
    const fetcher = vi.fn(async () => new Response('{}', { status: 503 })); const cancelled = await Fixture(fetcher);
    await expect(cancelled.provider.StreamCompletion({ ...cancelled.input, onRecovery: () => cancelled.controller.abort(new Error('user cancelled')) })).rejects.toThrow('user cancelled');
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it('持续输出可以超过空闲窗口，正常长回复不会被总时长截断', async () => {
    vi.useFakeTimers(); let count = 0;
    const body = new ReadableStream({ start(controller) {
      const interval = setInterval(() => {
        count++;
        controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta: { content: '字' }, ...(count === 5 ? { finish_reason: 'stop' } : {}) }] })}\n\n`));
        if (count === 5) { clearInterval(interval); controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n')); controller.close(); }
      }, 10);
    } });
    const h = await Fixture(vi.fn(async () => new Response(body)), { maxAttempts: 1, idleTimeoutMs: 15 });
    const pending = h.provider.StreamCompletion(h.input); await vi.advanceTimersByTimeAsync(55);
    await expect(pending).resolves.toMatchObject({ content: '字字字字字' }); expect(vi.getTimerCount()).toBe(0);
  });
  it('后续模型断流时，不重放前一轮已成功的写工具', async () => {
    let requests = 0;
    const h = await Fixture(vi.fn(async () => {
      requests++;
      if (requests === 1) return new Response('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"saved-once","type":"function","function":{"name":"SaveJob","arguments":"{}"}}]},"finish_reason":"tool_calls"}]}\n\ndata: [DONE]\n\n');
      if (requests < 4) return new Response('data: {"choices":[{"delta":{"content":"失败片段"}}]}\n\n');
      return new Response('{"choices":[{"message":{"content":"已恢复汇报"},"finish_reason":"stop"}]}');
    }));
    const kernel = CreateKernelHarness({ tools: [CreateRegisteredTool('SaveJob', { sideEffect: 'local_write' })] });
    kernel.modules.modelProvider = h.provider; kernel.input.provider = 'MIMO'; kernel.input.model = 'mimo-v2.6-flash';
    await expect(RunAgentLoop(kernel.input)).resolves.toMatchObject({ outcome: 'completed' });
    expect(kernel.modules.tools.ExecuteToolCall).toHaveBeenCalledOnce();
    expect(kernel.events.find(event => event.type === 'completed')?.content).toBe('已恢复汇报');
  });
  it('DONE 后立即结束并释放连接，不等待服务器断开', async () => {
    const cancel = vi.fn(); const body = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"完成"}}]}\n\ndata: [DONE]\n\n')); }, cancel });
    const h = await Fixture(vi.fn(async () => new Response(body)));
    await expect(h.provider.StreamCompletion(h.input)).resolves.toMatchObject({ content: '完成' }); expect(cancel).toHaveBeenCalledOnce();
  });
  it('完整的无换行尾块可读取，任何半截工具或 length 截断不得执行', async () => {
    const h = await Fixture(vi.fn(async () => new Response('data: {"choices":[{"delta":{"content":"完整尾块"},"finish_reason":"stop"}]}')));
    await expect(h.provider.StreamCompletion(h.input)).resolves.toMatchObject({ content: '完整尾块' });
    const broken = await Fixture(vi.fn(async () => new Response('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"first","function":{"name":"Read","arguments":"{}"}},{"index":1,"id":"second","function":{"arguments":"{"}}]}}]}\n\ndata: [DONE]\n\n')), { maxAttempts: 1 });
    await expect(broken.provider.StreamCompletion(broken.input)).rejects.toMatchObject({ code: 'PROTOCOL_INCOMPLETE_TOOL_CALL' });
    const truncated = await Fixture(vi.fn(async () => new Response('data: {"choices":[{"delta":{"content":"partial"},"finish_reason":"length"}]}\n\n')));
    await expect(truncated.provider.StreamCompletion(truncated.input)).rejects.toMatchObject({ code: 'PROVIDER_OUTPUT_TRUNCATED' });
  });
  it('支持 UTF-8 分片和多行 data，不因标准 SSE 分帧触发重试', async () => {
    const bytes = new TextEncoder().encode('event: message\ndata: {"choices":\ndata: [{"delta":{"content":"中文回复"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
    const body = new ReadableStream({ start(controller) { for (let i = 0; i < bytes.length; i += 7) controller.enqueue(bytes.slice(i, i + 7)); controller.close(); } });
    const fetcher = vi.fn(async () => new Response(body)); const h = await Fixture(fetcher);
    await expect(h.provider.StreamCompletion(h.input)).resolves.toMatchObject({ content: '中文回复' }); expect(fetcher).toHaveBeenCalledOnce();
  });
  it('重试耗尽保持诊断码，摘要同样使用恢复机制', async () => {
    const fetcher = vi.fn(async () => new Response('{}', { status: 502 })); const h = await Fixture(fetcher);
    await expect(h.provider.StreamCompletion(h.input)).rejects.toMatchObject({ code: 'PROVIDER_HTTP_ERROR', status: 502, retryable: false }); expect(fetcher).toHaveBeenCalledTimes(3);
    const summaryFetch = vi.fn().mockRejectedValueOnce(new TypeError('fetch failed')).mockImplementation(async () => new Response('{"choices":[{"message":{"content":"摘要"},"finish_reason":"stop"}]}'));
    const summary = await Fixture(summaryFetch);
    await expect(summary.provider.CreateSummary('MIMO', 'mimo-v2.6-flash', [], undefined, { signal: summary.controller.signal })).resolves.toMatchObject({ content: '摘要' });
    expect(summaryFetch).toHaveBeenCalledTimes(2);
  });
  it('智谱降级移除流式专用参数，保留 low 思考配置', async () => {
    const bodies: Record<string, unknown>[] = [];
    const h = await Fixture(vi.fn(async (_url, init) => {
      const body = JSON.parse(String(init?.body)); bodies.push(body);
      return body.stream ? new Response('data: {broken}\n\n') : new Response('{"choices":[{"message":{"content":"完整回复"},"finish_reason":"stop"}]}');
    }));
    await h.provider.Configure({ provider: 'Z.AI', model: 'glm-5.3-flash', apiKey: 'fixture-secret', thinkingEnabled: true });
    await expect(h.provider.StreamCompletion({ ...h.input, provider: 'Z.AI', model: 'glm-5.3-flash', reasoningEffort: 'low' })).resolves.toMatchObject({ content: '完整回复' });
    expect(bodies.map(body => body.reasoning_effort)).toEqual(['low', 'low', 'low']);
    expect(bodies[0].tool_stream).toBe(true); expect(bodies[2].tool_stream).toBeUndefined();
    expect(bodies[2].stream).toBe(false);
  });
});
