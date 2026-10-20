import type { AgentConfiguration, DesktopAgentBridge } from '@avery/contracts';
import type { OnboardingDraft, ProfileItem, SettingsDraft } from '../../../types/domain';

export const OnboardingSteps = ['欢迎与偏好', '连接模型', '建立档案', '向 Avery 提问', '管理简历', '保存与采集岗位', '浏览器协作', '跟进投递', '开始使用'] as const;
export type OnboardingDestination = 'profiles' | 'assistant' | 'settings';
export type Provider = AgentConfiguration['provider'];
export const Providers: Provider[] = ['DeepSeek', 'Z.AI', 'MIMO', '自定义'];
export const ProviderDefaults: Record<Provider, { baseUrl: string; model: string }> = {
  DeepSeek: { baseUrl: 'https://api.deepseek.com', model: 'deepseek-v4-flash' },
  'Z.AI': { baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-5.3-flash' },
  MIMO: { baseUrl: 'https://api.xiaomimimo.com/v1', model: 'mimo-v2.6-flash' },
  自定义: { baseUrl: '', model: '' },
};

/** 旧向导的步骤含义不同，只迁移已有表单；不把旧偏好步骤当作已读教程。 */
export function RestoreOnboarding(settings: SettingsDraft): OnboardingDraft {
  const draft = settings.onboardingDraft;
  const provider = draft?.provider ?? settings.provider;
  const storedModel = draft?.model ?? settings.model;
  const model = provider === 'Z.AI' || (provider === 'DeepSeek' && ['deepseek-chat', 'deepseek-reasoner'].includes(storedModel))
    ? ProviderDefaults[provider].model : storedModel || ProviderDefaults[provider].model;
  const step = draft?.version === 2 && Number.isInteger(draft.step) ? Math.min(8, Math.max(0, draft.step)) : draft && draft.step >= 2 && (draft.nickname ?? settings.nickname)?.trim() ? 1 : 0;
  return {
    version: 2, step, nickname: draft?.nickname ?? settings.nickname,
    provider, baseUrl: draft?.baseUrl ?? settings.baseUrl ?? ProviderDefaults[provider].baseUrl,
    model,
    contextLength: draft?.contextLength ?? settings.contextLength,
    contextLimitMode: draft?.contextLimitMode ?? settings.contextLimitMode ?? 'default',
    preferencesEdited: draft?.preferencesEdited ?? false,
    jobType: draft?.jobType ?? '', experience: draft?.experience ?? '', education: draft?.education ?? '',
    industry: draft?.industry ?? '', roles: draft?.roles ?? [], city: draft?.city ?? '',
  };
}

export function ValidateModelConfiguration(config: AgentConfiguration): string | null {
  if (!config.apiKey.trim()) return '请填写 API Key。';
  try {
    const url = new URL(config.baseUrl);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) return '请填写不含凭据、查询参数或片段的 HTTP(S) 服务地址。';
  } catch { return '请填写完整的服务地址，例如 https://api.example.com/v1。'; }
  if (!config.model.trim()) return '请填写模型名称。';
  if (config.contextLimitMode === 'custom') {
    const matched = config.contextLength.trim().match(/^([1-9]\d*)\s*([kKmM])?$/);
    const value = matched ? Number(matched[1]) * (matched[2]?.toUpperCase() === 'K' ? 1000 : matched[2]?.toUpperCase() === 'M' ? 1_000_000 : 1) : Number.NaN;
    if (!Number.isSafeInteger(value) || value < 128_000 || value > 1_000_000) return '上下文限制需为 128000–1000000，可填写 128K 或 1M。';
  }
  return null;
}

/** 草稿中的成功标记不作为凭据证据；必须与桌面端仍存在的配置相符。 */
export function MatchesSavedConfiguration(draft: OnboardingDraft, status: Awaited<ReturnType<DesktopAgentBridge['GetStatus']>>): boolean {
  if (!status.configured || draft.provider !== status.provider || draft.model !== status.model) return false;
  if (draft.baseUrl?.replace(/\/+$/, '') !== status.baseUrl?.replace(/\/+$/, '')) return false;
  if ((draft.contextLimitMode ?? 'default') !== (status.contextLimitMode ?? 'default')) return false;
  if (draft.contextLimitMode === 'custom') {
    const text = (draft.contextLength ?? '').trim().toUpperCase();
    const multiplier = text.endsWith('K') ? 1000 : text.endsWith('M') ? 1_000_000 : 1;
    return Number.parseFloat(text) * multiplier === status.contextLimit;
  }
  return true;
}

/** 加密凭据可能先于设置副本落盘；恢复完成时以运行时配置修正副本，绝不保存未测试的表单值。 */
export function SettingsWithSavedModel(settings: SettingsDraft, status: Awaited<ReturnType<DesktopAgentBridge['GetStatus']>> | null): SettingsDraft {
  if (!status?.configured || !Providers.includes(status.provider as Provider)) return settings;
  return {
    ...settings, provider: status.provider as Provider, model: status.model, baseUrl: status.baseUrl ?? settings.baseUrl,
    contextLimitMode: status.contextLimitMode ?? settings.contextLimitMode,
    contextLength: status.contextLimit ? String(status.contextLimit) : settings.contextLength,
    compressionThreshold: status.compressionThreshold ?? settings.compressionThreshold,
    thinkingEnabled: status.provider === 'Z.AI' || settings.thinkingEnabled,
  };
}

/** 引导只创建缺失的求职意向，不覆盖用户已经整理过的档案。 */
export function BuildOnboardingProfiles(profiles: ProfileItem[], draft: OnboardingDraft, now = Date.now()): ProfileItem[] | null {
  if (!draft.preferencesEdited || profiles.some((item) => item.category === 'job_intention' || item.id === 'profile-job-preference')) return null;
  const lines = [
    ['求职类型', draft.jobType], ['工作经验', draft.experience], ['最高学历', draft.education],
    ['期望行业', draft.industry?.trim()], ['目标岗位', draft.roles?.join('、')], ['求职城市', draft.city?.trim()],
  ].filter(([, value]) => Boolean(value));
  if (!lines.length) return null;
  return [{ id: 'profile-job-preference', category: 'job_intention', title: '求职意向', content: lines.map(([label, value]) => `${label}：${value}`).join('\n'), updatedAt: now }, ...profiles];
}
