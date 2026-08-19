import type { ResumeSnapshot, ToolDisposition, ToolExecutionResult, ToolReceipt } from '@offerget/agent-sdk';

/** 校验字符串字段，避免工具/配置输入直接进入请求层或持久化。 */
export function RequireString(value: unknown, field: string, maxLength = 20000): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maxLength) throw new Error(`${field} is invalid.`);
  return value.trim();
}

/** 生成符合 Chat Completions 协议的脱敏工具结果；可携带统一 disposition 与 receipt。 */
export function CreateToolResult(
  toolCallId: string,
  payload: Record<string, unknown>,
  extra: { disposition?: ToolDisposition; receipt?: ToolReceipt } = {},
): ToolExecutionResult {
  return {
    role: 'tool',
    tool_call_id: toolCallId,
    content: JSON.stringify(payload),
    ...(extra.disposition ? { disposition: extra.disposition } : {}),
    ...(extra.receipt ? { receipt: extra.receipt } : {}),
  };
}

/** 待确认简历补丁：创建或编辑内容；确认时经写端口整份落库并释放锁；resume 携带编辑前的完整快照。 */
export interface PendingResumeEdit {
  kind: 'create' | 'edit';
  resumeId: string;
  name?: string;
  content: string;
  reason: string;
  baseRevision?: number;
  ownerId: string;
  resume?: ResumeSnapshot;
  /** 冻结提案哈希；接受确认时必须与当前提案一致，防止参数被替换。 */
  proposalHash: string;
  /** 规范化参数；确认后 Harness 只执行这份冻结参数，不再让模型重新生成。 */
  canonicalArguments: unknown;
  /** 业务幂等键；确认提交时复用同一键保证幂等。 */
  idempotencyKey: string;
  /** 待确认推测补全条目；写入正式简历前必须由用户文本确认。 */
  uncertainItems?: Array<{ id: string; text: string }>;
}
