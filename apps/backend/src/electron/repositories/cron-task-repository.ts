import { randomUUID } from 'node:crypto';
import { BrowserTaskGrantSchema, CreateCronTaskSchema, UpdateCronTaskSchema, type BrowserTaskGrant, type CronRunState, type CronSchedule } from '@avery/contracts';
import { CronOccurrenceAt, CronTotalOccurrences, ValidateCronScheduleTiming } from '../backend/cron-schedule';
import { GetNow, WriteAudit, AssertRevision } from './helpers';

function ParseBrowserTaskGrant(value: unknown): BrowserTaskGrant | undefined {
  if (typeof value !== 'string' || !value) return undefined;
  try {
    const parsed = BrowserTaskGrantSchema.safeParse(JSON.parse(value));
    return parsed.success ? parsed.data : undefined;
  } catch { return undefined; }
}

function ToTask(row: any): any {
  const browserTaskGrant = ParseBrowserTaskGrant(row.browser_task_grant_json);
  return {
    id: row.id, title: row.title, message: row.message, scenarioId: row.scenario_id, ...(row.resume_id ? { resumeId: row.resume_id } : {}),
    // 旧 browser_authorized 不能升级为新版授权；只有经过 Schema 校验且未撤销的 Grant 才有效。
    browserAuthorized: Boolean(browserTaskGrant && !browserTaskGrant.revokedAt),
    ...(browserTaskGrant ? { browserTaskGrant } : {}),
    schedule: JSON.parse(row.schedule_json), state: row.state, consumedOccurrences: row.consumed_occurrences,
    totalOccurrences: row.total_occurrences, nextRunAt: row.next_run_at, revision: row.revision,
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

function ToRun(row: any): any {
  return {
    id: row.id, cronTaskId: row.cron_task_id, occurrence: row.occurrence, scheduledAt: row.scheduled_at,
    state: row.state, ...(row.reason ? { reason: row.reason } : {}), ...(row.conversation_id ? { conversationId: row.conversation_id } : {}),
    ...(row.started_at ? { startedAt: row.started_at } : {}), ...(row.completed_at ? { completedAt: row.completed_at } : {}),
  };
}

/** CronTask 与 CronRun 的单写者 Repository；claim 在事务中消费 occurrence，避免重复唤醒产生双重执行。 */
export class CronTaskRepository {
  constructor(private readonly db: any) {}

  List(includeCancelled = false): any[] {
    return this.db.prepare(`SELECT * FROM cron_tasks ${includeCancelled ? '' : "WHERE state <> 'cancelled'"} ORDER BY created_at DESC`).all().map(ToTask);
  }

  Read(id: string): any | null {
    const row = this.db.prepare('SELECT * FROM cron_tasks WHERE id = ?').get(id);
    return row ? ToTask(row) : null;
  }

  ListRuns(cronTaskId: string): any[] {
    return this.db.prepare('SELECT * FROM cron_runs WHERE cron_task_id = ? ORDER BY occurrence DESC').all(cronTaskId).map(ToRun);
  }

  Create(raw: unknown, resourceContext: { resumeId?: string; browserTaskGrant?: BrowserTaskGrant } = {}): any {
    const input = CreateCronTaskSchema.parse(raw);
    ValidateCronScheduleTiming(input.schedule);
    const id = `cron-${randomUUID()}`;
    const now = GetNow();
    const total = CronTotalOccurrences(input.schedule);
    const nextRunAt = CronOccurrenceAt(input.schedule, 1);
    if (input.scenarioId !== 'application' && resourceContext.browserTaskGrant) throw Object.assign(new Error('Default CronTasks cannot receive browser authorization.'), { code: 'VALIDATION_ERROR' });
    const browserTaskGrant = input.scenarioId === 'application' && resourceContext.browserTaskGrant
      ? BrowserTaskGrantSchema.parse(resourceContext.browserTaskGrant)
      : undefined;
    const browserAuthorized = Boolean(browserTaskGrant && !browserTaskGrant.revokedAt);
    this.db.prepare('INSERT INTO cron_tasks(id,title,message,scenario_id,resume_id,browser_authorized,browser_task_grant_json,schedule_json,state,consumed_occurrences,total_occurrences,next_run_at,revision,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(id, input.title, input.message, input.scenarioId, resourceContext.resumeId ?? null, browserAuthorized ? 1 : 0, browserTaskGrant ? JSON.stringify(browserTaskGrant) : null, JSON.stringify(input.schedule), 'active', 0, total, nextRunAt, 1, now, now);
    WriteAudit(this.db, 'user', 'create', 'cron_task', id, {
      scenarioId: input.scenarioId,
      browserGrantPurpose: browserTaskGrant?.purpose ?? null,
      browserAllowNavigation: browserTaskGrant?.allowNavigation ?? false,
      browserAllowFormFill: browserTaskGrant?.allowFormFill ?? false,
      browserAllowFileUpload: browserTaskGrant?.allowFileUpload ?? false,
      browserAllowExternalSend: browserTaskGrant?.allowExternalSend ?? false,
      browserResourceCount: browserTaskGrant?.resourceIds.length ?? 0,
    });
    return this.Read(id);
  }

  Update(raw: unknown, expectedRevision?: number): any {
    const input = UpdateCronTaskSchema.parse(raw);
    const row = this.db.prepare('SELECT * FROM cron_tasks WHERE id = ?').get(input.cronTaskId);
    if (!row || row.state === 'cancelled') throw new Error('CronTask was not found.');
    AssertRevision(row, expectedRevision, 'cron_task', input.cronTaskId);
    if (input.message !== undefined && input.message !== row.message && ParseBrowserTaskGrant(row.browser_task_grant_json)) {
      throw Object.assign(new Error('Changing a browser CronTask message requires a new confirmed task so its BrowserTaskGrant can be frozen again.'), { code: 'CRON_BROWSER_GRANT_RECONFIRM_REQUIRED' });
    }
    const schedule = (input.schedule ?? JSON.parse(row.schedule_json)) as CronSchedule;
    if (input.schedule) ValidateCronScheduleTiming(schedule);
    const total = CronTotalOccurrences(schedule);
    if (total < row.consumed_occurrences) throw Object.assign(new Error('CronTask occurrences cannot be lower than the already consumed count.'), { code: 'VALIDATION_ERROR' });
    let state = input.state ?? row.state;
    if (row.consumed_occurrences >= total) state = 'completed';
    const nextRunAt = state === 'active' ? CronOccurrenceAt(schedule, row.consumed_occurrences + 1) : null;
    const revision = row.revision + 1;
    this.db.prepare('UPDATE cron_tasks SET title=?,message=?,schedule_json=?,state=?,total_occurrences=?,next_run_at=?,revision=?,updated_at=? WHERE id=?')
      .run(input.title ?? row.title, input.message ?? row.message, JSON.stringify(schedule), state, total, nextRunAt, revision, GetNow(), input.cronTaskId);
    WriteAudit(this.db, 'user', 'update', 'cron_task', input.cronTaskId, { state });
    return this.Read(input.cronTaskId);
  }

  Delete(id: string): any {
    const row = this.db.prepare('SELECT revision,browser_task_grant_json FROM cron_tasks WHERE id = ?').get(id);
    if (!row) throw new Error('CronTask was not found.');
    const now = GetNow();
    const grant = ParseBrowserTaskGrant(row.browser_task_grant_json);
    const revokedGrant = grant && !grant.revokedAt ? { ...grant, revokedAt: new Date(now).toISOString() } : grant;
    this.db.prepare("UPDATE cron_tasks SET state='cancelled',next_run_at=NULL,cancelled_at=?,browser_authorized=0,browser_task_grant_json=?,revision=revision+1,updated_at=? WHERE id=?")
      .run(now, revokedGrant ? JSON.stringify(revokedGrant) : null, now, id);
    WriteAudit(this.db, 'user', 'cancel', 'cron_task', id, {});
    return { id, deleted: true };
  }

  /** 只允许撤销创建时的任务级授权；重新授权必须重新经过 CronTask 创建确认。 */
  RevokeBrowserAuthorization(id: string): any {
    const row = this.db.prepare('SELECT state,browser_task_grant_json FROM cron_tasks WHERE id = ?').get(id);
    if (!row || row.state === 'cancelled') throw new Error('CronTask was not found.');
    const grant = ParseBrowserTaskGrant(row.browser_task_grant_json);
    if (!grant || grant.revokedAt) return this.Read(id);
    const now = GetNow();
    const revokedGrant = { ...grant, revokedAt: new Date(now).toISOString() };
    this.db.prepare('UPDATE cron_tasks SET browser_authorized=0,browser_task_grant_json=?,revision=revision+1,updated_at=? WHERE id=?')
      .run(JSON.stringify(revokedGrant), now, id);
    WriteAudit(this.db, 'user', 'revoke_browser_authorization', 'cron_task', id, {});
    return this.Read(id);
  }

  EarliestNextRunAt(): number | null {
    return this.db.prepare("SELECT MIN(next_run_at) AS value FROM cron_tasks WHERE state='active' AND next_run_at IS NOT NULL").get()?.value ?? null;
  }

  /** 对每个到期任务仅 claim 最近一次；更早 occurrence 作为 missed 落库并同样消费。 */
  ClaimDue(now = GetNow()): any[] {
    const transaction = this.db.transaction(() => {
      const dueTasks = this.db.prepare("SELECT * FROM cron_tasks WHERE state='active' AND next_run_at IS NOT NULL AND next_run_at <= ? ORDER BY next_run_at").all(now);
      const claims: any[] = [];
      for (const row of dueTasks) {
        const schedule = JSON.parse(row.schedule_json) as CronSchedule;
        const due: Array<{ occurrence: number; scheduledAt: number }> = [];
        let occurrence = row.consumed_occurrences + 1;
        let scheduledAt = CronOccurrenceAt(schedule, occurrence);
        while (scheduledAt !== null && scheduledAt <= now) {
          due.push({ occurrence, scheduledAt });
          occurrence += 1;
          scheduledAt = CronOccurrenceAt(schedule, occurrence);
        }
        if (!due.length) continue;
        const previousRunning = this.db.prepare("SELECT 1 FROM cron_runs WHERE cron_task_id=? AND state='running' LIMIT 1").get(row.id);
        const runnable = previousRunning ? null : due[due.length - 1];
        for (const item of due) {
          const isRunnable = runnable?.occurrence === item.occurrence;
          this.db.prepare('INSERT OR IGNORE INTO cron_runs(id,cron_task_id,occurrence,scheduled_at,state,reason,started_at,created_at) VALUES(?,?,?,?,?,?,?,?)')
            .run(`cron-run-${randomUUID()}`, row.id, item.occurrence, item.scheduledAt, isRunnable ? 'running' : 'missed', isRunnable ? null : (previousRunning ? 'previous_run_active' : 'superseded_by_latest'), isRunnable ? now : null, now);
        }
        const consumed = row.consumed_occurrences + due.length;
        const next = CronOccurrenceAt(schedule, consumed + 1);
        this.db.prepare('UPDATE cron_tasks SET consumed_occurrences=?,next_run_at=?,updated_at=? WHERE id=?').run(consumed, next, now, row.id);
        if (runnable) {
          const runRow = this.db.prepare('SELECT * FROM cron_runs WHERE cron_task_id=? AND occurrence=?').get(row.id, runnable.occurrence);
          claims.push({ task: ToTask({ ...row, consumed_occurrences: consumed, next_run_at: next }), run: ToRun(runRow) });
        } else if (next === null) {
          this.db.prepare("UPDATE cron_tasks SET state='completed',updated_at=? WHERE id=?").run(now, row.id);
        }
      }
      return claims;
    });
    return transaction();
  }

  AttachConversation(runId: string, conversationId: string): void {
    this.db.prepare("UPDATE cron_runs SET conversation_id=? WHERE id=? AND state='running'").run(conversationId, runId);
  }

  FinishRun(runId: string, state: Exclude<CronRunState, 'running'>, reason?: string): any {
    const run = this.db.prepare('SELECT cron_task_id FROM cron_runs WHERE id=?').get(runId);
    if (!run) throw new Error('CronRun was not found.');
    this.db.prepare("UPDATE cron_runs SET state=?,reason=?,completed_at=? WHERE id=? AND state='running'").run(state, reason ?? null, GetNow(), runId);
    const task = this.db.prepare('SELECT consumed_occurrences,total_occurrences,next_run_at,state FROM cron_tasks WHERE id=?').get(run.cron_task_id);
    if (task && task.state === 'active' && task.consumed_occurrences >= task.total_occurrences && task.next_run_at === null) {
      this.db.prepare("UPDATE cron_tasks SET state='completed',updated_at=? WHERE id=?").run(GetNow(), run.cron_task_id);
    }
    return ToRun(this.db.prepare('SELECT * FROM cron_runs WHERE id=?').get(runId));
  }

  RecoverInterruptedRuns(): number {
    const transaction = this.db.transaction(() => {
      const now = GetNow();
      const result = this.db.prepare("UPDATE cron_runs SET state='needsAttention',reason='application_restarted',completed_at=? WHERE state='running'").run(now);
      // 最后一次 occurrence 在应用退出前已经被 claim；恢复时必须同时收口父任务，避免永远停在 active。
      this.db.prepare("UPDATE cron_tasks SET state='completed',updated_at=? WHERE state='active' AND consumed_occurrences>=total_occurrences AND next_run_at IS NULL").run(now);
      return result.changes;
    });
    return transaction();
  }
}
