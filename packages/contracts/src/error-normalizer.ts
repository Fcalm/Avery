import { ErrorCode, type ErrorCodeValue } from './error-codes';

/** 从异常中提取白名单化的错误详情，不透传任意属性以防止路径或堆栈泄露。 */
export function ExtractDetails(error: unknown): Record<string, string | number | boolean> {
  const details: Record<string, string | number | boolean> = {};
  const target = error as {
    entityType?: unknown; entityId?: unknown; expectedRevision?: unknown; actualRevision?: unknown; details?: unknown;
  } | null;
  if (target && target.entityType) details.entityType = String(target.entityType);
  if (target && target.entityId) details.entityId = String(target.entityId);
  if (target && target.expectedRevision != null) details.expectedRevision = target.expectedRevision as number;
  if (target && target.actualRevision != null) details.actualRevision = target.actualRevision as number;
  if (target && target.details && typeof target.details === 'object') {
    for (const [key, value] of Object.entries(target.details as Record<string, unknown>)) {
      // 仅透传已脱敏的标量或纯数据字段，拒绝任何嵌套对象里的路径/堆栈。
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') details[key] = value;
    }
  }
  return details;
}

/** 归一化错误详情类型：稳定错误码 + 白名单透传的实体冲突详情与可重试标记。 */
export interface NormalizedError {
  code: ErrorCodeValue;
  message: string;
  details?: Record<string, string | number | boolean>;
  retryable?: boolean;
}

/** 把任意异常规整为稳定错误信息，供后端出口转换为失败信封；剥离内部堆栈与绝对路径，白名单透传实体冲突详情与可重试标记。 */
export function NormalizeError(error: unknown): NormalizedError {
  const target = error as { code?: unknown; retryable?: unknown } | null;
  const code = target && typeof target.code === 'string' && (Object.values(ErrorCode) as string[]).includes(target.code)
    ? target.code as ErrorCodeValue
    : ErrorCode.INTERNAL_ERROR;
  const details = ExtractDetails(error);
  const normalized: NormalizedError = { code, message: error instanceof Error ? error.message : 'Internal error.' };
  if (Object.keys(details).length) normalized.details = details;
  if (target && target.retryable === true) normalized.retryable = true;
  return normalized;
}
