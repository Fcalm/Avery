import type { Job } from '../../types/domain';

type RequiredJobField = 'company' | 'title' | 'city' | 'experience' | 'jd';

/** 编辑采集所得岗位不强迫补造未知信息，手动新增仍需完整必填信息。 */
export function GetJobFormErrors(form: Partial<Pick<Job, RequiredJobField>>, editing: boolean): Partial<Record<RequiredJobField, string>> {
  const errors: Partial<Record<RequiredJobField, string>> = {};
  const fields: Array<[RequiredJobField, string]> = [['company', '公司'], ['title', '岗位名称']];
  if (!editing) fields.push(['city', '城市'], ['experience', '经验要求'], ['jd', '完整 JD']);
  for (const [field, label] of fields) if (!form[field]?.trim()) errors[field] = `请填写${label}`;
  return errors;
}
