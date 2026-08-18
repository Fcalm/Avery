"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ErrorCode = void 0;
/** 稳定错误码：跨进程业务错误的唯一枚举。前端不得通过解析异常字符串判断业务错误。 */
exports.ErrorCode = {
    VALIDATION_ERROR: 'VALIDATION_ERROR',
    NOT_FOUND: 'NOT_FOUND',
    REVISION_CONFLICT: 'REVISION_CONFLICT',
    /** 档案 profile.json 被外部修改的兼容错误码；V1 现有实现沿用。 */
    PROFILE_CONFLICT: 'PROFILE_CONFLICT',
    /** 简历乐观锁版本冲突：Agent 或用户基于过期版本保存。 */
    RESUME_REVISION_CONFLICT: 'RESUME_REVISION_CONFLICT',
    /** 简历互斥锁被用户占用：Agent 尝试编辑时被拒绝。 */
    RESUME_LOCKED_BY_USER: 'RESUME_LOCKED_BY_USER',
    RESOURCE_LOCKED: 'RESOURCE_LOCKED',
    PERMISSION_DENIED: 'PERMISSION_DENIED',
    RESOURCE_NOT_AUTHORIZED: 'RESOURCE_NOT_AUTHORIZED',
    AGENT_BUSY: 'AGENT_BUSY',
    WORKSPACE_BUSY: 'WORKSPACE_BUSY',
    PROVIDER_UNAVAILABLE: 'PROVIDER_UNAVAILABLE',
    STORAGE_ERROR: 'STORAGE_ERROR',
    CANCELLED: 'CANCELLED',
    INTERNAL_ERROR: 'INTERNAL_ERROR',
};
