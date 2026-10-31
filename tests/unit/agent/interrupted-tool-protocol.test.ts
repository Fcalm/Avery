import { describe, expect, it, vi } from 'vitest';
import type { AgentMessage } from '../../../packages/agent-sdk/src';
import { RunAgentLoop } from '../../../packages/agent-core/src/kernel';
import { CreateKernelHarness, CreateRegisteredTool } from './test-helpers';
import { CreateProviderModule } from '../../../packages/agent-modules-defaults/src/provider';
import { BuildDefaultCompiledInstructions } from '../../../packages/agent-modules-defaults/src/prompts';
import { afterEach } from 'vitest';

afterEach(() => vi.unstubAllGlobals());

const call = { id: 'interrupted-browser', type: 'function' as const, function: { name: 'BrowserNavigate', arguments: '{"url":"https://example.test/form"}' } };

describe('中断工具协议恢复', () => {
  it('首次模型请求前的观察被取消时，保留已接受输入且不发送迟到观察', async () => {
    const controller = new AbortController();
    const harness = CreateKernelHarness({ signal: controller.signal });
    harness.input.prepareBrowserObservation = async () => {
      controller.abort();
      return { role: 'user', content: '<runtime-context>迟到观察</runtime-context>', metadata: { source: 'runtime', visibility: 'hidden', kind: 'runtime_context' } };
    };
    expect(await RunAgentLoop(harness.input)).toMatchObject({ outcome: 'cancelled' });
    expect(harness.modules.modelProvider.StreamCompletion).not.toHaveBeenCalled();
    expect(harness.input.histories.get('session-1')?.some((message) => message.content === 'test request')).toBe(true);
    expect(JSON.stringify(harness.input.histories.get('session-1'))).not.toContain('迟到观察');
  });
  it('前一阶段已确认的结果保留，取消后迟到的成功不能伪造已完成状态', async () => {
    const controller = new AbortController();
    const read = { ...call, id: 'read-first', function: { name: 'Read', arguments: '{}' } };
    const write = { ...call, id: 'write-late', function: { name: 'Write', arguments: '{}' } };
    const harness = CreateKernelHarness({ signal: controller.signal, tools: [CreateRegisteredTool('Read'), CreateRegisteredTool('Write', { sideEffect: 'local_write', isConcurrencySafe: false })],
      completions: [{ content: '', toolCalls: [read, write] }],
      executeTool: async (current) => {
        if (current.id === write.id) { controller.abort(); return { role: 'tool', tool_call_id: current.id, content: '{"ok":true,"receipt":"late-uncommitted"}' }; }
        return { role: 'tool', tool_call_id: current.id, content: '{"ok":true,"fact":"confirmed-before-cancel"}' };
      },
    });
    const result = await RunAgentLoop(harness.input);
    expect(result.transcript.find((message) => message.tool_call_id === read.id)?.content).toContain('confirmed-before-cancel');
    const late = result.transcript.find((message) => message.tool_call_id === write.id)!;
    expect(JSON.parse(late.content)).toMatchObject({ ok: false, status: 'unknown', code: 'TOOL_RESULT_MISSING' });
    expect(late.content).not.toContain('late-uncommitted');
  });

  it('工具调用预算耗尽也补齐未执行回执，后续重试不带悬空调用', async () => {
    const harness = CreateKernelHarness({ tools: [CreateRegisteredTool('BrowserNavigate')], completions: [{ content: '', toolCalls: [call] }] });
    harness.input.scenario.budgets!.maxToolCalls = 0;
    const result = await RunAgentLoop(harness.input);
    expect(result.outcome).toBe('circuit_open');
    expect(JSON.parse(result.transcript.find((message) => message.tool_call_id === call.id)!.content)).toMatchObject({ ok: false, executed: false });
    expect(harness.modules.tools.ExecuteToolCall).not.toHaveBeenCalled();
  });
  it('工具执行期间取消也必须结算调用，不能留下缺失回执的历史', async () => {
    const controller = new AbortController();
    const harness = CreateKernelHarness({ signal: controller.signal, tools: [CreateRegisteredTool('BrowserNavigate')],
      completions: [{ content: '', toolCalls: [call] }],
      executeTool: async () => { controller.abort(); return { role: 'tool', tool_call_id: call.id, content: '{"ok":false,"code":"CANCELLED"}' }; },
    });
    const result = await RunAgentLoop(harness.input);
    expect(result.outcome).toBe('cancelled');
    const receipt = result.transcript.find((message) => message.tool_call_id === call.id);
    expect(receipt).toBeDefined();
    expect(JSON.parse(receipt!.content)).toMatchObject({ ok: false });
    expect(result.transcript.filter((message) => message.tool_call_id === call.id)).toHaveLength(1);
  });

  it('已有缺失回执夹在重试消息前时恢复协议，不重复执行旧动作，不删除用户历史', async () => {
    const history: AgentMessage[] = [
      { role: 'user', content: '打开表单，不提交' },
      { role: 'assistant', content: '', reasoning_content: '准备打开页面', tool_calls: [call] },
      { role: 'user', content: '再次尝试' },
      { role: 'user', content: '再次尝试' },
    ];
    const original = JSON.stringify(history);
    const harness = CreateKernelHarness({ history, tools: [CreateRegisteredTool('BrowserNavigate')],
      streamCompletion: vi.fn(async ({ history: messages }) => {
        const index = messages.findIndex((message) => message.tool_calls?.some((item) => item.id === call.id));
        expect(messages[index + 1]).toMatchObject({ role: 'tool', tool_call_id: call.id });
        expect(JSON.parse(messages[index + 1].content)).toMatchObject({ ok: false });
        expect(messages.filter((message) => message.content === '再次尝试')).toHaveLength(2);
        return { content: '请先核对页面状态，旧动作不会自动重放。', toolCalls: [] };
      }),
    });
    await RunAgentLoop(harness.input);
    expect(harness.modules.tools.ExecuteToolCall).not.toHaveBeenCalled();
    expect(JSON.stringify(history)).toBe(original);
  });
});

describe('供应商错误详情', () => {
  it.each(['completion', 'summary'])('%s 保留协议错误原因，脱敏凭据', async (kind) => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: { message: 'tool_calls 缺少回执；key=test-private-key; Bearer bearer-private-value' } }), { status: 400 })));
    const provider = CreateProviderModule({ getConfig: async () => ({ provider: 'DeepSeek', model: 'deepseek-flash', baseUrl: 'https://api.deepseek.com', apiKey: 'test-private-key', thinkingEnabled: true, contextLimit: 256000, compressionThreshold: 80 }), saveConfig: async () => {}, getStoredSettings: async () => ({}) } as never);
    const request = kind === 'summary' ? provider.CreateSummary('DeepSeek', 'deepseek-flash', [{ role: 'user', content: '合成历史' }])
      : provider.StreamCompletion({ requestId: 'test', provider: 'DeepSeek', model: 'deepseek-flash', reasoningEffort: 'medium', instructions: BuildDefaultCompiledInstructions(), history: [{ role: 'user', content: '测试' }], tools: [], signal: new AbortController().signal, onDelta() {} });
    const error = await request.catch((value) => value as Error);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain('(400). tool_calls');
    expect(error.message).not.toContain('test-private-key');
    expect(error.message).not.toContain('bearer-private-value');
  });
});
