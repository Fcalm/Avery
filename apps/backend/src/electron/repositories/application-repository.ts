import { GetNow, CreateId, WriteAudit, AssertRevision } from './helpers';
import { ApplicationToStorage, ApplicationToDisplay, ToStorage, ApplicationStatusStorage } from './enum-map';

/** 投递看板的独立事实源；创建与状态迁移均追加不可变事件，删除时由外键级联清理事件。 */
export class ApplicationRepository {
  private db: any;

  constructor({ db }: { db: any }) {
    this.db = db;
  }

  /** 读取全部投递，按最近更新倒序；payload_json 即页面 Application ViewModel，状态映射为契约英文值，revision 供外部冲突校验。 */
  ListAll(): any[] {
    return this.db.prepare('SELECT payload_json, revision FROM applications ORDER BY updated_at DESC').all()
      .map((row: any) => ApplicationToDisplay({ ...JSON.parse(row.payload_json), revision: row.revision }));
  }

  /** 创建或编辑投递；校验期望版本，首次创建追加 created 事件，状态变化时追加 status_changed 事件；写入前将状态映射为存储中文值。 */
  Upsert(application: any, expectedRevision?: number): any {
    if (!application || typeof application !== 'object') throw new Error('Application is invalid.');
    if (typeof application.id !== 'string' || application.id.length === 0 || application.id.length > 200) throw new Error('Application id is invalid.');
    if (typeof application.status !== 'string' || application.status.length === 0 || application.status.length > 100) throw new Error('Application status is invalid.');
    const storageApplication = ApplicationToStorage(application);
    const storageStatus = storageApplication.status;
    const now = GetNow();
    const existing = this.db.prepare('SELECT status, revision FROM applications WHERE id = ?').get(application.id);
    if (existing) AssertRevision(existing, expectedRevision, 'application', application.id);
    const nextRevision = existing ? existing.revision + 1 : 1;
    this.db.prepare('INSERT INTO applications(id, job_id, payload_json, status, revision, created_at, updated_at) VALUES(?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET job_id = excluded.job_id, payload_json = excluded.payload_json, status = excluded.status, revision = excluded.revision, updated_at = excluded.updated_at')
      .run(application.id, storageApplication.jobId ?? null, JSON.stringify(storageApplication), storageStatus, nextRevision, now, now);
    if (!existing) {
      this.db.prepare('INSERT INTO application_events(id, application_id, event_type, from_status, to_status, payload_json, created_at) VALUES(?, ?, ?, ?, ?, ?, ?)')
        .run(CreateId(), application.id, 'created', null, storageStatus, null, now);
    } else if (existing.status !== storageStatus) {
      this.db.prepare('INSERT INTO application_events(id, application_id, event_type, from_status, to_status, payload_json, created_at) VALUES(?, ?, ?, ?, ?, ?, ?)')
        .run(CreateId(), application.id, 'status_changed', existing.status, storageStatus, null, now);
    }
    WriteAudit(this.db, 'user', 'save', 'application', application.id, {});
    return { id: application.id, revision: nextRevision };
  }

  /** 推进投递到看板的下一阶段；校验期望版本并记录状态迁移事件；存储用中文、返回契约英文值。 */
  MoveStatus(id: string, status: string, expectedRevision?: number): any {
    if (typeof id !== 'string' || id.length === 0 || id.length > 200) throw new Error('Application id is invalid.');
    if (typeof status !== 'string' || status.length === 0 || status.length > 100) throw new Error('Application status is invalid.');
    const storageStatus = ToStorage(status, ApplicationStatusStorage);
    const existing = this.db.prepare('SELECT status, payload_json, revision FROM applications WHERE id = ?').get(id);
    if (!existing) throw new Error('Application was not found.');
    AssertRevision(existing, expectedRevision, 'application', id);
    if (existing.status !== storageStatus) {
      const payload = JSON.parse(existing.payload_json);
      payload.status = storageStatus;
      const nextRevision = existing.revision + 1;
      this.db.prepare('UPDATE applications SET status = ?, payload_json = ?, revision = ?, updated_at = ? WHERE id = ?').run(storageStatus, JSON.stringify(payload), nextRevision, GetNow(), id);
      this.db.prepare('INSERT INTO application_events(id, application_id, event_type, from_status, to_status, payload_json, created_at) VALUES(?, ?, ?, ?, ?, ?, ?)')
        .run(CreateId(), id, 'status_changed', existing.status, storageStatus, null, GetNow());
      WriteAudit(this.db, 'user', 'move_status', 'application', id, { from: String(existing.status), to: String(storageStatus) });
      return { id, status, revision: nextRevision };
    }
    return { id, status, revision: existing.revision };
  }

  /** 删除投递；外键级联移除其不可再访问的事件历史。 */
  Delete(id: string): any {
    if (typeof id !== 'string' || id.length === 0 || id.length > 200) throw new Error('Application id is invalid.');
    this.db.prepare('DELETE FROM applications WHERE id = ?').run(id);
    WriteAudit(this.db, 'user', 'delete', 'application', id, {});
    return { id };
  }
}
