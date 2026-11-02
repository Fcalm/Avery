/**
 * 岗位库筛选条件的应用内缓存。
 *
 * 条件用于岗位查询及已有采集指令入口，不修改岗位事实，只缓存在应用本地。
 */
import { ParseJobQuery, type JobQuery, type JobLibraryView } from '@avery/contracts';

export type JobConditionKey = 'channel' | 'city' | 'jobSeekingType' | 'salary' | 'experience' | 'education' | 'companySize';

export interface JobConditionOption {
  value: string;
  label: string;
}

export interface JobConditionGroup {
  key: JobConditionKey;
  label: string;
  multiple?: boolean;
  options: JobConditionOption[];
}

/** 筛选面板的标签分组；单选维度再次点击可取消，公司规模支持同组 OR 多选。 */
export const JobConditionGroups: JobConditionGroup[] = [
  { key: 'channel', label: '渠道', options: [
    { value: 'any', label: '不限' }, { value: 'boss_zhipin', label: 'BOSS直聘' },
    { value: 'company_website', label: '企业官网' }, { value: 'other', label: '其他' },
  ] },
  { key: 'city', label: '城市', options: [
    { value: 'any', label: '不限' }, { value: '北京', label: '北京' }, { value: '上海', label: '上海' },
    { value: '深圳', label: '深圳' }, { value: '广州', label: '广州' }, { value: '杭州', label: '杭州' }, { value: '远程', label: '远程' },
  ] },
  { key: 'jobSeekingType', label: '求职类型', options: [
    { value: 'any', label: '不限' }, { value: 'intern', label: '实习' },
    { value: 'campus_recruitment', label: '校招' }, { value: 'social_recruitment', label: '社招' },
  ] },
  { key: 'salary', label: '薪资', options: [
    { value: 'any', label: '不限' }, { value: '15k', label: '15k 以上' },
    { value: '25k', label: '25k 以上' }, { value: '35k', label: '35k 以上' }, { value: '50k', label: '50k 以上' },
  ] },
  { key: 'experience', label: '工作经验', options: [
    { value: 'any', label: '不限' }, { value: 'fresh', label: '应届' }, { value: '1-3', label: '1 到 3 年' },
    { value: '3-5', label: '3 到 5 年' }, { value: '5+', label: '5 年以上' },
  ] },
  { key: 'education', label: '学历要求', options: [
    { value: 'any', label: '不限' }, { value: 'college', label: '大专' }, { value: 'bachelor', label: '本科' },
    { value: 'master', label: '硕士' }, { value: 'doctor', label: '博士' },
  ] },
  { key: 'companySize', label: '公司规模', multiple: true, options: [
    { value: 'any', label: '不限' }, { value: '0-20', label: '20 人以下' }, { value: '20-99', label: '20 到 99 人' },
    { value: '100-499', label: '100 到 499 人' }, { value: '500-999', label: '500 到 999 人' }, { value: '1000+', label: '1000 人以上' },
  ] },
];

export interface JobConditions {
  keyword: string;
  channel: string;
  city: string;
  jobSeekingType: string;
  salary: string;
  experience: string;
  education: string;
  companySize: string[];
}

export const DefaultJobConditions: JobConditions = {
  keyword: '', channel: 'any', city: 'any', jobSeekingType: 'any', salary: 'any', experience: 'any', education: 'any', companySize: [],
};

export const JobConditionsStorageKey = 'avery.job-conditions.v1';

/**
 * 读取应用内缓存的条件；结构或取值非法时回退默认值。
 * 只接受仍存在于选项表中的值，避免选项调整后旧缓存把控件置为非法状态。
 */
export function LoadJobConditions(): JobConditions {
  try {
    const raw = window.localStorage.getItem(JobConditionsStorageKey);
    if (!raw) return { ...DefaultJobConditions };
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { ...DefaultJobConditions };
    const record = parsed as Record<string, unknown>;
    const keyword = typeof record.keyword === 'string' ? record.keyword.slice(0, 500) : DefaultJobConditions.keyword;
    const conditions: JobConditions = { ...DefaultJobConditions, keyword };
    for (const group of JobConditionGroups) {
      const value = record[group.key];
      if (group.key === 'companySize') {
        // 旧版为单个字符串，读取时无损迁移为多选数组；非法值与“不限”不进入查询。
        const selected = Array.isArray(value) ? value : [value];
        conditions.companySize = group.options.filter((option) => option.value !== 'any' && selected.includes(option.value)).map((option) => option.value);
      } else if (typeof value === 'string' && group.options.some((option) => option.value === value)) conditions[group.key] = value;
    }
    return conditions;
  } catch {
    // 存储不可用时条件仅本次会话生效，不影响岗位数据本身。
    return { ...DefaultJobConditions };
  }
}

/** 写入应用内缓存；存储不可用时忽略，不阻断筛选流程。 */
export function SaveJobConditions(conditions: JobConditions): void {
  try {
    window.localStorage.setItem(JobConditionsStorageKey, JSON.stringify(conditions));
  } catch { /* 存储不可用时条件仅本次会话生效 */ }
}

/** 将界面“不限”转成缺省维度；共享契约校验保证页面与后续工具使用相同条件语义。 */
export function BuildJobLibraryQuery(conditions: JobConditions, view: JobLibraryView, sort: JobQuery['sort'], page: number, sortDirection: JobQuery['sortDirection'] = 'desc'): JobQuery {
  const selected = (value: string) => value === 'any' ? [] : [value];
  return ParseJobQuery({
    keyword: conditions.keyword, channels: selected(conditions.channel), cities: selected(conditions.city),
    jobSeekingTypes: selected(conditions.jobSeekingType), experiences: selected(conditions.experience),
    educations: selected(conditions.education), companySizes: conditions.companySize,
    ...(conditions.salary === 'any' ? {} : { minMonthlySalary: Number(conditions.salary.replace('k', '')) * 1000 }),
    view, sort, sortDirection, page, pageSize: 20,
  });
}

/** 空数组与“不限”语义相同，供面板选中态、条件计数和采集指令共用。 */
export function GetJobConditionValues(value: string | readonly string[]): readonly string[] {
  return typeof value === 'string' ? value === 'any' ? [] : [value] : value;
}

/** 单选互斥，多选同组取并集；点击“不限”只清空当前分组，不影响其他筛选。 */
export function ToggleJobCondition(conditions: JobConditions, key: JobConditionKey, value: string): JobConditions {
  if (key === 'companySize') {
    const selected = conditions.companySize;
    return { ...conditions, companySize: value === 'any' ? [] : selected.includes(value) ? selected.filter((item) => item !== value) : [...selected, value] };
  }
  return { ...conditions, [key]: conditions[key] === value ? 'any' : value };
}

/** 条件转采集指令：与原型一致，仅带上已明确选择的项，全部不限时退化为“不限”。 */
export function BuildCollectPrompt(conditions: JobConditions): string {
  const parts: string[] = [];
  if (conditions.keyword.trim()) parts.push(conditions.keyword.trim());
  for (const group of JobConditionGroups) {
    const selected = GetJobConditionValues(conditions[group.key]);
    for (const option of group.options) if (selected.includes(option.value)) parts.push(option.label);
  }
  return `帮我按照条件：${parts.length ? parts.join('、') : '不限'}，采集岗位`;
}
