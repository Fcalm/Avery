import { describe, expect, it, vi } from 'vitest';
import { CreateProviderModule } from '../../../packages/agent-modules-defaults/src/provider';
import { ResolveBundledModelCapabilities, type ResolvedModelConfiguration } from '../../../packages/agent-sdk/src/index';
import { CreateRegisteredTool } from './test-helpers';

function Configuration(): ResolvedModelConfiguration {
  const values = { ...ResolveBundledModelCapabilities('DeepSeek', 'deepseek-flash')!, contextWindow: 128000, maxOutput: 2048, thinking: false };
  return { provider: 'DeepSeek', model: 'deepseek-flash', baseUrl: 'https://api.deepseek.com', values, inherited: values, overrides: { maxOutput: 2048, thinking: false }, source: 'directory', revision: 1, verified: false };
}

describe('Provider 消费同一生效模型能力', () => {
  it.each(['completion', 'summary'] as const)('%s 在窗口不足以容纳最大输出时缩减预算，输入已超限则不发请求', async (kind) => {
    const configuration = Configuration();
    configuration.values = { ...configuration.values, contextWindow: 12000, maxOutput: 8192 };
    const bodies: Record<string, unknown>[] = [];
    const originalFetch = globalThis.fetch;
    const request = vi.fn(async (_url, options) => {
      const body = JSON.parse(String(options?.body));
      bodies.push(body);
      return body.stream
        ? new Response('data: {"choices":[{"delta":{"content":"OK"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
        : new Response(JSON.stringify({ choices: [{ message: { content: '摘要完成' } }] }));
    });
    vi.stubGlobal('fetch', request);
    try {
      const provider = CreateProviderModule({ getConfig: async () => null, saveConfig: async () => undefined,
        getStoredSettings: async () => ({}), resolveModelConfiguration: () => configuration } as never);
      await provider.Configure({ provider: 'DeepSeek', model: 'deepseek-flash', apiKey: 'test-key' });
      const run = (content: string) => kind === 'summary'
        ? provider.CreateSummary('DeepSeek', 'deepseek-flash', [{ role: 'user', content }], undefined, { modelConfiguration: configuration })
        : provider.StreamCompletion({ requestId: 'context-budget', provider: 'DeepSeek', model: 'deepseek-flash',
          modelConfiguration: configuration, tools: [], signal: new AbortController().signal, onDelta: vi.fn(),
          instructions: { compiled: 'test' } as never, history: [{ role: 'user', content }] });
      await run('中'.repeat(5500));
      const body = bodies[0];
      expect(body.max_tokens).toBeGreaterThan(0);
      expect(body.max_tokens).toBeLessThan(configuration.values.maxOutput);
      expect(provider.EstimateTokens(body.messages) + Number(body.max_tokens)).toBeLessThan(configuration.values.contextWindow);
      await expect(run('中'.repeat(14000))).rejects.toThrow(/预算|budget/);
      expect(request).toHaveBeenCalledTimes(1);
    } finally { vi.stubGlobal('fetch', originalFetch); }
  });

  it('图片块、思考开关与输出上限均使用冻结配置，后续目录变化不改变请求', async () => {
    let current = Configuration();
    const bodies: Record<string, any>[] = [];
    const originalFetch = globalThis.fetch;
    const request = vi.fn(async (_url, options) => {
      bodies.push(JSON.parse(String(options?.body)));
      if (!bodies.at(-1)!.stream) return new Response(JSON.stringify({ choices: [{ message: { content: '摘要完成' } }] }));
      return new Response('data: {"choices":[{"delta":{"content":"OK"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
    });
    vi.stubGlobal('fetch', request);
    try {
      const provider = CreateProviderModule({ getConfig: async () => null, saveConfig: async () => undefined, getStoredSettings: async () => ({}),
        resolveModelConfiguration: () => current } as never);
      await provider.Configure({ provider: 'DeepSeek', model: 'deepseek-flash', apiKey: 'test-key', thinkingEnabled: true, contextLength: '128K', contextLimitMode: 'custom' });
      const frozen = structuredClone(current);
      current = { ...current, values: { ...current.values, inputImage: false, maxOutput: 4096, thinking: true } };
      const input = { requestId: 'frozen-capabilities', provider: 'DeepSeek', model: 'deepseek-flash', reasoningEffort: 'medium' as const,
        modelConfiguration: frozen, tools: [], signal: new AbortController().signal, onDelta: vi.fn(),
        instructions: { compiled: 'test' } as never,
        history: [{ role: 'user' as const, content: '图片内容', providerContent: [{ type: 'image_url' as const, image_url: { url: 'data:image/png;base64,aGVsbG8=' } }] }],
      };
      await provider.StreamCompletion(input);
      expect(bodies[0]).toMatchObject({ max_tokens: 2048, thinking: { type: 'disabled' } });
      expect(bodies[0].messages[1].content[0].type).toBe('image_url');
      await provider.CreateSummary('DeepSeek', 'deepseek-flash', [{ role: 'user', content: '需要摘要' }], undefined, { modelConfiguration: frozen });
      expect(bodies[1]).toMatchObject({ max_tokens: 2048, thinking: { type: 'disabled' } });
      await expect(provider.StreamCompletion({ ...input, modelConfiguration: current })).rejects.toThrow('不支持图片');
      await expect(provider.StreamCompletion({ ...input, history: [], tools: [CreateRegisteredTool('Read')], modelConfiguration: { ...frozen, values: { ...frozen.values, toolCall: false } } })).rejects.toThrow('不支持工具');
      await expect(provider.StreamCompletion({ ...input, modelConfiguration: { ...frozen, baseUrl: 'https://another.example/v1' } })).rejects.toThrow('接口配置已改变');
      expect(request).toHaveBeenCalledTimes(2);
    } finally { vi.stubGlobal('fetch', originalFetch); }
  });
});
