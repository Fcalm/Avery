import { z } from 'zod';
import type { JobDto } from './dto';
import { JobQuerySchema } from './job-query';

/** 采集数量不限制岗位库容量；UI 与后续 Agent 共用同一配置和校验。 */
export const JobCollectionLimits = { defaultCount: 100, maxCount: 1000, batchSize: 25 } as const;
export const JobCollectionInputSchema = z.object({
  channel: z.enum(['boss_zhipin', 'company_website', 'campus_aggregator']),
  keyword: z.string().trim().max(500).default(''),
  keywordScope: z.enum(['all', 'title']).default('all'),
  targetCount: z.number().int().min(1).max(JobCollectionLimits.maxCount).default(JobCollectionLimits.defaultCount),
  /** 与岗位库查询共用枚举；同维度 OR、跨维度 AND，缺省不限制。 */
  jobSeekingTypes: JobQuerySchema.shape.jobSeekingTypes,
  educations: JobQuerySchema.shape.educations,
  city: z.string().trim().min(1).max(100).optional(),
  sourceIds: z.array(z.string().min(1).max(100)).max(1000).optional(),
  company: z.string().trim().min(1).max(200).optional(),
  graduationYear: z.number().int().min(2020).max(2100).optional(),
  batch: z.string().trim().min(1).max(100).optional(),
  refresh: z.boolean().default(false),
  browserFallback: z.boolean().default(false),
}).strict().superRefine((value, ctx) => {
  if (value.channel === 'boss_zhipin' && (!value.keyword || !value.city || value.sourceIds?.length)) {
    ctx.addIssue({ code: 'custom', message: 'BOSS 采集需要关键词和城市，不能指定企业来源。' });
  }
  if (value.channel !== 'campus_aggregator' && (value.company || value.graduationYear || value.batch)) {
    ctx.addIssue({ code: 'custom', message: '公司、届别和批次条件仅用于校招汇总来源。' });
  }
  if (value.channel === 'campus_aggregator' && value.sourceIds?.length) {
    ctx.addIssue({ code: 'custom', message: '校招汇总自动识别企业入口，不接受来源ID。' });
  }
}).transform((value) => {
  // 汇总公告可能指向含社招的综合门户；默认只接收官网明确标注的校招/实习岗位。
  const jobSeekingTypes: z.output<typeof JobQuerySchema>['jobSeekingTypes'] = value.channel === 'campus_aggregator' && !value.jobSeekingTypes.length
    ? ['campus_recruitment', 'intern'] : value.jobSeekingTypes;
  return { ...value, jobSeekingTypes };
});
export type JobCollectionInput = z.input<typeof JobCollectionInputSchema>;
export type JobCollectionRequest = z.output<typeof JobCollectionInputSchema>;

export interface RecruitmentSource {
  sourceId: string;
  companyId: string;
  company: string;
  url: string;
  platform: 'beisen' | 'moka' | 'hotjob' | 'feishu';
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
  browserAssisted?: boolean;
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
  /** 汇总公告只作为发现依据；不会作为岗位正文、届别或截止时间入库。 */
  discovery?: { total: number; matched: number; sources: number; skipped: number; cacheHit: boolean; fetchedAt: number; url: string; reasons: Record<string, number> };
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
