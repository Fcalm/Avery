import { z } from 'zod';
import { ChannelValues, JobSeekingTypeValues } from './enums';
import type { JobDto } from './dto';

/** 岗位库共享查询：同一维度数组为 OR，不同维度为 AND；空数组与缺省均不限制。排序默认分数降序，旧调用无需补传方向。 */
export const JobQuerySchema = z.object({
  jobId: z.string().trim().min(1).max(200).optional(),
  keyword: z.string().trim().max(500).default(''),
  channels: z.array(z.enum(ChannelValues)).max(3).default([]),
  cities: z.array(z.string().trim().min(1).max(100)).max(50).default([]),
  jobSeekingTypes: z.array(z.enum(JobSeekingTypeValues)).max(3).default([]),
  minMonthlySalary: z.number().finite().nonnegative().max(10000000).optional(),
  experiences: z.array(z.enum(['fresh', '1-3', '3-5', '5+'])).max(4).default([]),
  educations: z.array(z.enum(['college', 'bachelor', 'master', 'doctor'])).max(4).default([]),
  companySizes: z.array(z.enum(['0-20', '20-99', '100-499', '500-999', '1000+'])).max(5).default([]),
  view: z.enum(['all', 'favorites', 'pending', 'applied']).default('all'),
  sort: z.enum(['created', 'score', 'salary']).default('score'),
  sortDirection: z.enum(['asc', 'desc']).default('desc'),
  page: z.number().int().min(1).max(1000000).default(1),
  pageSize: z.number().int().min(1).max(100).default(20),
}).strict();

export type JobQueryInput = z.input<typeof JobQuerySchema>;
export type JobQuery = z.output<typeof JobQuerySchema>;
export type JobLibraryView = JobQuery['view'];

/** page 为实际页码；删除最后一页数据后自动收敛到末页，空结果仍返回第 1 页。 */
export interface JobQueryResult {
  items: JobDto[];
  total: number;
  page: number;
  pageSize: number;
  pageCount: number;
}

/** IPC 与 Worker 内部调用共用校验，非法查询保持稳定业务错误，不静默忽略条件。 */
export function ParseJobQuery(input: unknown): JobQuery {
  const result = JobQuerySchema.safeParse(input);
  if (!result.success) throw Object.assign(new Error('岗位筛选参数无效。'), { code: 'VALIDATION_ERROR' });
  return result.data;
}
