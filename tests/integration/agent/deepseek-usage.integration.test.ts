import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { AgentDefaultPorts, ProviderConfig } from '../../../packages/agent-modules-defaults/src/ports';
import { CreateProviderModule, DefaultBaseUrl } from '../../../packages/agent-modules-defaults/src/provider';
import { BuildDefaultCompiledInstructions } from '../../../packages/agent-modules-defaults/src/prompts';

const liveRequested = process.env.OFFERGET_DEEPSEEK_LIVE === '1';

/** 真实计费联调只在显式开关开启时执行；避免普通测试意外消耗额度或依赖外网。 */
describe.skipIf(!liveRequested)('DeepSeek real usage integration', () => {
  it('真实响应返回完整且自洽的 Provider usage', async () => {
    const apiKey = process.env.DEEPSEEK_API_KEY?.trim();
    expect(apiKey, 'OFFERGET_DEEPSEEK_LIVE=1 时必须提供 DEEPSEEK_API_KEY').toBeTruthy();
    const model = process.env.OFFERGET_DEEPSEEK_MODEL?.trim() || 'deepseek-v4-flash';
    const config: ProviderConfig = {
      provider: 'DeepSeek', baseUrl: DefaultBaseUrl, model, thinkingEnabled: false,
      contextLimit: 64_000, compressionThreshold: 80, apiKey: apiKey!,
    };
    const ports = {
      getConfig: async () => config,
      saveConfig: async () => undefined,
      getStoredSettings: async () => ({}),
    } as AgentDefaultPorts;
    const provider = CreateProviderModule(ports);

    const result = await provider.StreamCompletion({
      requestId: randomUUID(),
      model,
      history: [{ role: 'user', content: '只回复 OK。' }],
      tools: [],
      signal: AbortSignal.timeout(30_000),
      instructions: { ...BuildDefaultCompiledInstructions(), compiled: 'Follow the user instruction exactly.' },
      onDelta: () => undefined,
    });

    expect(result.usage).toEqual({
      promptTokens: expect.any(Number),
      completionTokens: expect.any(Number),
      totalTokens: expect.any(Number),
    });
    expect(Number.isSafeInteger(result.usage?.promptTokens)).toBe(true);
    expect(Number.isSafeInteger(result.usage?.completionTokens)).toBe(true);
    expect(result.usage?.totalTokens).toBe((result.usage?.promptTokens ?? -1) + (result.usage?.completionTokens ?? -1));
  }, 35_000);
});
