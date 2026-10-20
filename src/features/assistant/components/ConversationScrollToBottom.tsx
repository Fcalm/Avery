import { useLayoutEffect, useState, type RefObject } from 'react';
import { Icon } from '../../../shared/components/Icon';

interface ConversationScrollToBottomProps {
  scrollContainerRef: RefObject<HTMLDivElement | null>;
  onScrollToBottom: () => void;
}

/** 只观察对话主滚动区，工具详情的内部滚动不影响按钮；按会话挂载以隔离显示状态。 */
export function ConversationScrollToBottom({ scrollContainerRef, onScrollToBottom }: ConversationScrollToBottomProps) {
  const [visible, setVisible] = useState(false);

  useLayoutEffect(() => {
    const list = scrollContainerRef.current;
    const thread = list?.querySelector('.message-thread');
    if (!list || !thread) return undefined;
    let scheduledFrame = 0;
    const UpdateVisibility = () => {
      scheduledFrame = 0;
      // scrollTop 可带小数，其余高度取整；允许 1px 的舍入误差，避免在底部闪烁。
      setVisible(list.clientHeight > 0 && list.scrollHeight - list.clientHeight - list.scrollTop > 1);
    };
    const ScheduleUpdate = () => {
      if (!scheduledFrame) scheduledFrame = requestAnimationFrame(UpdateVisibility);
    };
    UpdateVisibility();
    // 流式回复、过程展开收起、图片加载，以及窗口或输入区尺寸变化都可能改变底部位置。
    const observer = new ResizeObserver(ScheduleUpdate);
    observer.observe(list);
    observer.observe(thread);
    list.addEventListener('scroll', ScheduleUpdate, { passive: true });
    return () => {
      observer.disconnect();
      list.removeEventListener('scroll', ScheduleUpdate);
      cancelAnimationFrame(scheduledFrame);
    };
  }, [scrollContainerRef]);

  if (!visible) return null;
  return <button className="conversation-scroll-bottom" type="button" aria-label="回到对话底部" title="回到底部" onClick={onScrollToBottom}>
    <Icon name="chevron-down" size={16} />
  </button>;
}
