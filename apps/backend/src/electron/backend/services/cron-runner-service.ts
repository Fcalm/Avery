import { randomUUID } from 'node:crypto';

const MaximumTimerMs = 2_147_000_000;
const BusyRetryMs = 30_000;
const BusyDeadlineMs = 30 * 60_000;

/**
 * Cron Runner 只在 Backend 内部调用 AgentHost.SendScheduled，Renderer 无法伪造 unattended。
 * 每个 occurrence 先原子 claim，再创建独立会话并自行持久化流式最终文本，因此无窗口时同样完整。
 */
export class CronRunnerService {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private busySince: number | null = null;

  constructor(private readonly input: { business: any; agent: any; syncOsWake: (nextRunAt: number | null) => Promise<unknown> | unknown; emit?: (event: unknown) => void }) {}

  async Initialize(): Promise<void> {
    await this.input.business.RecoverInterruptedCronRuns();
    await this.Sync();
  }

  Close(): void { if (this.timer) clearTimeout(this.timer); this.timer = null; }

  /** 同步 OS 唤醒后在当前存活进程内也设置最近计时器，避免必须重启应用才能触发。 */
  async Sync(): Promise<void> {
    const nextRunAt = (await this.input.business.GetEarliestCronRunAt())?.nextRunAt ?? null;
    this.Arm(nextRunAt);
    await this.input.syncOsWake(nextRunAt);
  }

  Arm(nextRunAt: number | null): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (nextRunAt === null) return;
    const delay = Math.min(MaximumTimerMs, Math.max(0, nextRunAt - Date.now()));
    this.timer = setTimeout(() => { void this.RunDue(); }, delay);
  }

  async RunDue(now = Date.now()): Promise<{ claimed: number; completed: number; needsAttention: number; missed: number; failed: number }> {
    if (this.running) return { claimed: 0, completed: 0, needsAttention: 0, missed: 0, failed: 0 };
    this.running = true;
    let deferredForBusy = false;
    const summary = { claimed: 0, completed: 0, needsAttention: 0, missed: 0, failed: 0 };
    try {
      if (this.input.agent.IsBusy()) {
        this.busySince ??= now;
        if (now - this.busySince < BusyDeadlineMs) {
          deferredForBusy = true;
          this.timer = setTimeout(() => { void this.RunDue(); }, BusyRetryMs);
          return summary;
        }
      } else {
        this.busySince = null;
      }
      const browserBusyExpired = this.input.agent.IsBusy() && this.busySince !== null && now - this.busySince >= BusyDeadlineMs;
      const claims = await this.input.business.ClaimDueCronTasks(now);
      summary.claimed = claims.length;
      for (const claim of claims) {
        if (browserBusyExpired) {
          await this.input.business.FinishCronRun(claim.run.id, 'missed', claim.task.scenarioId === 'application' ? 'browser_busy' : 'agent_busy');
          summary.missed += 1;
          continue;
        }
        await this.ExecuteClaim(claim, summary);
      }
      this.busySince = null;
      return summary;
    } finally {
      this.running = false;
      if (!deferredForBusy) await this.Sync();
    }
  }

  private async ExecuteClaim(claim: any, summary: { completed: number; needsAttention: number; failed: number }): Promise<void> {
    const conversationId = `cron-conversation-${randomUUID()}`;
    const requestId = `cron-request-${randomUUID()}`;
    const replyId = `reply-${requestId}`;
    const dateLabel = new Intl.DateTimeFormat('zh-CN', { timeZone: claim.task.schedule.timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(claim.run.scheduledAt));
    try {
      await this.input.business.CreateConversation({ id: conversationId, title: `${claim.task.title} · ${dateLabel}`.slice(0, 300) });
      await this.input.business.AppendConversationMessages(conversationId, [
        { id: `message-${randomUUID()}`, role: 'user', content: claim.task.message },
        { id: replyId, role: 'assistant', content: '', thinkingContent: '' },
      ]);
      await this.input.business.AttachCronRunConversation(claim.run.id, conversationId);
      const result = await this.input.agent.SendScheduled({
        requestId, sessionId: conversationId, content: claim.task.message, scenarioId: claim.task.scenarioId,
        ...(claim.task.resumeId ? { resumeId: claim.task.resumeId } : {}),
      });
      const needsAttention = result.needsAttention === true || ['waiting_user_input', 'waiting_confirmation'].includes(result.terminal);
      const content = result.content || (needsAttention ? '定时任务需要你接管登录、验证码或补充必要信息。' : '定时任务已完成。');
      await this.input.business.CompleteConversationMessage(conversationId, replyId, content, result.thinkingContent || undefined);
      await this.input.business.FinishCronRun(claim.run.id, needsAttention ? 'needsAttention' : 'completed', needsAttention ? 'user_action_required' : undefined);
      if (needsAttention) summary.needsAttention += 1; else summary.completed += 1;
      this.input.emit?.({ type: 'cron_run_completed', cronTask: { id: claim.task.id, title: claim.task.title, state: needsAttention ? 'needsAttention' : 'completed' }, conversationId });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Scheduled Agent run failed.';
      try { await this.input.business.CompleteConversationMessage(conversationId, replyId, `定时任务执行失败：${message.slice(0, 500)}`); } catch { /* 会话尚未创建时没有占位消息可更新。 */ }
      await this.input.business.FinishCronRun(claim.run.id, 'failed', message.slice(0, 500));
      summary.failed += 1;
      this.input.emit?.({ type: 'cron_run_completed', cronTask: { id: claim.task.id, title: claim.task.title, state: 'failed' }, conversationId });
    }
  }
}
