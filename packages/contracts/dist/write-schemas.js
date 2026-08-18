"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ProfileItemsSchema = exports.ProfileItemSchema = exports.SettingsSubmitSchema = exports.ApplicationUpsertSchema = exports.JobUpsertSchema = exports.ResumeUpsertSchema = exports.ConversationCreateSchema = exports.ChatMessagesSchema = exports.ChatMessageInputSchema = void 0;
const zod_1 = require("zod");
/**
 * 写通道负载的形状校验 Schema（阶段 6 A2 收口）：
 * 校验对象结构、必填的结构字段与字符串长度上限；未知字段放行，枚举与业务规则仍由领域层负责。
 * 目的：在进入业务服务前拦截明显畸形的负载，而非替代领域校验。
 */
/** 追加会话消息的输入形状；时间由后端落库统一填写。 */
exports.ChatMessageInputSchema = zod_1.z.object({
    id: zod_1.z.string().min(1).max(200),
    role: zod_1.z.enum(['user', 'assistant', 'system']),
    content: zod_1.z.string().max(200000),
    thinkingContent: zod_1.z.string().max(200000).optional(),
    attachments: zod_1.z.array(zod_1.z.object({
        name: zod_1.z.string().min(1).max(500),
        path: zod_1.z.string().regex(/^attachment:\/\/[^/\s]+\//).max(2000),
    }).strict()).max(10).optional(),
}).passthrough();
/** 会话追加消息数组：单次追加规模有上限，防止超大批写入。 */
exports.ChatMessagesSchema = zod_1.z.array(exports.ChatMessageInputSchema).max(500);
/** 新建会话：id 与 title 为结构必需。 */
exports.ConversationCreateSchema = zod_1.z.object({
    id: zod_1.z.string().min(1).max(200),
    title: zod_1.z.string().min(1).max(200),
}).passthrough();
/** 简历 upsert：id 必需，正文等长文本字段做长度上限。 */
exports.ResumeUpsertSchema = zod_1.z.object({
    id: zod_1.z.string().min(1).max(200),
    name: zod_1.z.string().max(200).optional(),
    targetRoles: zod_1.z.array(zod_1.z.string().max(100)).max(50).optional(),
    summary: zod_1.z.string().max(20000).optional(),
    content: zod_1.z.string().max(200000).optional(),
}).passthrough();
/** 岗位 upsert：id 必需，其余字段类型/长度校验但允许缺省（领域层负责枚举）。 */
exports.JobUpsertSchema = zod_1.z.object({
    id: zod_1.z.string().min(1).max(200),
    company: zod_1.z.string().max(200).optional(),
    title: zod_1.z.string().max(200).optional(),
    city: zod_1.z.string().max(100).optional(),
    salary: zod_1.z.string().max(100).optional(),
    experience: zod_1.z.string().max(100).optional(),
    employmentType: zod_1.z.string().max(50).optional(),
    channel: zod_1.z.string().max(100).optional(),
    favorite: zod_1.z.boolean().optional(),
    matchScore: zod_1.z.number().optional(),
    url: zod_1.z.string().max(2000).optional(),
    jd: zod_1.z.string().max(200000).optional(),
}).passthrough();
/** 投递 upsert：id/jobId/resumeId 为结构必需；日期字段为 YYYY-MM-DD。 */
exports.ApplicationUpsertSchema = zod_1.z.object({
    id: zod_1.z.string().min(1).max(200),
    jobId: zod_1.z.string().min(1).max(200),
    resumeId: zod_1.z.string().min(1).max(200),
    status: zod_1.z.string().min(1).max(50),
    appliedAt: zod_1.z.string().max(10).optional(),
    nextStepAt: zod_1.z.string().max(10).optional(),
    note: zod_1.z.string().max(20000).optional(),
}).passthrough();
/** 设置提交：全部字段可选但类型/长度受校验（前端可能分步持久化）；API Key 不进入此对象。 */
exports.SettingsSubmitSchema = zod_1.z.object({
    nickname: zod_1.z.string().max(200).optional(),
    provider: zod_1.z.string().max(50).optional(),
    baseUrl: zod_1.z.string().max(2000).optional(),
    model: zod_1.z.string().max(200).optional(),
    contextLength: zod_1.z.string().max(50).optional(),
    thinkingEnabled: zod_1.z.boolean().optional(),
    developerMode: zod_1.z.boolean().optional(),
    traceRetention: zod_1.z.number().int().min(1).max(100).optional(),
    compressionThreshold: zod_1.z.number().int().min(1).max(100).optional(),
    onboardingCompleted: zod_1.z.boolean().optional(),
    customContext: zod_1.z.string().max(50000).optional(),
}).passthrough();
/** 档案单项：id 为结构必需。 */
exports.ProfileItemSchema = zod_1.z.object({
    id: zod_1.z.string().min(1).max(200),
    category: zod_1.z.string().min(1).max(100).optional(),
    title: zod_1.z.string().min(1).max(500).optional(),
    content: zod_1.z.string().max(50000).optional(),
    updatedAt: zod_1.z.number().optional(),
}).passthrough();
/** 档案保存输入：单项数组，整体规模有上限。 */
exports.ProfileItemsSchema = zod_1.z.array(exports.ProfileItemSchema).max(500);
