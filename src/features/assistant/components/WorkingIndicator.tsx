import { useEffect, useRef, useState } from 'react';

const ANIMATION_SPEED = 1.5;
const CYCLE_DURATION_MS = 7200;
const TIMER_INTERVAL_MS = 100;
const Ease = (value: number) => value * value * (3 - 2 * value);
const Lerp = (start: number, end: number, progress: number) => start + (end - start) * progress;

/** 参考加载态的计时格式：一分钟内保留一位小数，超过后停在分钟加秒。 */
function FormatElapsed(milliseconds: number): string {
  const seconds = Math.max(0, milliseconds) / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  return `${Math.floor(seconds / 60)}m ${(seconds % 60).toFixed(1)}s`;
}

/** 计时状态独立在子组件内，避免每 100ms 重绘整条助手消息。 */
function ElapsedTimer({ startedAt, endedAt }: { startedAt: number; endedAt?: number }) {
  const active = endedAt === undefined;
  const [now, setNow] = useState(Date.now);

  useEffect(() => {
    if (!active) return undefined;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), TIMER_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [active, startedAt]);

  const end = endedAt ?? now;
  if (!Number.isFinite(startedAt) || !Number.isFinite(end) || end < startedAt) return null;
  return <span className="conversation-work-timer">{FormatElapsed(end - startedAt)}</span>;
}

/**
 * 运行期间播放跳跃、聚环、旋转、展开轨迹，并排显示状态文字与计时器。
 * 运行结束后动画收起，计时器按落盘时间定格并随布局过渡停到左顶格。
 */
export function WorkingIndicator({ label, running = true, startedAt, endedAt }: {
  label: string;
  running?: boolean;
  startedAt?: number;
  endedAt?: number;
}) {
  const artworkRef = useRef<SVGSVGElement>(null);

  useEffect(() => {
    if (!running) return undefined;
    const balls = artworkRef.current?.querySelectorAll('circle');
    if (!balls) return undefined;
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
  }, [running]);

  const hasTimer = startedAt !== undefined;
  if (!running && !hasTimer) return null;

  return <div className="conversation-work" data-live={running ? 'true' : 'false'} role={running ? 'status' : undefined} aria-live={running ? 'polite' : undefined}>
    <div className="conversation-work-leading" aria-hidden={running ? undefined : true} inert={running ? undefined : true}>
      <div className="conversation-work-live">
        <svg ref={artworkRef} className="conversation-work-art" viewBox="-44 -44 88 88" aria-hidden="true">
          <circle r="8" cx="-24" cy="0" />
          <circle r="8" cx="0" cy="0" />
          <circle r="8" cx="24" cy="0" />
        </svg>
        <div className="conversation-work-title">{label}</div>
      </div>
    </div>
    {hasTimer && <ElapsedTimer startedAt={startedAt} endedAt={endedAt} />}
  </div>;
}
