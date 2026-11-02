import { useLayoutEffect, useRef, type ReactNode, type RefObject } from 'react';
import { GetSelectMenuLayout } from './selectMenuLayout';

/**
 * 原生顶层浮层不受祖先 overflow/filter 裁切，DOM 仍留在所属表单内，
 * 因而保留弹窗的焦点约束、主题继承以及组件的外部点击判断。
 */
export function SelectMenu({ rootRef, menuRef: suppliedMenuRef, id, ariaLabel, preferUp = false, onDismiss, children }: {
  rootRef: RefObject<HTMLDivElement | null>;
  menuRef?: RefObject<HTMLDivElement | null>;
  id: string; ariaLabel: string; preferUp?: boolean; onDismiss: () => void; children: ReactNode;
}) {
  const ownMenuRef = useRef<HTMLDivElement>(null);
  const menuRef = suppliedMenuRef ?? ownMenuRef;
  const dismissRef = useRef(onDismiss);
  const scheduleRef = useRef<(() => void) | null>(null);
  useLayoutEffect(() => { dismissRef.current = onDismiss; }, [onDismiss]);

  useLayoutEffect(() => {
    const menu = menuRef.current;
    const anchor = rootRef.current?.querySelector<HTMLElement>('.custom-select-trigger');
    if (!menu || !anchor) return;
    let frame = 0;
    function Reposition() {
      const bounds = anchor!.getBoundingClientRect();
      if (!anchor!.isConnected || bounds.width <= 0 || bounds.height <= 0) { dismissRef.current(); return; }
      const visual = window.visualViewport;
      const viewport = { left: visual?.offsetLeft ?? 0, top: visual?.offsetTop ?? 0, width: visual?.width ?? window.innerWidth, height: visual?.height ?? window.innerHeight };
      if (bounds.bottom <= viewport.top || bounds.top >= viewport.top + viewport.height) { dismissRef.current(); return; }
      // 先按内容测量宽度，再限制到视口；长选项不会被短触发器强行压缩。
      Object.assign(menu!.style, { width: 'max-content', minWidth: `${Math.min(bounds.width, Math.max(0, viewport.width - 16))}px`, maxWidth: `${Math.max(0, viewport.width - 16)}px`, maxHeight: '240px' });
      const measured = menu!.getBoundingClientRect();
      const layout = GetSelectMenuLayout(bounds, viewport, { width: measured.width, height: menu!.scrollHeight + measured.height - menu!.clientHeight }, preferUp);
      Object.assign(menu!.style, { left: `${layout.left}px`, top: `${layout.top}px`, width: `${layout.width}px`, maxHeight: `${layout.maxHeight}px`, visibility: 'visible' });
      menu!.dataset.placement = layout.placement;
    }
    function Schedule(event?: Event) {
      if (event?.type === 'scroll' && event.target instanceof Node && menu!.contains(event.target)) return;
      if (!frame) frame = requestAnimationFrame(() => { frame = 0; Reposition(); });
    }
    scheduleRef.current = Schedule;
    const previousFocus = document.activeElement;
    menu.showPopover();
    // 展示浮层不擅自转移输入焦点，键盘选项定位由所属控件负责。
    if (previousFocus instanceof HTMLElement && rootRef.current?.contains(previousFocus) && document.activeElement !== previousFocus) previousFocus.focus({ preventScroll: true });
    Reposition();
    const observer = new ResizeObserver(() => Schedule());
    observer.observe(anchor); observer.observe(menu);
    const visibility = new IntersectionObserver(([entry]) => { if (entry && !entry.isIntersecting) dismissRef.current(); });
    visibility.observe(anchor);
    window.addEventListener('resize', Schedule);
    window.addEventListener('scroll', Schedule, true);
    window.visualViewport?.addEventListener('resize', Schedule);
    window.visualViewport?.addEventListener('scroll', Schedule);
    return () => {
      scheduleRef.current = null;
      observer.disconnect();
      visibility.disconnect();
      if (frame) cancelAnimationFrame(frame);
      window.removeEventListener('resize', Schedule);
      window.removeEventListener('scroll', Schedule, true);
      window.visualViewport?.removeEventListener('resize', Schedule);
      window.visualViewport?.removeEventListener('scroll', Schedule);
      if (menu.matches(':popover-open')) menu.hidePopover();
    };
  }, [rootRef, menuRef, preferUp]);

  // 筛选后的内容即使行数不变，也可能改变最长选项；仅靠尺寸观察无法发现这种变化。
  useLayoutEffect(() => { scheduleRef.current?.(); }, [children]);

  return <div popover="manual" id={id} ref={menuRef} className="custom-select-menu" role="listbox" aria-label={ariaLabel} style={{ visibility: 'hidden' }}>{children}</div>;
}
