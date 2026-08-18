import type { ApplicationStatus, Channel, EmploymentType, JobScore, ProfileCategory } from '@offerget/contracts';

/** 英文枚举 → 中文文案映射；枚举值在前端转换展示，持久化用稳定英文值。 */
export const EmploymentTypeLabel: Record<EmploymentType, string> = { intern: '实习', full_time: '正式工' };
export const ChannelLabel: Record<Channel, string> = { boss_zhipin: 'BOSS直聘', company_website: '企业官网', other: '其他' };
export const ApplicationStatusLabel: Record<ApplicationStatus, string> = { saved: '已收藏', applied: '已投递', written_test: '笔试中', interviewing: '面试中', ended: '已结束' };
export const ProfileCategoryLabel: Record<ProfileCategory, string> = { project: '项目经历', work: '工作经历', education: '教育背景', skill_certificate: '技能/证书', other: '其他附件' };
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

export function GetExcerpt(content: string, lines = 2) {
  return content.split('\n').slice(0, lines).join('\n');
}
