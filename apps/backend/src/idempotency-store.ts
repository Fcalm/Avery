import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

interface IdempotencyRecord {
  payloadHash: string;
  result: unknown;
  createdAt: number;
}

type IdempotencyLookup =
  | { hit: false; conflict: false }
  | { hit: false; conflict: true }
  | { hit: true; conflict: false; result: unknown };

/**
 * 跨 Backend 重启保留的有限请求回放表。
 * 只保存统一结果信封和负载哈希，不保存凭据类通道；
 * 原子替换文件避免进程退出时留下半写 JSON，按时间仅保留最近 maxEntries 条。
 */
export class IdempotencyStore {
  private readonly filePath: string;
  private readonly maxEntries: number;
  private records = new Map<string, IdempotencyRecord>();

  constructor(filePath: string, maxEntries = 500) {
    this.filePath = filePath;
    this.maxEntries = maxEntries;
    try {
      const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as Record<string, IdempotencyRecord>;
      for (const [key, value] of Object.entries(parsed)) {
        if (value && typeof value.payloadHash === 'string' && typeof value.createdAt === 'number') {
          this.records.set(key, value);
        }
      }
    } catch {
      // 首次启动或损坏缓存按空表处理；业务事实源不依赖本文件。
    }
  }

  Get(key: string, payloadHash: string): IdempotencyLookup {
    const record = this.records.get(key);
    if (!record) return { hit: false, conflict: false };
    if (record.payloadHash !== payloadHash) return { hit: false, conflict: true };
    return { hit: true, conflict: false, result: record.result };
  }

  Put(key: string, payloadHash: string, result: unknown): void {
    this.records.set(key, { payloadHash, result, createdAt: Date.now() });
    const entries = [...this.records.entries()]
      .sort((left, right) => right[1].createdAt - left[1].createdAt)
      .slice(0, this.maxEntries);
    this.records.clear();
    for (const [entryKey, value] of entries) this.records.set(entryKey, value);
    try {
      mkdirSync(dirname(this.filePath), { recursive: true });
      const temporaryPath = `${this.filePath}.tmp`;
      writeFileSync(temporaryPath, JSON.stringify(Object.fromEntries(this.records)), { encoding: 'utf8', mode: 0o600 });
      renameSync(temporaryPath, this.filePath);
    } catch {
      // 内存记录已先行更新；落盘失败不改变业务已成功的响应语义。
      // 跨进程重启后该键可能丢失，但调用方不会收到“可重试失败”后盲目重试。
    }
  }
}
