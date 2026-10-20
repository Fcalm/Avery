import type {
  ApplicationDto, ChatMessageDto, ConversationDto, JobDto, ProfileItemDto, ResumeDto, SettingsDto,
} from '@avery/contracts';

export type PageId = 'assistant' | 'jobs' | 'applications' | 'resumes' | 'profiles' | 'settings' | 'developer';

export type { ApplicationStatus, Channel, JobSeekingType, JobScore, ProfileCategory } from '@avery/contracts';

/** 前端业务 ViewModel：统一以契约 DTO 为模型来源，避免双类型源漂移。 */
export type Conversation = ConversationDto;
export type ChatMessage = ChatMessageDto;
export type Resume = ResumeDto;
export type Job = JobDto;
export type Application = ApplicationDto;
export type ProfileItem = ProfileItemDto;

/** 设置草稿：契约 SettingsDto（不含 API Key）+ 仅存在于表单内存的 apiKey。 */
export type SettingsDraft = SettingsDto & {
  apiKey: string;
  onboardingDraft?: OnboardingDraft;
};

/** 首次启动向导的中断暂存；只含非敏感字段，绝不含 API Key。 */
export interface OnboardingDraft {
  version?: 2;
  step: number;
  preferencesEdited?: boolean;
  /** 兼容旧版草稿；新版从桌面端重新确认凭据状态，不信任此标记。 */
  apiConfigurationSaved?: boolean;
  nickname?: string;
  provider?: 'DeepSeek' | 'Z.AI' | 'MIMO' | '自定义';
  baseUrl?: string;
  model?: string;
  contextLength?: string;
  contextLimitMode?: 'default' | 'custom';
  jobType?: string;
  experience?: string;
  education?: string;
  industry?: string;
  roles?: string[];
  city?: string;
}
