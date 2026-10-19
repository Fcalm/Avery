import type { TaskItem } from './types';
import type { ConversationActivity, ConversationPresentation } from './conversation';

/** Kernel 发给宿主的流式事件：与 contracts AgentStreamEvent 结构保持一致，agent-sdk 保持零运行时依赖。 */
export interface AgentStreamEvent {
  /** activity 由内核产生，presentation 由宿主持久化后向 Renderer 发布。 */
  activity?: ConversationActivity;
  presentation?: ConversationPresentation;
  type: 'conversation_save_error' | 'conversation_activity' | 'conversation_updated' | 'thinking_delta' | 'content_delta' | 'completed' | 'cancelled' | 'error' | 'run_released' | 'run_resumed' | 'resume_updated' | 'resume_created' | 'resume_confirmation' | 'cron_task_confirmation' | 'cron_task_changed' | 'cron_run_completed' | 'browser_confirmation' | 'browser_action_completed' | 'browser_user_action' | 'task_created' | 'task_updated' | 'task_deleted' | 'question_requested' | 'waiting_user_input' | 'waiting_confirmation' | 'paused';
  requestId?: string;
  /** 恢复保留原 requestId；confirmationId 指向刚消费的交互。 */
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
  browserAction?: { confirmationId?: string; proposalId?: string; toolName?: string; summary?: string; url?: string; risk?: 'low' | 'medium' | 'high'; status?: 'succeeded' | 'rejected' | 'failed' | 'status_unknown' | 'user_action_required'; message?: string; receipt?: unknown };
  cleanupOutcomes?: Array<{ status: 'confirmed' | 'status_unknown' | 'failed'; browserTaskId: string | null; code?: string; message?: string; closedTabs: number; unknownTabs: number | null }>;
  cronTask?: { id?: string; title?: string; message?: string; scenarioId?: 'default' | 'application'; schedule?: unknown; state?: string; summary?: string };
}
