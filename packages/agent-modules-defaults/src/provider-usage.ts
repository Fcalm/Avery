import type { ProviderAccountUsage, ProviderAmount } from '@avery/agent-sdk';

/** 只访问已知官方地址，禁止把其它供应商的凭据交给 DeepSeek 或任意自定义地址。 */
export const AccountUsageEndpoints = {
  DeepSeek: { name: 'DeepSeek', endpoint: 'https://api.deepseek.com/user/balance', dashboardUrl: 'https://platform.deepseek.com/usage' },
  MIMO: { name: 'MiMo', dashboardUrl: 'https://platform.xiaomimimo.com/#/console/balance' },
  'Z.AI': { name: 'GLM', endpoint: 'https://open.bigmodel.cn/api/biz/account/query-customer-account-report', dashboardUrl: 'https://open.bigmodel.cn/finance-center/finance/overview' },
} as const;

/** 仅接受明确的金额字符串/数值；null、空字符串和非有限数不能被 Number 转成虚假的零余额。 */
function ParseAmount(value: unknown): string | null {
  if ((typeof value !== 'string' && typeof value !== 'number') || !/^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(String(value)) || !Number.isFinite(Number(value))) return null;
  return String(value);
}

function ParseBalances(json: unknown): ProviderAmount[] | null {
  if (!json || typeof json !== 'object' || !('balance_infos' in json) || !Array.isArray(json.balance_infos) || json.balance_infos.length === 0) return null;
  const balances: ProviderAmount[] = [];
  for (const item of json.balance_infos) {
    if (!item || typeof item !== 'object' || typeof item.currency !== 'string' || !/^[A-Z]{3}$/.test(item.currency)) return null;
    const amount = ParseAmount(item.total_balance);
    if (amount === null) return null;
    balances.push({ currency: item.currency, amount });
  }
  return balances;
}

/**
 * DeepSeek 使用公开余额接口；GLM 使用国内账户报表接口，累计消费不能解释为月消费。
 * MiMo 需要控制台 Cookie，交由主进程的隔离会话查询，绝不把模型 API Key 当成登录凭据。
 * 禁止跟随重定向，且不输出上游响应正文，避免密钥跨域或进入界面/日志。
 */
export async function QueryProviderAccountUsage(provider: string, apiKey: string, fetcher: typeof fetch): Promise<ProviderAccountUsage> {
  if (!Object.hasOwn(AccountUsageEndpoints, provider)) return { provider, name: provider, billing: 'unknown', status: 'unsupported', balances: [], message: '该供应商暂未提供账户用量查询。' };
  const source = AccountUsageEndpoints[provider as keyof typeof AccountUsageEndpoints];
  const base = { provider, name: source.name, billing: 'metered' as const, balances: [], dashboardUrl: source.dashboardUrl };
  if (!('endpoint' in source)) return { ...base, status: 'needs_auth', message: '登录 MiMo 控制台后可查看余额。' };
  try {
    const response = await fetcher(source.endpoint, {
      method: 'GET', headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
      redirect: 'error', signal: AbortSignal.timeout(15000),
    });
    if ([404, 405, 501].includes(response.status)) return { ...base, status: 'unsupported', message: '暂不支持余额查询，请前往控制台查看。' };
    if (!response.ok) return { ...base, status: 'error', message: response.status === 401 || response.status === 403 ? '查询未获授权，请检查该供应商的 API Key。' : `查询失败（${response.status}），请稍后刷新。` };
    let json: unknown;
    try { json = await response.json(); }
    catch { return { ...base, status: 'error', message: '接口未返回有效的余额数据。' }; }
    if (provider === 'Z.AI') {
      if (!json || typeof json !== 'object' || !('success' in json) || json.success !== true || !('data' in json) || !json.data || typeof json.data !== 'object') return { ...base, status: 'error', message: 'GLM 账户查询未成功，请检查 API Key 或前往控制台查看。' };
      const amount = ParseAmount('availableBalance' in json.data ? json.data.availableBalance : undefined);
      if (amount === null) return { ...base, status: 'error', message: 'GLM 未返回有效的可用余额。' };
      return { ...base, status: 'ready', balances: [{ currency: 'CNY', amount }], updatedAt: new Date().toISOString() };
    }
    const balances = ParseBalances(json);
    if (!balances) return { ...base, status: 'error', message: '接口返回的余额格式暂不支持，请前往控制台查看。' };
    // is_available=false 只说明余额不足以调用 API，仍须展示供应商返回的真实零/负余额。
    return { ...base, status: 'ready', balances, updatedAt: new Date().toISOString() };
  } catch {
    return { ...base, status: 'error', message: '连接失败或查询超时，请稍后刷新。' };
  }
}
