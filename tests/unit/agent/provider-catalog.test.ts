import { afterEach, describe, expect, it, vi } from 'vitest';
import { CreateProviderModule } from '../../../packages/agent-modules-defaults/src/provider';

afterEach(() => { vi.unstubAllGlobals(); });

describe('供应商目录的读取与同步', () => {
  it('读取已配置目录无需联网，显式获取模型时才访问厂商接口', async () => {
    const fetch = vi.fn(async (_input: string | URL | Request) => new Response(JSON.stringify({ data: [{ id: 'deepseek-v4-pro' }] }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetch);
    const provider = CreateProviderModule({
      getConfig: async () => ({
        provider: 'DeepSeek', model: 'deepseek-v4-flash', baseUrl: 'https://api.deepseek.com', apiKey: 'test-key',
        thinkingEnabled: true, contextLimit: 256000, contextLimitMode: 'default', compressionThreshold: 80,
      }),
      saveConfig: async () => undefined,
      getStoredSettings: async () => ({}),
    });

    const catalog = await provider.GetProviderCatalog();
    expect(catalog.providers.find((item) => item.provider === 'DeepSeek')).toMatchObject({
      configured: true, model: 'deepseek-v4-flash', models: expect.arrayContaining(['deepseek-v4-flash']),
    });
    expect(catalog.providers.find((item) => item.provider === 'MIMO')).toMatchObject({ configured: false, models: [] });
    expect(fetch).not.toHaveBeenCalled();

    await expect(provider.GetModels('DeepSeek')).resolves.toEqual({ provider: 'DeepSeek', models: ['deepseek-v4-pro'] });
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0][0]).toBe('https://api.deepseek.com/models');
    await provider.GetProviderCatalog();
    expect(fetch).toHaveBeenCalledOnce();
  });
});
