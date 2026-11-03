import type { IconName } from '../shared/components/Icon';

export type NoticeTone = 'success' | 'warning' | 'error' | 'info' | 'pending';

/** 通知语义由调用方指定；图标与阅读时长固定，不受文案、语言或措辞影响。 */
export const NoticePresentation: Record<NoticeTone, { icon: IconName; duration: number }> = {
  success: { icon: 'check-circle', duration: 1900 },
  warning: { icon: 'warning', duration: 3500 },
  error: { icon: 'error', duration: 5000 },
  info: { icon: 'info', duration: 3500 },
  pending: { icon: 'loading', duration: 1900 },
};
