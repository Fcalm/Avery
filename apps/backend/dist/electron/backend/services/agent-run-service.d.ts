/** Agent 运行的应用服务门面：封装 AgentHost，向 Router 暴露启动/取消/确认/重载命令；Send 由 Kernel 与六槽模块执行。 */
export declare class AgentRunService {
    private agent;
    private selectModuleDirectory?;
    constructor({ agentHost, selectModuleDirectory }: {
        agentHost: any;
        selectModuleDirectory?: () => Promise<{
            path?: string;
        } | null | undefined>;
    });
    /** 保存经校验的模型配置，API Key 移入 safeStorage。 */
    Configure(config: any): any;
    /** 使用表单临时配置测试连通性，不写入配置。 */
    TestConnection(config: any): any;
    /** 查询已保存 DeepSeek 凭据对应的账户余额。 */
    GetBalance(): any;
    /** 查询已保存 DeepSeek 凭据可访问的模型列表。 */
    GetModels(): any;
    /** 提交一轮受限的流式对话回合。 */
    Send(request: any): any;
    /** 中止指定在途请求。 */
    Cancel(requestId: string): any;
    /** 应用或丢弃待确认的简历补丁。 */
    ConfirmResumeEdit(confirmationId: string, accepted: boolean): any;
    /** 用户开始编辑简历前获取互斥锁。 */
    AcquireResumeEditLock(resumeId: string): any;
    /** 用户保存或取消编辑后释放简历锁。 */
    ReleaseResumeEditLock(resumeId: string): any;
    /** 返回脱敏的配置状态。 */
    GetStatus(): any;
    /** 空闲时原子重载会话上下文与工具快照。 */
    ReloadSession(sessionId: string): any;
    GetSessionAssistantState(sessionId: string): any;
    BindProjectEnvironment(sessionId: string, projectId: string): Promise<any>;
    GetModuleConfiguration(): any;
    SelectModuleDirectory(): Promise<any>;
    ResetModules(): any;
}
