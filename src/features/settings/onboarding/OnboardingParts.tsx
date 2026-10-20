import { useEffect, useState } from 'react';
import { useUiStore } from '../../../app/UiStore';
import { Button, FormField, Select } from '../../../shared/components/UI';
import { Icon } from '../../../shared/components/Icon';
import { BrandAssets } from '../../../shared/brand';
import { Unwrap } from '../../../shared/platform/platformClient';
import type { OnboardingDraft } from '../../../types/domain';
import { ProviderDefaults, Providers } from './onboardingModel';
import type { TutorialImage } from './tutorialContent';

export function PreferenceFields({ draft, onChange }: { draft: OnboardingDraft; onChange: (patch: Partial<OnboardingDraft>) => void }) {
  const [rolesText, setRolesText] = useState(() => draft.roles?.join('、') ?? '');
  return <><p>这些信息会保存为求职意向，之后可以在档案中调整。</p><div className="tour-preferences">
    <PreferenceSelect label="机会类型" value={draft.jobType} options={['社招', '校招', '实习']} onChange={(jobType) => onChange({ jobType })} />
    <PreferenceSelect label="工作阶段" value={draft.experience} options={['在校学生', '刚毕业', '工作 1-3 年', '工作 3-5 年', '工作 5 年以上']} onChange={(experience) => onChange({ experience })} />
    <PreferenceSelect label="最高学历" value={draft.education} options={['高中及以下', '大专', '本科', '硕士', '博士']} onChange={(education) => onChange({ education })} />
    <FormField label="期望行业"><input maxLength={80} value={draft.industry ?? ''} placeholder="例如：教育、医疗" onChange={(event) => onChange({ industry: event.target.value })} /></FormField>
    <FormField label="目标岗位（最多 3 项）"><input maxLength={180} value={rolesText} placeholder="用逗号或顿号分隔" onChange={(event) => { setRolesText(event.target.value); onChange({ roles: [...new Set(event.target.value.split(/[,，、]/).map((value) => value.trim()).filter(Boolean))] }); }} /></FormField>
    <FormField label="求职城市"><input maxLength={80} value={draft.city ?? ''} placeholder="可留空" onChange={(event) => onChange({ city: event.target.value })} /></FormField>
  </div></>;
}

function PreferenceSelect({ label, value, options, onChange }: { label: string; value?: string; options: string[]; onChange: (value: string) => void }) {
  return <div className="tour-select-field"><span>{label}</span><Select ariaLabel={label} value={value ?? ''} options={[{ label: '暂不填写', value: '' }, ...options.map((option) => ({ label: option, value: option }))]} onChange={onChange} /></div>;
}

type ModelProps = {
  draft: OnboardingDraft; apiKey: string; onKeyChange: (value: string) => void;
  onChange: (patch: Partial<OnboardingDraft>) => void;
  busy: boolean; loading: boolean; formSaved: boolean; testing: boolean;
  statusError: string | null; formError: string | null;
  onRetryStatus: () => void; onTest: () => void;
  onPreview: (image: TutorialImage) => void;
};

export function ModelSetupForm({ draft, apiKey, onKeyChange, onChange, busy, loading, formSaved, testing, statusError, formError, onRetryStatus, onTest, onPreview }: ModelProps) {
  const { ShowNotice } = useUiStore();
  const provider = draft.provider ?? 'DeepSeek';
  async function OpenDeepSeek() {
    try {
      if (!window.averyWindow?.OpenDeepSeekApiKeys) throw new Error('请在系统浏览器打开 https://platform.deepseek.com/api_keys');
      await Unwrap(window.averyWindow.OpenDeepSeekApiKeys());
    } catch (error) { ShowNotice(error instanceof Error ? error.message : '打开链接失败，请重试。', 'error'); }
  }
  return <div className="tour-model-grid"><form id="tour-model-form" className="tour-form" onSubmit={(event) => { event.preventDefault(); onTest(); }}><fieldset disabled={busy || loading}>
    <legend className="tour-field-title">模型服务</legend><div className="tour-provider-options">{Providers.map((item) => <button type="button" key={item} aria-pressed={provider === item} className={provider === item ? 'is-selected' : ''} onClick={() => { if (provider === item) return; onKeyChange(''); onChange({ provider: item, ...ProviderDefaults[item] }); }}>{item === 'Z.AI' ? 'GLM' : item === 'MIMO' ? 'MiMo' : item}</button>)}</div>
    <div className="tour-provider-link">还没有 API Key？推荐 <a href="https://platform.deepseek.com/api_keys" onClick={(event) => { event.preventDefault(); void OpenDeepSeek(); }}>DeepSeek · 获取 API Key <span aria-hidden="true">↗</span></a><small>在 DeepSeek 平台创建 Key 后，回到 Avery 粘贴并测试连接。</small></div>
    <FormField label="API Key" hint={formSaved ? '密钥已加密保存在本机，无需再次填写。' : '填写所选模型服务商提供的 Key，不是登录密码。'}><input type="password" autoComplete="off" spellCheck={false} value={apiKey} placeholder={formSaved ? '已保存，留空保留当前配置' : '粘贴你的 API Key'} aria-invalid={Boolean(formError)} aria-describedby={formError ? 'tour-form-error' : undefined} onChange={(event) => onKeyChange(event.target.value)} /></FormField>
    {provider === '自定义' ? <><FormField label="Base URL"><input maxLength={500} value={draft.baseUrl ?? ''} placeholder="https://api.example.com/v1" onChange={(event) => onChange({ baseUrl: event.target.value })} /></FormField><FormField label="模型名称"><input value={draft.model ?? ''} maxLength={160} placeholder="填写服务商提供的模型名称" onChange={(event) => onChange({ model: event.target.value })} /></FormField></> : <p className="tour-model-name">当前模型 <strong>{draft.model}</strong>{provider === 'Z.AI' && ' · 始终启用思考模式'}</p>}
    <details className="tour-details"><summary>上下文设置（可选）</summary><label className="tour-checkbox"><input type="checkbox" checked={draft.contextLimitMode === 'custom'} onChange={(event) => onChange({ contextLimitMode: event.target.checked ? 'custom' : 'default' })} />自定义上下文限制</label><p>默认使用 256K；模型上限更小时自动使用模型上限。</p>{draft.contextLimitMode === 'custom' && <FormField label="上下文限制"><input maxLength={30} value={draft.contextLength ?? ''} placeholder="例如 128K" onChange={(event) => onChange({ contextLength: event.target.value })} /></FormField>}</details>
  </fieldset></form><aside className="tour-connection-guide"><h2>连接只需三步</h2><ol><li>选择你已开通的模型服务。</li><li>粘贴 Key；自定义服务还需填写地址和模型名称。</li><li>测试连接并保存，成功后继续。</li></ol><div className="tour-connection-state" role="status"><Icon name={loading || testing ? 'loading' : formSaved ? 'check-circle' : 'info'} size={19} /><span>{loading ? '正在读取模型配置…' : testing ? '正在测试并保存配置…' : formSaved ? '配置已保存在本机，可以继续。' : '填写后测试连接。修改配置需要重新测试。'}</span></div>{statusError && <div className="tour-status-error" role="alert"><p>{statusError}</p><Button variant="quiet" disabled={busy || loading} onClick={onRetryStatus}>重新读取</Button></div>}<p className="tour-privacy"><Icon name="shield-check" size={16} />密钥加密保存在本机。使用模型时，本次任务所需的内容会发送给你选择的服务商。</p><p className="tour-later-note">尚未准备好？可以先了解界面，之后在「设置 → 模型配置」中连接。</p><Button variant="quiet" disabled={busy} onClick={() => onPreview({ file: '02-model', alt: '设置中的模型配置界面，可在完成引导后继续调整服务商与模型' })}><Icon name="panel-expand" size={14} />查看设置位置示意</Button></aside></div>;
}

export function TutorialVisual({ images, onPreview }: { images: TutorialImage[]; onPreview: (image: TutorialImage) => void }) {
  const [selected, setSelected] = useState(0);
  const current = images[selected];
  return <figure className="tour-visual"><div className="tour-visual-top"><span><i />示例界面</span><button type="button" onClick={() => onPreview(current)}><Icon name="panel-expand" size={14} />查看大图</button></div><button type="button" className="tour-image-stage" onClick={() => onPreview(current)} aria-label={`查看大图：${current.alt}`}><img src={`./assets/onboarding/${current.file}.webp`} alt={current.alt} /></button>{images.length > 1 && <div className="tour-image-tabs" aria-label="切换示例图片">{images.map((image, index) => <button key={image.file} type="button" aria-pressed={selected === index} onClick={() => setSelected(index)}>{index === 0 ? '操作界面' : '相关界面'}</button>)}</div>}<figcaption>{current.alt}</figcaption></figure>;
}

export function TourWindowBar() {
  const [maximized, setMaximized] = useState(false);
  useEffect(() => {
    const controls = window.averyWindow;
    if (!controls) return;
    let active = true;
    let changed = false;
    const unsubscribe = controls.OnMaximizedChange((value) => { changed = true; setMaximized(value); });
    void controls.IsMaximized().then((value) => { if (active && !changed) setMaximized(value); }).catch(() => undefined);
    return () => { active = false; unsubscribe(); };
  }, []);
  return <header className="tour-windowbar"><div className="tour-brand"><img src={BrandAssets.icon} alt="" /><img className="tour-wordmark" src={BrandAssets.wordmark} alt="Avery" /><span>使用引导</span></div><div className="win-ctl"><button className="win-btn" type="button" aria-label="最小化" onClick={() => void window.averyWindow?.Minimize()}><Icon name="window-minimize" size={15} /></button><button className="win-btn" type="button" aria-label={maximized ? '向下还原' : '最大化'} onClick={() => void window.averyWindow?.ToggleMaximize()}><Icon name={maximized ? 'window-restore' : 'window-maximize'} size={15} /></button><button className="win-btn close" type="button" aria-label="关闭" onClick={() => void window.averyWindow?.Close()}><Icon name="close" size={15} /></button></div></header>;
}
