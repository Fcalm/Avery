import type { ApplicationStatus, Channel, JobSeekingType, ProfileCategory } from './enums';

/** 跨进程实体 DTO：形状与当前 preload / Repository 返回保持一致，作为前端 ViewModel 的稳定数据契约。 */

/** 会话消息的跨进程形状；createdAt 为服务端落库的 UTC epoch 毫秒，前端仅用于展示格式化。 */
export interface ChatMessageDto {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  thinkingContent?: string;
  createdAt?: number;
  attachments?: Array<{ name: string; path: string }>;
}

/** 追加会话消息时的输入形状；时间由后端落库时统一填写，前端不参与持久化。 */
export interface ChatMessageInput {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  thinkingContent?: string;
  attachments?: Array<{ name: string; path: string }>;
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
  jobSeekingType: JobSeekingType;
  channel: Channel;
  favorite: boolean;
  matchScore?: number;
  url?: string;
  jd: string;
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
  provider: 'DeepSeek' | 'Z.AI' | '自定义';
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
  /** Agent 浏览器内核；Electron 使用专用 Profile，Chrome/Edge 轻量连接用户已登录的 BOSS 页面。 */
  browserEngine?: 'electron' | 'chrome' | 'edge';
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
