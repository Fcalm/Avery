import { useEffect, useRef, useState } from 'react';
import type { AgentConfiguration, DesktopAgentBridge } from '@avery/contracts';
import { useUiStore } from '../../../app/UiStore';
import { useSettingsStore } from '../api/settingsQueries';
import { useProfiles, useSaveProfiles } from '../../profile/api/profileQueries';
import { ConfigureAgent, GetAgentStatus, IsDesktopAgentAvailable, TestAgentConnection } from '../../assistant/api/agentQueries';
import { Button, FormField, Modal } from '../../../shared/components/UI';
import { Icon, type IconName } from '../../../shared/components/Icon';
import { platformClient, Unwrap } from '../../../shared/platform/platformClient';
import type { OnboardingDraft } from '../../../types/domain';
import { BuildOnboardingProfiles, MatchesSavedConfiguration, OnboardingSteps, RestoreOnboarding, SettingsWithSavedModel, ValidateModelConfiguration, type OnboardingDestination } from '../onboarding/onboardingModel';
import { Tutorials, type TutorialImage } from '../onboarding/tutorialContent';
import { ModelSetupForm, PreferenceFields, TourWindowBar, TutorialVisual } from '../onboarding/OnboardingParts';
import '../../../styles/onboarding.css';

type SavedStatus = Awaited<ReturnType<DesktopAgentBridge['GetStatus']>>;
type Props = { review?: boolean; onComplete: (destination?: OnboardingDestination) => void; onClose?: () => void };
const StepIcons: IconName[] = ['sparkle', 'cpu', 'profiles', 'assistant', 'resumes', 'jobs', 'browser', 'applications', 'check-circle'];

/** 首次设置保存非敏感草稿；重看教程完全不修改设置、凭据与档案。 */
export function OnboardingPage({ review = false, onComplete, onClose }: Props) {
  const { ShowNotice } = useUiStore();
  const { settings, saveSettingsNow } = useSettingsStore();
  const profiles = useProfiles();
  const saveProfiles = useSaveProfiles();
  const [draft, setDraft] = useState<OnboardingDraft>(() => ({ ...RestoreOnboarding(settings), ...(review ? { step: 2 } : {}) }));
  const [apiKey, setApiKey] = useState('');
  const [savedStatus, setSavedStatus] = useState<SavedStatus | null>(null);
  const [statusLoading, setStatusLoading] = useState(true);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [statusVersion, setStatusVersion] = useState(0);
  const [operation, setOperation] = useState<'test' | 'save' | 'finish' | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [preview, setPreview] = useState<TutorialImage | null>(null);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const busyRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const previousStepRef = useRef(draft.step);
  const hasPreference = profiles.some((item) => item.category === 'job_intention' || item.id === 'profile-job-preference');
  const step = draft.step;
  const busy = operation !== null;
  const provider = draft.provider ?? 'DeepSeek';
  const formSaved = !apiKey && savedStatus !== null && MatchesSavedConfiguration(draft, savedStatus);
  const hasModel = savedStatus?.configured === true;
  const tutorial = step >= 2 && step <= 7 ? Tutorials[step - 2] : null;
  const serializedDraft = JSON.stringify(draft);

  useEffect(() => {
    mountedRef.current = true;
    headingRef.current?.focus();
    return () => { mountedRef.current = false; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    setStatusLoading(true);
    setStatusError(null);
    if (!IsDesktopAgentAvailable()) {
      setStatusLoading(false);
      setStatusError('请在 Avery 桌面客户端中连接模型。');
      return;
    }
    void GetAgentStatus().then((status) => {
      if (!cancelled) setSavedStatus(status);
    }).catch((error: unknown) => {
      if (!cancelled) setStatusError(error instanceof Error ? error.message : '无法读取模型配置，请重试。');
    }).finally(() => { if (!cancelled) setStatusLoading(false); });
    return () => { cancelled = true; };
  }, [statusVersion]);

  /** 白名单草稿不含密钥；串行保存保证较早的草稿不会覆盖完成状态。 */
  useEffect(() => {
    if (review || busyRef.current) return;
    timerRef.current = setTimeout(() => {
      const snapshot = JSON.parse(serializedDraft) as OnboardingDraft;
      void saveSettingsNow({ ...settingsRef.current, onboardingDraft: snapshot }).then(() => {
        if (mountedRef.current) setSaveError(null);
      }).catch((error: unknown) => {
        if (mountedRef.current) setSaveError(error instanceof Error ? error.message : '引导进度保存失败，请重试。');
      });
    }, 400);
    return () => { if (timerRef.current) clearTimeout(timerRef.current); };
  }, [review, serializedDraft, saveSettingsNow]);

  useEffect(() => {
    if (previousStepRef.current === step) return;
    previousStepRef.current = step;
    bodyRef.current?.scrollTo({ top: 0 });
    headingRef.current?.focus();
    setFormError(null);
  }, [step]);

  function UpdateDraft(patch: Partial<OnboardingDraft>) {
    setFormError(null);
    setDraft((current) => ({ ...current, ...patch }));
  }
  function BeginOperation(value: 'test' | 'save' | 'finish') {
    if (busyRef.current) return false;
    busyRef.current = true;
    if (timerRef.current) clearTimeout(timerRef.current);
    setOperation(value);
    setFormError(null);
    return true;
  }
  function EndOperation() { busyRef.current = false; if (mountedRef.current) setOperation(null); }

  async function MoveTo(next: number) {
    if (next < (review ? 2 : 0) || next > 8 || !BeginOperation('save')) return;
    try {
      const nextDraft = { ...draft, step: next };
      if (!review) await saveSettingsNow({ ...settingsRef.current, onboardingDraft: nextDraft });
      setSaveError(null);
      setDraft(nextDraft);
    } catch (error) { setSaveError(error instanceof Error ? error.message : '进度保存失败，请重试。'); }
    finally { EndOperation(); }
  }

  function ContinueWelcome() {
    if (!draft.nickname?.trim()) { setFormError('请先填写昵称。'); document.getElementById('tour-nickname')?.focus(); return; }
    if ((draft.roles?.length ?? 0) > 3) { setFormError('目标岗位最多填写 3 项，请用逗号或顿号分隔。'); return; }
    void MoveTo(1);
  }

  async function TestConnection() {
    if (busyRef.current) return;
    const config: AgentConfiguration = {
      provider, apiKey: apiKey.trim(), baseUrl: draft.baseUrl?.trim() ?? '', model: draft.model?.trim() ?? '',
      contextLength: draft.contextLength?.trim() || '256K', contextLimitMode: draft.contextLimitMode ?? 'default',
      thinkingEnabled: provider === 'Z.AI' || settingsRef.current.thinkingEnabled,
      compressionThreshold: settingsRef.current.compressionThreshold,
    };
    const error = ValidateModelConfiguration(config);
    if (error) { setFormError(error); return; }
    if (!IsDesktopAgentAvailable()) { setFormError('请在 Avery 桌面客户端中测试 API 连接。'); return; }
    if (!BeginOperation('test')) return;
    try {
      // 测试与保存使用同一份配置；表单禁用期间不能把旧请求的成功套到新输入上。
      await TestAgentConnection(config);
      await ConfigureAgent(config);
      const status = await GetAgentStatus();
      const nextDraft = { ...draft, baseUrl: config.baseUrl, model: config.model, contextLength: config.contextLength };
      if (!MatchesSavedConfiguration(nextDraft, status)) throw new Error('模型配置尚未生效，请重新测试。');
      await saveSettingsNow({ ...settingsRef.current, provider, baseUrl: config.baseUrl, model: config.model, contextLength: config.contextLength, contextLimitMode: config.contextLimitMode, thinkingEnabled: config.thinkingEnabled, onboardingDraft: nextDraft });
      setSavedStatus(status);
      setStatusError(null);
      setSaveError(null);
      setApiKey('');
      setDraft(nextDraft);
      ShowNotice('连接成功，配置已加密保存在本机。');
    } catch (error) { setFormError(error instanceof Error ? error.message : '连接未成功，请检查密钥、地址和网络后重试。'); }
    finally { EndOperation(); }
  }

  async function Complete(destination: OnboardingDestination) {
    if (review) { onComplete(destination); return; }
    if (!draft.nickname?.trim() || (draft.roles?.length ?? 0) > 3) {
      await MoveTo(0);
      setFormError('请填写昵称，并确保目标岗位不超过 3 项。');
      return;
    }
    if (!BeginOperation('finish')) return;
    try {
      // 完成前再次读取真实状态，不依据草稿宣称模型已经连接。
      const status = IsDesktopAgentAvailable() ? await GetAgentStatus() : null;
      setSavedStatus(status);
      const nextProfiles = BuildOnboardingProfiles(profiles, draft);
      if (nextProfiles) await saveProfiles.mutateAsync({ items: nextProfiles });
      await saveSettingsNow({ ...SettingsWithSavedModel(settingsRef.current, status), nickname: draft.nickname?.trim() ?? '', apiKey: '', onboardingDraft: undefined, onboardingCompleted: true });
      onComplete(destination === 'assistant' && !status?.configured ? 'profiles' : destination);
    } catch (error) {
      const message = error instanceof Error ? error.message : '首次设置保存失败，请重试。';
      setFormError(`${message} 你的设置尚未完成，可以重试。`);
    } finally { EndOperation(); }
  }

  async function CopyPrompt(prompt: string) {
    try { await Unwrap(platformClient.desktop.WriteClipboardText(prompt)); ShowNotice('示例指令已复制。'); }
    catch (error) { ShowNotice(error instanceof Error ? error.message : '复制失败，请重试。', 'error'); }
  }

  return <div className={`setup-tour${review ? ' is-review' : ''}`}>
    <TourWindowBar />
    <div className="tour-layout">
      <aside className="tour-sidebar" aria-label="引导步骤">
        <div className="tour-sidebar-intro"><span className="tour-overline">{review ? '使用教程' : '初次见面'}</span><h2>一步步，<br />把机会准备好。</h2><p>从真实经历出发，<br />让求职的每一步都有着落。</p></div>
        <ol>{OnboardingSteps.map((label, index) => <li key={label} className={index === step ? 'is-current' : index < step ? 'is-done' : ''}>
          <button type="button" aria-current={index === step ? 'step' : undefined} disabled={busy || (review && index < 2) || (step < 2 && index > step)} onClick={() => void MoveTo(index)}><span className="tour-step-number">{index < step ? <Icon name="check" size={12} /> : String(index + 1).padStart(2, '0')}</span><span>{label}</span></button>
        </li>)}</ol>
        <div className="tour-sidebar-foot"><Icon name="shield-check" size={16} /><span>按自己的节奏开始<br />教程随时可以再次查看</span></div>
      </aside>
      <main className="tour-main">
        <div className="tour-topline"><span>{step < 2 ? `基础设置 ${step + 1} / 2` : step < 8 ? `使用教程 ${step - 1} / 6` : '准备开始'}</span><span className="tour-top-actions">{review ? <Button variant="quiet" disabled={busy} onClick={onClose}>退出教程</Button> : step >= 2 && step <= 7 && <Button variant="quiet" disabled={busy} onClick={() => void MoveTo(8)}>跳过教程<Icon name="arrow-right" size={14} /></Button>}<span className="tour-page-count">{String(step + 1).padStart(2, '0')} / 09</span></span></div>
        <div className="tour-progress" role="progressbar" aria-label="引导进度" aria-valuemin={1} aria-valuemax={9} aria-valuenow={step + 1}><span style={{ width: `${(step + 1) / 9 * 100}%` }} /></div>
        <div className="tour-scroll" ref={bodyRef} inert={busy}>
          <div className="tour-heading"><span className="tour-section-label"><Icon name={StepIcons[step]} size={16} />{OnboardingSteps[step]}</span><h1 ref={headingRef} tabIndex={-1}>{step === 0 ? '从你的经历，走向下一份机会' : step === 1 ? '先让 Avery 连接你的模型' : step === 8 ? '从第一段经历开始' : tutorial?.title}</h1><p>{step === 0 ? '把经历整理成档案，让 Avery 帮你准备简历、整理岗位、协助填写申请，并跟进每一次投递。' : step === 1 ? '选择模型服务，填写自己的 API Key，再测试连接。连接模型后，Avery 才能理解你的目标并协助处理任务。' : step === 8 ? '不必一次填完所有资料。先存下一段真实经历，再和 Avery 一起准备下一次申请。' : tutorial?.description}</p></div>

          {step === 0 && <div className="tour-welcome-grid"><form id="tour-welcome-form" className="tour-form" onSubmit={(event) => { event.preventDefault(); ContinueWelcome(); }}>
            <FormField label="怎么称呼你？" hint="只用于应用内显示。"><input id="tour-nickname" autoComplete="nickname" maxLength={40} value={draft.nickname ?? ''} placeholder="输入昵称" aria-invalid={Boolean(formError)} aria-describedby={formError ? 'tour-form-error' : undefined} onChange={(event) => UpdateDraft({ nickname: event.target.value })} /></FormField>
            <details className="tour-details"><summary>补充求职偏好（可选）</summary>{hasPreference ? <p>你已保存求职意向。可以在「档案」中继续调整，已有内容会保留。</p> : <PreferenceFields draft={draft} onChange={(patch) => UpdateDraft({ ...patch, preferencesEdited: true })} />}</details>
          </form><div className="tour-welcome-note"><h2>先认识你的工作区</h2><ul><li>整理一次经历，为不同岗位准备材料。</li><li>说清求职目标，一起完善简历。</li><li>保存岗位与投递记录，把下一步留在眼前。</li></ul><button type="button" className="tour-navigation-preview" onClick={() => setPreview({ file: '01-navigation', alt: '左侧导航中的对话、岗位、简历、投递记录和档案' })}><img src="./assets/onboarding/01-navigation.webp" alt="应用的五个主要功能入口，点击查看大图" /></button><small>示例界面 · 从左侧进入各项功能</small></div></div>}

          {step === 1 && <ModelSetupForm draft={draft} apiKey={apiKey} onKeyChange={(value) => { setApiKey(value); setFormError(null); }} onChange={UpdateDraft} busy={busy} loading={statusLoading} formSaved={formSaved} testing={operation === 'test'} statusError={statusError} formError={formError} onRetryStatus={() => setStatusVersion((current) => current + 1)} onTest={() => formSaved ? void MoveTo(2) : void TestConnection()} onPreview={setPreview} />}

          {tutorial && <div className="tour-lesson-grid"><div className="tour-lesson-copy"><ol className="tour-instructions">{tutorial.steps.map((item, index) => <li key={item.title}><span>{index + 1}</span><div><h2>{item.title}</h2><p>{item.text}</p></div></li>)}</ol>{tutorial.prompt && <div className="tour-prompt"><div><span>试着这样说</span><Button variant="quiet" onClick={() => void CopyPrompt(tutorial.prompt!)}><Icon name="copy" size={14} />复制示例</Button></div><p>{tutorial.prompt}</p></div>}{tutorial.detail && <details className="tour-details"><summary>{tutorial.detail.title}</summary>{tutorial.detail.paragraphs.map((text) => <p key={text}>{text}</p>)}</details>}<p className="tour-tip"><Icon name="info" size={16} /><span>{tutorial.tip}</span></p></div><TutorialVisual key={step} images={tutorial.images} onPreview={setPreview} /></div>}

          {step === 8 && <div className="tour-finish-grid"><div><div className="tour-ready-icon"><Icon name="check" size={26} /></div><h2>{review ? '随时回来，再看一遍' : `${draft.nickname?.trim() || '你'}，可以开始了`}</h2><p>打开「档案」，点击「添加条目」，先记录一段教育、项目或实习经历。</p><div className="tour-finish-status"><Icon name={hasModel ? 'check-circle' : 'cpu'} size={18} /><div><strong>{statusLoading ? '正在确认模型状态…' : hasModel ? '模型配置已保存' : '模型尚未连接'}</strong><p>{hasModel ? `${savedStatus?.provider} · ${savedStatus?.model}` : '可以先整理档案、手动保存或采集岗位；使用 AI 功能前再连接模型。'}</p></div></div>{!review && <small>完成后，可在左下角账户菜单中重新查看使用教程。</small>}{statusError && <div role="alert"><p>{statusError}</p><Button disabled={busy || statusLoading} onClick={() => setStatusVersion((current) => current + 1)}>重新读取</Button></div>}</div><TutorialVisual images={[{ file: '03-profile-list', alt: '档案列表与右上角添加条目入口' }]} onPreview={setPreview} /></div>}
          {formError && <div className="tour-error" id="tour-form-error" role="alert"><Icon name="error" size={17} /><span>{formError}</span></div>}
          {saveError && <div className="tour-error" role="alert"><span>进度未保存：{saveError}</span><Button variant="quiet" disabled={busy} onClick={() => void MoveTo(step)}>重试保存</Button></div>}
        </div>
        <footer className="tour-footer"><Button variant="quiet" disabled={busy || step === (review ? 2 : 0)} onClick={() => void MoveTo(step - 1)}><Icon name="arrow-left" size={15} />上一步</Button><div className="tour-footer-right">
          {step === 0 && <Button type="submit" form="tour-welcome-form" variant="primary" disabled={busy}>开始设置<Icon name="arrow-right" size={15} /></Button>}
          {step === 1 && <><Button variant="quiet" disabled={busy} onClick={() => void MoveTo(2)}>稍后设置</Button><Button type="submit" form="tour-model-form" variant="primary" disabled={busy || statusLoading}>{operation === 'test' ? '正在测试并保存…' : formSaved ? '继续了解 Avery' : '测试连接并保存'}<Icon name="arrow-right" size={15} /></Button></>}
          {tutorial && <Button variant="primary" disabled={busy} onClick={() => void MoveTo(step + 1)}>{step === 7 ? '准备开始' : `下一步：${OnboardingSteps[step + 1]}`}<Icon name="arrow-right" size={15} /></Button>}
          {step === 8 && (review ? <><Button variant="quiet" onClick={onClose}>回到工作区</Button><Button variant="primary" onClick={() => onComplete('profiles')}>去添加第一条档案<Icon name="arrow-right" size={15} /></Button></> : <><Button variant="quiet" disabled={busy || statusLoading} onClick={() => void Complete(hasModel ? 'assistant' : 'profiles')}>{hasModel ? '进入工作区' : '先整理档案'}</Button><Button variant="primary" disabled={busy || statusLoading} onClick={() => hasModel ? void Complete('profiles') : void MoveTo(1)}>{operation === 'finish' ? '正在保存…' : hasModel ? '去添加第一条档案' : '返回连接模型'}<Icon name="arrow-right" size={15} /></Button></>)}
        </div></footer>
      </main>
    </div>
    <Modal open={preview !== null} title="查看示例界面" variant="dialog" onClose={() => setPreview(null)}>{preview && <img className="tour-zoom-image" src={`./assets/onboarding/${preview.file}.webp`} alt={preview.alt} />}</Modal>
  </div>;
}
