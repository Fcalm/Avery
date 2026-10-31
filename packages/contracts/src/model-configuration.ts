import { z } from 'zod';
import type { ResolvedModelConfiguration } from '@avery/agent-sdk';

/** IPC 严格限制身份、覆盖字段和数值范围，不能借模型配置注入密钥或网络请求参数。 */
export const ModelConfigurationIdentitySchema = z.object({
  provider: z.enum(['DeepSeek', 'Z.AI', 'MIMO', '自定义']),
  model: z.string().trim().min(1).max(200),
  baseUrl: z.string().url().max(500).optional(),
}).strict();
export const ModelCapabilityOverridesSchema = z.object({
  contextWindow: z.number().int().min(1024).max(1_000_000).optional(),
  maxOutput: z.number().int().min(1).max(1_000_000).optional(),
  inputImage: z.boolean().optional(), inputPdf: z.boolean().optional(),
  thinking: z.boolean().optional(), toolCall: z.boolean().optional(),
}).strict();
export const GetModelConfigurationSchema = ModelConfigurationIdentitySchema.extend({ refresh: z.boolean().optional() }).strict();
export const SaveModelConfigurationSchema = ModelConfigurationIdentitySchema.extend({
  overrides: ModelCapabilityOverridesSchema,
  expectedRevision: z.number().int().min(0),
}).strict();
export type GetModelConfigurationInput = z.infer<typeof GetModelConfigurationSchema>;
export type SaveModelConfigurationInput = z.infer<typeof SaveModelConfigurationSchema>;
export type { ResolvedModelConfiguration };
