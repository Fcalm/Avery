/** 开发者可观测性门面：承接 AgentHost 的观测命令，数据经 observability 模块缓冲并落可观测性库。 */
export declare class DeveloperService {
    private agent;
    constructor({ agentHost }: {
        agentHost: any;
    });
    /** 聚合运行时内存态与可观测性库数据，供开发者界面展示脱敏日志与 Trace。 */
    GetObservability(): any;
    /** 读取单条 Trace 的已脱敏事件。 */
    GetTraceEvents(requestId: string): any;
    /** 按会话删除 Trace 索引和事件，不影响运行日志。 */
    DeleteTraces(sessionIds: string[]): any;
    /** 更新 Trace 留存量并裁剪既有索引。 */
    SetTraceRetention(value: number): any;
    /** 清空开发者日志与 Trace，不影响业务数据与 API 配置。 */
    ClearObservability(): any;
}
