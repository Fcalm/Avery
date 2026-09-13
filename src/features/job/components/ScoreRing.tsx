const RingRadius = 15;
const RingCircumference = 2 * Math.PI * RingRadius;

/**
 * 岗位分数环：沿用原型的“环 + 居中数字”表达，是岗位行里最醒目的一个元素。
 * 未记录分数时只画底环并显示占位符，不用 0 分伪装成“已评分”。
 */
function ScoreRing({ score, size = 'row' }: { score?: number; size?: 'row' | 'detail' }) {
  const value = typeof score === 'number' && Number.isFinite(score) ? Math.min(100, Math.max(0, score)) : null;
  return <span className={`ring-wrap w-${size}`} role="img" aria-label={value === null ? '岗位分数待计算' : `岗位分数 ${value}`}>
    <svg className="mini-ring" viewBox="0 0 36 36" aria-hidden="true">
      <circle className="mr-track" cx="18" cy="18" r={RingRadius}></circle>
      {value !== null && <circle className="mr-val" cx="18" cy="18" r={RingRadius} strokeDasharray={RingCircumference.toFixed(1)} strokeDashoffset={(RingCircumference * (1 - value / 100)).toFixed(1)}></circle>}
    </svg>
    <span className="jr-num">{value ?? '—'}</span>
  </span>;
}

export { ScoreRing };
