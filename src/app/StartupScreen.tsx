import { useEffect, useRef, useState } from 'react';
import { BrandAssets, BrandGeometry } from '../shared/brand';
import { Button, EmptyState } from '../shared/components/UI';
import { Icon } from '../shared/components/Icon';

type Props = { animationComplete: boolean; onAnimationComplete: () => void };

// 字标保留原画布尺寸，起点向右留出放大图标所需的间距。
const WordmarkBox = { x: 96, y: 0, width: 280, height: 112 };
const WordmarkScale = Math.min(WordmarkBox.width / BrandGeometry.wordmark.width, WordmarkBox.height / BrandGeometry.wordmark.height);
const WordmarkOffsetY = (WordmarkBox.height - BrandGeometry.wordmark.height * WordmarkScale) / 2;
// 图片含透明留白；按 A 的实际上下边界计算图标大小与位置，使两者可见轮廓等高、底边对齐。
const SplashIconSize = (BrandGeometry.wordmark.capitalBottom - BrandGeometry.wordmark.capitalTop) * WordmarkScale
  * BrandGeometry.icon.height / (BrandGeometry.icon.bottom - BrandGeometry.icon.top);
const SplashIconY = WordmarkBox.y + WordmarkOffsetY + BrandGeometry.wordmark.capitalTop * WordmarkScale
  - BrandGeometry.icon.top / BrandGeometry.icon.height * SplashIconSize;

/** 开屏只播放一次；动画结束后保持最后一帧，由上层等待工作空间就绪。 */
export function StartupScreen({ animationComplete, onAnimationComplete }: Props) {
  const animationRef = useRef<SVGAnimateElement>(null);
  const [assetError, setAssetError] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const animation = animationRef.current;
    if (animationComplete || !animation) return;
    let disposed = false;
    const HandleEnd = () => { if (!disposed) onAnimationComplete(); };
    animation.addEventListener('endEvent', HandleEnd);

    // 图片解码后才启动 SVG 时间线，避免把图片加载耗时算进动画播放时长。
    void Promise.all(Object.values(BrandAssets).map(async (url) => {
      const image = new Image();
      image.src = url;
      await image.decode();
    })).then(() => {
      if (!disposed) animation.beginElement();
    }).catch((error: unknown) => {
      if (disposed) return;
      console.error('启动图片加载失败', error);
      setAssetError(true);
    });
    return () => {
      disposed = true;
      animation.removeEventListener('endEvent', HandleEnd);
    };
  }, [animationComplete, onAnimationComplete, attempt]);

  if (assetError) return <div className="app-screen">
    <EmptyState className="app-state app-state-error" role="alert" ariaLive="assertive" icon={<Icon name="error" size={24} />}
      title="启动图片加载失败" description="无法加载本地品牌图片，请重新加载。"
      action={<Button variant="primary" onClick={() => { setAssetError(false); setAttempt((value) => value + 1); }}>重新加载</Button>} />
  </div>;

  return <div className="app-screen app-splash" role="status" aria-live="polite" aria-label="正在启动 Avery" aria-busy="true">
    <div className="app-splash-content">
      <svg className="app-splash-brand" viewBox={`0 0 ${WordmarkBox.x + WordmarkBox.width} ${WordmarkBox.height}`} role="img" aria-label="Avery">
        <defs>
          <linearGradient id="avery-splash-reveal-gradient" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0" stopColor="white" /><stop offset="0.76" stopColor="white" /><stop offset="1" stopColor="white" stopOpacity="0" />
          </linearGradient>
          <mask id="avery-splash-reveal-mask" maskUnits="userSpaceOnUse" maskContentUnits="userSpaceOnUse">
            <rect x={animationComplete ? 0 : -480} y="0" width="480" height="112" fill="url(#avery-splash-reveal-gradient)">
              <animate ref={animationRef} attributeName="x" from="-480" to="0" begin="indefinite" dur="1.2s" fill="freeze" />
            </rect>
          </mask>
        </defs>
        <g mask="url(#avery-splash-reveal-mask)">
          <image href={BrandAssets.icon} x="0" y={SplashIconY} width={SplashIconSize} height={SplashIconSize} preserveAspectRatio="xMidYMid meet" />
          <image href={BrandAssets.wordmark} {...WordmarkBox} preserveAspectRatio="xMidYMid meet" />
        </g>
      </svg>
    </div>
  </div>;
}
