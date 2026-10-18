import type { JobQuery } from '@avery/contracts';
import { ApplicationStatusStorage, ChannelStorage, JobSeekingTypeStorage } from './enum-map';

/** 只解析可确定的月薪；K/万为月薪简写，日薪、年薪、面议不换算。范围按下限筛选。 */
export function MonthlySalaryMinimum(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  let text = value.trim().toLowerCase().replace(/[，,\s]/g, '');
  if (/[年日天时]|面议|negotiable|year|day|hour/.test(text)) return null;
  const explicitMonthly = /月|month/.test(text);
  text = text.replace(/[·•*×]\d+薪$/, '').replace(/^月薪/, '')
    .replace(/(?:元)?(?:\/月|每月|月|\/month)$/, '').replace(/(?:起|以上|\+)$/, '');
  const match = /^(\d+(?:\.\d+)?)(k|千|万|元)?(?:[-~～—–至到](\d+(?:\.\d+)?)(k|千|万|元)?)?$/.exec(text);
  if (!match) return null;
  const unit = match[2] ?? match[4];
  if (!explicitMonthly && (!unit || unit === '元')) return null;
  const scale = (u: string | undefined) => u === '万' ? 10000 : u === 'k' || u === '千' ? 1000 : 1;
  const lower = Number(match[1]) * scale(unit);
  const upper = match[3] ? Number(match[3]) * scale(match[4] ?? unit) : lower;
  return Number.isFinite(lower) && upper >= lower ? lower : null;
}

/** 结构化条件只读来源字段，不扫描 JD 推测学历、经验或企业规模。 */
export function NormalizeJobFilterValue(field: string, value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const text = value.trim().toLowerCase().replace(/\s/g, '');
  if (field === 'education') {
    const name = text.replace(/(?:及以上|以上)$/, '');
    return ({ college: 'college', 大专: 'college', 专科: 'college', bachelor: 'bachelor', 本科: 'bachelor',
      master: 'master', 硕士: 'master', 研究生: 'master', doctor: 'doctor', 博士: 'doctor' } as Record<string, string>)[name] ?? null;
  }
  if (field === 'experience') {
    if (/^(fresh|应届|应届生|应届毕业生|无经验|经验不限|不限)$/.test(text)) {
      // “经验不限”不是“应届”的事实，不把未知/不限自动视为满足应届条件。
      return /不限/.test(text) ? null : 'fresh';
    }
    const match = /^(\d+)(?:[-~～至到](\d+))?(?:年)?(?:及以上|以上|\+)?$/.exec(text);
    if (!match || (match[2] && Number(match[2]) < Number(match[1]))) return null;
    const minimum = Number(match[1]);
    return minimum === 0 ? 'fresh' : minimum < 3 ? '1-3' : minimum < 5 ? '3-5' : '5+';
  }
  if (field === 'companySize') {
    if (text === '0-20' || /^(?:20人以下|少于20人|20以下)$/.test(text)) return '0-20';
    const match = /^(\d+)(?:[-~～至到](\d+))?(?:人)?(?:及以上|以上|\+)?$/.exec(text);
    if (!match || (match[2] && Number(match[2]) < Number(match[1]))) return null;
    const minimum = Number(match[1]);
    return minimum < 20 ? '0-20' : minimum < 100 ? '20-99' : minimum < 500 ? '100-499' : minimum < 1000 ? '500-999' : '1000+';
  }
  return null;
}

/** 城市匹配兼容“上海市·浦东新区”等明确地点，关键词仍只查询名称、企业与 JD。 */
export function JobCityMatches(value: unknown, city: string): number {
  if (typeof value !== 'string') return 0;
  const target = city.trim().toLowerCase().replace(/市$/, '');
  const locations = value.toLowerCase().split(/[\s,，、/;；|·]+/);
  return locations.some((location) => location === target || location.startsWith(`${target}市`)) ? 1 : 0;
}

/** 动态值全部参数绑定；动态 SQL 仅由固定字段、排序和条件枚举生成。 */
export function BuildJobQueryWhere(query: JobQuery): { sql: string; values: Array<string | number> } {
  const clauses = ['j.deleted_at IS NULL'];
  const values: Array<string | number> = [];
  if (query.jobId) { clauses.push('j.id = ?'); values.push(query.jobId); }
  function OneOf(expression: string, options: string[]) {
    if (!options.length) return;
    clauses.push(`${expression} IN (${options.map(() => '?').join(', ')})`);
    values.push(...options);
  }
  if (query.keyword) {
    clauses.push("instr(avery_job_lower(COALESCE(json_extract(j.payload_json, '$.company'), '') || ' ' || COALESCE(json_extract(j.payload_json, '$.title'), '') || ' ' || COALESCE(json_extract(j.payload_json, '$.jd'), '')), ?) > 0");
    values.push(query.keyword.toLowerCase());
  }
  OneOf('j.channel', query.channels.flatMap((channel) => [channel, ChannelStorage[channel]]));
  const seekingTypes = query.jobSeekingTypes.flatMap((type) => [type, JobSeekingTypeStorage[type], ...(type === 'social_recruitment' ? ['full_time', '正式工'] : [])]);
  OneOf("COALESCE(json_extract(j.payload_json, '$.jobSeekingType'), json_extract(j.payload_json, '$.employmentType'))", seekingTypes);
  if (query.cities.length) {
    clauses.push(`(${query.cities.map(() => "avery_job_city(json_extract(j.payload_json, '$.city'), ?) = 1").join(' OR ')})`);
    values.push(...query.cities);
  }
  if (query.minMonthlySalary !== undefined) {
    clauses.push("avery_job_monthly_salary(json_extract(j.payload_json, '$.salary')) >= ?");
    values.push(query.minMonthlySalary);
  }
  OneOf("avery_job_filter_value('experience', json_extract(j.payload_json, '$.experience'))", query.experiences);
  OneOf("avery_job_filter_value('education', json_extract(j.payload_json, '$.education'))", query.educations);
  OneOf("avery_job_filter_value('companySize', json_extract(j.payload_json, '$.companySize'))", query.companySizes);
  if (query.view === 'favorites') clauses.push('j.is_favorite = 1');
  if (query.view === 'pending' || query.view === 'applied') {
    const statuses = ['applied', 'written_test', 'interviewing', 'ended'];
    const applied = `(COALESCE(json_extract(j.payload_json, '$.contactStatus'), '') = 'contacted' OR EXISTS (SELECT 1 FROM applications a WHERE a.job_id = j.id AND a.status IN (${statuses.flatMap((status) => [status, ApplicationStatusStorage[status]]).map(() => '?').join(', ')})))`;
    clauses.push(query.view === 'pending' ? `NOT ${applied}` : applied);
    values.push(...statuses.flatMap((status) => [status, ApplicationStatusStorage[status]]));
  }
  return { sql: clauses.join(' AND '), values };
}
