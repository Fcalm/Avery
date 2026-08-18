import { z } from 'zod';

/**
 * 写通道负载的形状校验 Schema（阶段 6 A2 收口）：
 * 校验对象结构、必填的结构字段与字符串长度上限；未知字段放行，枚举与业务规则仍由领域层负责。
 * 目的：在进入业务服务前拦截明显畸形的负载，而非替代领域校验。
 */

/** 追加会话消息的输入形状；时间由后端落库统一填写。 */
export const ChatMessageInputSchema = z.object({
  id: z.string().min(1).max(200),
  role: z.enum(['user', 'assistant', 'system']),
  content: z.string().max(200000),
  thinkingContent: z.string().max(200000).optional(),
  attachments: z.array(z.object({
    name: z.string().min(1).max(500),
    path: z.string().regex(/^attachment:\/\/[^/\s]+\//).max(2000),
  }).strict()).max(10).optional(),
}).passthrough();

/** 会话追加消息数组：单次追加规模有上限，防止超大批写入。 */
export const ChatMessagesSchema = z.array(ChatMessageInputSchema).max(500);

/** 新建会话：id 与 title 为结构必需。 */
export const ConversationCreateSchema = z.object({
  id: z.string().min(1).max(200),
  title: z.string().min(1).max(200),
}).passthrough();

/** 简历 upsert：id 必需，正文等长文本字段做长度上限。 */
export const ResumeUpsertSchema = z.object({
  id: z.string().min(1).max(200),
  name: z.string().max(200).optional(),
  targetRoles: z.array(z.string().max(100)).max(50).optional(),
  summary: z.string().max(20000).optional(),
  content: z.string().max(200000).optional(),
}).passthrough();

/** 岗位 upsert：id 必需，其余字段类型/长度校验但允许缺省（领域层负责枚举）。 */
export const JobUpsertSchema = z.object({
  id: z.string().min(1).max(200),
  company: z.string().max(200).optional(),
  title: z.string().max(200).optional(),
  city: z.string().max(100).optional(),
  salary: z.string().max(100).optional(),
  experience: z.string().max(100).optional(),
  employmentType: z.string().max(50).optional(),
  channel: z.string().max(100).optional(),
  favorite: z.boolean().optional(),
  matchScore: z.number().optional(),
  url: z.string().max(2000).optional(),
  jd: z.string().max(200000).optional(),
}).passthrough();

/** 投递 upsert：id/jobId/resumeId 为结构必需；日期字段为 YYYY-MM-DD。 */
export const ApplicationUpsertSchema = z.object({
  id: z.string().min(1).max(200),
  jobId: z.string().min(1).max(200),
  resumeId: z.string().min(1).max(200),
  status: z.string().min(1).max(50),
  appliedAt: z.string().max(10).optional(),
  nextStepAt: z.string().max(10).optional(),
  note: z.string().max(20000).optional(),
}).passthrough();

/** 设置提交：全部字段可选但类型/长度受校验（前端可能分步持久化）；API Key 不进入此对象。 */
export const SettingsSubmitSchema = z.object({
  nickname: z.string().max(200).optional(),
  provider: z.string().max(50).optional(),
  baseUrl: z.string().max(2000).optional(),
  model: z.string().max(200).optional(),
  contextLength: z.string().max(50).optional(),
  thinkingEnabled: z.boolean().optional(),
  developerMode: z.boolean().optional(),
  traceRetention: z.number().int().min(1).max(100).optional(),
  compressionThreshold: z.number().int().min(1).max(100).optional(),
  onboardingCompleted: z.boolean().optional(),
  customContext: z.string().max(50000).optional(),
}).passthrough();

/** 档案单项：id 为结构必需。 */
export const ProfileItemSchema = z.object({
  id: z.string().min(1).max(200),
  category: z.string().min(1).max(100).optional(),
  title: z.string().min(1).max(500).optional(),
  content: z.string().max(50000).optional(),
  updatedAt: z.number().optional(),
}).passthrough();

/** 档案保存输入：单项数组，整体规模有上限。 */
export const ProfileItemsSchema = z.array(ProfileItemSchema).max(500);
