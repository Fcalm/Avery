import { ProfileCategoryValues } from '@avery/contracts';

/** 中英枚举映射：契约层使用稳定英文值，持久化层使用当前中文分类名称。 */

export const JobSeekingTypeStorage: Record<string, string> = { intern: '实习', campus_recruitment: '校招', social_recruitment: '社招' };
// 旧版本持久化的“正式工 / full_time”在读取时归并为社招，保证升级后历史岗位可继续编辑。
export const JobSeekingTypeDisplay: Record<string, string> = { 实习: 'intern', 校招: 'campus_recruitment', 社招: 'social_recruitment', 正式工: 'social_recruitment', full_time: 'social_recruitment' };
export const ChannelStorage: Record<string, string> = { boss_zhipin: 'BOSS直聘', company_website: '企业官网', other: '其他' };
export const ChannelDisplay: Record<string, string> = { BOSS直聘: 'boss_zhipin', 企业官网: 'company_website', 其他: 'other' };
export const ApplicationStatusStorage: Record<string, string> = { saved: '已收藏', applied: '已投递', written_test: '笔试中', interviewing: '面试中', ended: '已结束' };
export const ApplicationStatusDisplay: Record<string, string> = { 已收藏: 'saved', 已投递: 'applied', 笔试中: 'written_test', 面试中: 'interviewing', 已结束: 'ended' };
export const ProfileCategoryStorage: Record<string, string> = { application: '个人信息', project: '项目经历', work: '工作经历', education: '教育经历', job_intention: '求职意向', skill_certificate: '技能/证书', other: '其他资料' };
export const ProfileCategoryDisplay: Record<string, string> = { 个人信息: 'application', 项目经历: 'project', 工作经历: 'work', 教育经历: 'education', 求职意向: 'job_intention', '技能/证书': 'skill_certificate', 其他资料: 'other' };
const CurrentProfileCategories = new Set<string>(ProfileCategoryValues);

/** 仅当前模板分类可进入档案读写和表单填写流程。 */
export function IsCurrentProfileCategory(value: unknown): value is string {
  return typeof value === 'string' && CurrentProfileCategories.has(value);
}

/** 英文值映射为存储中文值；已是中文或未知值原样透传（容忍存量与未列枚举）。 */
export function ToStorage(value: unknown, storageMap: Record<string, string>): unknown {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(storageMap, value) ? storageMap[value] : value;
}

/** 存储中文值映射为契约英文值；已是英文或未知值原样透传。 */
export function ToDisplay(value: unknown, displayMap: Record<string, string>): unknown {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(displayMap, value) ? displayMap[value] : value;
}

/** 岗位写入前映射为存储形状；不修改原始对象。 */
export function JobToStorage(job: any): any {
  if (!job || typeof job !== 'object') return job;
  const { employmentType: legacyEmploymentType, ...rest } = job;
  const requestedType = job.jobSeekingType ?? legacyEmploymentType;
  const jobSeekingType = requestedType === 'full_time' || requestedType === '正式工' ? 'social_recruitment' : requestedType;
  return { ...rest, jobSeekingType: ToStorage(jobSeekingType, JobSeekingTypeStorage), channel: ToStorage(job.channel, ChannelStorage) };
}

/** 岗位读取后映射为契约英文形状；不修改原始对象。 */
export function JobToDisplay(job: any): any {
  if (!job || typeof job !== 'object') return job;
  const { employmentType: legacyEmploymentType, ...rest } = job;
  const jobSeekingType = job.jobSeekingType ?? legacyEmploymentType;
  return { ...rest, jobSeekingType: ToDisplay(jobSeekingType, JobSeekingTypeDisplay), channel: ToDisplay(job.channel, ChannelDisplay) };
}

/** 投递写入前映射为存储形状；不修改原始对象。 */
export function ApplicationToStorage(application: any): any {
  if (!application || typeof application !== 'object') return application;
  return { ...application, status: ToStorage(application.status, ApplicationStatusStorage) };
}

/** 投递读取后映射为契约英文形状；不修改原始对象。 */
export function ApplicationToDisplay(application: any): any {
  if (!application || typeof application !== 'object') return application;
  return { ...application, status: ToDisplay(application.status, ApplicationStatusDisplay) };
}

/** 档案项写入前映射为存储形状；不修改原始对象。 */
export function ProfileItemToStorage(item: any): any {
  if (!item || typeof item !== 'object') return item;
  return { ...item, category: ToStorage(item.category, ProfileCategoryStorage) };
}

/** 档案项读取后映射为契约英文形状；不修改原始对象。 */
export function ProfileItemToDisplay(item: any): any {
  if (!item || typeof item !== 'object') return item;
  return { ...item, category: ToDisplay(item.category, ProfileCategoryDisplay) };
}

/** 归一化展示用时间字段为 UTC epoch 毫秒；缺失或非法时回退到调用方提供的时间，禁止「刚刚」类展示串落库。 */
export function NormalizeEpochMs(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}
