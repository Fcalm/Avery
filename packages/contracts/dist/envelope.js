"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ResultEnvelopeSchema = exports.WriteCommandEnvelopeSchema = exports.RequestEnvelopeSchema = exports.ErrorInfoSchema = void 0;
exports.CreateResultSuccess = CreateResultSuccess;
exports.CreateResultFailure = CreateResultFailure;
const zod_1 = require("zod");
const error_codes_1 = require("./error-codes");
const errorCodeValues = Object.values(error_codes_1.ErrorCode);
/** 跨进程错误信息 Schema；code 必须是稳定错误码。 */
exports.ErrorInfoSchema = zod_1.z.object({
    code: zod_1.z.enum(errorCodeValues),
    message: zod_1.z.string(),
    details: zod_1.z.unknown().optional(),
    retryable: zod_1.z.boolean(),
});
/** 写命令信封 Schema；requestId 必填，可重放写入带 idempotencyKey，实体修改带 expectedRevision。 */
exports.RequestEnvelopeSchema = zod_1.z.object({
    requestId: zod_1.z.string().min(1).max(200),
    idempotencyKey: zod_1.z.string().min(1).max(200).optional(),
    expectedRevision: zod_1.z.number().int().nonnegative().optional(),
    payload: zod_1.z.unknown(),
});
/**
 * Renderer 发往 Gateway 的写命令信封。内部 requestId 只用于 Main 与 Backend 的传输配对，
 * 不允许 Renderer 伪造；稳定幂等键则在一次用户写意图及其自动重试中复用。
 */
exports.WriteCommandEnvelopeSchema = exports.RequestEnvelopeSchema.pick({ idempotencyKey: true }).extend({
    idempotencyKey: exports.RequestEnvelopeSchema.shape.idempotencyKey.unwrap(),
    payload: zod_1.z.array(zod_1.z.unknown()),
});
/** 统一结果信封 Schema：成功携带 data/meta，失败携带稳定错误码，禁止前端解析异常字符串。 */
exports.ResultEnvelopeSchema = zod_1.z.discriminatedUnion('ok', [
    zod_1.z.object({ ok: zod_1.z.literal(true), data: zod_1.z.unknown(), meta: zod_1.z.object({ revision: zod_1.z.number().optional() }).optional() }),
    zod_1.z.object({ ok: zod_1.z.literal(false), error: exports.ErrorInfoSchema }),
]);
/** 构造统一成功结果信封；meta 可选携带 revision 等元数据。 */
function CreateResultSuccess(data, meta) {
    return meta ? { ok: true, data, meta } : { ok: true, data };
}
/** 构造统一失败结果信封；非稳定错误码一律归一为 INTERNAL_ERROR，禁止向外部泄露内部细节。 */
function CreateResultFailure(code, message, extra) {
    const known = Object.values(error_codes_1.ErrorCode).includes(code);
    const normalizedCode = known ? code : error_codes_1.ErrorCode.INTERNAL_ERROR;
    return { ok: false, error: { code: normalizedCode, message, retryable: false, ...extra } };
}
