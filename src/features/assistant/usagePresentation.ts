/** 会话 Usage 的 UI 最小输入：inputTokens 是最近一次已完成请求的 Provider prompt_tokens。 */
export interface SessionUsagePresentationInput {
  inputTokens: number;
  contextLimit: number;
  compressionThreshold: number;
  source: 'actual' | 'unavailable' | 'legacy_estimate' | 'loading';
  reportedRequestCount: number;
  unreportedRequestCount: number;
}

export interface SessionUsagePresentation {
  display: string;
  title: string;
  tone: 'is-safe' | 'is-warning' | 'is-danger';
}

/**
 * 仅把 Provider 返回的最近一次 prompt_tokens 用于用户可见 Usage。
 * 缺失、历史估算和加载状态绝不显示为真实百分比，避免将本地推算误认为模型事实。
 */
export function CreateSessionUsagePresentation(usage: SessionUsagePresentationInput): SessionUsagePresentation {
  if (usage.source === 'actual') {
    const percent = Math.min(100, Math.round((usage.inputTokens / Math.max(1, usage.contextLimit)) * 100));
    return {
      display: `${percent}%`,
      title: `真实 Usage：prompt_tokens ${usage.inputTokens.toLocaleString()} / context_limit ${usage.contextLimit.toLocaleString()}；压缩阈值 ${usage.compressionThreshold}%`,
      tone: percent < 50 ? 'is-safe' : percent < 70 ? 'is-warning' : 'is-danger',
    };
  }
  if (usage.source === 'loading') return { display: '—', title: '正在恢复此会话的 Usage', tone: 'is-safe' };
  if (usage.source === 'unavailable' && usage.reportedRequestCount === 0 && usage.unreportedRequestCount === 0) {
    return { display: '—', title: '新会话尚无已完成请求', tone: 'is-safe' };
  }
  return {
    display: '未知',
    title: usage.source === 'legacy_estimate'
      ? '历史版本只保存了估算值，不能作为真实 Usage 使用'
      : '当前会话未收到 Provider 返回的 Usage；不会用本地估算替代',
    tone: 'is-safe',
  };
}
