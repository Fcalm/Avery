import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { ProviderAccountUsage, ProviderAmount, ProviderQuotaWindow } from '@avery/contracts';
import { GetProviderUsage, IsDesktopAgentAvailable } from '../../assistant/api/agentQueries';
import { Icon, type IconName } from '../../../shared/components/Icon';
import { platformClient, Unwrap } from '../../../shared/platform/platformClient';
import { useUiStore } from '../../../app/UiStore';
import { CreateDemoSubscriptionUsage } from './providerUsageDemo';

const ProviderIcons: Record<string, IconName> = { DeepSeek: 'deepseek', MIMO: 'mimo', 'Z.AI': 'zai' };
const BillingLabels = { metered: '账单制 · 按量付费', subscription: '额度制 · 订阅套餐', unknown: '账户用量' };

function FormatAmount(value: ProviderAmount) {
  const amount = Number(value.amount);
  return `${value.currency === 'CNY' ? '¥' : value.currency === 'USD' ? '$' : value.currency} ${Number.isFinite(amount) ? amount.toFixed(2) : '—'}`;
}

/** 重置时间按用户本地时区展示；没有供应商时间时不编造倒计时。 */
function ResetLabel(value: string | null) {
  if (!value || !Number.isFinite(Date.parse(value))) return '重置时间未提供';
  return `${new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(value))} 重置`;
}

function QuotaWindow({ window, provider }: { window: ProviderQuotaWindow; provider: string }) {
  const remaining = Number.isFinite(window.remainingPercent) ? Math.max(0, Math.min(100, window.remainingPercent)) : null;
  return <div className="pu-window">
    <div className="pu-metric"><span>{window.label}</span><strong className="pu-amount pu-quota">{remaining === null ? '—' : <>{Math.round(remaining)}<small>%</small></>}</strong></div>
    {remaining !== null && <div className="pu-track" role="meter" aria-label={`${provider} ${window.label}剩余额度`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={remaining} aria-valuetext={`剩余 ${remaining}%`}><span style={{ width: `${remaining}%` }} /></div>}
    <div className="pu-subrow"><span>剩余</span><span>{ResetLabel(window.resetsAt)}</span></div>
  </div>;
}

/** 纯展示卡片，可用隔离的测试快照覆盖订阅窗口，不依赖虚假模型配置。 */
export function ProviderUsageCard({ usage, onOpenDashboard, onAuthorize, onDisconnect, authorizing = false, disconnecting = false }: { usage: ProviderAccountUsage; onOpenDashboard: (provider: string) => void; onAuthorize?: () => void; onDisconnect?: () => void; authorizing?: boolean; disconnecting?: boolean }) {
  const subscription = usage.billing === 'subscription';
  const windows = usage.quotaWindows ?? [];
  return <article className={`pu-provider${subscription ? ' pu-subscription' : ''}`} aria-label={`${usage.name}用量`}>
    <header className="pu-provider-head"><Icon name={ProviderIcons[usage.provider] ?? 'cpu'} size={18} /><strong>{usage.name}</strong><span>{BillingLabels[usage.billing]}</span></header>
    {usage.status === 'ready' ? subscription ? <div className="pu-windows">{windows.length ? windows.map((window) => <QuotaWindow key={window.id} window={window} provider={usage.name} />) : <p className="pu-message">暂无可查询的额度窗口</p>}</div> : <>
      <div className="pu-metric"><span>账户余额</span><strong className="pu-amount">{usage.balances.length ? usage.balances.map(FormatAmount).join(' / ') : '—'}</strong></div>
    </> : <p className={`pu-message${usage.status === 'error' ? ' pu-error' : ''}`}>{usage.message ?? '暂时无法查询账户用量。'}</p>}
    {usage.provider === 'MIMO' && <div className="pu-auth-actions">
      {usage.status !== 'ready' && onAuthorize && <button className="pu-authorize" type="button" onClick={onAuthorize} disabled={authorizing || disconnecting}>{authorizing ? '等待登录…' : usage.canDisconnect ? '重新登录' : '登录授权'}</button>}
      {usage.canDisconnect && onDisconnect && <button type="button" onClick={onDisconnect} disabled={disconnecting}>{disconnecting ? '正在断开…' : '断开授权'}</button>}
    </div>}
    <footer className="pu-provider-foot"><span>{usage.updatedAt && Number.isFinite(Date.parse(usage.updatedAt)) ? `${new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(usage.updatedAt))} 更新` : '以供应商控制台为准'}</span>{usage.dashboardUrl && <button type="button" onClick={() => onOpenDashboard(usage.provider)}>{subscription ? '查看用量' : '查看账单'}<Icon name="arrow-right" size={12} /></button>}</footer>
  </article>;
}

/** 菜单打开时读取账户快照；关闭后不轮询、不请求模型列表，也不让单家失败清空其它卡片。 */
export function ProviderUsagePanel({ onConfigure }: { onConfigure: () => void }) {
  const { ShowNotice } = useUiStore();
  const queryClient = useQueryClient();
  const [authorizing, SetAuthorizing] = useState(false);
  const [disconnecting, SetDisconnecting] = useState(false);
  const desktop = IsDesktopAgentAvailable();
  const query = useQuery({ queryKey: ['provider-account-usage'], queryFn: GetProviderUsage, enabled: desktop, staleTime: 0, retry: false, refetchOnWindowFocus: false });
  const providers = [...(query.data?.providers ?? [])];
  // 仅显式开启的开发环境加入演示卡片；生产构建会消除此分支，不写入配置或数据库。
  if (import.meta.env.DEV && import.meta.env.VITE_PROVIDER_USAGE_DEMO === '1') providers.push(CreateDemoSubscriptionUsage());
  async function OpenDashboard(provider: string) {
    try { await Unwrap(platformClient.desktop.OpenProviderDashboard(provider)); }
    catch (error) { ShowNotice(error instanceof Error ? error.message : '无法打开供应商控制台。'); }
  }
  async function AuthorizeMimo() {
    SetAuthorizing(true);
    ShowNotice('请在 MiMo 窗口中完成登录，余额验证成功后窗口会自动关闭。');
    try {
      const result = await Unwrap(platformClient.desktop.OpenMimoAccountLogin());
      ShowNotice(result.authorized ? 'MiMo 登录成功，正在刷新余额。' : '登录窗口已关闭，正在检查授权状态。');
    } catch (error) { ShowNotice(error instanceof Error ? error.message : 'MiMo 登录失败，请稍后重试。'); }
    finally { SetAuthorizing(false); await queryClient.invalidateQueries({ queryKey: ['provider-account-usage'] }); }
  }
  async function DisconnectMimo() {
    SetDisconnecting(true);
    try {
      await Unwrap(platformClient.desktop.DisconnectMimoAccount());
      // 先移除缓存余额，再读取主进程的撤销结果，避免菜单重开时闪现旧授权数据。
      queryClient.setQueryData<Awaited<ReturnType<typeof GetProviderUsage>>>(['provider-account-usage'], (current) => current ? { ...current, providers: current.providers.map((provider) => provider.provider === 'MIMO' ? { ...provider, status: 'needs_auth', balances: [], updatedAt: undefined, canDisconnect: false, message: '登录 MiMo 控制台后可查看余额。' } : provider) } : current);
      ShowNotice('已断开 MiMo 授权，模型 API Key 保持不变。');
    } catch (error) { ShowNotice(error instanceof Error ? error.message : '断开授权失败，请稍后重试。'); }
    finally { SetDisconnecting(false); await queryClient.invalidateQueries({ queryKey: ['provider-account-usage'] }); }
  }
  return <>
    <header className="pu-section-head"><strong>供应商用量</strong><button className="pu-refresh" type="button" onClick={() => void query.refetch()} disabled={!desktop || query.isFetching} aria-label="刷新所有供应商用量" title="刷新所有供应商用量" aria-busy={query.isFetching}><Icon name="refresh" size={14} /></button></header>
    <div className="pu-providers" aria-busy={query.isFetching}>
      {providers.map((provider) => <ProviderUsageCard key={provider.provider} usage={provider} onOpenDashboard={(id) => void OpenDashboard(id)} onAuthorize={() => void AuthorizeMimo()} onDisconnect={() => void DisconnectMimo()} authorizing={authorizing} disconnecting={disconnecting} />)}
      {!providers.length && <div className="pu-empty">{!desktop ? '请在 Avery 桌面客户端查看账户用量。' : query.isPending ? '正在查询供应商用量…' : query.isError ? query.error.message : <>尚未配置供应商<button type="button" onClick={onConfigure}>前往设置</button></>}</div>}
    </div>
    <div className="pu-sync" role="status" aria-live="polite" title={query.isError ? query.error.message : undefined}>{query.isFetching ? '正在刷新…' : query.isError ? query.data ? '刷新失败，已保留上次结果' : '刷新失败，请重试' : query.data ? '刚刚检查' : !desktop ? '桌面端可用' : '等待查询'}</div>
  </>;
}
