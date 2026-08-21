import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const Database = require('better-sqlite3') as any;

/** 返回统一 UTC 时间戳，避免日志清理受本地时区影响。 */
function GetNow(): number {
  return Date.now();
}

/** 可观测性数据库的 Infrastructure 组合根：持有 Trace 与日志两张表，全部方法经 DB Worker RPC 暴露。 */
export class ObservabilityStore {
  databasePath: string;
  db: any;
  traceRetention: number;

  /** 初始化不随工作空间迁移的本地日志数据库。 */
  constructor(userDataPath: string) {
    mkdirSync(userDataPath, { recursive: true });
    this.databasePath = join(userDataPath, 'observability.db');
    this.db = new Database(this.databasePath);
    this.traceRetention = 50;
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS app_logs (
        id TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL,
        level TEXT NOT NULL,
        event TEXT NOT NULL,
        detail TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_app_logs_created ON app_logs(created_at DESC);
      CREATE TABLE IF NOT EXISTS agent_traces (
        id TEXT PRIMARY KEY,
        request_id TEXT NOT NULL UNIQUE,
        session_id TEXT NOT NULL,
        model TEXT NOT NULL,
        state TEXT NOT NULL,
        summary TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        completed_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_agent_traces_created ON agent_traces(created_at DESC);
      CREATE TABLE IF NOT EXISTS agent_trace_events (
        id TEXT PRIMARY KEY,
        request_id TEXT NOT NULL,
        ordinal INTEGER NOT NULL,
        event_type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        token_count INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        UNIQUE(request_id, ordinal)
      );
      CREATE INDEX IF NOT EXISTS idx_agent_trace_events_request ON agent_trace_events(request_id, ordinal);
    `);
    try {
      this.db.exec('ALTER TABLE agent_trace_events ADD COLUMN token_count INTEGER NOT NULL DEFAULT 0');
    } catch {
      // Existing databases already include the column.
    }
  }

  /** 追加已由调用方脱敏的结构化运行日志，并执行数量与时间双重留存限制。 */
  RecordLog(level: string, event: string, detail: string): void {
    const now = GetNow();
    this.db.prepare('INSERT INTO app_logs(id, created_at, level, event, detail) VALUES(?, ?, ?, ?, ?)')
      .run(randomUUID(), now, String(level).slice(0, 20), String(event).slice(0, 100), String(detail).slice(0, 300));
    this.db.prepare('DELETE FROM app_logs WHERE created_at < ?').run(now - 30 * 24 * 60 * 60 * 1000);
    this.db.prepare('DELETE FROM app_logs WHERE id IN (SELECT id FROM app_logs ORDER BY created_at DESC LIMIT -1 OFFSET 10000)').run();
  }

  /** 读取按最新优先排列的开发者日志，并格式化为页面现有 ViewModel。 */
  GetLogs(limit = 100): any[] {
    return this.db.prepare('SELECT created_at, level, event, detail FROM app_logs ORDER BY created_at DESC LIMIT ?').all(limit)
      .map((row: any) => ({ time: new Date(row.created_at).toLocaleTimeString('zh-CN', { hour12: false }), level: row.level, event: row.event, detail: row.detail }));
  }

  /** 清空开发者模式可见的日志与 Trace，不影响业务、附件或 API Key 数据。 */
  ClearObservability(): void {
    const clear = this.db.transaction(() => {
      this.db.prepare('DELETE FROM app_logs').run();
      this.db.prepare('DELETE FROM agent_trace_events').run();
      this.db.prepare('DELETE FROM agent_traces').run();
    });
    clear();
  }

  /** 创建一条不含消息正文与凭据的 Trace 索引记录。 */
  StartTrace(requestId: string, sessionId: string, model: string): void {
    this.db.prepare('INSERT OR REPLACE INTO agent_traces(id, request_id, session_id, model, state, summary, created_at, completed_at) VALUES(?, ?, ?, ?, ?, ?, ?, NULL)')
      .run(randomUUID(), requestId, sessionId, model, 'running', 'Agent request started', GetNow());
    this.PruneTraces();
  }

  /** 用结束状态和脱敏摘要关闭一条 Trace。 */
  FinishTrace(requestId: string, state: string, summary: string): void {
    this.db.prepare('UPDATE agent_traces SET state = ?, summary = ?, completed_at = ? WHERE request_id = ?')
      .run(state, String(summary).slice(0, 300), GetNow(), requestId);
  }

  /** 追加一条 Trace 事件；调用方不得传入 API Key、Authorization 或 Provider 凭据。 */
  AppendTraceEvent(requestId: string, eventType: string, payload: unknown, tokenCount = 0): void {
    const ordinal = this.db.prepare('SELECT COALESCE(MAX(ordinal), 0) + 1 AS ordinal FROM agent_trace_events WHERE request_id = ?').get(requestId).ordinal;
    this.db.prepare('INSERT INTO agent_trace_events(id, request_id, ordinal, event_type, payload_json, token_count, created_at) VALUES(?, ?, ?, ?, ?, ?, ?)')
      .run(randomUUID(), requestId, ordinal, String(eventType).slice(0, 100), JSON.stringify(payload), Math.max(0, Math.floor(Number(tokenCount) || 0)), GetNow());
  }

  /**
   * 写入单次 Provider usage 的原始事实。Trace 汇总和会话账本都只消费此形状：
   * 缺失 usage 必须明确为 unavailable，禁止把本地 token 估算写入本表。
   */
  RecordTraceUsage(requestId: string, usage: { source: 'provider' | 'unavailable'; promptTokens: number; completionTokens: number; totalTokens: number }): void {
    if (typeof requestId !== 'string' || !requestId || requestId.length > 200) throw new Error('Trace request id is invalid.');
    const validSource = usage?.source === 'provider' || usage?.source === 'unavailable';
    const validTokens = [usage?.promptTokens, usage?.completionTokens, usage?.totalTokens].every((value) => Number.isSafeInteger(value) && value >= 0)
      && usage.totalTokens >= usage.promptTokens && usage.totalTokens >= usage.completionTokens;
    if (!validSource || !validTokens) throw new Error('Provider usage is invalid.');
    this.AppendTraceEvent(requestId, 'provider_usage', usage, 0);
  }

  /** 从原始 Provider usage 事件构建 Trace 汇总，避免用 Trace token_count 的估算值参与账单展示。 */
  private GetTraceUsage(requestId: string): any {
    const rows = this.db.prepare("SELECT payload_json FROM agent_trace_events WHERE request_id = ? AND event_type = 'provider_usage' ORDER BY ordinal").all(requestId);
    const usage = { source: 'unavailable' as 'provider' | 'unavailable', promptTokens: 0, completionTokens: 0, totalTokens: 0, reportedRequestCount: 0, unreportedRequestCount: 0 };
    for (const row of rows) {
      try {
        const fact = JSON.parse(row.payload_json) as { source?: unknown; promptTokens?: unknown; completionTokens?: unknown; totalTokens?: unknown };
        const tokens = [fact.promptTokens, fact.completionTokens, fact.totalTokens];
        const valid = tokens.every((value) => Number.isSafeInteger(value) && (value as number) >= 0)
          && (fact.totalTokens as number) >= (fact.promptTokens as number) && (fact.totalTokens as number) >= (fact.completionTokens as number);
        if (fact.source === 'provider' && valid) {
          usage.source = 'provider'; usage.promptTokens += fact.promptTokens as number; usage.completionTokens += fact.completionTokens as number; usage.totalTokens += fact.totalTokens as number; usage.reportedRequestCount += 1;
        } else if (fact.source === 'unavailable') usage.unreportedRequestCount += 1;
      } catch { usage.unreportedRequestCount += 1; }
    }
    return usage;
  }

  /** 返回供开发者界面展示的最近 Trace 索引。 */
  GetTraces(limit = 50): any[] {
    return this.db.prepare('SELECT request_id, session_id, model, state, summary, created_at, completed_at FROM agent_traces ORDER BY created_at DESC, rowid DESC LIMIT ?').all(limit)
      .map((row: any) => ({ requestId: row.request_id, sessionId: row.session_id, model: row.model, state: row.state, summary: row.summary, createdAt: row.created_at, completedAt: row.completed_at, eventCount: this.db.prepare('SELECT COUNT(*) AS count FROM agent_trace_events WHERE request_id = ?').get(row.request_id).count, usage: this.GetTraceUsage(row.request_id) }));
  }

  /** 读取单条 Trace 的已脱敏事件，供开发者页面按需展开，不暴露其它会话的数据。 */
  GetTraceEvents(requestId: string): any[] {
    if (typeof requestId !== 'string' || requestId.length === 0 || requestId.length > 200) throw new Error('Trace request id is invalid.');
    return this.db.prepare('SELECT ordinal, event_type, payload_json, token_count, created_at FROM agent_trace_events WHERE request_id = ? ORDER BY ordinal').all(requestId)
      .map((row: any) => {
        let payload = null;
        try { payload = JSON.parse(row.payload_json); } catch { payload = { error: 'Trace payload is invalid.' }; }
        return { ordinal: row.ordinal, eventType: row.event_type, payload, tokenCount: row.token_count ?? 0, createdAt: row.created_at };
      });
  }

  /** 按会话原子删除 Trace 索引与事件；不删除日志或会话本身。 */
  DeleteTraces(sessionIds: string[]): any {
    if (!Array.isArray(sessionIds) || sessionIds.length === 0 || sessionIds.length > 100
      || sessionIds.some((id) => typeof id !== 'string' || id.length === 0 || id.length > 200)) {
      throw new Error('Trace session ids are invalid.');
    }
    const ids = [...new Set(sessionIds)];
    const placeholders = ids.map(() => '?').join(', ');
    const remove = this.db.transaction(() => {
      const requestIds = this.db.prepare(`SELECT request_id FROM agent_traces WHERE session_id IN (${placeholders})`).all(...ids).map((row: any) => row.request_id);
      if (requestIds.length) {
        const requestPlaceholders = requestIds.map(() => '?').join(', ');
        this.db.prepare(`DELETE FROM agent_trace_events WHERE request_id IN (${requestPlaceholders})`).run(...requestIds);
      }
      const result = this.db.prepare(`DELETE FROM agent_traces WHERE session_id IN (${placeholders})`).run(...ids);
      return { deleted: result.changes };
    });
    return remove();
  }

  /** 设置 Trace 留存数量并立即裁剪已有索引，范围与设置页保持一致。 */
  SetTraceRetention(value: number): any {
    const retention = Number(value);
    if (!Number.isInteger(retention) || retention < 1 || retention > 100) throw new Error('Trace retention must be an integer between 1 and 100.');
    this.traceRetention = retention;
    this.PruneTraces();
    return { traceRetention: this.traceRetention };
  }

  /** 按产品默认 50 条、设置最高 100 条的当前默认值裁剪完整 Trace 索引。 */
  private PruneTraces(): void {
    this.db.prepare('DELETE FROM agent_traces WHERE id IN (SELECT id FROM agent_traces ORDER BY created_at DESC, rowid DESC LIMIT -1 OFFSET ?)').run(this.traceRetention);
  }

  /** 将进程崩溃遗留的 running Trace 标记为 interrupted，供 Backend 启动时恢复观测一致性。 */
  RecoverInterruptedTraces(): any {
    const result = this.db.prepare("UPDATE agent_traces SET state = 'interrupted', completed_at = ? WHERE state = 'running'").run(GetNow());
    return { recovered: result.changes };
  }

  /** 关闭用户目录日志数据库。 */
  Close(): void {
    try {
      this.db?.close();
    } catch {
      // 退出阶段重复关闭原生句柄无需额外处理。
    }
  }
}
