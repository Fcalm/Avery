import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { CronOccurrenceAt } from '../../../apps/backend/src/electron/backend/cron-schedule';
import { CronTaskRepository } from '../../../apps/backend/src/electron/repositories/cron-task-repository';

function CreateRepository() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE audit_events(id TEXT PRIMARY KEY,actor_type TEXT,action TEXT,entity_type TEXT,entity_id TEXT,metadata_json TEXT,created_at INTEGER);
    CREATE TABLE conversations(id TEXT PRIMARY KEY);
    CREATE TABLE cron_tasks(id TEXT PRIMARY KEY,title TEXT NOT NULL,message TEXT NOT NULL,scenario_id TEXT NOT NULL,resume_id TEXT,browser_authorized INTEGER NOT NULL DEFAULT 0,browser_task_grant_json TEXT,schedule_json TEXT NOT NULL,state TEXT NOT NULL,consumed_occurrences INTEGER NOT NULL,total_occurrences INTEGER NOT NULL,next_run_at INTEGER,revision INTEGER NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,cancelled_at INTEGER);
    CREATE TABLE cron_runs(id TEXT PRIMARY KEY,cron_task_id TEXT NOT NULL REFERENCES cron_tasks(id),occurrence INTEGER NOT NULL,scheduled_at INTEGER NOT NULL,state TEXT NOT NULL,reason TEXT,conversation_id TEXT REFERENCES conversations(id),started_at INTEGER,completed_at INTEGER,created_at INTEGER NOT NULL,UNIQUE(cron_task_id,occurrence));
  `);
  return { db, repository: new CronTaskRepository(db) };
}

describe('CronTask 调度与领取', () => {
  const SearchGrant = {
    mode: 'personal_browser_extension' as const,
    purpose: 'job_search' as const,
    allowNavigation: true,
    allowFormFill: false,
    allowFileUpload: false,
    allowExternalSend: false,
    resourceIds: ['resume:resume-1'],
    grantedAt: '2026-09-23T02:00:00.000Z',
  };
  it('按 IANA 本地日历跨 DST 保持 09:00，而不是固定增加 24 小时', () => {
    const schedule = { type: 'daily' as const, startAt: '2026-03-07T09:00:00-05:00', timeZone: 'America/New_York', intervalDays: 1, occurrences: 3 };
    const first = CronOccurrenceAt(schedule, 1)!;
    const second = CronOccurrenceAt(schedule, 2)!;
    expect(second - first).toBe(23 * 60 * 60 * 1000);
    expect(new Intl.DateTimeFormat('en-US', { timeZone: schedule.timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(second)).toBe('09:00');
  });

  it('工作日计划按指定星期生成 occurrence', () => {
    const schedule = { type: 'weekly' as const, startAt: '2026-08-31T09:30:00+08:00', timeZone: 'Asia/Shanghai', daysOfWeek: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'] as const, intervalWeeks: 1, occurrences: 7 };
    const labels = [1, 2, 3, 4, 5, 6, 7].map((occurrence) => new Intl.DateTimeFormat('en-US', { timeZone: schedule.timeZone, weekday: 'short' }).format(CronOccurrenceAt(schedule, occurrence)!));
    expect(labels).toEqual(['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Mon', 'Tue']);
  });

  it('纯岗位搜索的投递任务允许不绑定简历', () => {
    const { db, repository } = CreateRepository();
    const task = repository.Create({
      title: '读取岗位', message: '打开招聘网站搜索岗位并读取 JD', scenarioId: 'application',
      schedule: { type: 'once', executeAt: '2030-01-01T09:00:00+08:00', timeZone: 'Asia/Shanghai' },
    });

    expect(task).toMatchObject({ scenarioId: 'application', browserAuthorized: false });
    expect(task).not.toHaveProperty('resumeId');
    db.close();
  });

  it('只接受 Host 在创建确认后授予的投递任务浏览器权限，并允许持久撤销', () => {
    const { db, repository } = CreateRepository();
    const input = {
      title: '定时读取 BOSS', message: '搜索岗位', scenarioId: 'application',
      schedule: { type: 'once', executeAt: '2030-01-01T09:00:00+08:00', timeZone: 'Asia/Shanghai' },
    };
    const task = repository.Create(input, { resumeId: 'resume-1', browserTaskGrant: SearchGrant });
    expect(task).toMatchObject({ browserAuthorized: true, browserTaskGrant: SearchGrant, revision: 1 });
    expect(repository.RevokeBrowserAuthorization(task.id)).toMatchObject({ browserAuthorized: false, browserTaskGrant: { purpose: 'job_search' }, revision: 2 });
    expect(repository.Read(task.id)?.browserTaskGrant.revokedAt).toMatch(/Z$/);
    expect(() => repository.Create({ ...input, title: '本地任务', scenarioId: 'default' }, { browserTaskGrant: SearchGrant })).toThrow(/cannot receive browser authorization/);
    db.close();
  });

  it('旧 browser_authorized 布尔值不会自动升级为 BrowserTaskGrant', () => {
    const { db, repository } = CreateRepository();
    db.prepare('INSERT INTO cron_tasks(id,title,message,scenario_id,resume_id,browser_authorized,browser_task_grant_json,schedule_json,state,consumed_occurrences,total_occurrences,next_run_at,revision,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run('legacy', '旧任务', '读取岗位', 'application', null, 1, null, JSON.stringify({ type: 'once', executeAt: '2030-01-01T09:00:00+08:00', timeZone: 'Asia/Shanghai' }), 'active', 0, 1, Date.parse('2030-01-01T01:00:00Z'), 1, Date.now(), Date.now());
    expect(repository.Read('legacy')).toMatchObject({ browserAuthorized: false });
    expect(repository.Read('legacy')).not.toHaveProperty('browserTaskGrant');
    db.close();
  });

  it('浏览器任务正文改变时要求重新确认 Grant，标题和调度仍可更新', () => {
    const { db, repository } = CreateRepository();
    const task = repository.Create({
      title: '搜索岗位', message: '只读取岗位', scenarioId: 'application',
      schedule: { type: 'once', executeAt: '2030-01-01T09:00:00+08:00', timeZone: 'Asia/Shanghai' },
    }, { browserTaskGrant: SearchGrant });
    expect(() => repository.Update({ cronTaskId: task.id, message: '改为投递岗位' })).toThrow(/requires a new confirmed task/);
    expect(repository.Update({ cronTaskId: task.id, title: '新的标题' })).toMatchObject({ title: '新的标题', browserAuthorized: true });
    db.close();
  });

  it('多个过期 occurrence 只 claim 最近一次，其余标记 missed 并全部消费', () => {
    const { db, repository } = CreateRepository();
    const task = repository.Create({ title: '工作日投递', message: '投递合适岗位', scenarioId: 'application', schedule: { type: 'daily', startAt: '2026-08-25T09:00:00+08:00', timeZone: 'Asia/Shanghai', intervalDays: 1, occurrences: 4 } }, { resumeId: 'resume-1' });
    const claims = repository.ClaimDue(Date.parse('2026-08-28T10:00:00+08:00'));
    expect(claims).toHaveLength(1);
    expect(claims[0].run.occurrence).toBe(4);
    expect(repository.Read(task.id)).toMatchObject({ consumedOccurrences: 4, nextRunAt: null, resumeId: 'resume-1' });
    expect(db.prepare('SELECT occurrence,state,reason FROM cron_runs ORDER BY occurrence').all()).toEqual([
      { occurrence: 1, state: 'missed', reason: 'superseded_by_latest' },
      { occurrence: 2, state: 'missed', reason: 'superseded_by_latest' },
      { occurrence: 3, state: 'missed', reason: 'superseded_by_latest' },
      { occurrence: 4, state: 'running', reason: null },
    ]);
    repository.FinishRun(claims[0].run.id, 'completed');
    expect(repository.Read(task.id)?.state).toBe('completed');
    db.close();
  });

  it('一次性任务拒绝过去时间，Schema 拒绝重复星期', () => {
    const { db, repository } = CreateRepository();
    expect(() => repository.Create({ title: '过去', message: '无效', scenarioId: 'default', schedule: { type: 'once', executeAt: '2020-01-01T00:00:00Z', timeZone: 'UTC' } })).toThrow(/future/);
    expect(() => repository.Create({ title: '重复', message: '无效', scenarioId: 'default', schedule: { type: 'weekly', startAt: '2026-09-01T09:00:00+08:00', timeZone: 'Asia/Shanghai', daysOfWeek: ['monday', 'monday'], occurrences: 2 } })).toThrow();
    db.close();
  });

  it('应用重启恢复最后一次 running 时，同时收口父任务状态', () => {
    const { db, repository } = CreateRepository();
    const task = repository.Create({ title: '最后一次', message: '执行', scenarioId: 'default', schedule: { type: 'daily', startAt: '2026-08-30T09:00:00+08:00', timeZone: 'Asia/Shanghai', intervalDays: 1, occurrences: 1 } });
    const claims = repository.ClaimDue(Date.parse('2026-08-30T10:00:00+08:00'));
    expect(claims).toHaveLength(1);
    expect(repository.RecoverInterruptedRuns()).toBe(1);
    expect(repository.ListRuns(task.id)[0]).toMatchObject({ state: 'needsAttention', reason: 'application_restarted' });
    expect(repository.Read(task.id)?.state).toBe('completed');
    db.close();
  });
});
