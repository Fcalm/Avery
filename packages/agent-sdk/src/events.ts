import type { TaskItem } from './types';

/** Kernel 发给宿主的流式事件：与 contracts AgentStreamEvent 结构保持一致，agent-sdk 保持零运行时依赖。 */
export interface AgentStreamEvent {
  type: 'thinking_delta' | 'content_delta' | 'completed' | 'cancelled' | 'error' | 'resume_updated' | 'resume_created' | 'resume_confirmation' | 'browser_confirmation' | 'browser_action_completed' | 'browser_user_action' | 'task_created' | 'task_updated' | 'question_requested' | 'waiting_user_input' | 'waiting_confirmation' | 'paused';
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
  questions?: Array<{ id: string; question: string; options: string[] }>;
  browserAction?: { confirmationId?: string; toolName?: string; summary?: string; url?: string; risk?: 'low' | 'medium' | 'high'; status?: 'succeeded' | 'rejected' | 'failed' | 'status_unknown' | 'user_action_required'; message?: string; receipt?: unknown };
}
