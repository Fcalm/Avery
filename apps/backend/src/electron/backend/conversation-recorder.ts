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
  private browserWaitMessage: string | undefined;
  private pendingSnapshot: ConversationPresentation | undefined;
  private draining = false;
  private attemptedSequence = -1;
  get Status(): ConversationPresentation['status'] { return this.presentation.status; }

  constructor(
    readonly requestId: string, sessionId: string,
    private readonly save: (sessionId: string, presentation: ConversationPresentation) => Promise<{ saved: boolean }>,
    private readonly publish: (event: AgentStreamEvent) => void,
    initial?: ConversationPresentation,
    private readonly saveTimeoutMs = 5_000,
  ) {
    this.sessionId = sessionId;
    this.presentation = initial ?? CreateConversationPresentation(requestId);
  }

  Accept(event: AgentStreamEvent): void {
    if (this.disposed) return;
    let activity = event.activity;
    if (event.type === 'browser_user_action' && event.browserAction?.summary) this.browserWaitMessage = event.browserAction.summary;
    // 浏览器接管没有应用内待回答卡片；与真正的问答/审批等待分开，显示为已暂停。
    const status = event.type === 'waiting_user_input' && this.browserWaitMessage ? 'paused' : TerminalStatuses[event.type];
    if (status) {
      activity = { kind: 'status', status, ...(event.type === 'error' ? { error: event.message ?? '运行失败' } : {}),
        ...((status === 'waiting' || status === 'paused') && this.browserWaitMessage ? { summary: this.browserWaitMessage } : status === 'paused' && event.message ? { summary: event.message } : {}),
      };
      if (status !== 'waiting' && status !== 'paused') this.browserWaitMessage = undefined;
    }
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
    if (this.failure && !this.draining && this.attemptedSequence === this.presentation.sequence) return;
    // 投影是包含全部步骤的不可变快照；只保留一个在途写入和最新候选，避免慢盘堆积数百次全量写入。
    this.pendingSnapshot = this.presentation;
    if (this.draining) return;
    this.draining = true;
    this.queue = this.Drain().finally(() => {
      this.draining = false;
      if (this.pendingSnapshot && !this.disposed) this.Enqueue();
    });
    void this.queue.catch(() => undefined);
  }

  private async Drain(): Promise<void> {
    while (this.pendingSnapshot && !this.disposed) {
      const snapshot = this.pendingSnapshot; this.pendingSnapshot = undefined;
      this.attemptedSequence = snapshot.sequence;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const timeout = new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error('会话过程保存超时，保存结果尚未确认')), this.saveTimeoutMs);
        });
        const result = await Promise.race([this.save(this.sessionId, snapshot), timeout]);
        this.failure = undefined;
        if (result.saved && !this.disposed) this.publish({ type: 'conversation_updated', requestId: this.requestId, sessionId: this.sessionId, presentation: snapshot });
      } catch (error) {
        this.failure = error instanceof Error ? error : new Error('会话过程保存失败');
        this.pendingSnapshot = undefined;
        if (!this.disposed) this.publish({ type: 'conversation_save_error', requestId: this.requestId, sessionId: this.sessionId, message: '会话过程保存失败：' + this.failure.message });
        return;
      } finally { clearTimeout(timer); }
    }
  }

  /** 删除会话时取消尚未派发的批次；已进入数据库的请求由消息存在性检查阻止复活。 */
  Dispose(): void {
    this.disposed = true;
    this.pendingSnapshot = undefined;
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  /** Send 释放请求和确认返回前等待持久化，避免用户切换或退出时丢失终态。 */
  async Flush(): Promise<void> {
    clearTimeout(this.timer); this.timer = undefined; this.Enqueue();
    let pending: Promise<void>;
    do { pending = this.queue; await pending; } while (pending !== this.queue);
    if (this.failure) throw this.failure;
  }
}
