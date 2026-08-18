/** 稳定错误码：跨进程业务错误的唯一枚举。前端不得通过解析异常字符串判断业务错误。 */
export declare const ErrorCode: {
    readonly VALIDATION_ERROR: 'VALIDATION_ERROR';
    readonly NOT_FOUND: 'NOT_FOUND';
    readonly REVISION_CONFLICT: 'REVISION_CONFLICT';
    /** 档案 profile.json 被外部修改的兼容错误码；V1 现有实现沿用。 */
    readonly PROFILE_CONFLICT: 'PROFILE_CONFLICT';
    /** 简历乐观锁版本冲突：Agent 或用户基于过期版本保存。 */
    readonly RESUME_REVISION_CONFLICT: 'RESUME_REVISION_CONFLICT';
    /** 简历互斥锁被用户占用：Agent 尝试编辑时被拒绝。 */
    readonly RESUME_LOCKED_BY_USER: 'RESUME_LOCKED_BY_USER';
    readonly RESOURCE_LOCKED: 'RESOURCE_LOCKED';
    readonly PERMISSION_DENIED: 'PERMISSION_DENIED';
    readonly RESOURCE_NOT_AUTHORIZED: 'RESOURCE_NOT_AUTHORIZED';
    readonly AGENT_BUSY: 'AGENT_BUSY';
    readonly WORKSPACE_BUSY: 'WORKSPACE_BUSY';
    readonly PROVIDER_UNAVAILABLE: 'PROVIDER_UNAVAILABLE';
    readonly STORAGE_ERROR: 'STORAGE_ERROR';
    readonly CANCELLED: 'CANCELLED';
    readonly INTERNAL_ERROR: 'INTERNAL_ERROR';
};
/** 稳定错误码的字面量联合类型。 */
export type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode];
