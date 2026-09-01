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
  /** 仅在已拿到 Provider usage 时显示黑色进度；否则维持灰色空环。 */
  progress: number;
  title: string;
}

/**
 * 仅把 Provider 返回的最近一次 prompt_tokens 用于用户可见 Usage。
 * 缺失、历史估算和加载状态绝不显示为真实百分比，避免将本地推算误认为模型事实。
 */
export function CreateSessionUsagePresentation(usage: SessionUsagePresentationInput): SessionUsagePresentation {
  if (usage.source === 'actual') {
    const percent = Math.min(100, Math.round((usage.inputTokens / Math.max(1, usage.contextLimit)) * 100));
    return {
      progress: percent,
      // 详情刻意不暴露具体 token 数；阈值和进度仍足以表达压缩时机。
      title: `上下文进度 ${percent}%；压缩阈值 ${usage.compressionThreshold}%`,
    };
  }
  if (usage.source === 'loading') return { progress: 0, title: '正在恢复上下文进度' };
  if (usage.source === 'unavailable' && usage.reportedRequestCount === 0 && usage.unreportedRequestCount === 0) {
    return { progress: 0, title: '新会话尚无上下文进度' };
  }
  return {
    progress: 0,
    title: usage.source === 'legacy_estimate'
      ? '历史会话没有可用的真实上下文进度'
      : '当前会话未收到 Provider 返回的上下文进度',
  };
}
