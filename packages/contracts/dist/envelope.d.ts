import { z } from 'zod';
import { type ErrorCodeValue } from './error-codes';
/** 跨进程错误信息 Schema；code 必须是稳定错误码。 */
export declare const ErrorInfoSchema: z.ZodObject<{
    code: z.ZodEnum<{
        AGENT_BUSY: "AGENT_BUSY";
        CANCELLED: "CANCELLED";
        INTERNAL_ERROR: "INTERNAL_ERROR";
        NOT_FOUND: "NOT_FOUND";
        PERMISSION_DENIED: "PERMISSION_DENIED";
        PROFILE_CONFLICT: "PROFILE_CONFLICT";
        PROVIDER_UNAVAILABLE: "PROVIDER_UNAVAILABLE";
        RESOURCE_LOCKED: "RESOURCE_LOCKED";
        RESOURCE_NOT_AUTHORIZED: "RESOURCE_NOT_AUTHORIZED";
        RESUME_LOCKED_BY_USER: "RESUME_LOCKED_BY_USER";
        RESUME_REVISION_CONFLICT: "RESUME_REVISION_CONFLICT";
        REVISION_CONFLICT: "REVISION_CONFLICT";
        STORAGE_ERROR: "STORAGE_ERROR";
        VALIDATION_ERROR: "VALIDATION_ERROR";
        WORKSPACE_BUSY: "WORKSPACE_BUSY";
    }>;
    message: z.ZodString;
    details: z.ZodOptional<z.ZodUnknown>;
    retryable: z.ZodBoolean;
}, z.core.$strip>;
/** 写命令信封 Schema；requestId 必填，可重放写入带 idempotencyKey，实体修改带 expectedRevision。 */
export declare const RequestEnvelopeSchema: z.ZodObject<{
    requestId: z.ZodString;
    idempotencyKey: z.ZodOptional<z.ZodString>;
    expectedRevision: z.ZodOptional<z.ZodNumber>;
    payload: z.ZodUnknown;
}, z.core.$strip>;
/** 统一结果信封 Schema：成功携带 data/meta，失败携带稳定错误码，禁止前端解析异常字符串。 */
export declare const ResultEnvelopeSchema: z.ZodDiscriminatedUnion<[z.ZodObject<{
    ok: z.ZodLiteral<true>;
    data: z.ZodUnknown;
    meta: z.ZodOptional<z.ZodObject<{
        revision: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strip>>;
}, z.core.$strip>, z.ZodObject<{
    ok: z.ZodLiteral<false>;
    error: z.ZodObject<{
        code: z.ZodEnum<{
            AGENT_BUSY: "AGENT_BUSY";
            CANCELLED: "CANCELLED";
            INTERNAL_ERROR: "INTERNAL_ERROR";
            NOT_FOUND: "NOT_FOUND";
            PERMISSION_DENIED: "PERMISSION_DENIED";
            PROFILE_CONFLICT: "PROFILE_CONFLICT";
            PROVIDER_UNAVAILABLE: "PROVIDER_UNAVAILABLE";
            RESOURCE_LOCKED: "RESOURCE_LOCKED";
            RESOURCE_NOT_AUTHORIZED: "RESOURCE_NOT_AUTHORIZED";
            RESUME_LOCKED_BY_USER: "RESUME_LOCKED_BY_USER";
            RESUME_REVISION_CONFLICT: "RESUME_REVISION_CONFLICT";
            REVISION_CONFLICT: "REVISION_CONFLICT";
            STORAGE_ERROR: "STORAGE_ERROR";
            VALIDATION_ERROR: "VALIDATION_ERROR";
            WORKSPACE_BUSY: "WORKSPACE_BUSY";
        }>;
        message: z.ZodString;
        details: z.ZodOptional<z.ZodUnknown>;
        retryable: z.ZodBoolean;
    }, z.core.$strip>;
}, z.core.$strip>], "ok">;
/** 写命令的跨进程请求类型。 */
export interface RequestEnvelope<T> {
    requestId: string;
    idempotencyKey?: string;
    expectedRevision?: number;
    payload: T;
}
/** 成功结果信封。 */
export interface SuccessResult<T> {
    ok: true;
    data: T;
    meta?: {
        revision?: number;
    };
}
/** 失败结果信封；code 来自稳定错误码枚举。 */
export interface FailureResult {
    ok: false;
    error: {
        code: ErrorCodeValue;
        message: string;
        details?: unknown;
        retryable: boolean;
    };
}
/** 统一结果信封类型。 */
export type ResultEnvelope<T> = SuccessResult<T> | FailureResult;
/** 构造统一成功结果信封；meta 可选携带 revision 等元数据。 */
export declare function CreateResultSuccess<T>(data: T, meta?: {
    revision?: number;
}): SuccessResult<T>;
/** 构造统一失败结果信封；非稳定错误码一律归一为 INTERNAL_ERROR，禁止向外部泄露内部细节。 */
export declare function CreateResultFailure(code: string, message: string, extra?: {
    details?: unknown;
    retryable?: boolean;
}): FailureResult;
