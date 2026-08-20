"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.IdempotencyStore = void 0;
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
/**
 * 跨 Backend 重启保留的有限请求回放表。
 * 只保存统一结果信封和负载哈希，不保存凭据类通道；
 * 原子替换文件避免进程退出时留下半写 JSON，按时间仅保留最近 maxEntries 条。
 * 写盘故障后仅保证当前进程的内存去重；重启后的回放能力会降级，不能宣称 exactly-once。
 */
class IdempotencyStore {
    filePath;
    maxEntries;
    records = new Map();
    persistenceErrorCode = null;
    constructor(filePath, maxEntries = 500) {
        this.filePath = filePath;
        this.maxEntries = maxEntries;
        try {
            const parsed = JSON.parse((0, node_fs_1.readFileSync)(filePath, 'utf8'));
            for (const [key, value] of Object.entries(parsed)) {
                if (value && typeof value.payloadHash === 'string' && typeof value.createdAt === 'number') {
                    this.records.set(key, value);
                }
            }
        }
        catch {
            // 首次启动或损坏缓存按空表处理；业务事实源不依赖本文件。
        }
    }
    Get(key, payloadHash) {
        const record = this.records.get(key);
        if (!record)
            return { hit: false, conflict: false };
        if (record.payloadHash !== payloadHash)
            return { hit: false, conflict: true };
        return { hit: true, conflict: false, result: record.result };
    }
    /** 返回不含路径与负载的持久化降级状态，供健康检查与诊断使用。 */
    GetHealth() {
        return this.persistenceErrorCode ? { degraded: true, code: this.persistenceErrorCode } : { degraded: false };
    }
    Put(key, payloadHash, result) {
        this.records.set(key, { payloadHash, result, createdAt: Date.now() });
        const entries = [...this.records.entries()]
            .sort((left, right) => right[1].createdAt - left[1].createdAt)
            .slice(0, this.maxEntries);
        this.records.clear();
        for (const [entryKey, value] of entries)
            this.records.set(entryKey, value);
        try {
            (0, node_fs_1.mkdirSync)((0, node_path_1.dirname)(this.filePath), { recursive: true });
            const temporaryPath = `${this.filePath}.tmp`;
            (0, node_fs_1.writeFileSync)(temporaryPath, JSON.stringify(Object.fromEntries(this.records)), { encoding: 'utf8', mode: 0o600 });
            (0, node_fs_1.renameSync)(temporaryPath, this.filePath);
            this.persistenceErrorCode = null;
        }
        catch {
            // 内存记录已先行更新；落盘失败不改变业务已成功的响应语义。
            // 跨进程重启后该键可能丢失，但调用方不会收到“可重试失败”后盲目重试。
            if (this.persistenceErrorCode !== 'STORAGE_ERROR') {
                console.warn('[idempotency] code=STORAGE_ERROR persistence=degraded');
            }
            this.persistenceErrorCode = 'STORAGE_ERROR';
        }
    }
}
exports.IdempotencyStore = IdempotencyStore;
