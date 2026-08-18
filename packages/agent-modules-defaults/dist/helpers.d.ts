import type { ResumeSnapshot, ToolExecutionResult } from '@offerget/agent-sdk';
/** 校验字符串字段，避免工具/配置输入直接进入请求层或持久化。 */
export declare function RequireString(value: unknown, field: string, maxLength?: number): string;
/** 生成符合 Chat Completions 协议的脱敏工具结果。 */
export declare function CreateToolResult(toolCallId: string, payload: Record<string, unknown>): ToolExecutionResult;
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
}
