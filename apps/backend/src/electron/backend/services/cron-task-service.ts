/** CronTask 应用服务：Repository 是唯一事实源；每次写后通知调度器同步最早唤醒。 */
export class CronTaskService {
  constructor(private readonly repository: any, private readonly syncWake: (nextRunAt: number | null) => Promise<unknown> | unknown = () => undefined) {}

  async Create(input: unknown, resourceContext?: { resumeId?: string }): Promise<any> { const task = this.repository.Create(input, resourceContext); await this.Sync(); return task; }
  Read(input: { cronTaskId?: string; includeRuns?: boolean } = {}): any {
    if (input.cronTaskId) {
      const task = this.repository.Read(input.cronTaskId);
      if (!task) throw new Error('CronTask was not found.');
      return { task, ...(input.includeRuns ? { runs: this.repository.ListRuns(input.cronTaskId) } : {}) };
    }
    return { tasks: this.repository.List() };
  }
  async Update(input: unknown, expectedRevision?: number): Promise<any> { const task = this.repository.Update(input, expectedRevision); await this.Sync(); return task; }
  async Delete(id: string): Promise<any> { const result = this.repository.Delete(id); await this.Sync(); return result; }
  ClaimDue(now?: number): any[] { return this.repository.ClaimDue(now); }
  AttachConversation(runId: string, conversationId: string): void { this.repository.AttachConversation(runId, conversationId); }
  FinishRun(runId: string, state: string, reason?: string): any { return this.repository.FinishRun(runId, state, reason); }
  RecoverInterruptedRuns(): number { return this.repository.RecoverInterruptedRuns(); }
  EarliestNextRunAt(): number | null { return this.repository.EarliestNextRunAt(); }
  async Sync(): Promise<void> { await this.syncWake(this.repository.EarliestNextRunAt()); }
}
