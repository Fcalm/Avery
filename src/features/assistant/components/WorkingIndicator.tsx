import { useEffect, useRef } from 'react';

const ANIMATION_SPEED = 1.5;
const CYCLE_DURATION_MS = 7200;
const Ease = (value: number) => value * value * (3 - 2 * value);
const Lerp = (start: number, end: number, progress: number) => start + (end - start) * progress;

/** 沿用原型的跳跃、聚环、旋转、展开轨迹；等待确认只改变提示，不中断播放。 */
export function WorkingIndicator({ waiting, label }: { waiting?: boolean; label: string }) {
  const artworkRef = useRef<SVGSVGElement>(null);

  useEffect(() => {
    const balls = artworkRef.current?.querySelectorAll('circle');
    if (!balls) return;
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    let elapsed = 0;
    let last: number | null = null;
    let frameId = 0;

    const Frame = (now: number) => {
      if (last !== null) elapsed += Math.min(now - last, 50) * ANIMATION_SPEED;
      last = now;
      const time = (elapsed % CYCLE_DURATION_MS) / 1000;
      balls.forEach((ball, index) => {
        const line = (index - 1) * 24;
        const angle = -Math.PI / 2 + index * Math.PI * 2 / 3;
        let x = line;
        let y = 0;
        if (time < 2.1) {
          const progress = (time - index * 0.18) / 0.65;
          if (progress > 0 && progress < 1) y = -15 * Math.sin(Math.PI * progress) ** 2;
        } else if (time < 3.1) {
          const progress = Ease(time - 2.1);
          x = Lerp(line, Math.cos(angle) * 28, progress);
          y = Lerp(0, Math.sin(angle) * 28, progress);
        } else if (time < 5.2) {
          const rotation = angle + Math.PI * 2 * Ease((time - 3.1) / 2.1);
          x = Math.cos(rotation) * 28;
          y = Math.sin(rotation) * 28;
        } else if (time < 6.3) {
          const progress = Ease((time - 5.2) / 1.1);
          x = Lerp(Math.cos(angle) * 28, line, progress);
          y = Lerp(Math.sin(angle) * 28, 0, progress);
        }
        ball.setAttribute('cx', x.toFixed(3));
        ball.setAttribute('cy', y.toFixed(3));
      });
      frameId = requestAnimationFrame(Frame);
    };
    // 与原型一致尊重系统减少动态效果设置；组件卸载时释放帧回调和监听。
    const UpdateMotionPreference = () => {
      cancelAnimationFrame(frameId);
      last = null;
      if (!reducedMotion.matches) frameId = requestAnimationFrame(Frame);
    };
    const ResetFrameTime = () => { last = null; };
    UpdateMotionPreference();
    reducedMotion.addEventListener('change', UpdateMotionPreference);
    document.addEventListener('visibilitychange', ResetFrameTime);
    return () => {
      cancelAnimationFrame(frameId);
      reducedMotion.removeEventListener('change', UpdateMotionPreference);
      document.removeEventListener('visibilitychange', ResetFrameTime);
    };
  }, []);

  return <div className="conversation-work" data-mode={waiting ? 'waiting' : 'working'} role="status" aria-live="polite">
    <svg ref={artworkRef} className="conversation-work-art" viewBox="-44 -44 88 88" aria-hidden="true">
      <circle r="8" cx="-24" cy="0" />
      <circle r="8" cx="0" cy="0" />
      <circle r="8" cx="24" cy="0" />
    </svg>
    <div><div className="conversation-work-title">{label}</div><div className="conversation-work-caption">{waiting ? '处理过程已保留，等待后续操作' : '正在结合已有信息推进任务'}</div></div>
  </div>;
}
