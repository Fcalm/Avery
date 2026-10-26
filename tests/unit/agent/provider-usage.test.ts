import { afterEach, describe, expect, it, vi } from 'vitest';
import { QueryProviderAccountUsage } from '../../../packages/agent-modules-defaults/src/provider-usage';
import { CreateProviderModule } from '../../../packages/agent-modules-defaults/src/provider';
import type { AgentDefaultPorts, ProviderConfig } from '../../../packages/agent-modules-defaults/src/ports';

afterEach(() => vi.unstubAllGlobals());
const BalanceResponse = (amount: unknown = '0.00', available = false) => Response.json({ is_available: available, balance_infos: [{ currency: 'CNY', total_balance: amount }] });
const Config = (provider: string): ProviderConfig => ({ provider, apiKey: `${provider}-secret`, model: provider === 'MIMO' ? 'mimo-v2.6-flash' : provider === 'Z.AI' ? 'glm-5.3-flash' : 'deepseek-v4-flash', baseUrl: '', thinkingEnabled: true, contextLimit: 256000, compressionThreshold: 80 });

describe('供应商账户用量', () => {
  it('余额不足调用时仍展示真实零余额，不把余额当作本月消费', async () => {
    const fetcher = vi.fn(async () => BalanceResponse());
    const result = await QueryProviderAccountUsage('DeepSeek', 'private-key', fetcher);
    expect(result).toMatchObject({ status: 'ready', balances: [{ currency: 'CNY', amount: '0.00' }] });
    expect(result.monthlySpend).toBeUndefined();
    expect(fetcher).toHaveBeenCalledWith('https://api.deepseek.com/user/balance', expect.objectContaining({ method: 'GET', headers: { Authorization: 'Bearer private-key', Accept: 'application/json' }, redirect: 'error' }));
    expect(JSON.stringify(result)).not.toContain('private-key');
  });

  it('中国区 GLM 使用账户报表接口，而非推理路径下的 DeepSeek 兼容地址', async () => {
    const fetcher = vi.fn(async () => Response.json({ success: true, data: { availableBalance: '12.50', totalSpendAmount: '200.00' } }));
    await QueryProviderAccountUsage('Z.AI', 'glm-secret', fetcher);
    expect(fetcher.mock.calls).toEqual([
      ['https://open.bigmodel.cn/api/biz/account/query-customer-account-report', expect.objectContaining({ headers: { Authorization: 'Bearer glm-secret', Accept: 'application/json' }, redirect: 'error' })],
    ]);
  });

  it('MiMo 的模型 API Key 不能用于控制台余额查询，后端不发送猜测请求', async () => {
    const fetcher = vi.fn();
    expect(await QueryProviderAccountUsage('MIMO', 'mimo-secret', fetcher)).toMatchObject({ status: 'needs_auth', balances: [] });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each(['0', '0E-9', '-0.01', '12.50'])('GLM 接受真实可用余额 %s，不把累计消费当作月消费', async (amount) => {
    const result = await QueryProviderAccountUsage('Z.AI', 'secret', vi.fn(async () => Response.json({ success: true, data: { availableBalance: amount, totalSpendAmount: '200.00' } })));
    expect(result).toMatchObject({ status: 'ready', balances: [{ currency: 'CNY', amount }] });
    expect(result.monthlySpend).toBeUndefined();
  });

  it.each([
    { success: false, data: { availableBalance: '10' } },
    { success: true, data: { availableBalance: null } },
    { success: true, data: { availableBalance: '' } },
    { success: true, data: { totalSpendAmount: '50' } },
  ])('GLM 拒绝业务失败或缺失可用余额：%j', async (body) => {
    const result = await QueryProviderAccountUsage('Z.AI', 'secret', vi.fn(async () => Response.json(body)));
    expect(result.status).toBe('error'); expect(result.balances).toEqual([]);
  });

  it.each([null, '', false, 'NaN', 'Infinity', {}, []])('拒绝无效余额 %j，避免空值变成零余额', async (amount) => {
    const result = await QueryProviderAccountUsage('DeepSeek', 'secret', vi.fn(async () => BalanceResponse(amount)));
    expect(result.status).toBe('error');
    expect(result.balances).toEqual([]);
  });

  it.each([404, 405, 501])('接口返回 %i 时说明不支持，不编造账户数据', async (status) => {
    const result = await QueryProviderAccountUsage('Z.AI', 'secret', vi.fn(async () => new Response('', { status })));
    expect(result.status).toBe('unsupported');
    expect(result.balances).toEqual([]);
  });

  it('鉴权失败、畸形响应与网络错误均不泄漏响应内容或凭据', async () => {
    for (const fetcher of [vi.fn(async () => new Response('private-key', { status: 401 })), vi.fn(async () => new Response('<html>private-key</html>')), vi.fn(async () => { throw new Error('private-key'); })]) {
      const result = await QueryProviderAccountUsage('DeepSeek', 'private-key', fetcher);
      expect(result.status).toBe('error');
      expect(JSON.stringify(result)).not.toContain('private-key');
    }
  });

  it('自定义供应商不发出未经定义的账户请求', async () => {
    const fetcher = vi.fn();
    expect((await QueryProviderAccountUsage('自定义', 'secret', fetcher)).status).toBe('unsupported');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('当前模型为 MiMo 时仍查询所有已配置供应商，单家失败不影响其它结果', async () => {
    const fetcher = vi.fn(async (url: string | URL | Request) => String(url).includes('deepseek') ? BalanceResponse('42.30', true) : new Response('', { status: 404 }));
    vi.stubGlobal('fetch', fetcher);
    const provider = CreateProviderModule({ getConfig: async () => ({ ...Config('MIMO'), providerConfigs: { DeepSeek: Config('DeepSeek'), MIMO: Config('MIMO'), 'Z.AI': { ...Config('Z.AI'), apiKey: '' } } }) } as AgentDefaultPorts);
    const result = await provider.GetProviderUsage!();
    expect(result.providers).toHaveLength(2);
    expect(result.providers.find((item) => item.provider === 'DeepSeek')).toMatchObject({ status: 'ready', balances: [{ amount: '42.30' }] });
    expect(result.providers.find((item) => item.provider === 'MIMO')?.status).toBe('needs_auth');
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result)).not.toContain('-secret');
  });

  it('没有配置凭据时返回空列表，不调用网络', async () => {
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    const provider = CreateProviderModule({ getConfig: async () => null } as AgentDefaultPorts);
    expect((await provider.GetProviderUsage!()).providers).toEqual([]);
    expect(fetcher).not.toHaveBeenCalled();
  });
});
