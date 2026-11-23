import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { AgentStatePatch, AgentStatePort, AgentStateSnapshot } from '../../infra/agent-state-contract';
import { AgentStateBuckets } from '../../infra/agent-state-contract';

interface Change { version: number; bucket: string; key: string; value?: unknown; deleted?: boolean }
interface HistoryChange { version: number; value?: unknown[] }

/** Backend 只比较变化并提交小补丁；JSON 编码、共享内容哈希和 SQLite 事务全部留在 DB Worker。 */
export class AgentStatePersistence {
  private revision = 0;
  private version = 0;
  private durableVersion = 0;
  private seen = new Map<string, Map<string, unknown>>();
  private historyViews = new Map<string, unknown[]>();
  private committedHistories = new Map<string, unknown[]>();
  private unloadedHistories = new Set<string>();
  private rows = new Map<string, Change>();
  private histories = new Map<string, HistoryChange>();
  private running?: Promise<void>;
  private pending?: { patch: AgentStatePatch; rows: Change[]; histories: Array<[string, HistoryChange]> };
  constructor(private readonly port: AgentStatePort) {}

  async Load(): Promise<Record<string, unknown>> {
    const snapshot: AgentStateSnapshot = await this.port.ReadAgentState({ includeHistory: false });
    this.unloadedHistories = new Set(snapshot.unloadedHistories ?? []);
    this.revision = snapshot.revision;
    this.Capture(snapshot.state, true);
    this.rows.clear(); this.histories.clear();
    this.durableVersion = this.version;
    this.committedHistories = new Map(this.historyViews);
    return snapshot.state;
  }

  /** 首次使用才读取该会话；与写入使用同一 Worker 顺序，读结果本身不创建提交或授权。 */
  async LoadHistory(sessionId: string, signal?: AbortSignal): Promise<unknown[] | undefined> {
    if (!this.unloadedHistories.has(sessionId)) return undefined;
    if (!this.port.ReadAgentHistory) throw new Error('历史存储不支持按会话读取。');
    const messages = await this.port.ReadAgentHistory(sessionId);
    signal?.throwIfAborted();
    this.unloadedHistories.delete(sessionId);
    this.historyViews.set(sessionId, messages);
    this.committedHistories.set(sessionId, messages);
    return messages;
  }

  /** 大型历史和运行快照保持不可变对象引用；小型可变状态取副本，才能识别原地修改。 */
  Capture(state: Record<string, unknown>, baseline = false): void {
    const immutable = new Set(['runSnapshots', 'toolLedger']);
    for (const bucket of AgentStateBuckets) {
      const values = bucket === 'documentChangeBaselines' ? [['current', state[bucket] ?? []]] : state[bucket] ?? [];
      const entries = new Map(values as Array<[string, unknown]>);
      const before = this.seen.get(bucket) ?? new Map<string, unknown>();
      const next = new Map<string, unknown>();
      for (const [key, value] of entries) {
        const unchanged = before.has(key) && (immutable.has(bucket) ? before.get(key) === value : isDeepStrictEqual(before.get(key), value));
        if (!unchanged && !baseline) this.rows.set(JSON.stringify([bucket, key]), { version: ++this.version, bucket, key, value: structuredClone(value) });
        next.set(key, unchanged ? before.get(key) : immutable.has(bucket) ? value : structuredClone(value));
      }
      for (const key of before.keys()) if (!baseline && !entries.has(key)) this.rows.set(JSON.stringify([bucket, key]), { version: ++this.version, bucket, key, deleted: true });
      this.seen.set(bucket, next);
    }
    const histories = new Map((state.histories ?? []) as Array<[string, unknown[]]>);
    for (const [sessionId, value] of histories) {
      if (this.unloadedHistories.has(sessionId) && value.length === 0) continue;
      this.unloadedHistories.delete(sessionId);
      if (!baseline && this.historyViews.get(sessionId) !== value) this.histories.set(sessionId, { version: ++this.version, value });
    }
    for (const sessionId of this.historyViews.keys()) if (!histories.has(sessionId)) {
      this.unloadedHistories.delete(sessionId);
      this.histories.set(sessionId, { version: ++this.version });
    }
    this.historyViews = histories;
  }

  /** 队列只保留一个在途事务和每个键的最新候选。失败补丁原样保留，下一次 Flush 先查询同一提交。 */
  Flush(): Promise<void> {
    const target = this.version;
    if (!this.running) {
      const work = this.Drain().finally(() => { if (this.running === work) this.running = undefined; });
      this.running = work;
      void work.catch(() => undefined);
    }
    // Drain 完成到 finally 清理之间也可能收到新状态；每个屏障必须等到自己请求的版本获得回执。
    return this.running.then(() => this.durableVersion < target ? this.Flush() : undefined);
  }

  private async Drain(): Promise<void> {
    while (this.pending || this.rows.size || this.histories.size) {
      if (!this.pending) {
        const rows = [...this.rows.values()];
        const histories = [...this.histories.entries()];
        const patch: AgentStatePatch = { commitId: randomUUID(), expectedRevision: this.revision, rows: rows.map(({ version: _version, ...row }) => row), histories: [] };
        for (const [sessionId, change] of histories) {
          const previous = this.committedHistories.get(sessionId) ?? [];
          const next = change.value ?? [];
          let from = 0;
          while (from < previous.length && from < next.length && (previous[from] === next[from] || isDeepStrictEqual(previous[from], next[from]))) from++;
          patch.histories.push({ sessionId, from, messages: structuredClone(next.slice(from)), ...(change.value ? {} : { deleted: true }) });
        }
        this.pending = { patch, rows, histories };
      }
      const batch = this.pending;
      const result = await this.port.CommitAgentState(batch.patch);
      this.revision = result.revision;
      for (const change of batch.rows) {
        this.durableVersion = Math.max(this.durableVersion, change.version);
        const key = JSON.stringify([change.bucket, change.key]);
        if (this.rows.get(key)?.version === change.version) this.rows.delete(key);
      }
      for (const [sessionId, change] of batch.histories) {
        this.durableVersion = Math.max(this.durableVersion, change.version);
        if (change.value) this.committedHistories.set(sessionId, change.value);
        else this.committedHistories.delete(sessionId);
        if (this.histories.get(sessionId)?.version === change.version) this.histories.delete(sessionId);
      }
      this.pending = undefined;
    }
  }
}
