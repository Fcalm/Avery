import type { DesktopAgentBridge } from '@avery/contracts';

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
  /** 仅返回脱敏用量快照，保持 IPC → Host 的读取边界。 */
  GetProviderUsage(): ReturnType<DesktopAgentBridge['GetProviderUsage']> { return this.agent.GetProviderUsage(); }

  /** 查询指定 Provider 凭据可访问的模型列表；缺省 DeepSeek。参数必须原样转发：漏转发会被当成 DeepSeek 查询，把 DeepSeek 模型列表交回请求其它供应商的调用方。 */
  GetModels(provider?: unknown): any { return this.agent.GetModels(provider); }

  /** 返回所有已配置 Provider 的脱敏模型目录。 */
  GetProviderCatalog(): any { return this.agent.GetProviderCatalog(); }
  /** 模型能力读取和保存复用 Host 的严格 Schema 与 revision 校验。 */
  GetModelConfiguration(input: unknown): ReturnType<DesktopAgentBridge['GetModelConfiguration']> { return this.agent.GetModelConfiguration(input); }
  SaveModelConfiguration(input: unknown): ReturnType<DesktopAgentBridge['SaveModelConfiguration']> { return this.agent.SaveModelConfiguration(input); }

  /** 提交一轮受限的流式对话回合。 */
  Send(request: any): any { return this.agent.Send(request); }

  /** 提交结构化决定，恢复调度完全由 Host 执行。 */
  RespondToInteraction(response: import('@avery/contracts').AgentInteractionResponse): any { return this.agent.RespondToInteraction(response); }

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
  ConfirmBrowserAction(confirmationId: string, accepted: boolean, sessionId: string): any { return this.agent.ConfirmBrowserAction(confirmationId, accepted, { sessionId }); }

  /** 返回不含本地路径的浏览器状态；用户显式检测时可发起一次只读连接握手。 */
  GetBrowserRuntimeStatus(probeConnection?: boolean): any { return this.agent.GetBrowserRuntimeStatus(probeConnection); }

  GetCronBrowserAccess(): any { return this.agent.GetCronBrowserAccess(); }

  RevokeCronBrowserAccess(input: unknown): any { return this.agent.RevokeCronBrowserAccess(input); }

  /** 清除 Avery 独立浏览器登录身份。 */

  /** 用户开始编辑简历前获取互斥锁。 */
  AcquireResumeEditLock(resumeId: string): any { return this.agent.AcquireResumeEditLock(resumeId); }

  /** 用户保存或取消编辑后释放简历锁。 */
  ReleaseResumeEditLock(resumeId: string): any { return this.agent.ReleaseResumeEditLock(resumeId); }

  /** 返回脱敏的配置状态。 */
  GetStatus(): any { return this.agent.GetStatus(); }

  /** 空闲时原子重载会话上下文与工具快照。 */
  ReloadSession(sessionId: string): any { return this.agent.ReloadSession(sessionId); }

  /** 命令面板仅经服务层读取技能索引，保持 Router 与 Host 的调用链完整。 */
  GetCommandSkills(input: Parameters<DesktopAgentBridge['GetCommandSkills']>[0]): ReturnType<DesktopAgentBridge['GetCommandSkills']> { return this.agent.GetCommandSkills(input); }

  GetSessionAssistantState(sessionId: string): any { return this.agent.GetSessionAssistantState(sessionId); }

  /** 会话产物读取由 Host 校验引用归属与物理路径。 */
  ReadConversationResource(sessionId: string, resource: import('@avery/contracts').ConversationResource): Promise<import('@avery/contracts').ConversationResourceView> { return this.agent.ReadConversationResource(sessionId, resource); }

  /** 批量返回会话场景映射（只读），与 GetSessionAssistantState 同源。 */
  GetSessionScenes(): any { return this.agent.GetSessionScenes(); }

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
