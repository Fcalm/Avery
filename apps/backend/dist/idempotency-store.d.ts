type IdempotencyLookup = {
    hit: false;
    conflict: false;
} | {
    hit: false;
    conflict: true;
} | {
    hit: true;
    conflict: false;
    result: unknown;
};
/**
 * 跨 Backend 重启保留的有限请求回放表。
 * 只保存统一结果信封和负载哈希，不保存凭据类通道；
 * 原子替换文件避免进程退出时留下半写 JSON，按时间仅保留最近 maxEntries 条。
 */
export declare class IdempotencyStore {
    private readonly filePath;
    private readonly maxEntries;
    private records;
    constructor(filePath: string, maxEntries?: number);
    Get(key: string, payloadHash: string): IdempotencyLookup;
    Put(key: string, payloadHash: string, result: unknown): void;
}
export {};
