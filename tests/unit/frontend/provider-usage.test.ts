import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderAccountUsage } from '@avery/contracts';
import { ProviderUsageCard } from '../../../src/features/settings/components/ProviderUsagePanel';
import { CreateDemoSubscriptionUsage } from '../../../src/features/settings/components/providerUsageDemo';

const Render = (usage: ProviderAccountUsage) => renderToStaticMarkup(createElement(ProviderUsageCard, { usage, onOpenDashboard: vi.fn() }));
beforeEach(() => vi.stubGlobal('document', { baseURI: 'file:///D:/Avery/project/dist/index.html' }));
afterEach(() => vi.unstubAllGlobals());
describe('供应商用量卡片', () => {
  it('仅展示账户余额与账单入口，不保留无法查询的本月消费行', () => {
    const html = Render({ provider: 'DeepSeek', name: 'DeepSeek', billing: 'metered', status: 'ready', balances: [{ currency: 'CNY', amount: '0.00' }], dashboardUrl: 'https://platform.deepseek.com/usage' });
    expect(html).toContain('¥ 0.00'); expect(html).not.toContain('本月消费'); expect(html).not.toContain('接口未提供'); expect(html).toContain('查看账单');
  });
  it('隔离的订阅样本展示两个剩余额度窗口和重置时间', () => {
    const html = Render(CreateDemoSubscriptionUsage(new Date('2026-10-25T04:00:00Z')));
    expect(html).toContain('订阅演示'); expect(html).toContain('5 小时额度'); expect(html).toContain('月度额度');
    expect(html.match(/role="meter"/g)).toHaveLength(2);
    expect(html).toContain('aria-valuenow="72"'); expect(html).toContain('aria-valuenow="68"'); expect(html).toContain('重置');
    expect(html).not.toContain('查看账单'); expect(html).not.toContain('https://');
  });
  it('未知/越界额度不绘制无效进度，缺失重置时间不编造倒计时', () => {
    const usage = CreateDemoSubscriptionUsage();
    usage.quotaWindows = [{ id: 'a', label: '窗口 A', remainingPercent: 120, resetsAt: null }, { id: 'b', label: '窗口 B', remainingPercent: NaN, resetsAt: null }];
    const html = Render(usage);
    expect(html).toContain('aria-valuenow="100"'); expect(html).not.toContain('NaN'); expect(html).not.toContain('width:120'); expect(html).toContain('重置时间未提供');
  });
  it('查询失败展示原因与控制台入口，不展示零元或虚构额度', () => {
    const html = Render({ provider: 'MIMO', name: 'MiMo', billing: 'metered', status: 'unsupported', balances: [], message: '暂不支持余额查询', dashboardUrl: 'https://platform.xiaomimimo.com/console/balance' });
    expect(html).toContain('暂不支持余额查询'); expect(html).toContain('查看账单'); expect(html).not.toContain('0.00'); expect(html).not.toContain('role="meter"');
  });
  it('MiMo 未登录展示授权入口，授权失效可重新登录或断开，不要求修改 API Key', () => {
    const html = renderToStaticMarkup(createElement(ProviderUsageCard, { usage: { provider: 'MIMO', name: 'MiMo', billing: 'metered', status: 'needs_auth', balances: [], canDisconnect: true, message: 'MiMo 授权已失效，请重新登录。' }, onOpenDashboard: vi.fn(), onAuthorize: vi.fn(), onDisconnect: vi.fn() }));
    expect(html).toContain('重新登录'); expect(html).toContain('断开授权'); expect(html).not.toContain('API Key'); expect(html).not.toContain('0.00');
  });
});
