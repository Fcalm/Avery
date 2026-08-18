"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ExtractDetails = ExtractDetails;
exports.NormalizeError = NormalizeError;
const error_codes_1 = require("./error-codes");
/** 从异常中提取白名单化的错误详情，不透传任意属性以防止路径或堆栈泄露。 */
function ExtractDetails(error) {
    const details = {};
    const target = error;
    if (target && target.entityType)
        details.entityType = String(target.entityType);
    if (target && target.entityId)
        details.entityId = String(target.entityId);
    if (target && target.expectedRevision != null)
        details.expectedRevision = target.expectedRevision;
    if (target && target.actualRevision != null)
        details.actualRevision = target.actualRevision;
    if (target && target.details && typeof target.details === 'object') {
        for (const [key, value] of Object.entries(target.details)) {
            // 仅透传已脱敏的标量或纯数据字段，拒绝任何嵌套对象里的路径/堆栈。
            if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')
                details[key] = value;
        }
    }
    return details;
}
/** 把任意异常规整为稳定错误信息，供后端出口转换为失败信封；剥离内部堆栈与绝对路径，白名单透传实体冲突详情与可重试标记。 */
function NormalizeError(error) {
    const target = error;
    const code = target && typeof target.code === 'string' && Object.values(error_codes_1.ErrorCode).includes(target.code)
        ? target.code
        : error_codes_1.ErrorCode.INTERNAL_ERROR;
    const details = ExtractDetails(error);
    const normalized = { code, message: error instanceof Error ? error.message : 'Internal error.' };
    if (Object.keys(details).length)
        normalized.details = details;
    if (target && target.retryable === true)
        normalized.retryable = true;
    return normalized;
}
