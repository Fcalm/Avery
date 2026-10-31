import type { ApplicationStatus, Channel, JobSeekingType, ProfileCategory } from './enums';
import type { ConversationPresentation, ConversationResource } from '@avery/agent-sdk';

/** 产物预览只返回授权正文或受限文件字节，不向渲染进程暴露磁盘路径。 */
export type ConversationResourceView =
  | { resource: ConversationResource; format: 'resume'; document: ResumeDto; versions: ResumeRevisionDto[] }
  | { resource: ConversationResource; format: 'markdown'; content: string }
  | { resource: ConversationResource; format: 'file'; mimeType: 'application/pdf' | 'image/png'; base64: string };

/** 跨进程实体 DTO：形状与当前 preload / Repository 返回保持一致，作为前端 ViewModel 的稳定数据契约。 */

/** 用户发送时的技能展示快照；不授予工具权限，执行仍由 AgentSendRequest.selectedSkillId 单独校验。 */
export interface ChatMessageSkill { id: string; label: string }

/** 会话消息的跨进程形状；createdAt 为服务端落库的 UTC epoch 毫秒，前端仅用于展示格式化。 */
export interface ChatMessageDto {
  presentation?: ConversationPresentation;
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  thinkingContent?: string;
  createdAt?: number;
  /** 消息最后落盘时间，仅在旧会话缺少整轮计时时用于估算结束时间。 */
  updatedAt?: number;
  attachments?: Array<{ name: string; path: string }>;
  skill?: ChatMessageSkill;
}

/** 追加会话消息时的输入形状；时间由后端落库时统一填写，前端不参与持久化。 */
export interface ChatMessageInput {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  thinkingContent?: string;
  attachments?: Array<{ name: string; path: string }>;
  skill?: ChatMessageSkill;
}

/** 会话 DTO：含 revision 供外部修改冲突校验；pinned/archived 仅控制"最近"列表的排序与可见性。
 * scenarioId/projectId/projectName 在创建时定格（场景与项目绑定此后不可变），是侧栏场景标注与项目分组的数据源；旧会话缺省按聊天/未分组处理。 */
export interface ConversationDto {
  id: string;
  title: string;
  revision?: number;
  updatedAt?: number;
  pinned?: boolean;
  archived?: boolean;
  scenarioId?: 'default' | 'application';
  projectId?: string | null;
  projectName?: string | null;
  messages: ChatMessageDto[];
}

/** 简历 DTO：document_json 即页面 Resume ViewModel，正文变化提升 revision 并追加版本快照。 */
export interface ResumeDto {
  id: string;
  name: string;
  targetRoles: string[];
  summary: string;
  content: string;
  updatedAt?: number;
  revision?: number;
}

/** 岗位 DTO：payload_json 即页面 Job ViewModel；枚举使用稳定英文值。 */
export interface JobDto {
  id: string;
  company: string;
  title: string;
  city: string;
  salary?: string;
  experience: string;
  /** 来源明确给出的学历要求与企业规模；旧岗位缺省时保持未知，不从 JD 推测。 */
  education?: string;
  companySize?: string;
  /** 来源未明确招聘类别时保持缺失，不自动归为社招。 */
  jobSeekingType?: JobSeekingType;
  channel: Channel;
  favorite: boolean;
  matchScore?: number;
  url?: string;
  jd: string;
  /** 截止时间（UTC 毫秒）；到时后由岗位库自动清理，缺省表示长期有效。 */
  deadline?: number;
  /** 入库时间（UTC 毫秒）；由后端 created_at 投影写入，只读。 */
  createdAt?: number;
  revision?: number;
}

/** 投递 DTO：payload_json 即页面 Application ViewModel；状态迁移追加不可变事件。 */
export interface ApplicationDto {
  id: string;
  jobId: string;
  resumeId: string;
  status: ApplicationStatus;
  /** 日历日期 YYYY-MM-DD（来自日期选择器，天然可排序），非时间戳。 */
  appliedAt?: string;
  nextStepAt?: string;
  note: string;
  revision?: number;
}

/** 档案项 DTO：profile.json items 的单项形状；分类使用稳定英文值。 */
export interface ProfileItemDto {
  id: string;
  category: ProfileCategory;
  title: string;
  content: string;
  updatedAt?: number;
}

/** 简历版本 DTO：当前版本与最多两份只读历史版本的元数据。 */
export interface ResumeRevisionDto {
  id: string;
  revision: number;
  source: 'user' | 'agent' | 'restore' | 'import';
  createdAt: number;
  isCurrent: boolean;
}

/** 简历历史版本的只读正文；历史版本只能预览、导出或恢复，不能直接编辑。 */
export interface ResumeRevisionDocumentDto extends ResumeRevisionDto {
  document: ResumeDto;
}

/** 非敏感设置 DTO；API Key 只经 Agent IPC 加密保存，不进入本对象。 */
export interface SettingsDto {
  nickname: string;
  /** 当前工作空间目录名的掩码（不含绝对路径），由后端动态注入，不参与持久化。 */
  workspaceName?: string;
  provider: 'DeepSeek' | 'Z.AI' | 'MIMO' | '自定义';
  baseUrl: string;
  model: string;
  contextLength: string;
  /** 默认模式使用 min(256K, 模型上限)，自定义模式使用 contextLength。 */
  contextLimitMode?: 'default' | 'custom';
  thinkingEnabled: boolean;
  developerMode: boolean;
  traceRetention: number;
  compressionThreshold: number;
  onboardingCompleted?: boolean;
  customContext?: string;
  /** Agent 浏览器使用用户的 Chrome 或 Edge，实际动作通过 Avery 扩展完成。 */
  browserEngine?: 'chrome' | 'edge' | 'ego';
  /** 常规-通用：界面语言；当前版本界面文案仅提供中文，英文选项先持久化偏好供后续 i18n 使用。 */
  language?: 'zh' | 'en';
  /** 常规-通用：启动时打开「上次的对话」或停留在工作区首页（新对话页）。 */
  startPage?: 'last' | 'home';
  /** 常规-通知：窗口未聚焦时长任务完成时弹出系统通知；主进程在收到完成事件时读取。 */
  notifyOnComplete?: boolean;
  /** 常规-通知：完成通知附带系统提示音；仅在 notifyOnComplete 开启时生效。 */
  notifySound?: boolean;
  /** 常规-更新：有新版本时在后台自动下载；更新发布通道接入前仅保存偏好。 */
  autoUpdate?: boolean;
  /** 常规-系统：开机时自动启动，保存时经主进程 setLoginItemSettings 写入系统。 */
  autoLaunch?: boolean;
  /** 常规-系统：关闭主窗口改为隐藏到托盘，正在运行的任务继续；主进程在关闭窗口时读取。 */
  closeToTray?: boolean;
  /** 个性化-头像：未上传图片时昵称首字头像的底色样式。 */
  avatarStyle?: 'default' | 'accent' | 'ink';
  /** 个性化-头像：上传后居中裁切压缩的方形小图 data URL；空串表示未上传，走首字头像。 */
  avatarImage?: string;
  /** 个性化-外观：对话里 Avery 回复的字号档位；默认档跟随样式表原值。 */
  chatFontSize?: 'sm' | 'md' | 'lg';
  /** 个性化-外观：主题颜色偏好；真实换肤接入前仅记录选择。 */
  accentColor?: 'pine' | 'indigo' | 'plum' | 'amber';
  /** 个性化-外观：简历模板偏好；模板渲染接入前仅记录选择。 */
  resumeTemplate?: 'classic' | 'compact' | 'timeline';
  /** 浏览器控制-行为：任务结束时是否自动关闭 Avery 自己打开的标签页；真实关闭策略接入前仅记录选择。 */
  closeTaskTabs?: boolean;
}

/** 附件导入结果 DTO；只返回虚拟 URI，绝不暴露源文件物理路径。 */
export interface AttachmentDto {
  id: string;
  name: string;
  uri: string;
}

/** 业务 ViewModel 聚合：启动时一次读取全部业务集合。 */
export interface WorkspaceViewModel {
  conversations: ConversationDto[];
  resumes: ResumeDto[];
  jobs: JobDto[];
  applications: ApplicationDto[];
}

/** 工作空间健康状态 DTO；只含掩码名称，不含任何绝对路径。 */
export interface WorkspaceStatusDto {
  name: string;
  metadata: { workspace_id: string; schema_version: number; created_at: number; last_opened_at: number };
  integrity: string;
}
