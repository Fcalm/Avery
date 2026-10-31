import { useEffect, useState } from 'react';
import type { ConversationPresentation } from '@avery/agent-sdk';
import { Icon } from '../../../shared/components/Icon';

function FormatDuration(milliseconds: number, active: boolean): string {
  if (!active && milliseconds < 1000) return '不足1秒';
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  const minutes = Math.floor(seconds / 60);
  if (minutes === 0) return `${seconds}秒`;
  if (minutes < 60) return `${minutes}分钟 ${seconds % 60}秒`;
  return `${Math.floor(minutes / 60)}小时 ${minutes % 60}分钟 ${seconds % 60}秒`;
}

/** 计时仅刷新入口，避免每秒重绘长思考及工具详情；终态使用落盘时间。 */
export function ConversationProcessSummary({ presentation, messageCreatedAt, messageUpdatedAt }: { presentation: ConversationPresentation; messageCreatedAt?: number; messageUpdatedAt?: number }) {
  const active = presentation.status === 'running';
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active, presentation.requestId]);

  // 工具时间不包含前后思考和生成正文，不能代表整轮用时；旧记录以消息落盘时间估算。
  const startedAt = presentation.startedAt ?? messageCreatedAt;
  const completedAt = presentation.completedAt ?? presentation.pausedAt ?? messageUpdatedAt;
  const end = active ? now : completedAt;
  const approximate = presentation.startedAt === undefined || (!active && presentation.completedAt === undefined && presentation.pausedAt === undefined);
  const hasDuration = startedAt !== undefined && end !== undefined && Number.isFinite(startedAt) && Number.isFinite(end) && end >= startedAt;
  const label = hasDuration ? `用时${approximate ? '约' : ''} ${FormatDuration(end - startedAt, active)}` : '用时未记录';

  return <summary aria-label={`${label}，展开或收起工作过程`}><span>{label}</span><Icon name="chevron-right" className="conversation-chevron" size={12} /></summary>;
}
