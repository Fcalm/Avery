import type { AgentConfiguration, AgentModuleConfiguration, AgentSendRequest, AgentSessionAssistantState, AgentStreamEvent, ConfirmationMode } from '@offerget/contracts';
import { platformClient, Unwrap } from '../../../shared/platform/platformClient';

/** 判断当前页面是否由带安全桥接的桌面客户端承载。 */
export function IsDesktopAgentAvailable() {
  return Boolean(window.offergetAgent);
}

/** 保存模型配置，API Key 仅经 IPC 进入主进程；失败抛统一业务错误。 */
export async function ConfigureAgent(config: AgentConfiguration) {
  return Unwrap(await platformClient.agent.Configure(config));
}

/** 使用表单中的临时 API 配置进行连通性测试，不保存任何字段。 */
export async function TestAgentConnection(config: AgentConfiguration) {
  return Unwrap(await platformClient.agent.TestConnection(config));
}

/** 读取主进程中的真实 DeepSeek 余额；API Key 不会进入渲染层。 */
export async function GetAgentBalance() {
  return Unwrap(await platformClient.agent.GetBalance());
}

/** 读取当前凭据在 DeepSeek 官方 /models 返回的可用模型。 */
export async function GetDeepSeekModels() {
  return Unwrap(await platformClient.agent.GetModels());
}

/** 提交一轮真实 Agent 请求；业务只读快照由后端按 resumeId/projectId 读取，不再整包透传。 */
export async function SendAgentRequest(request: AgentSendRequest) {
  return Unwrap(await platformClient.agent.Send(request));
}

/** 取消当前 Agent 请求。 */
export async function CancelAgentRequest(requestId: string) {
  const result = await platformClient.agent.Cancel(requestId);
  return result.ok ? result.data : { cancelled: false };
}

/** 提交用户对待确认简历修改的唯一决定。 */
export async function ConfirmResumeEdit(confirmationId: string, accepted: boolean) {
  return Unwrap(await platformClient.agent.ConfirmResumeEdit(confirmationId, accepted));
}

/** 用户开始编辑简历前获取互斥锁；未获取时返回原因。 */
export async function AcquireResumeEditLock(resumeId: string) {
  return Unwrap(await platformClient.agent.AcquireResumeEditLock(resumeId));
}

/** 用户保存或取消编辑后释放简历锁。 */
export async function ReleaseResumeEditLock(resumeId: string) {
  return Unwrap(await platformClient.agent.ReleaseResumeEditLock(resumeId));
}

/** 读取已脱敏的运行指标与日志。 */
export async function GetAgentObservability() {
  const result = await platformClient.agent.GetObservability();
  return result.ok ? result.data : null;
}

/** 读取用户在开发者页面主动展开的一条 Trace 事件链。 */
export async function GetAgentTraceEvents(requestId: string) {
  const result = await platformClient.agent.GetTraceEvents(requestId);
  return result.ok ? result.data : [];
}

/** 更新在途 Run 的确认权限；无在途 Run 时由下一次 Send 携带当前值。 */
export async function UpdateAgentConfirmationMode(requestId: string, confirmationMode: ConfirmationMode) {
  return Unwrap(await platformClient.agent.UpdateConfirmationMode(requestId, confirmationMode));
}

/** 按会话删除对应的全部 Trace 与事件；运行日志和会话消息保持不变。 */
export async function DeleteAgentTraces(sessionIds: string[]) {
  return Unwrap(await platformClient.agent.DeleteTraces(sessionIds));
}

/** 更新本地 Trace 保留数量。 */
export async function SetAgentTraceRetention(value: number) {
  return Unwrap(await platformClient.agent.SetTraceRetention(value));
}

/** 清空本地运行日志与 Trace。 */
export async function ClearAgentObservability() {
  const result = await platformClient.agent.ClearObservability();
  return result.ok ? result.data : { cleared: false };
}

/** 仅空闲时原子重载会话上下文与 Tool Array 快照。 */
export async function ReloadAgentSession(sessionId: string) {
  const result = await platformClient.agent.ReloadSession(sessionId);
  return result.ok ? result.data : { reloaded: false, reason: 'desktop-unavailable' };
}

/** 仅通过原生目录选择器获取用户明确授权的项目目录。 */
export async function SelectAgentProjectDirectory() {
  const result = await platformClient.agent.SelectProjectDirectory();
  return result.ok ? result.data : null;
}

/** 读取当前会话独有的 usage 与项目环境；结果不包含绝对路径。 */
export async function GetSessionAssistantState(sessionId: string): Promise<AgentSessionAssistantState> {
  return Unwrap(await platformClient.agent.GetSessionAssistantState(sessionId));
}

/** 把已选项目立即绑定到会话，切换会话后可恢复同一项目标签。 */
export async function BindProjectEnvironment(sessionId: string, projectId: string) {
  return Unwrap(await platformClient.agent.BindProjectEnvironment(sessionId, projectId));
}

/** 读取高级用户模块配置；目录仅以名称形式返回。 */
export async function GetAgentModuleConfiguration() {
  return Unwrap(await platformClient.agent.GetModuleConfiguration());
}

/** 由主进程目录选择器选择并校验用户模块，不向 Renderer 透露绝对路径。 */
export async function SelectAgentModuleDirectory(): Promise<AgentModuleConfiguration> {
  return Unwrap(await platformClient.agent.SelectModuleDirectory());
}

/** 恢复内置模块；调用方必须先完成显式二次确认。 */
export async function ResetAgentModules(): Promise<AgentModuleConfiguration> {
  return Unwrap(await platformClient.agent.ResetModules());
}

/** 将用户主动选择的文件经 preload 隔离导入工作空间，返回不暴露源路径的虚拟 URI。 */
export async function ImportAttachmentFile(file: File) {
  return Unwrap(await platformClient.workspace.ImportAttachment(file, file.type || 'application/octet-stream'));
}

/** 订阅单一的主进程流式事件通道。 */
export function SubscribeAgentStream(listener: (event: AgentStreamEvent) => void) {
  return platformClient.agent.OnStream(listener);
}
