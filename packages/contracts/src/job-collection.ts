import { z } from 'zod';
import type { JobDto } from './dto';
import { JobQuerySchema } from './job-query';

/** 采集数量不限制岗位库容量；UI 与后续 Agent 共用同一配置和校验。 */
export const JobCollectionLimits = { defaultCount: 100, maxCount: 1000, batchSize: 25 } as const;
export const JobCollectionInputSchema = z.object({
  channel: z.enum(['boss_zhipin', 'company_website']),
  keyword: z.string().trim().max(500).default(''),
  targetCount: z.number().int().min(1).max(JobCollectionLimits.maxCount).default(JobCollectionLimits.defaultCount),
  /** 与岗位库查询共用枚举；同维度 OR、跨维度 AND，缺省不限制。 */
  jobSeekingTypes: JobQuerySchema.shape.jobSeekingTypes,
  educations: JobQuerySchema.shape.educations,
  city: z.string().trim().min(1).max(100).optional(),
  sourceIds: z.array(z.string().min(1).max(100)).max(1000).optional(),
}).strict().superRefine((value, ctx) => {
  if (value.channel === 'boss_zhipin' && (!value.keyword || !value.city || value.sourceIds?.length)) {
    ctx.addIssue({ code: 'custom', message: 'BOSS 采集需要关键词和城市，不能指定企业来源。' });
  }
  if (value.channel === 'company_website' && value.city) {
    ctx.addIssue({ code: 'custom', message: '企业官网采集不使用 BOSS 城市参数。' });
  }
});
export type JobCollectionInput = z.input<typeof JobCollectionInputSchema>;
export type JobCollectionRequest = z.output<typeof JobCollectionInputSchema>;

export interface RecruitmentSource {
  sourceId: string;
  companyId: string;
  company: string;
  url: string;
  platform: 'beisen' | 'moka' | 'hotjob';
  category: 'campus' | 'social' | 'mixed';
  enabled: boolean;
  origin: 'builtin' | 'custom';
  lastValidatedAt?: string;
  lastError?: string;
}
export type JobCollectionState = 'running' | 'completed' | 'completed_with_shortage' | 'cancelled' | 'interrupted' | 'timed_out' | 'failed';
export interface JobCollectionSourceResult {
  sourceId: string;
  company: string;
  status: 'pending' | 'running' | 'completed' | 'partial' | 'failed';
  segments: number;
  received: number;
  error?: string;
}
export interface JobCollectionTask {
  taskId: string;
  /** 后端工具调用的业务幂等键；页面输入和模型参数不能指定。 */
  idempotencyKey?: string;
  request: JobCollectionRequest;
  status: JobCollectionState;
  createdAt: number;
  updatedAt: number;
  finishedAt?: number;
  deadline: number;
  scanned: number;
  collected: number;
  inserted: number;
  existing: number;
  skippedDeleted: number;
  failedWrites: number;
  sources: JobCollectionSourceResult[];
  warnings: string[];
}

/** 仅后端标准化器与业务 Worker 使用；不开放 Renderer 任意批量岗位写入。 */
export interface CollectedJob {
  identity: string;
  job: JobDto;
  platform: 'boss_zhipin' | RecruitmentSource['platform'];
  sourceId: string;
  originalJobId: string;
  sourceUrl: string;
  collectedAt: string;
}
export interface JobImportResult {
  items: Array<{ identity: string; jobId: string; status: 'inserted' | 'existing' | 'deleted' | 'failed'; error?: string }>;
}
