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
