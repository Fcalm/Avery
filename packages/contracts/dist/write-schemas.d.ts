import { z } from 'zod';
/**
 * 写通道负载的形状校验 Schema（阶段 6 A2 收口）：
 * 校验对象结构、必填的结构字段与字符串长度上限；未知字段放行，枚举与业务规则仍由领域层负责。
 * 目的：在进入业务服务前拦截明显畸形的负载，而非替代领域校验。
 */
/** 追加会话消息的输入形状；时间由后端落库统一填写。 */
export declare const ChatMessageInputSchema: z.ZodObject<{
    id: z.ZodString;
    role: z.ZodEnum<{
        assistant: "assistant";
        system: "system";
        user: "user";
    }>;
    content: z.ZodString;
    thinkingContent: z.ZodOptional<z.ZodString>;
    attachments: z.ZodOptional<z.ZodArray<z.ZodObject<{
        name: z.ZodString;
        path: z.ZodString;
    }, z.core.$strict>>>;
}, z.core.$loose>;
/** 会话追加消息数组：单次追加规模有上限，防止超大批写入。 */
export declare const ChatMessagesSchema: z.ZodArray<z.ZodObject<{
    id: z.ZodString;
    role: z.ZodEnum<{
        assistant: "assistant";
        system: "system";
        user: "user";
    }>;
    content: z.ZodString;
    thinkingContent: z.ZodOptional<z.ZodString>;
    attachments: z.ZodOptional<z.ZodArray<z.ZodObject<{
        name: z.ZodString;
        path: z.ZodString;
    }, z.core.$strict>>>;
}, z.core.$loose>>;
/** 新建会话：id 与 title 为结构必需。 */
export declare const ConversationCreateSchema: z.ZodObject<{
    id: z.ZodString;
    title: z.ZodString;
}, z.core.$loose>;
/** 简历 upsert：id 必需，正文等长文本字段做长度上限。 */
export declare const ResumeUpsertSchema: z.ZodObject<{
    id: z.ZodString;
    name: z.ZodOptional<z.ZodString>;
    targetRoles: z.ZodOptional<z.ZodArray<z.ZodString>>;
    summary: z.ZodOptional<z.ZodString>;
    content: z.ZodOptional<z.ZodString>;
}, z.core.$loose>;
/** 岗位 upsert：id 必需，其余字段类型/长度校验但允许缺省（领域层负责枚举）。 */
export declare const JobUpsertSchema: z.ZodObject<{
    id: z.ZodString;
    company: z.ZodOptional<z.ZodString>;
    title: z.ZodOptional<z.ZodString>;
    city: z.ZodOptional<z.ZodString>;
    salary: z.ZodOptional<z.ZodString>;
    experience: z.ZodOptional<z.ZodString>;
    employmentType: z.ZodOptional<z.ZodString>;
    channel: z.ZodOptional<z.ZodString>;
    favorite: z.ZodOptional<z.ZodBoolean>;
    matchScore: z.ZodOptional<z.ZodNumber>;
    url: z.ZodOptional<z.ZodString>;
    jd: z.ZodOptional<z.ZodString>;
}, z.core.$loose>;
/** 投递 upsert：id/jobId/resumeId 为结构必需；日期字段为 YYYY-MM-DD。 */
export declare const ApplicationUpsertSchema: z.ZodObject<{
    id: z.ZodString;
    jobId: z.ZodString;
    resumeId: z.ZodString;
    status: z.ZodString;
    appliedAt: z.ZodOptional<z.ZodString>;
    nextStepAt: z.ZodOptional<z.ZodString>;
    note: z.ZodOptional<z.ZodString>;
}, z.core.$loose>;
/** 设置提交：全部字段可选但类型/长度受校验（前端可能分步持久化）；API Key 不进入此对象。 */
export declare const SettingsSubmitSchema: z.ZodObject<{
    nickname: z.ZodOptional<z.ZodString>;
    provider: z.ZodOptional<z.ZodString>;
    baseUrl: z.ZodOptional<z.ZodString>;
    model: z.ZodOptional<z.ZodString>;
    contextLength: z.ZodOptional<z.ZodString>;
    thinkingEnabled: z.ZodOptional<z.ZodBoolean>;
    developerMode: z.ZodOptional<z.ZodBoolean>;
    traceRetention: z.ZodOptional<z.ZodNumber>;
    compressionThreshold: z.ZodOptional<z.ZodNumber>;
    onboardingCompleted: z.ZodOptional<z.ZodBoolean>;
    customContext: z.ZodOptional<z.ZodString>;
}, z.core.$loose>;
/** 档案单项：id 为结构必需。 */
export declare const ProfileItemSchema: z.ZodObject<{
    id: z.ZodString;
    category: z.ZodOptional<z.ZodString>;
    title: z.ZodOptional<z.ZodString>;
    content: z.ZodOptional<z.ZodString>;
    updatedAt: z.ZodOptional<z.ZodNumber>;
}, z.core.$loose>;
/** 档案保存输入：单项数组，整体规模有上限。 */
export declare const ProfileItemsSchema: z.ZodArray<z.ZodObject<{
    id: z.ZodString;
    category: z.ZodOptional<z.ZodString>;
    title: z.ZodOptional<z.ZodString>;
    content: z.ZodOptional<z.ZodString>;
    updatedAt: z.ZodOptional<z.ZodNumber>;
}, z.core.$loose>>;
