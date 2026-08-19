/** 可观测性数据库的 Infrastructure 组合根：持有 Trace 与日志两张表，全部方法经 DB Worker RPC 暴露。 */
export declare class ObservabilityStore {
    databasePath: string;
    db: any;
    traceRetention: number;
    /** 初始化不随工作空间迁移的本地日志数据库。 */
    constructor(userDataPath: string);
    /** 追加已由调用方脱敏的结构化运行日志，并执行数量与时间双重留存限制。 */
    RecordLog(level: string, event: string, detail: string): void;
    /** 读取按最新优先排列的开发者日志，并格式化为页面现有 ViewModel。 */
    GetLogs(limit?: number): any[];
    /** 清空开发者模式可见的日志与 Trace，不影响业务、附件或 API Key 数据。 */
    ClearObservability(): void;
    /** 创建一条不含消息正文与凭据的 Trace 索引记录。 */
    StartTrace(requestId: string, sessionId: string, model: string): void;
    /** 用结束状态和脱敏摘要关闭一条 Trace。 */
    FinishTrace(requestId: string, state: string, summary: string): void;
    /** 追加一条 Trace 事件；调用方不得传入 API Key、Authorization 或 Provider 凭据。 */
    AppendTraceEvent(requestId: string, eventType: string, payload: unknown, tokenCount?: number): void;
    /** 返回供开发者界面展示的最近 Trace 索引。 */
    GetTraces(limit?: number): any[];
    /** 读取单条 Trace 的已脱敏事件，供开发者页面按需展开，不暴露其它会话的数据。 */
    GetTraceEvents(requestId: string): any[];
    /** 按会话原子删除 Trace 索引与事件；不删除日志或会话本身。 */
    DeleteTraces(sessionIds: string[]): any;
    /** 设置 Trace 留存数量并立即裁剪已有索引，范围与设置页保持一致。 */
    SetTraceRetention(value: number): any;
    /** 按产品默认 50 条、设置最高 100 条的当前默认值裁剪完整 Trace 索引。 */
    private PruneTraces;
    /** 将进程崩溃遗留的 running Trace 标记为 interrupted，供 Backend 启动时恢复观测一致性。 */
    RecoverInterruptedTraces(): any;
    /** 关闭用户目录日志数据库。 */
    Close(): void;
}
