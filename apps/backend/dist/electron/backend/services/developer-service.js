"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DeveloperService = void 0;
/** 开发者可观测性门面：承接 AgentHost 的观测命令，数据经 observability 模块缓冲并落可观测性库。 */
class DeveloperService {
    agent;
    constructor({ agentHost }) {
        this.agent = agentHost;
    }
    /** 聚合运行时内存态与可观测性库数据，供开发者界面展示脱敏日志与 Trace。 */
    GetObservability() {
        return this.agent.GetObservability();
    }
    /** 读取单条 Trace 的已脱敏事件。 */
    GetTraceEvents(requestId) {
        return this.agent.GetTraceEvents(requestId);
    }
    /** 按会话删除 Trace 索引和事件，不影响运行日志。 */
    DeleteTraces(sessionIds) {
        return this.agent.DeleteTraces(sessionIds);
    }
    /** 更新 Trace 留存量并裁剪既有索引。 */
    SetTraceRetention(value) {
        return this.agent.SetTraceRetention(value);
    }
    /** 清空开发者日志与 Trace，不影响业务数据与 API 配置。 */
    ClearObservability() {
        return this.agent.ClearObservability();
    }
}
exports.DeveloperService = DeveloperService;
