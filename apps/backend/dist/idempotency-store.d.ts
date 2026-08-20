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
 * 写盘故障后仅保证当前进程的内存去重；重启后的回放能力会降级，不能宣称 exactly-once。
 */
export declare class IdempotencyStore {
    private readonly filePath;
    private readonly maxEntries;
    private records;
    private persistenceErrorCode;
    constructor(filePath: string, maxEntries?: number);
    Get(key: string, payloadHash: string): IdempotencyLookup;
    /** 返回不含路径与负载的持久化降级状态，供健康检查与诊断使用。 */
    GetHealth(): {
        degraded: boolean;
        code?: 'STORAGE_ERROR';
    };
    Put(key: string, payloadHash: string, result: unknown): void;
}
export {};
