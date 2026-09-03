/** Agent 运行的应用服务门面：封装 AgentHost，向 Router 暴露启动/取消/确认/重载命令；Send 由 Kernel 与六槽模块执行。 */
export class AgentRunService {
  private agent: any;
  private selectModuleDirectory?: () => Promise<{ path?: string } | null | undefined>;

  constructor({ agentHost, selectModuleDirectory }: { agentHost: any; selectModuleDirectory?: () => Promise<{ path?: string } | null | undefined> }) {
    this.agent = agentHost;
    this.selectModuleDirectory = selectModuleDirectory;
  }

  /** 保存经校验的模型配置，API Key 移入 safeStorage。 */
  Configure(config: any): any { return this.agent.Configure(config); }

  /** 使用表单临时配置测试连通性，不写入配置。 */
  TestConnection(config: any): any { return this.agent.TestConnection(config); }

  /** 查询已保存 DeepSeek 凭据对应的账户余额。 */
  GetBalance(): any { return this.agent.GetBalance(); }

  /** 查询已保存 DeepSeek 凭据可访问的模型列表。 */
  GetModels(): any { return this.agent.GetModels(); }

  /** 提交一轮受限的流式对话回合。 */
  Send(request: any): any { return this.agent.Send(request); }

  /** 中止指定在途请求。 */
  Cancel(requestId: string): any { return this.agent.Cancel(requestId); }

  /** 在途 Run 的确认权限切换；Kernel 在下一轮状态提醒中同步给模型。 */
  UpdateConfirmationMode(requestId: string, confirmationMode: unknown): any { return this.agent.UpdateConfirmationMode(requestId, confirmationMode); }

  /** 持久化会话级思考强度；下一 Run 读取该值。 */
  UpdateReasoningEffort(sessionId: string, reasoningEffort: unknown): any { return this.agent.UpdateReasoningEffort(sessionId, reasoningEffort); }

  /** 应用或丢弃待确认的简历补丁。 */
  ConfirmResumeEdit(confirmationId: string, accepted: boolean): any { return this.agent.ConfirmResumeEdit(confirmationId, accepted); }

  /** 确认或拒绝周期级无人值守 CronTask 创建提案。 */
  ConfirmCronTask(confirmationId: string, accepted: boolean): any { return this.agent.ConfirmCronTask(confirmationId, accepted); }

  /** 应用或拒绝冻结的浏览器动作提案。 */
  ConfirmBrowserAction(confirmationId: string, accepted: boolean): any { return this.agent.ConfirmBrowserAction(confirmationId, accepted); }

  /** 返回不含本地路径的浏览器运行时状态。 */
  GetBrowserRuntimeStatus(): any { return this.agent.GetBrowserRuntimeStatus(); }

  /** 清除 Avery 独立浏览器登录身份。 */
  ClearBrowserProfile(): any { return this.agent.ClearBrowserProfile(); }

  /** 用户开始编辑简历前获取互斥锁。 */
  AcquireResumeEditLock(resumeId: string): any { return this.agent.AcquireResumeEditLock(resumeId); }

  /** 用户保存或取消编辑后释放简历锁。 */
  ReleaseResumeEditLock(resumeId: string): any { return this.agent.ReleaseResumeEditLock(resumeId); }

  /** 返回脱敏的配置状态。 */
  GetStatus(): any { return this.agent.GetStatus(); }

  /** 空闲时原子重载会话上下文与工具快照。 */
  ReloadSession(sessionId: string): any { return this.agent.ReloadSession(sessionId); }

  GetSessionAssistantState(sessionId: string): any { return this.agent.GetSessionAssistantState(sessionId); }

  async BindProjectEnvironment(sessionId: string, projectId: string): Promise<any> {
    await this.agent.BindProjectEnvironment(sessionId, projectId);
    return (await this.agent.GetSessionAssistantState(sessionId)).project;
  }

  GetModuleConfiguration(): any { return this.agent.GetModuleConfiguration(); }

  async SelectModuleDirectory(): Promise<any> {
    const selected = await this.selectModuleDirectory?.();
    return selected?.path ? this.agent.ConfigureUserModules(selected.path) : this.agent.GetModuleConfiguration();
  }

  ResetModules(): any { return this.agent.ResetUserModules(); }
}
