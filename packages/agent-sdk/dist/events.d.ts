import type { TaskItem } from './types';
/** Kernel 发给宿主的流式事件：与 contracts AgentStreamEvent 结构保持一致，agent-sdk 保持零运行时依赖。 */
export interface AgentStreamEvent {
    type: 'thinking_delta' | 'content_delta' | 'completed' | 'cancelled' | 'error' | 'resume_updated' | 'resume_created' | 'resume_confirmation' | 'task_created' | 'task_updated' | 'question_requested';
    requestId?: string;
    sessionId?: string;
    delta?: string;
    content?: string;
    thinkingContent?: string;
    message?: string;
    resumeId?: string;
    resumeName?: string;
    reason?: string;
    /** 简历事件可携带后端返回的版本号；前端据此同步本地 revision。 */
    revision?: number;
    task?: TaskItem;
    confirmationId?: string;
    questions?: Array<{
        id: string;
        question: string;
        options: string[];
    }>;
}
