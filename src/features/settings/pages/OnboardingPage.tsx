import { useEffect, useState } from 'react';
import { useUiStore } from '../../../app/UiStore';
import { useSettingsStore } from '../../../features/settings/api/settingsQueries';
import { useProfiles, useSaveProfiles } from '../../../features/profile/api/profileQueries';
import { ConfigureAgent, IsDesktopAgentAvailable, TestAgentConnection } from '../../../features/assistant/api/agentQueries';
import { Button, FormField } from '../../../shared/components/UI';
import type { ProfileItem } from '../../../types/domain';

const Steps = ['欢迎', '昵称', 'API 配置', '求职类型', '工作经验', '学历', '期望方向', '求职城市', '完成'];
function UpgradeDeepSeekModel(model: string | undefined) {
  return model === 'deepseek-chat' || model === 'deepseek-reasoner' || !model ? 'deepseek-v4-flash' : model;
}

/** 首次启动的一页分步向导，完成后把非敏感偏好写入工作空间。 */
function OnboardingPage({ onComplete }: { onComplete: () => void }) {
  const { ShowNotice } = useUiStore();
  const { settings, setSettings, saveSettingsNow } = useSettingsStore();
  const profiles = useProfiles();
  const saveProfiles = useSaveProfiles({ onFailure: () => ShowNotice('求职偏好保存失败，请稍后重试。') });
  const draft = settings.onboardingDraft;
  const [step, setStep] = useState(draft?.step ?? 0);
  const [nickname, setNickname] = useState(draft?.nickname ?? settings.nickname ?? '');
  const [provider, setProvider] = useState<'DeepSeek' | '自定义'>(draft?.provider ?? settings.provider ?? 'DeepSeek');
  const [apiKey, setApiKey] = useState('');
  const [baseUrl, setBaseUrl] = useState(draft?.baseUrl ?? settings.baseUrl ?? 'https://api.deepseek.com/v1');
  const [model, setModel] = useState(UpgradeDeepSeekModel(draft?.model ?? settings.model));
  const [contextLength, setContextLength] = useState(draft?.contextLength ?? settings.contextLength ?? '256K');
  const [contextLimitMode, setContextLimitMode] = useState<'default' | 'custom'>(draft?.contextLimitMode ?? settings.contextLimitMode ?? (provider === '自定义' ? 'custom' : 'default'));
  const [jobType, setJobType] = useState(draft?.jobType ?? '校招');
  const [experience, setExperience] = useState(draft?.experience ?? '在校学生');
  const [education, setEducation] = useState(draft?.education ?? '本科');
  const [industry, setIndustry] = useState(draft?.industry ?? '互联网');
  const [roles, setRoles] = useState<string[]>(draft?.roles ?? ['前端开发工程师']);
  const [city, setCity] = useState(draft?.city ?? '');
  const [testing, setTesting] = useState(false);
  const [connectionPassed, setConnectionPassed] = useState(Boolean(draft?.apiConfigurationSaved));
  const [apiConfigurationSaved, setApiConfigurationSaved] = useState(Boolean(draft?.apiConfigurationSaved));
  const [formError, setFormError] = useState<string | null>(null);
  const isLast = step === Steps.length - 1;

  /** 表单字段与步骤变化时暂存非敏感快照，供中断后从最近步骤恢复；快照绝不含 API Key。 */
  useEffect(() => {
    setSettings((current) => ({ ...current, onboardingDraft: { step, nickname, provider, baseUrl, model, contextLength, contextLimitMode, jobType, experience, education, industry, roles, city, apiConfigurationSaved } }));
  }, [step, nickname, provider, baseUrl, model, contextLength, contextLimitMode, jobType, experience, education, industry, roles, city, apiConfigurationSaved]);

  function ToggleRole(role: string) { setRoles((current) => current.includes(role) ? current.filter((item) => item !== role) : current.length < 3 ? [...current, role] : current); }
  function ValidateCurrentStep() {
    if (step === 1 && !nickname.trim()) { setFormError('请填写账户昵称'); return false; }
    if (step === 2) {
      if (!apiKey.trim()) { setFormError('请填写 API Key'); return false; }
      if (provider === '自定义' && (!baseUrl.trim() || !model.trim())) { setFormError('请完整填写自定义服务配置'); return false; }
      if (contextLimitMode === 'custom' && !contextLength.trim()) { setFormError('请填写自定义上下文限制'); return false; }
    }
    if (step === 5 && !education) { setFormError('请选择学历'); return false; }
    if (step === 6 && (!industry.trim() || roles.length === 0)) { setFormError('请填写期望行业并选择至少一个目标岗位'); return false; }
    setFormError(null);
    return true;
  }
  async function TestConnection() {
    if (!ValidateCurrentStep()) return;
    if (!IsDesktopAgentAvailable()) { ShowNotice('请在桌面客户端中测试 API 连接'); return; }
    setTesting(true);
    try {
      await TestAgentConnection({ provider, apiKey, baseUrl, model, thinkingEnabled: settings.thinkingEnabled, contextLength, contextLimitMode, compressionThreshold: settings.compressionThreshold });
      await ConfigureAgent({ provider, apiKey, baseUrl, model, thinkingEnabled: settings.thinkingEnabled, contextLength, contextLimitMode, compressionThreshold: settings.compressionThreshold });
      setConnectionPassed(true);
      setApiConfigurationSaved(true);
      setFormError(null);
      ShowNotice('API 连接测试成功，配置已加密保存到桌面端');
    }
    catch (error) { const message = error instanceof Error ? error.message : 'API 连接测试失败'; setFormError(message); }
    finally { setTesting(false); }
  }
  async function Complete() {
    if (!ValidateCurrentStep()) return;
    if (!connectionPassed || !apiConfigurationSaved) { ShowNotice('请先返回 API 配置步骤并完成连接测试'); return; }
    try {
      const preferenceContent = `求职类型：${jobType}\n工作经验：${experience}\n最高学历：${education}\n期望行业：${industry}\n目标岗位：${roles.join('、')}\n求职城市：${city || '不限'}`;
      const preference: ProfileItem = { id: 'profile-job-preference', category: 'other', title: '求职偏好', content: preferenceContent, updatedAt: Date.now() };
      const next = profiles.some((item) => item.id === preference.id) ? profiles.map((item) => (item.id === preference.id ? preference : item)) : [preference, ...profiles];
      await saveProfiles.mutateAsync({ items: next });
      const completedSettings = { ...settings, nickname: nickname.trim(), provider, apiKey: '', baseUrl, model, contextLength, contextLimitMode, onboardingDraft: undefined, onboardingCompleted: true };
      await saveSettingsNow(completedSettings);
      setSettings(() => completedSettings);
      ShowNotice('设置已完成，API 配置已加密保存到桌面端');
      onComplete();
    } catch (error) { ShowNotice(error instanceof Error ? error.message : 'API 配置保存失败'); }
  }
  const title = ['欢迎来到 Avery', '怎么称呼你？', '连接你的模型服务', '这次主要寻找什么机会？', '你的工作经验处于哪个阶段？', '目前的最高学历是？', '想去哪里，做什么？', '你的求职城市是？', '准备就绪'][step];
  const description = ['让每一次经历，都成为投向理想岗位的一封好信。', '这个昵称只会显示在本地应用中。', '默认使用 DeepSeek；也可以填入自定义 OpenAI 兼容服务。', '它将帮助我们在后续界面中呈现更贴近你的内容。', '工作经验会影响简历建议的侧重点。', '用于整理教育背景信息。', '目标岗位最多选择三个，后续可在档案中补充。', '这一步可跳过，后续仍可补充。', '你可以从求职助手开始，继续补齐档案与简历。'][step];
  return <div className="onboarding-shell"><div className="onboarding-brand"><div className="brand-mark"><img src="./assets/avery-guiding-elf-icon-v2.png" alt="" /></div><b>Avery</b></div><div className="onboarding-card"><div className="onboarding-top"><span>首次设置</span><span>第 {step + 1} / {Steps.length} 步</span></div><div className="onboarding-progress"><span style={{ width: `${((step + 1) / Steps.length) * 100}%` }} /></div><div className="onboarding-content"><p className="eyebrow">{Steps[step]}</p><h1>{title}</h1><p>{description}</p>
    {step === 0 && <div className="welcome-letter"><span>To</span><strong>{nickname || '你'}</strong><small>从整理一段真实经历开始。</small></div>}
    {step === 1 && <FormField label="账户昵称"><input value={nickname} onChange={(event) => { setNickname(event.target.value); setFormError(null); }} placeholder="输入昵称" aria-invalid={Boolean(formError)} aria-describedby={formError ? 'onboarding-form-error' : undefined} />{formError && <small id="onboarding-form-error" className="field-error" role="alert">{formError}</small>}</FormField>}
    {step === 2 && <div className="onboarding-form"><div className="segmented"><button className={provider === 'DeepSeek' ? 'selected' : ''} aria-pressed={provider === 'DeepSeek'} onClick={() => { setProvider('DeepSeek'); setModel('deepseek-v4-flash'); setConnectionPassed(false); setApiConfigurationSaved(false); setFormError(null); }}>DeepSeek</button><button className={provider === '自定义' ? 'selected' : ''} aria-pressed={provider === '自定义'} onClick={() => { setProvider('自定义'); setConnectionPassed(false); setApiConfigurationSaved(false); setFormError(null); }}>自定义</button></div><FormField label="API Key"><input type="password" value={apiKey} onChange={(event) => { setApiKey(event.target.value); setConnectionPassed(false); setApiConfigurationSaved(false); setFormError(null); }} autoComplete="off" aria-invalid={Boolean(formError)} aria-describedby={formError ? 'onboarding-form-error' : undefined} />{formError && <small id="onboarding-form-error" className="field-error" role="alert">{formError}</small>}</FormField>{provider === '自定义' && <><FormField label="Base URL"><input value={baseUrl} onChange={(event) => { setBaseUrl(event.target.value); setConnectionPassed(false); setApiConfigurationSaved(false); setFormError(null); }} placeholder="https://api.example.com/v1" /></FormField><FormField label="模型名称"><input value={model} onChange={(event) => { setModel(event.target.value); setConnectionPassed(false); setApiConfigurationSaved(false); setFormError(null); }} /></FormField></>}<label className="switch-line"><span><b>自定义上下文限制</b><small>关闭时默认使用 256K；模型上限更小时自动使用模型上限。</small></span><input type="checkbox" checked={contextLimitMode === 'custom'} onChange={(event) => { setContextLimitMode(event.target.checked ? 'custom' : 'default'); setConnectionPassed(false); setApiConfigurationSaved(false); setFormError(null); }} /></label>{contextLimitMode === 'custom' && <FormField label="上下文限制"><input value={contextLength} onChange={(event) => { setContextLength(event.target.value); setConnectionPassed(false); setApiConfigurationSaved(false); setFormError(null); }} placeholder="例如 128K" /></FormField>}<div className="api-test-row"><span>{connectionPassed ? '● 已通过连接测试并加密保存' : '需要通过测试后才能进入应用'}</span><Button disabled={testing} onClick={() => void TestConnection()}>{testing ? '测试中…' : '测试连接'}</Button></div></div>}
    {step === 3 && <OptionGrid value={jobType} onChange={setJobType} options={['社招', '校招', '实习']} />}
    {step === 4 && <OptionGrid value={experience} onChange={setExperience} options={['在校学生', '刚毕业', '工作 1-3 年', '工作 3-5 年', '工作 5 年以上']} />}
    {step === 5 && <OptionGrid value={education} onChange={setEducation} options={['高中及以下', '大专', '本科', '硕士', '博士']} />}
    {step === 6 && <div className="onboarding-form"><FormField label="期望行业"><input value={industry} onChange={(event) => setIndustry(event.target.value)} /></FormField><span className="field-label">目标岗位（最多三项）</span><div className="chip-options">{['前端开发工程师', '数据可视化工程师', '数据产品经理', '产品实习生'].map((role) => <button key={role} className={roles.includes(role) ? 'selected' : ''} aria-pressed={roles.includes(role)} onClick={() => ToggleRole(role)}>{roles.includes(role) ? '✓ ' : ''}{role}</button>)}</div></div>}
    {step === 7 && <div className="onboarding-form"><FormField label="求职城市（可选）"><input value={city} onChange={(event) => setCity(event.target.value)} /></FormField><div className="chip-options">{['北京', '上海', '杭州', '全国 / 不限'].map((item) => <button key={item} type="button" onClick={() => setCity(item === '全国 / 不限' ? '' : item)}>{item}</button>)}</div></div>}
    {step === 8 && <div className="setup-summary"><div><span>昵称</span><b>{nickname}</b></div><div><span>求职方向</span><b>{industry} · {roles.join('、')}</b></div><div><span>基础信息</span><b>{jobType} · {experience} · {education} · {city || '不限'}</b></div><div><span>模型服务</span><b>{provider} · 配置将加密保存在本机</b></div></div>}
  </div><div className="onboarding-actions"><Button variant="quiet" disabled={step === 0} onClick={() => setStep((current) => current - 1)}>上一步</Button>{isLast ? <Button variant="primary" onClick={() => void Complete()}>进入 Avery</Button> : <Button variant="primary" onClick={() => { if (ValidateCurrentStep()) setStep((current) => current + 1); }}>{step === 7 ? '跳过或下一步' : '下一步'}</Button>}</div></div></div>;
}

function OptionGrid({ value, onChange, options }: { value: string; onChange: (value: string) => void; options: string[] }) { return <div className="option-grid">{options.map((option) => <button type="button" key={option} className={value === option ? 'selected' : ''} aria-pressed={value === option} onClick={() => onChange(option)}>{value === option && <span>✓</span>}{option}</button>)}</div>; }

export { OnboardingPage };
