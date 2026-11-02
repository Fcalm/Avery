import { useEffect, type RefObject } from 'react';

/** 仅无效提交时定位、提示，逐字编辑不会反复移动焦点；尊重系统减少动效设置。 */
export function useInvalidFormFeedback(attempt: number, container: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    if (!attempt) return;
    const controls = Array.from(container.current?.querySelectorAll<HTMLElement>('[aria-invalid="true"]:not(:disabled)') ?? []);
    controls[0]?.scrollIntoView({ block: 'nearest' });
    controls[0]?.focus({ preventScroll: true });
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const animations = controls.map((control) => control.animate(
      [{ transform: 'translateX(0)' }, { transform: 'translateX(-4px)' }, { transform: 'translateX(4px)' }, { transform: 'translateX(-3px)' }, { transform: 'translateX(3px)' }, { transform: 'translateX(0)' }],
      { duration: 320, easing: 'ease-in-out' },
    ));
    return () => animations.forEach((animation) => animation.cancel());
  }, [attempt, container]);
}
