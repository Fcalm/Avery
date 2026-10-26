/** 供应商账户的金额；保留十进制字符串，展示层不得把余额推算为月消费。 */
export interface ProviderAmount { currency: string; amount: string }

/** 供应商返回的订阅窗口；百分比表示剩余，重置时刻使用带时区的 ISO 时间。 */
export interface ProviderQuotaWindow {
  id: string;
  label: string;
  remainingPercent: number;
  resetsAt: string | null;
}

/** 脱敏的账户用量快照；各供应商独立失败，不返回凭据或上游响应正文。 */
export interface ProviderAccountUsage {
  provider: string;
  name: string;
  billing: 'metered' | 'subscription' | 'unknown';
  status: 'ready' | 'needs_auth' | 'unsupported' | 'error';
  /** 登录会话仅存在于主进程；界面只能据此提供断开授权入口。 */
  canDisconnect?: boolean;
  balances: ProviderAmount[];
  monthlySpend?: ProviderAmount;
  quotaWindows?: ProviderQuotaWindow[];
  message?: string;
  dashboardUrl?: string;
  updatedAt?: string;
}

export interface ProviderUsageSnapshot {
  providers: ProviderAccountUsage[];
  checkedAt: string;
}
