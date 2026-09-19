import type { EvalRun } from '@avery/contracts';

/**
 * 评测记录的展示口径：应用侧栏（开发者页）与评估控制台共用同一份纯函数，
 * 保证侧栏分组、行内元信息与结果区文案永远一致。
 */

export const TerminalStatuses = new Set(['completed', 'failed', 'cancelled']);

/** 侧栏状态分组的展示顺序；failed 是原型没有的真实状态，如实补充一组。 */
export const RunBuckets = [
  { key: 'completed', label: '已完成' }, { key: 'active', label: '进行中' }, { key: 'idle', label: '未开始' }, { key: 'failed', label: '已失败' }, { key: 'cancelled', label: '已终止' },
] as const;
export type RunBucketKey = (typeof RunBuckets)[number]['key'];

/** 分组归属取该评测最近一次运行的状态；没有运行时归入"未开始"。 */
export function BucketOf(project: EvalRun | undefined): RunBucketKey {
  if (!project) return 'idle';
  if (project.status === 'completed') return 'completed';
  if (project.status === 'failed') return 'failed';
  if (project.status === 'cancelled') return 'cancelled';
  return 'active';
}

export const BucketDotClass: Record<RunBucketKey, string> = { completed: 'is-done', active: 'is-live', idle: '', failed: 'is-stop', cancelled: 'is-stop' };

export function ShortHash(text: string | null | undefined): string {
  return text ? text.slice(0, 8) : '—';
}

export function FormatDuration(ms: number | null | undefined): string {
  if (!ms) return '未记录';
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest ? `${minutes} 分 ${rest} 秒` : `${minutes} 分`;
}

export function FormatTime(ts: number | null | undefined): string {
  return ts ? new Date(ts).toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—';
}

export function RunStatusText(status: string): string {
  if (status === 'queued' || status === 'preparing') return '排队中';
  if (status === 'running') return '进行中';
  if (status === 'scoring') return '评分中';
  if (status === 'completed') return '已完成';
  if (status === 'failed') return '已失败';
  return '已终止';
}
