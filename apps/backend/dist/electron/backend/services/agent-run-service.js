"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
// @ts-nocheck
/** Agent 运行的应用服务门面：封装 AgentHost，向 Router 暴露启动/取消/确认/重载命令；Send 由 Kernel 与六槽模块执行。 */
class AgentRunService {
    constructor({ agentHost, selectModuleDirectory }) {
        this.agent = agentHost;
        this.selectModuleDirectory = selectModuleDirectory;
    }
    /** 保存经校验的模型配置，API Key 移入 safeStorage。 */
    Configure(config) { return this.agent.Configure(config); }
    /** 使用表单临时配置测试连通性，不写入配置。 */
    TestConnection(config) { return this.agent.TestConnection(config); }
    /** 查询已保存 DeepSeek 凭据对应的账户余额。 */
    GetBalance() { return this.agent.GetBalance(); }
    /** 查询已保存 DeepSeek 凭据可访问的模型列表。 */
    GetModels() { return this.agent.GetModels(); }
    /** 提交一轮受限的流式对话回合。 */
    Send(request) { return this.agent.Send(request); }
    /** 中止指定在途请求。 */
    Cancel(requestId) { return this.agent.Cancel(requestId); }
    /** 应用或丢弃待确认的简历补丁。 */
    ConfirmResumeEdit(confirmationId, accepted) { return this.agent.ConfirmResumeEdit(confirmationId, accepted); }
    /** 用户开始编辑简历前获取互斥锁。 */
    AcquireResumeEditLock(resumeId) { return this.agent.AcquireResumeEditLock(resumeId); }
    /** 用户保存或取消编辑后释放简历锁。 */
    ReleaseResumeEditLock(resumeId) { return this.agent.ReleaseResumeEditLock(resumeId); }
    /** 返回脱敏的配置状态。 */
    GetStatus() { return this.agent.GetStatus(); }
    /** 空闲时原子重载会话上下文与工具快照。 */
    ReloadSession(sessionId) { return this.agent.ReloadSession(sessionId); }
    GetSessionAssistantState(sessionId) { return this.agent.GetSessionAssistantState(sessionId); }
    async BindProjectEnvironment(sessionId, projectId) {
        await this.agent.BindProjectEnvironment(sessionId, projectId);
        return this.agent.GetSessionAssistantState(sessionId).project;
    }
    GetModuleConfiguration() { return this.agent.GetModuleConfiguration(); }
    async SelectModuleDirectory() {
        const selected = await this.selectModuleDirectory?.();
        return selected?.path ? this.agent.ConfigureUserModules(selected.path) : this.agent.GetModuleConfiguration();
    }
    ResetModules() { return this.agent.ResetUserModules(); }
}
module.exports = { AgentRunService };
