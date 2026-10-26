import { afterEach, describe, expect, it, vi } from 'vitest';
import { GetProviderUsage } from '../../../src/features/assistant/api/agentQueries';

afterEach(() => vi.unstubAllGlobals());
describe('多供应商用量查询', () => {
  it('MiMo 通过主进程隔离账户服务查询，GLM/DeepSeek 保留后端结果', async () => {
    const glm = { provider: 'Z.AI', name: 'GLM', billing: 'metered', status: 'ready', balances: [{ currency: 'CNY', amount: '10' }] };
    const ReadMimoAccountUsage = vi.fn(async () => ({ ok: true, data: { provider: 'MIMO', name: 'MiMo', billing: 'metered', status: 'ready', balances: [{ currency: 'CNY', amount: '20' }], canDisconnect: true } }));
    vi.stubGlobal('window', { averyAgent: { GetProviderUsage: vi.fn(async () => ({ providers: [glm, { provider: 'MIMO', status: 'needs_auth', balances: [] }], checkedAt: '2026-10-25T00:00:00Z' })) }, averyWindow: { ReadMimoAccountUsage } });
    const result = await GetProviderUsage();
    expect(result.providers).toEqual([glm, expect.objectContaining({ provider: 'MIMO', status: 'ready', balances: [{ currency: 'CNY', amount: '20' }] })]);
    expect(ReadMimoAccountUsage).toHaveBeenCalledExactlyOnceWith();
  });
  it('未配置 MiMo 不读取任何网页登录态', async () => {
    const ReadMimoAccountUsage = vi.fn();
    vi.stubGlobal('window', { averyAgent: { GetProviderUsage: vi.fn(async () => ({ providers: [], checkedAt: '2026-10-25T00:00:00Z' })) }, averyWindow: { ReadMimoAccountUsage } });
    expect((await GetProviderUsage()).providers).toEqual([]); expect(ReadMimoAccountUsage).not.toHaveBeenCalled();
  });
  it('MiMo 桥接失败保留其它供应商的余额，并显示可操作的错误', async () => {
    const glm = { provider: 'Z.AI', status: 'ready', balances: [{ currency: 'CNY', amount: '10' }] };
    vi.stubGlobal('window', { averyAgent: { GetProviderUsage: vi.fn(async () => ({ providers: [glm, { provider: 'MIMO', status: 'needs_auth', balances: [] }] })) } });
    const result = await GetProviderUsage(); expect(result.providers[0]).toEqual(glm);
    expect(result.providers[1]).toMatchObject({ status: 'error', balances: [], message: '请重启 Avery 后查看 MiMo 余额。' });
  });
});
