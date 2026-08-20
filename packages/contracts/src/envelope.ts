import { z } from 'zod';
import { ErrorCode, type ErrorCodeValue } from './error-codes';

const errorCodeValues = Object.values(ErrorCode) as [ErrorCodeValue, ...ErrorCodeValue[]];

/** 跨进程错误信息 Schema；code 必须是稳定错误码。 */
export const ErrorInfoSchema = z.object({
  code: z.enum(errorCodeValues),
  message: z.string(),
  details: z.unknown().optional(),
  retryable: z.boolean(),
});

/** 写命令信封 Schema；requestId 必填，可重放写入带 idempotencyKey，实体修改带 expectedRevision。 */
export const RequestEnvelopeSchema = z.object({
  requestId: z.string().min(1).max(200),
  idempotencyKey: z.string().min(1).max(200).optional(),
  expectedRevision: z.number().int().nonnegative().optional(),
  payload: z.unknown(),
});

/**
 * Renderer 发往 Gateway 的写命令信封。内部 requestId 只用于 Main 与 Backend 的传输配对，
 * 不允许 Renderer 伪造；稳定幂等键则在一次用户写意图及其自动重试中复用。
 */
export const WriteCommandEnvelopeSchema = RequestEnvelopeSchema.pick({ idempotencyKey: true }).extend({
  idempotencyKey: RequestEnvelopeSchema.shape.idempotencyKey.unwrap(),
  payload: z.array(z.unknown()),
});

/** 统一结果信封 Schema：成功携带 data/meta，失败携带稳定错误码，禁止前端解析异常字符串。 */
export const ResultEnvelopeSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), data: z.unknown(), meta: z.object({ revision: z.number().optional() }).optional() }),
  z.object({ ok: z.literal(false), error: ErrorInfoSchema }),
]);

/** 写命令的跨进程请求类型。 */
export interface RequestEnvelope<T> {
  requestId: string;
  idempotencyKey?: string;
  expectedRevision?: number;
  payload: T;
}

/** Renderer 写命令信封类型；字段语义与 RequestEnvelope 保持一致，但不暴露内部 requestId。 */
export interface WriteCommandEnvelope<T> {
  idempotencyKey: NonNullable<RequestEnvelope<T>['idempotencyKey']>;
  payload: T[];
}

/** 由调用意图创建的稳定写命令选项；调用方重试时必须复用同一对象中的键。 */
export interface WriteCommandOptions {
  idempotencyKey: string;
}

/** 成功结果信封。 */
export interface SuccessResult<T> {
  ok: true;
  data: T;
  meta?: { revision?: number };
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
export function CreateResultSuccess<T>(data: T, meta?: { revision?: number }): SuccessResult<T> {
  return meta ? { ok: true, data, meta } : { ok: true, data };
}

/** 构造统一失败结果信封；非稳定错误码一律归一为 INTERNAL_ERROR，禁止向外部泄露内部细节。 */
export function CreateResultFailure(code: string, message: string, extra?: { details?: unknown; retryable?: boolean }): FailureResult {
  const known = (Object.values(ErrorCode) as string[]).includes(code);
  const normalizedCode: ErrorCodeValue = known ? code as ErrorCodeValue : ErrorCode.INTERNAL_ERROR;
  return { ok: false, error: { code: normalizedCode, message, retryable: false, ...extra } };
}
