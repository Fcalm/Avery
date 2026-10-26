import type { ProviderAccountUsage } from '@avery/contracts';

/** 隔离的订阅展示样本；只供开发环境开关和测试注入，不代表真实供应商或实际额度。 */
export function CreateDemoSubscriptionUsage(now = new Date()): ProviderAccountUsage {
  const nextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  return {
    provider: 'demo-subscription', name: '订阅演示', billing: 'subscription', status: 'ready', balances: [],
    message: '仅用于界面测试', updatedAt: now.toISOString(),
    quotaWindows: [
      { id: 'five-hours', label: '5 小时额度', remainingPercent: 72, resetsAt: new Date(now.getTime() + 5 * 60 * 60 * 1000).toISOString() },
      { id: 'monthly', label: '月度额度', remainingPercent: 68, resetsAt: nextMonth.toISOString() },
    ],
  };
}
