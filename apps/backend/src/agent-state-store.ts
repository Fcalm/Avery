import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AgentStateBuckets, type AgentStatePatch, type AgentStateSnapshot } from './infra/agent-state-contract';

interface SqliteConnection {
  pragma(sql: string): unknown;
  exec(sql: string): void;
  prepare(sql: string): { run(...bindings: unknown[]): unknown; get(...bindings: unknown[]): unknown; all(...bindings: unknown[]): unknown[] };
  transaction<T>(work: () => T): () => T;
  close(): void;
}
const Database = require('better-sqlite3') as new (filename: string) => SqliteConnection;
const Allowed = new Set<string>(AgentStateBuckets);

/** 只在 DB Worker 内构造。运行事实与 Trace 分库，清空日志不影响恢复状态。 */
export class AgentStateStore {
  private readonly db: SqliteConnection;
  constructor(private readonly userDataPath: string) {
    mkdirSync(userDataPath, { recursive: true });
    this.db = new Database(join(userDataPath, 'agent-runtime.db'));
    try {
      this.db.pragma('journal_mode = WAL');
      this.db.pragma('synchronous = FULL');
      this.db.pragma('foreign_keys = ON');
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS runtime_meta(id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL, commit_id TEXT);
        CREATE TABLE IF NOT EXISTS runtime_rows(bucket TEXT NOT NULL, key TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(bucket,key));
        CREATE TABLE IF NOT EXISTS runtime_history(session_id TEXT NOT NULL, ordinal INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(session_id,ordinal));
        CREATE TABLE IF NOT EXISTS runtime_sessions(session_id TEXT PRIMARY KEY);
        CREATE TABLE IF NOT EXISTS runtime_shared(hash TEXT PRIMARY KEY, data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS runtime_refs(bucket TEXT NOT NULL, key TEXT NOT NULL, field TEXT NOT NULL, hash TEXT NOT NULL,
          PRIMARY KEY(bucket,key,field), FOREIGN KEY(bucket,key) REFERENCES runtime_rows(bucket,key) ON DELETE CASCADE,
          FOREIGN KEY(hash) REFERENCES runtime_shared(hash));
      `);
      this.MigrateLegacy();
    }
    catch (error) { this.db.close(); throw Object.assign(new Error('Agent 运行状态迁移失败，旧文件已保留。', { cause: error }), { code: 'STORAGE_ERROR', retryable: false }); }
  }

  /** 初始化标记与全部旧数据同事务提交；旧 JSON 始终保留，失败不会写入空状态覆盖它。 */
  private MigrateLegacy(): void {
    if (this.db.prepare('SELECT 1 FROM runtime_meta WHERE id=1').get()) return;
    const filename = join(this.userDataPath, 'agent-state.json');
    const legacy: unknown = existsSync(filename) ? JSON.parse(readFileSync(filename, 'utf8')) : {};
    if (!legacy || typeof legacy !== 'object' || Array.isArray(legacy)) throw new Error('Legacy state is invalid.');
    const state = legacy as Record<string, unknown>;
    this.db.transaction(() => {
      for (const [bucket, entries] of Object.entries(state)) {
        if (bucket === 'documentChangeBaselines') { this.PutRow(bucket, 'current', entries); continue; }
        if (bucket !== 'histories' && !Allowed.has(bucket)) throw new Error(`Unsupported legacy state collection: ${bucket}`);
        if (!Array.isArray(entries)) throw new Error('Legacy state collection is invalid.');
        for (const entry of entries) {
          if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string') throw new Error('Legacy state entry is invalid.');
          if (bucket === 'histories') {
            if (!Array.isArray(entry[1])) throw new Error('Legacy history is invalid.');
            this.PutHistory(entry[0], 0, entry[1]);
          } else this.PutRow(bucket, entry[0], entry[1]);
        }
      }
      this.db.prepare('INSERT INTO runtime_meta(id,revision) VALUES(1,0)').run();
    })();
  }

  private PutRow(bucket: string, key: string, value: unknown): void {
    let stored = value;
    const shared: Array<[string, string]> = [];
    if (bucket === 'runSnapshots' && value && typeof value === 'object' && !Array.isArray(value)) {
      const row = { ...value } as Record<string, unknown>;
      for (const field of ['instructions', 'tools']) {
        if (row[field] === undefined) continue;
        const data = JSON.stringify(row[field]);
        const hash = createHash('sha256').update(data).digest('hex');
        this.db.prepare('INSERT OR IGNORE INTO runtime_shared(hash,data) VALUES(?,?)').run(hash, data);
        shared.push([field, hash]); delete row[field];
      }
      stored = row;
    }
    this.db.prepare('INSERT INTO runtime_rows(bucket,key,data) VALUES(?,?,?) ON CONFLICT(bucket,key) DO UPDATE SET data=excluded.data').run(bucket, key, JSON.stringify(stored));
    this.db.prepare('DELETE FROM runtime_refs WHERE bucket=? AND key=?').run(bucket, key);
    for (const [field, hash] of shared) this.db.prepare('INSERT INTO runtime_refs(bucket,key,field,hash) VALUES(?,?,?,?)').run(bucket, key, field, hash);
  }

  private PutHistory(sessionId: string, from: number, messages: unknown[]): void {
    this.db.prepare('INSERT OR IGNORE INTO runtime_sessions(session_id) VALUES(?)').run(sessionId);
    this.db.prepare('DELETE FROM runtime_history WHERE session_id=? AND ordinal>=?').run(sessionId, from);
    const insert = this.db.prepare('INSERT INTO runtime_history(session_id,ordinal,data) VALUES(?,?,?)');
    messages.forEach((message, index) => insert.run(sessionId, from + index, JSON.stringify(message)));
  }

  Read(includeHistory = true): AgentStateSnapshot {
    const state: Record<string, unknown> = Object.fromEntries(AgentStateBuckets.map(bucket => [bucket, []]));
    // 读取时也复用同一内容对象，避免共享快照在 Worker 和 IPC 结构克隆中再次放大成数百份。
    const sharedValues = new Map((this.db.prepare('SELECT hash,data FROM runtime_shared').all() as Array<{ hash: string; data: string }>).map(row => [row.hash, JSON.parse(row.data) as unknown]));
    const references = this.db.prepare('SELECT bucket,key,field,hash FROM runtime_refs').all() as Array<{ bucket: string; key: string; field: string; hash: string }>;
    const refs = new Map<string, Record<string, unknown>>();
    for (const row of references) {
      if (!sharedValues.has(row.hash)) throw new Error('Shared runtime snapshot is unavailable.');
      refs.set(JSON.stringify([row.bucket, row.key]), { ...refs.get(JSON.stringify([row.bucket, row.key])), [row.field]: sharedValues.get(row.hash) });
    }
    for (const row of this.db.prepare('SELECT bucket,key,data FROM runtime_rows ORDER BY rowid').all() as Array<{ bucket: string; key: string; data: string }>) {
      let value = JSON.parse(row.data);
      const shared = refs.get(JSON.stringify([row.bucket, row.key]));
      if (shared) value = { ...value, ...shared };
      if (row.bucket === 'documentChangeBaselines') state[row.bucket] = value;
      else (state[row.bucket] as unknown[]).push([row.key, value]);
    }
    const histories = new Map<string, unknown[]>();
    for (const row of this.db.prepare('SELECT session_id FROM runtime_sessions ORDER BY rowid').all() as Array<{ session_id: string }>) histories.set(row.session_id, []);
    for (const row of (includeHistory ? this.db.prepare('SELECT session_id,data FROM runtime_history ORDER BY session_id,ordinal').all() : []) as Array<{ session_id: string; data: string }>) {
      const messages = histories.get(row.session_id) ?? [];
      messages.push(JSON.parse(row.data)); histories.set(row.session_id, messages);
    }
    state.histories = [...histories];
    return { state, revision: (this.db.prepare('SELECT revision FROM runtime_meta WHERE id=1').get() as { revision: number }).revision,
      ...(!includeHistory ? { unloadedHistories: [...histories.keys()] } : {}) };
  }

  /** 准备某个会话时只读取该会话，避免冷启动和普通状态保存搬运所有模型历史。 */
  ReadHistory(sessionId: string): unknown[] {
    if (typeof sessionId !== 'string' || !sessionId || sessionId.length > 200) throw new Error('Invalid history session.');
    return (this.db.prepare('SELECT data FROM runtime_history WHERE session_id=? ORDER BY ordinal').all(sessionId) as Array<{ data: string }>).map(row => JSON.parse(row.data) as unknown);
  }

  /** 同一 commitId 可安全重查确认；版本冲突拒绝覆盖，超时重试也不能把新状态覆盖成旧状态。 */
  Commit(patch: AgentStatePatch): { revision: number } {
    if (!patch || typeof patch.commitId !== 'string' || !Number.isSafeInteger(patch.expectedRevision) || !Array.isArray(patch.rows) || !Array.isArray(patch.histories)) throw new Error('Invalid runtime state patch.');
    return this.db.transaction(() => {
      const meta = this.db.prepare('SELECT revision,commit_id FROM runtime_meta WHERE id=1').get() as { revision: number; commit_id: string };
      if (meta.commit_id === patch.commitId) return { revision: meta.revision };
      if (meta.revision !== patch.expectedRevision) throw Object.assign(new Error('Agent 运行状态版本冲突，原变更没有重放。'), { code: 'REVISION_CONFLICT' });
      for (const row of patch.rows) {
        if (!Allowed.has(row.bucket) || typeof row.key !== 'string') throw new Error('Invalid runtime state row.');
        if (row.deleted) this.db.prepare('DELETE FROM runtime_rows WHERE bucket=? AND key=?').run(row.bucket, row.key);
        else this.PutRow(row.bucket, row.key, row.value);
      }
      for (const history of patch.histories) {
        if (typeof history.sessionId !== 'string' || !Number.isSafeInteger(history.from) || history.from < 0 || !Array.isArray(history.messages)) throw new Error('Invalid runtime history patch.');
        this.PutHistory(history.sessionId, history.deleted ? 0 : history.from, history.deleted ? [] : history.messages);
        if (history.deleted) this.db.prepare('DELETE FROM runtime_sessions WHERE session_id=?').run(history.sessionId);
      }
      const revision = meta.revision + 1;
      this.db.prepare('UPDATE runtime_meta SET revision=?,commit_id=? WHERE id=1').run(revision, patch.commitId);
      this.db.prepare('DELETE FROM runtime_shared WHERE hash NOT IN (SELECT hash FROM runtime_refs)').run();
      return { revision };
    })();
  }
  Close(): void { this.db.close(); }
}
