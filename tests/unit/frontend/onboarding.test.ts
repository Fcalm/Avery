import { describe, expect, it } from 'vitest';
import type { AgentConfiguration } from '@avery/contracts';
import { BuildOnboardingProfiles, MatchesSavedConfiguration, RestoreOnboarding, SettingsWithSavedModel, ValidateModelConfiguration } from '../../../src/features/settings/onboarding/onboardingModel';
import { CreateSettingsWriter } from '../../../src/features/settings/api/settingsPersistence';
import { DefaultSettings } from '../../../src/features/workspace/api/workspaceData';
import type { OnboardingDraft, ProfileItem } from '../../../src/types/domain';

const config: AgentConfiguration = { provider: '自定义', apiKey: 'test-key', baseUrl: 'http://127.0.0.1:8877/v1', model: 'test-model', contextLength: '256K', contextLimitMode: 'default', thinkingEnabled: false, compressionThreshold: 80 };

describe('引导进度迁移与凭据状态', () => {
  it('新用户不被预设行业、学历和岗位，也不创建空求职意向', () => {
    const draft = RestoreOnboarding(DefaultSettings);
    expect(draft).toMatchObject({ version: 2, step: 0, industry: '', roles: [], education: '', preferencesEdited: false });
    expect(BuildOnboardingProfiles([], draft)).toBeNull();
  });
  it('旧偏好步骤恢复到连接模型，不误认为已经学完教程', () => {
    const draft = RestoreOnboarding({ ...DefaultSettings, onboardingDraft: { step: 8, nickname: '小林', industry: '教育', roles: ['产品设计'], apiConfigurationSaved: true } });
    expect(draft).toMatchObject({ version: 2, step: 1, nickname: '小林', industry: '教育', roles: ['产品设计'] });
    expect(draft).not.toHaveProperty('apiConfigurationSaved');
  });
  it.each([-30, 90, Number.NaN])('异常步骤 %s 不会显示空白页', (step) => {
    const restored = RestoreOnboarding({ ...DefaultSettings, onboardingDraft: { version: 2, step } });
    expect(restored.step).toBeGreaterThanOrEqual(0);
    expect(restored.step).toBeLessThanOrEqual(8);
  });
  it('新版教程能恢复到最近一步，旧昵称页不会错跳模型页', () => {
    expect(RestoreOnboarding({ ...DefaultSettings, onboardingDraft: { version: 2, step: 5 } }).step).toBe(5);
    expect(RestoreOnboarding({ ...DefaultSettings, onboardingDraft: { step: 1 } }).step).toBe(0);
  });
  it('旧 DeepSeek 模型别名与教程草稿一起升级，不会在测试成功后因名称不同卡住', () => {
    const draft = RestoreOnboarding({ ...DefaultSettings, onboardingDraft: { step: 2, provider: 'DeepSeek', model: 'deepseek-chat' } });
    expect(draft.model).toBe('deepseek-v4-flash');
  });
  it('凭据已经落盘但设置保存失败后，完成时恢复实际模型而非保存未测试的输入', () => {
    const status = { configured: true, provider: '自定义', model: 'saved-model', baseUrl: 'http://127.0.0.1:8877/v1', contextLimit: 128000, contextLimitMode: 'custom' as const };
    const settings = SettingsWithSavedModel(DefaultSettings, status);
    expect(settings).toMatchObject({ provider: '自定义', model: 'saved-model', baseUrl: status.baseUrl, contextLength: '128000', contextLimitMode: 'custom' });
    expect(settings.apiKey).toBe('');
    expect(SettingsWithSavedModel(DefaultSettings, { ...status, configured: false })).toBe(DefaultSettings);
  });
  it('只有桌面端真实存在且匹配的配置才可以空密钥继续', () => {
    const draft: OnboardingDraft = { step: 1, ...config };
    const status = { configured: true, provider: '自定义', model: 'test-model', baseUrl: config.baseUrl };
    expect(MatchesSavedConfiguration(draft, status)).toBe(true);
    expect(MatchesSavedConfiguration(draft, { ...status, configured: false })).toBe(false);
    expect(MatchesSavedConfiguration({ ...draft, model: 'another-model' }, status)).toBe(false);
    expect(MatchesSavedConfiguration({ ...draft, baseUrl: 'https://another.example/v1' }, status)).toBe(false);
    expect(MatchesSavedConfiguration({ ...draft, contextLimitMode: 'custom', contextLength: '128K' }, { ...status, contextLimitMode: 'custom', contextLimit: 128000 })).toBe(true);
    expect(MatchesSavedConfiguration({ ...draft, contextLimitMode: 'custom', contextLength: '256K' }, { ...status, contextLimitMode: 'custom', contextLimit: 128000 })).toBe(false);
  });
});

describe('求职偏好保存的数据保护', () => {
  const draft: OnboardingDraft = { step: 8, preferencesEdited: true, industry: ' 教育 ', roles: ['产品设计'], city: '' };
  it('仅创建已填写字段，保留全部其他档案', () => {
    const existing: ProfileItem = { id: 'education-1', category: 'education', title: '教育经历', content: '原有内容', updatedAt: 1 };
    const next = BuildOnboardingProfiles([existing], draft, 123)!;
    expect(next).toHaveLength(2);
    expect(next[1]).toBe(existing);
    expect(next[0].content).toBe('期望行业：教育\n目标岗位：产品设计');
    expect(next[0].updatedAt).toBe(123);
  });
  it('已有任何求职意向时都不覆盖，包括失败后的再次完成', () => {
    const created = BuildOnboardingProfiles([], draft)!;
    expect(BuildOnboardingProfiles(created, { ...draft, industry: '互联网' })).toBeNull();
    expect(BuildOnboardingProfiles([{ ...created[0], id: 'user-intention' }], draft)).toBeNull();
  });
  it('未编辑的旧偏好和全部清空的偏好不会写成一份默认档案', () => {
    expect(BuildOnboardingProfiles([], { ...draft, preferencesEdited: false })).toBeNull();
    expect(BuildOnboardingProfiles([], { step: 8, preferencesEdited: true, industry: ' ', roles: [], city: '' })).toBeNull();
  });
});

describe('连接模型输入校验', () => {
  it('支持本地 OpenAI 兼容服务并拒绝缺失密钥或模型', () => {
    expect(ValidateModelConfiguration(config)).toBeNull();
    expect(ValidateModelConfiguration({ ...config, apiKey: ' ' })).toContain('API Key');
    expect(ValidateModelConfiguration({ ...config, model: '' })).toContain('模型名称');
  });
  it.each(['javascript:alert(1)', 'file:///secret', 'https://user:password@example.com', 'https://example.com?api_key=secret', 'example.com', 'https://example.com#secret'])('拒绝不安全或不完整地址 %s', (baseUrl) => {
    expect(ValidateModelConfiguration({ ...config, baseUrl })).not.toBeNull();
  });
  it.each(['0K', '1.5M', '10K', '1000001', 'not-a-number'])('上下文限制 %s 在请求前就反馈错误', (contextLength) => {
    expect(ValidateModelConfiguration({ ...config, contextLimitMode: 'custom', contextLength })).toContain('上下文限制');
  });
  it.each(['128K', '256000', '1M'])('接受合法的上下文限制 %s', (contextLength) => {
    expect(ValidateModelConfiguration({ ...config, contextLimitMode: 'custom', contextLength })).toBeNull();
  });
});

describe('设置落盘顺序', () => {
  it('完成等待正在落盘的草稿，最终磁盘不会被较早草稿覆盖', async () => {
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    const writes: string[] = [];
    const save = CreateSettingsWriter(async (state: string) => { if (state === 'draft') await barrier; writes.push(state); });
    const draft = save('draft');
    const completion = save('completed');
    await Promise.resolve();
    expect(writes).toEqual([]);
    release();
    await Promise.all([draft, completion]);
    expect(writes).toEqual(['draft', 'completed']);
  });
  it('业务失败传播给调用方，下一次保存仍可重试', async () => {
    let attempts = 0;
    const save = CreateSettingsWriter(async () => { if (++attempts === 1) throw new Error('disk unavailable'); });
    await expect(save('completed')).rejects.toThrow('disk unavailable');
    await expect(save('completed')).resolves.toBeUndefined();
    expect(attempts).toBe(2);
  });
});
