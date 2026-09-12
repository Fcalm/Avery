import { GetNow, WriteAudit } from './helpers';

/** BOSS 联系批次的持久检查点；消息正文只存在冻结计划中，不写普通日志。 */
export class BossContactBatchRepository {
  constructor(private readonly db: any) {}

  Create(input: { id: string; sessionId: string; proposalHash: string; plan: unknown; items: Array<{ jobId: string }> }): void {
    const now = GetNow();
    this.db.transaction(() => {
      this.db.prepare('INSERT INTO boss_contact_batches(id,session_id,proposal_hash,status,plan_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?)')
        .run(input.id, input.sessionId, input.proposalHash, 'prepared', JSON.stringify(input.plan), now, now);
      const insert = this.db.prepare("INSERT INTO boss_contact_items(batch_id,job_id,sequence,step,updated_at) VALUES(?,?,?,?,?)");
      input.items.forEach((item, index) => insert.run(input.id, item.jobId, index, 'pending', now));
      WriteAudit(this.db, 'agent', 'prepare', 'boss_contact_batch', input.id, { itemCount: input.items.length });
    })();
  }

  Checkpoint(batchId: string, jobId: string, step: string, result?: unknown): void {
    this.db.prepare('UPDATE boss_contact_items SET step=?,result_json=?,updated_at=? WHERE batch_id=? AND job_id=?')
      .run(step, result === undefined ? null : JSON.stringify(result), GetNow(), batchId, jobId);
    this.db.prepare("UPDATE boss_contact_batches SET status='running',updated_at=? WHERE id=? AND status IN ('prepared','running')").run(GetNow(), batchId);
  }

  Finish(batchId: string, status: string, result: unknown): void {
    this.db.prepare('UPDATE boss_contact_batches SET status=?,result_json=?,updated_at=? WHERE id=?').run(status, JSON.stringify(result), GetNow(), batchId);
    WriteAudit(this.db, 'agent', status, 'boss_contact_batch', batchId, {});
  }
}
