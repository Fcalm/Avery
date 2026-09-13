import type { ApplicationStatus, Channel, JobSeekingType, JobScore, ProfileCategory } from '@avery/contracts';

/** 英文枚举 → 中文文案映射；枚举值在前端转换展示，持久化用稳定英文值。 */
export const JobSeekingTypeLabel: Record<JobSeekingType, string> = { intern: '实习', campus_recruitment: '校招', social_recruitment: '社招' };
export const ChannelLabel: Record<Channel, string> = { boss_zhipin: 'BOSS直聘', company_website: '企业官网', other: '其他' };
export const ApplicationStatusLabel: Record<ApplicationStatus, string> = { saved: '已收藏', applied: '已投递', written_test: '笔试中', interviewing: '面试中', ended: '已结束' };
export const ProfileCategoryLabel: Record<ProfileCategory, string> = { application: '个人信息', project: '项目经历', work: '工作经历', education: '教育经历', job_intention: '求职意向', skill_certificate: '技能/证书', other: '其他资料' };
export const JobScoreLabel: Record<JobScore, string> = { pending: '待计算', poor: '较差', good: '优良', excellent: '极好' };

/** 匹配分映射为稳定英文分档；页面用 JobScoreLabel 转中文展示。 */
export function GetScoreLabel(score?: number): JobScore {
  if (typeof score !== 'number') return 'pending';
  if (score < 60) return 'poor';
  if (score <= 80) return 'good';
  return 'excellent';
}

/** 展示用时间格式化：UTC epoch 毫秒 → 本地化日期时间；非法输入返回空串。 */
export function FormatTime(value?: number): string {
  if (typeof value !== 'number') return '';
  return new Date(value).toLocaleString('zh-CN');
}

/** 展示用日期时间：UTC epoch 毫秒 → 本地 `YYYY-MM-DD HH:mm`；非法输入返回空串。 */
export function FormatDateTime(value?: number): string {
  const local = ToDateTimeLocalValue(value);
  return local ? local.replace('T', ' ') : '';
}

/** datetime-local 输入值：UTC epoch 毫秒 → 本地 `YYYY-MM-DDTHH:mm`；非法输入返回空串。 */
export function ToDateTimeLocalValue(value?: number): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '';
  const date = new Date(value);
  // 需要先扣除本地时区偏移；直接 toISOString 会按 UTC 输出，输入框会显示成另一个时间。
  const local = new Date(value - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

/** datetime-local 输入值 → UTC epoch 毫秒；空值或非法输入返回 undefined。 */
export function FromDateTimeLocalValue(value: string): number | undefined {
  if (!value) return undefined;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** 相对时间：供“刚刚 / N 分钟前 / N 小时前 / N 天前”一类近期时间展示，超过 30 天回退为日期。 */
export function FormatRelativeTime(value?: number, now: number = Date.now()): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '';
  const elapsed = now - value;
  if (elapsed < 60_000) return '刚刚';
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)} 分钟前`;
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)} 小时前`;
  if (elapsed < 2_592_000_000) return `${Math.floor(elapsed / 86_400_000)} 天前`;
  return FormatDateTime(value).slice(0, 10);
}

export function GetExcerpt(content: string, lines = 2) {
  return content.split('\n').slice(0, lines).join('\n');
}
