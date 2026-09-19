import type { ProfileItemDto, WorkspaceViewModel } from '@avery/contracts';
import type { SettingsDraft } from '../../../types/domain';

/** 工作空间聚合缓存的 Query Key；页面通过失效该 Key 重新拉取后端聚合视图。 */
export const WORKSPACE_QUERY_KEY = ['workspace'] as const;

/** 前端工作空间聚合数据：业务 ViewModel + 档案 + 非敏感设置。 */
export interface WorkspaceData extends WorkspaceViewModel {
  profiles: ProfileItemDto[];
  settings: SettingsDraft;
}

/** 空库/未配置时的安全设置默认值；API Key 仅存在于表单内存，不进入工作空间缓存。 */
export const DefaultSettings: SettingsDraft = {
  nickname: '',
  provider: 'DeepSeek',
  baseUrl: 'https://api.deepseek.com',
  model: 'deepseek-v4-flash',
  contextLength: '256K',
  contextLimitMode: 'default',
  thinkingEnabled: false,
  developerMode: false,
  traceRetention: 50,
  compressionThreshold: 80,
  apiKey: '',
  onboardingCompleted: false,
  customContext: '',
  browserEngine: 'edge',
  // 常规设置的默认值与原型 GENERAL_DEFAULTS 一致：托盘驻留与完成通知默认开启。
  language: 'zh',
  startPage: 'last',
  // 个性化默认值与原型 pstate 一致：首字头像默认底色、默认字号、松绿主题、经典模板。
  avatarStyle: 'default',
  chatFontSize: 'md',
  accentColor: 'pine',
  resumeTemplate: 'classic',
  // 浏览器控制-行为默认值与原型 bstate.closeTabs 一致：任务结束自动关闭 Avery 自己的标签页。
  closeTaskTabs: true,
  notifyOnComplete: true,
  notifySound: true,
  autoUpdate: true,
  autoLaunch: false,
  closeToTray: true,
};

/** 生成带业务前缀的本地实体 ID；仅用于乐观创建后由后端确认，不用于跨进程安全边界。 */
export function CreateEntityId(prefix: string) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
