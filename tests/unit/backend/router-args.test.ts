import { describe, expect, it, vi } from 'vitest';
import { CreateBackend } from '../../../apps/backend/src/router';
import { AgentRunService } from '../../../apps/backend/src/electron/backend/services/agent-run-service';

/**
 * 读通道的业务参数必须原样到达服务方法：曾出现过 provider 参数在链路中丢失、
 * 服务端静默按 DeepSeek 处理，导致 MiMo 的模型列表混入 DeepSeek 模型。
 * 这里把 IPC → Router → 应用服务门面 → AgentHost 的参数转发钉死，防止回归。
 */
describe('Router 读通道参数转发', () => {
  it('供应商用量通过只读路由及服务门面读取', async () => {
    const GetProviderUsage = vi.fn(async () => ({ providers: [], checkedAt: '2026-10-25T00:00:00Z' }));
    const backend = CreateBackend({ container: { agent: new AgentRunService({ agentHost: { GetProviderUsage } }) } });
    const result = await backend.HandleCommand('agent:get-provider-usage', 'usage-1', undefined) as { ok: boolean };
    expect(result.ok).toBe(true); expect(GetProviderUsage).toHaveBeenCalledOnce();
  });
  it('agent:get-models 的 provider 参数穿过应用服务门面到达 AgentHost', async () => {
    const GetModels = vi.fn(async (provider?: unknown) => ({ provider, models: [] }));
    // 生产容器把 agent 注册为 AgentRunService 门面：门面漏转发参数时，这里会拿到 undefined（被当成 DeepSeek）。
    const backend = CreateBackend({ container: { agent: new AgentRunService({ agentHost: { GetModels } }) } });

    const result = await backend.HandleCommand('agent:get-models', 'req-1', undefined, 'MIMO') as { ok: boolean };

    expect(result.ok).toBe(true);
    expect(GetModels).toHaveBeenCalledOnce();
    expect(GetModels).toHaveBeenCalledWith('MIMO');
  });

  it('无参调用保持缺省语义，多参数通道按位置转发', async () => {
    const GetModels = vi.fn(async () => ({ provider: 'DeepSeek', models: [] }));
    const GetTraceEvents = vi.fn(async (...args: unknown[]) => ({ args }));
    const backend = CreateBackend({ container: { agent: { GetModels }, developer: { GetTraceEvents } } });

    await backend.HandleCommand('agent:get-models', 'req-2', undefined) as { ok: boolean };
    await backend.HandleCommand('agent:trace-events', 'req-3', undefined, 'trace-1') as { ok: boolean };

    expect(GetModels).toHaveBeenCalledOnce();
    expect(GetModels).toHaveBeenCalledWith();
    expect(GetTraceEvents).toHaveBeenCalledWith('trace-1');
  });

  it('应用服务门面暴露路由声明的全部方法：缺方法会让通道在运行时不可路由', async () => {
    const facade = new AgentRunService({ agentHost: {} }) as unknown as Record<string, unknown>;
    for (const method of ['GetModels', 'GetSessionScenes', 'GetProviderCatalog', 'GetStatus']) {
      expect(typeof facade[method]).toBe('function');
    }
  });
});
