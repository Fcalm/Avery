import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

/** 指针停留后显示提示，避免扫过多个按钮时频繁闪动。 */
const ShowDelayMs = 350;
/** 提示框与触发元素之间的间距。 */
const AnchorGap = 8;
/** 提示框与视口边缘的安全距离。 */
const ViewportInset = 8;
/** 这些标签上的 title 是替代文本或可访问名称，不产生悬停提示，保持原生行为。 */
const SkipTags = new Set(['IFRAME', 'IMG', 'SVG', 'ABBR', 'AREA', 'OBJECT', 'EMBED']);
/** 内容型 title（用于展示被截断的完整文本）由元素自行标记，继续使用系统提示。 */
const NativeTitleSelector = '[data-native-title]';

/**
 * 全局接管按钮的原生 title 悬停提示。
 * 悬停期间以空 title 抑制系统提示；点击等交互只关闭浮层，指针离开后才恢复 title。
 */
export function TooltipLayer() {
  const [tip, setTip] = useState<{ text: string } | null>(null);
  const bubbleRef = useRef<HTMLDivElement>(null);
  const anchorRef = useRef<HTMLElement | null>(null);

  useLayoutEffect(() => {
    const bubble = bubbleRef.current;
    const anchor = anchorRef.current;
    if (!tip || !bubble || !anchor || !anchor.isConnected) return;
    const rect = anchor.getBoundingClientRect();
    const width = bubble.offsetWidth;
    const height = bubble.offsetHeight;
    // 上方空间不足时翻到元素下方，避免提示贴住窗口边缘。
    const above = rect.top - AnchorGap - height >= ViewportInset;
    const top = above ? rect.top - AnchorGap - height : rect.bottom + AnchorGap;
    const centered = rect.left + rect.width / 2 - width / 2;
    const left = Math.min(Math.max(centered, ViewportInset), Math.max(ViewportInset, window.innerWidth - width - ViewportInset));
    bubble.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
    bubble.dataset.show = 'true';
  }, [tip]);

  useEffect(() => {
    const bubble = bubbleRef.current;
    let anchor: HTMLElement | null = null;
    let focusedAnchor: HTMLElement | null = null;
    let savedTitle: string | null = null;
    let timer = 0;

    const Hide = () => {
      window.clearTimeout(timer);
      timer = 0;
      focusedAnchor = null;
      anchorRef.current = null;
      if (bubble) bubble.dataset.show = 'false';
      setTip(null);
    };

    const Show = (target: HTMLElement, text: string) => {
      anchorRef.current = target;
      setTip({ text });
    };

    const titleObserver = new MutationObserver(() => {
      if (!anchor?.isConnected) return;
      // 置顶等操作会重渲染按钮并更新 title，仍需抑制系统提示并保存新文案。
      savedTitle = anchor.getAttribute('title');
      anchor.setAttribute('title', '');
      titleObserver.takeRecords();
      if (anchorRef.current === anchor && bubble?.dataset.show === 'true') {
        const text = savedTitle?.trim();
        if (text) setTip({ text });
        else Hide();
      }
    });

    const ReleaseAnchor = () => {
      const titleChanged = titleObserver.takeRecords().length > 0;
      titleObserver.disconnect();
      // React 刚写入的新 title 和已卸载的按钮无需恢复。
      if (!titleChanged && anchor?.isConnected && anchor.getAttribute('title') === '') {
        if (savedTitle === null) anchor.removeAttribute('title');
        else anchor.setAttribute('title', savedTitle);
      }
      anchor = null;
      savedTitle = null;
    };

    const OnPointerOver = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      // 指针仍在同一触发元素内部移动时保留当前提示与计时，不因进入子节点而重来。
      if (anchor && event.composedPath().includes(anchor)) return;
      Hide();
      ReleaseAnchor();
      const next = target.closest<HTMLElement>('[title]');
      if (!next || SkipTags.has(next.tagName) || next.closest(NativeTitleSelector)) return;
      const raw = next.getAttribute('title');
      if (!raw?.trim()) return;
      anchor = next;
      savedTitle = raw;
      next.setAttribute('title', '');
      titleObserver.observe(next, { attributeFilter: ['title'] });
      timer = window.setTimeout(() => {
        timer = 0;
        const text = savedTitle?.trim();
        if (anchor?.isConnected && text) Show(anchor, text);
      }, ShowDelayMs);
    };

    const OnPointerOut = (event: PointerEvent) => {
      if (!anchor) return;
      const related = event.relatedTarget;
      if (related instanceof Node && anchor.contains(related)) return;
      Hide();
      ReleaseAnchor();
    };

    const OnFocusIn = (event: FocusEvent) => {
      const target = event.target;
      if (!(target instanceof HTMLElement) || !target.matches('[data-focus-tooltip]:focus-visible') || target.closest(NativeTitleSelector)) return;
      const text = (target === anchor ? savedTitle : target.getAttribute('title'))?.trim();
      if (!text) return;
      Hide();
      focusedAnchor = target;
      Show(target, text);
    };

    const OnFocusOut = (event: FocusEvent) => {
      if (event.target === focusedAnchor) Hide();
    };

    document.addEventListener('pointerover', OnPointerOver, true);
    document.addEventListener('pointerout', OnPointerOut, true);
    document.addEventListener('pointerdown', Hide, true);
    document.addEventListener('focusin', OnFocusIn, true);
    document.addEventListener('focusout', OnFocusOut, true);
    document.addEventListener('wheel', Hide, { capture: true, passive: true });
    document.addEventListener('scroll', Hide, true);
    window.addEventListener('blur', Hide);
    window.addEventListener('resize', Hide);
    const OnKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') Hide(); };
    document.addEventListener('keydown', OnKeyDown, true);

    return () => {
      document.removeEventListener('pointerover', OnPointerOver, true);
      document.removeEventListener('pointerout', OnPointerOut, true);
      document.removeEventListener('pointerdown', Hide, true);
      document.removeEventListener('focusin', OnFocusIn, true);
      document.removeEventListener('focusout', OnFocusOut, true);
      document.removeEventListener('wheel', Hide, true);
      document.removeEventListener('scroll', Hide, true);
      window.removeEventListener('blur', Hide);
      window.removeEventListener('resize', Hide);
      document.removeEventListener('keydown', OnKeyDown, true);
      window.clearTimeout(timer);
      ReleaseAnchor();
    };
  }, []);

  return createPortal(<div ref={bubbleRef} className="app-tooltip" role="tooltip" aria-hidden="true">{tip?.text}</div>, document.body);
}
