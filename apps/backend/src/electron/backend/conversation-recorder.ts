import { ApplyConversationActivity, CreateConversationPresentation, type AgentStreamEvent, type ConversationPresentation, type ConversationResource, type ConversationRunStatus } from '@avery/agent-sdk';

const TerminalStatuses: Record<string, ConversationRunStatus> = {
  run_resumed: 'running',
  completed: 'completed', cancelled: 'cancelled', error: 'failed',
  waiting_user_input: 'waiting', waiting_confirmation: 'waiting', paused: 'paused',
};

/** 宿主会话投影：合批保存文本增量，步骤/工具边界立即排队；只有已落盘的投影才发给页面。 */
export class ConversationRecorder {
  readonly sessionId: string;
  private presentation: ConversationPresentation;
  private queue: Promise<void> = Promise.resolve();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private failure: Error | undefined;
  private disposed = false;
  get Status(): ConversationPresentation['status'] { return this.presentation.status; }

  constructor(
    readonly requestId: string, sessionId: string,
    private readonly save: (sessionId: string, presentation: ConversationPresentation) => Promise<{ saved: boolean }>,
    private readonly publish: (event: AgentStreamEvent) => void,
    initial?: ConversationPresentation,
  ) {
    this.sessionId = sessionId;
    this.presentation = initial ?? CreateConversationPresentation(requestId);
  }

  Accept(event: AgentStreamEvent): void {
    if (this.disposed) return;
    let activity = event.activity;
    const status = TerminalStatuses[event.type];
    if (status) activity = { kind: 'status', status, ...(event.type === 'error' ? { error: event.message ?? '运行失败' } : {}) };
    // 已落库的实体事件才可创建产物引用，模型正文中的名称不视为资源授权。
    if ((event.type === 'resume_created' || event.type === 'resume_updated') && event.resumeId) {
      activity = { kind: 'resource', resource: { kind: 'resume', id: event.resumeId, title: event.resumeName || '简历', produced: true, ...(event.revision ? { revision: event.revision } : {}) } };
    }
    if (!activity) return;
    this.presentation = ApplyConversationActivity(this.presentation, activity, this.presentation.sequence + 1, Date.now());
    if (activity.kind === 'text' || activity.kind === 'reasoning') {
      if (!this.timer) this.timer = setTimeout(() => { this.timer = undefined; this.Enqueue(); }, 120);
    } else {
      clearTimeout(this.timer); this.timer = undefined; this.Enqueue();
    }
  }

  AddResource(resource: ConversationResource): void { this.Accept({ type: 'conversation_activity', activity: { kind: 'resource', resource } }); }

  /** 只结算原工具；结构化恢复保留同一 Run，不能把批准误记为整轮完成。 */
  async ResolveInteraction(accepted: boolean, outcome: 'succeeded' | 'failed' | 'skipped' = accepted ? 'succeeded' : 'skipped', summary?: string, continueRun = false): Promise<void> {
    for (const part of this.presentation.parts) {
      if (part.type === 'tool' && part.status === 'waiting') this.Accept({ type: 'conversation_activity', activity: {
        kind: 'tool', stepId: part.stepId, toolCallId: part.toolCallId, name: part.name,
        toolStatus: outcome, summary: summary ?? (accepted ? '已确认并执行' : '用户已拒绝执行'),
      } });
    }
    this.Accept(continueRun ? { type: 'run_resumed' } : outcome === 'failed' ? { type: 'error', message: summary ?? '确认后的操作未能完成，请核对结果后继续。' } : { type: 'completed' });
    await this.Flush();
  }

  private Enqueue(): void {
    if (this.disposed) return;
    const snapshot = this.presentation;
    this.queue = this.queue.then(async () => {
      if (this.disposed) return;
      const result = await this.save(this.sessionId, snapshot);
      this.failure = undefined;
      if (result.saved && !this.disposed) this.publish({ type: 'conversation_updated', requestId: this.requestId, sessionId: this.sessionId, presentation: snapshot });
    }).catch((error: unknown) => {
      this.failure = error instanceof Error ? error : new Error('会话过程保存失败');
      this.publish({ type: 'conversation_save_error', requestId: this.requestId, sessionId: this.sessionId, message: '会话过程保存失败：' + this.failure.message });
    });
  }

  /** 删除会话时取消尚未派发的批次；已进入数据库的请求由消息存在性检查阻止复活。 */
  Dispose(): void {
    this.disposed = true;
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  /** Send 释放请求和确认返回前等待持久化，避免用户切换或退出时丢失终态。 */
  async Flush(): Promise<void> {
    clearTimeout(this.timer); this.timer = undefined; this.Enqueue();
    await this.queue;
    if (this.failure) throw this.failure;
  }
}
