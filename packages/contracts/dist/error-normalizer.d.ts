import { type ErrorCodeValue } from './error-codes';
/** 从异常中提取白名单化的错误详情，不透传任意属性以防止路径或堆栈泄露。 */
export declare function ExtractDetails(error: unknown): Record<string, string | number | boolean>;
/** 归一化错误详情类型：稳定错误码 + 白名单透传的实体冲突详情与可重试标记。 */
export interface NormalizedError {
    code: ErrorCodeValue;
    message: string;
    details?: Record<string, string | number | boolean>;
    retryable?: boolean;
}
/** 把任意异常规整为稳定错误信息，供后端出口转换为失败信封；剥离内部堆栈与绝对路径，白名单透传实体冲突详情与可重试标记。 */
export declare function NormalizeError(error: unknown): NormalizedError;
