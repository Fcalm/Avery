import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import type { BossContactPort, BrowserActionProposal, BrowserAutomationPort, BrowserToolName } from '@avery/agent-sdk';

const BatchWallTimeMs = 10 * 60 * 1000;
const StepTimeoutMs = 30_000;
const QuickPhrasePrefix = '发送常用语：';

type ContactItem = { jobId: string; message: { mode: 'first_quick_phrase' } | { mode: 'custom'; text: string } };
type FrozenItem = ContactItem & { revision: number; company: string; title: string; url: string; messageHash: string; resumeFrom?: 'contact_started' | 'initial_greeting_sent' | 'message_sent' };
type FrozenPlan = {
  batchId: string; sessionId: string; resume: { id: string; name?: string; revision?: number };
  items: FrozenItem[]; imageAssetId?: string; imageHash?: string; createdAt: number;
};
type Snapshot = { refs: Record<string, { role?: string; name?: string; type?: string; description?: string; disabled?: boolean }>; pageRevision: number; currentUrl?: string };

const ChatFactsExpression = `(() => {
  const clean=(value)=>String(value||'').replace(/\\s+/g,' ').trim();
  const own=[...document.querySelectorAll('.item-myself,.message-item.is-me,.message-item.me,.chat-message.is-self,.message-self')];
  const sentPreviews=[...document.querySelectorAll('.last-msg')].filter((item)=>/\[?(送达|已读|已发送)\]?/.test(clean(item.innerText))).map((item)=>clean(item.querySelector('.last-msg-text')?.textContent||item.textContent));
  const initialGreetingTexts=[...document.querySelectorAll('.startchat-dialog .message-item,.startchat-dialog .message-list')].map((item)=>clean(item.innerText).replace(/^已发送\s*/, '')).filter(Boolean);
  const quickPhrases=[...document.querySelectorAll('.sentence-panel li,.sentence-panel [role="button"],.sentence-panel .sentence-item')].map((item)=>clean(item.textContent)).filter((text)=>text&&!/^(设置|编辑|删除|添加常用语)$/.test(text));
  const canContinue=[...document.querySelectorAll('a,button')].some((item)=>{const rect=item.getBoundingClientRect();return clean(item.textContent)==='继续沟通'&&rect.width>0&&rect.height>0;});
  return { url:location.href, body:clean(document.body?.innerText).slice(0,50000), ownTexts:[...own.map((item)=>clean(item.innerText)).filter(Boolean),...sentPreviews], ownImages:own.reduce((count,item)=>count+item.querySelectorAll('img').length,0), initialGreetingTexts, quickPhrases, canContinue };
})()`;

export class BossContactError extends Error {
  constructor(readonly code: string, message: string, readonly statusUnknown = false) { super(message); this.name = 'BossContactError'; }
}

function Hash(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function Normalize(value: unknown): string { return String(value ?? '').replace(/\s+/g, ' ').trim(); }
function BossUrl(value: unknown): string | null {
  try { const url = new URL(String(value ?? '')); if (url.protocol !== 'https:' || !(url.hostname === 'zhipin.com' || url.hostname.endsWith('.zhipin.com'))) return null; url.hash = ''; return url.toString(); } catch { return null; }
}
function Active(signal?: AbortSignal, deadline?: number): void {
  if (signal?.aborted) throw new BossContactError('BATCH_CANCELLED', 'The BOSS contact batch was cancelled.');
  if (deadline !== undefined && Date.now() >= deadline) throw new BossContactError('BATCH_WALL_TIME_EXCEEDED', 'The BOSS contact batch exceeded its wall-time limit.');
}
function ImageKind(path: string, mimeType: string, name: string): 'png' | 'jpeg' {
  const stat = statSync(path); if (!stat.isFile() || stat.size <= 0 || stat.size > 25 * 1024 * 1024) throw new BossContactError('IMAGE_FORMAT_INVALID', 'The image must be a non-empty file no larger than 25 MB.');
  const header = readFileSync(path).subarray(0, 12); const png = header.length >= 8 && header.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])); const jpeg = header.length >= 3 && header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff;
  const extension = name.toLocaleLowerCase().match(/\.(png|jpe?g)$/)?.[1];
  if (png && mimeType === 'image/png' && extension === 'png') return 'png';
  if (jpeg && ['image/jpeg', 'image/jpg'].includes(mimeType) && (extension === 'jpg' || extension === 'jpeg')) return 'jpeg';
  throw new BossContactError('IMAGE_FORMAT_INVALID', 'The image header, MIME type, and extension must consistently identify PNG or JPEG.');
}

export class BossContactService implements BossContactPort {
  constructor(private readonly input: {
    browser: BrowserAutomationPort;
    loadViewModel: () => Promise<any> | any;
    saveJob: (input: Record<string, unknown>) => Promise<any> | any;
    resolveAsset: (assetId: string) => Promise<{ id?: string; name: string; mimeType: string; physicalPath: string } | null> | { id?: string; name: string; mimeType: string; physicalPath: string } | null;
    readResume: (resumeId: string) => Promise<{ id: string; revision?: number } | null> | { id: string; revision?: number } | null;
    getBrowserStatus: () => Promise<any>;
    createBatch: (input: { id: string; sessionId: string; proposalHash: string; plan: unknown; items: Array<{ jobId: string }> }) => Promise<void> | void;
    checkpointBatch: (batchId: string, jobId: string, step: string, result?: unknown) => Promise<void> | void;
    finishBatch: (batchId: string, status: string, result: unknown) => Promise<void> | void;
    now?: () => number;
  }) {}

  private Now(): number { return this.input.now?.() ?? Date.now(); }
  async Prepare(input: Parameters<BossContactPort['Prepare']>[0]): Promise<BrowserActionProposal> {
    const status = await this.input.getBrowserStatus();
    if (!status?.running || !['chrome', 'edge'].includes(status.engine)) throw new BossContactError('BOSS_BROWSER_UNAVAILABLE', 'A logged-in authorized personal browser is required.');
    const view = await this.input.loadViewModel(); const jobs = Array.isArray(view?.jobs) ? view.jobs : [];
    const frozen: FrozenItem[] = input.items.map((item) => {
      const job = jobs.find((candidate: any) => candidate.id === item.jobId);
      const url = BossUrl(job?.url);
      if (!job) throw new BossContactError('BOSS_JOB_NOT_FOUND', `The saved job does not exist: ${item.jobId}`);
      if (job.channel !== 'boss_zhipin' || !url) throw new BossContactError('BOSS_JOB_NOT_ELIGIBLE', `The job is not an eligible BOSS job: ${item.jobId}`);
      if (job.contactStatus === 'contacted') throw new BossContactError('CONTACT_ALREADY_EXISTS', `The job was already contacted: ${item.jobId}`);
      if (['initial_contact_starting', 'initial_greeting_sending', 'message_sending', 'image_sending', 'uncertain'].includes(job.bossContactCheckpoint)) throw new BossContactError('MESSAGE_STATUS_UNKNOWN', `The previous contact attempt for ${item.jobId} has an uncertain external outcome.`);
      const messageHash = Hash(item.message);
      const resumeFrom = job.bossContactMessageHash === messageHash && ['contact_started', 'initial_greeting_sent', 'message_sent'].includes(job.bossContactCheckpoint)
        ? job.bossContactCheckpoint as 'contact_started' | 'initial_greeting_sent' | 'message_sent'
        : undefined;
      return { ...item, revision: Number(job.revision ?? 1), company: Normalize(job.company), title: Normalize(job.title), url, messageHash, ...(resumeFrom ? { resumeFrom } : {}) };
    });
    let imageHash: string | undefined; let imageName: string | undefined;
    if (input.imageAssetId) {
      if (!input.authorizedAssetIds.includes(input.imageAssetId)) throw new BossContactError('IMAGE_ASSET_NOT_AUTHORIZED', 'The image asset is not authorized for this Run.');
      const asset = await this.input.resolveAsset(input.imageAssetId); if (!asset) throw new BossContactError('IMAGE_ASSET_NOT_AUTHORIZED', 'The image asset is unavailable.');
      ImageKind(asset.physicalPath, asset.mimeType, asset.name); imageHash = createHash('sha256').update(readFileSync(asset.physicalPath)).digest('hex'); imageName = asset.name;
    }
    const plan: FrozenPlan = { batchId: `boss-contact-${randomUUID()}`, sessionId: input.sessionId, resume: structuredClone(input.resume), items: structuredClone(frozen), ...(input.imageAssetId ? { imageAssetId: input.imageAssetId, imageHash } : {}), createdAt: this.Now() };
    const lines = frozen.map((item, index) => `${index + 1}. ${item.company} · ${item.title}｜${item.message.mode === 'first_quick_phrase' ? '首条常用语' : `${item.message.text.slice(0, 24)}${item.message.text.length > 24 ? '…' : ''}`}`);
    const summary = [`即将联系 ${frozen.length} 个岗位`, ...lines, imageName ? `图片：${imageName}` : '', `简历：${input.resume.name ?? input.resume.id}`].filter(Boolean).join('\n');
    const proposalHash = Hash(plan);
    await this.input.createBatch({ id: plan.batchId, sessionId: plan.sessionId, proposalHash, plan, items: frozen });
    return { proposalHash, toolName: 'ContactBossJobs' as BrowserToolName, canonicalArguments: { __bossContactPlan: plan }, summary, risk: 'high', forceConfirmation: Boolean(input.imageAssetId), pageRevision: 0, resourceIds: frozen.map((item) => `jobs:${item.jobId}`) };
  }

  private async Browser(toolName: BrowserToolName, args: Record<string, unknown>, signal?: AbortSignal, deadline?: number): Promise<unknown> {
    Active(signal, deadline);
    try {
      const proposal = await this.input.browser.Prepare({ toolName, arguments: args }); const outcome = await this.input.browser.Execute({ proposal, signal, deadline: Math.min(deadline ?? Number.POSITIVE_INFINITY, Date.now() + StepTimeoutMs) });
      if (outcome.status !== 'succeeded') throw new BossContactError('MESSAGE_STATUS_UNKNOWN', `${toolName} returned an unknown outcome.`, true); return outcome.data;
    } catch (error) {
      if (error instanceof BossContactError) throw error;
      const sourceCode = error && typeof error === 'object' && 'code' in error ? String((error as any).code) : '';
      const code = sourceCode === 'BROWSER_SITE_RISK_DETECTED' ? 'BOSS_SITE_RISK_DETECTED'
        : sourceCode.includes('LOGIN') ? 'BOSS_LOGIN_REQUIRED'
          : sourceCode.includes('UNAVAILABLE') || sourceCode.includes('TAB_REQUIRED') ? 'BOSS_BROWSER_UNAVAILABLE' : sourceCode || 'MESSAGE_SEND_FAILED';
      throw new BossContactError(code, error instanceof Error ? error.message : `${toolName} failed.`, Boolean((error as any)?.statusUnknown));
    }
  }
  private async Snapshot(signal?: AbortSignal, deadline?: number): Promise<Snapshot> { return await this.Browser('BrowserSnapshot', {}, signal, deadline) as Snapshot; }
  private Find(snapshot: Snapshot, predicate: (value: Snapshot['refs'][string]) => boolean): string | null { return Object.entries(snapshot.refs ?? {}).find(([, value]) => predicate(value))?.[0] ?? null; }
  private async Click(snapshot: Snapshot, ref: string, signal?: AbortSignal, deadline?: number): Promise<void> { await this.Browser('BrowserClick', { ref, pageRevision: snapshot.pageRevision }, signal, deadline); }
  private async Facts(signal?: AbortSignal, deadline?: number): Promise<{ url: string; body: string; ownTexts: string[]; ownImages: number; initialGreetingTexts: string[]; quickPhrases: string[]; canContinue: boolean }> {
    if (typeof this.input.browser.EvaluateTrustedPage !== 'function') throw new BossContactError('BOSS_BROWSER_UNAVAILABLE', 'The personal browser does not support trusted BOSS inspection.');
    return await this.input.browser.EvaluateTrustedPage({ site: 'boss_zhipin', expression: ChatFactsExpression, signal, deadline }) as any;
  }
  private async WaitSnapshot(predicate: (snapshot: Snapshot) => boolean, signal?: AbortSignal, deadline?: number): Promise<Snapshot> {
    const end = Math.min(deadline ?? Date.now() + StepTimeoutMs, Date.now() + StepTimeoutMs); let latest: Snapshot = { refs: {}, pageRevision: 1 };
    while (Date.now() < end) { Active(signal, deadline); latest = await this.Snapshot(signal, deadline); if (predicate(latest)) return latest; await new Promise((resolve) => setTimeout(resolve, 350)); }
    return latest;
  }
  private async Persist(job: any, checkpoint: string, batchId: string, extra: Record<string, unknown> = {}): Promise<void> {
    await this.input.saveJob({ ...job, jobId: job.id, bossContactBatchId: batchId, bossContactCheckpoint: checkpoint, ...extra });
    await this.input.checkpointBatch(batchId, job.id, checkpoint);
  }

  private async ExecuteItem(plan: FrozenPlan, item: FrozenItem, signal?: AbortSignal, deadline?: number): Promise<any> {
    const browserStatus = await this.input.getBrowserStatus(); if (!browserStatus?.running) throw new BossContactError('BOSS_BROWSER_UNAVAILABLE', 'The authorized personal browser is no longer connected.');
    const resume = await this.input.readResume(plan.resume.id); if (!resume || resume.revision !== plan.resume.revision) throw new BossContactError('BOSS_JOB_NOT_ELIGIBLE', 'The bound resume changed after the BOSS batch was prepared.');
    const view = await this.input.loadViewModel(); const job = (view.jobs ?? []).find((candidate: any) => candidate.id === item.jobId);
    if (!job || Number(job.revision ?? 1) !== item.revision) return { jobId: item.jobId, outcome: 'failed', code: 'BOSS_JOB_NOT_ELIGIBLE' };
    if (job.contactStatus === 'contacted') return { jobId: item.jobId, outcome: 'skipped', code: 'CONTACT_ALREADY_EXISTS' };
    await this.Browser('BrowserNavigate', { url: item.url }, signal, deadline);
    let snapshot = await this.WaitSnapshot((value) => Boolean(this.Find(value, (ref) => /立即沟通|继续沟通/.test(ref.name ?? ''))), signal, deadline);
    let platformGreeting = '';
    let messageVerified = item.resumeFrom === 'message_sent';
    if (snapshot.currentUrl?.includes('/web/geek/chat')) { /* 已进入聊天页。 */ }
    else {
      const detailFacts = await this.Facts(signal, deadline);
      if (!detailFacts.body.includes(item.title) || !detailFacts.body.includes(item.company)) return { jobId: item.jobId, outcome: 'failed', code: 'BOSS_JOB_NOT_ELIGIBLE' };
      const continued = this.Find(snapshot, (ref) => /继续沟通/.test(ref.name ?? ''));
      if (continued && !item.resumeFrom) return { jobId: item.jobId, outcome: 'skipped', code: 'CONTACT_ALREADY_EXISTS' };
      if (continued) { await this.Click(snapshot, continued, signal, deadline); }
      else {
        if (item.resumeFrom) return { jobId: item.jobId, outcome: 'uncertain', code: 'MESSAGE_STATUS_UNKNOWN' };
        const initial = this.Find(snapshot, (ref) => /立即沟通/.test(ref.name ?? ''));
        if (!initial) return { jobId: item.jobId, outcome: 'failed', code: 'BOSS_JOB_CLOSED' };

        // “立即沟通”可能发送账号预设语，也可能只建立关系；点击前先持久化不可重试边界。
        await this.Persist(job, 'initial_contact_starting', plan.batchId, { bossContactMessageHash: item.messageHash, bossContactImageHash: plan.imageHash });
        await this.Click(snapshot, initial, signal, deadline);
        const initialOutcome = await this.WaitForInitialContact(signal, deadline);
        if (!initialOutcome) {
          await this.Persist(job, 'uncertain', plan.batchId, { bossContactMessageHash: item.messageHash, bossContactImageHash: plan.imageHash });
          return { jobId: item.jobId, outcome: 'uncertain', code: 'MESSAGE_STATUS_UNKNOWN' };
        }
        snapshot = initialOutcome.snapshot;
        platformGreeting = initialOutcome.greeting;
        if (platformGreeting && item.message.mode === 'first_quick_phrase') {
          messageVerified = true;
          await this.Persist(job, 'message_sent', plan.batchId, { bossContactMessageHash: item.messageHash, bossContactImageHash: plan.imageHash });
        } else if (platformGreeting) {
          await this.Persist(job, 'initial_greeting_sent', plan.batchId, { bossContactMessageHash: item.messageHash, bossContactImageHash: plan.imageHash });
        } else {
          await this.Persist(job, 'contact_started', plan.batchId, { bossContactMessageHash: item.messageHash, bossContactImageHash: plan.imageHash });
        }

        if (!snapshot.currentUrl?.includes('/web/geek/chat')) {
          const close = this.Find(snapshot, (ref) => /^(关闭|close)$/i.test(ref.name ?? '') || /关闭/.test(ref.description ?? ''));
          if (close) await this.Click(snapshot, close, signal, deadline); else await this.Browser('BrowserPressKey', { key: 'Escape' }, signal, deadline);
          snapshot = await this.WaitSnapshot((value) => Boolean(this.Find(value, (ref) => /继续沟通/.test(ref.name ?? ''))), signal, deadline);
          const continueRef = this.Find(snapshot, (ref) => /继续沟通/.test(ref.name ?? ''));
          if (!continueRef) return { jobId: item.jobId, outcome: 'failed', code: 'BOSS_CONTINUE_CONTACT_NOT_FOUND' };
          await this.Click(snapshot, continueRef, signal, deadline);
        }
      }
    }
    snapshot = await this.WaitSnapshot((value) => Boolean(value.currentUrl?.includes('/web/geek/chat')), signal, deadline);
    const before = await this.Facts(signal, deadline);
    if (!before.url.includes('/web/geek/chat') || (!before.body.includes(item.title) && !before.body.includes(item.company))) return { jobId: item.jobId, outcome: 'failed', code: 'BOSS_WRONG_CHAT' };
    await this.Persist(job, 'chat_opened', plan.batchId);
    // BOSS 进入聊天页后会移除路由查询参数；在读取目标后重新取一次引用，避免沿用路由稳定前的 ref。
    snapshot = await this.Snapshot(signal, deadline);
    let expectedText = '';
    if (!messageVerified && item.message.mode === 'first_quick_phrase') {
      const phraseControl = this.Find(snapshot, (ref) => ref.name === '常用语');
      if (!phraseControl) return { jobId: item.jobId, outcome: 'failed', code: 'QUICK_PHRASE_NOT_FOUND' };
      await this.Click(snapshot, phraseControl, signal, deadline);
      snapshot = await this.WaitSnapshot((value) => Boolean(this.Find(value, (ref) => (ref.name ?? '').startsWith(QuickPhrasePrefix))), signal, deadline);
      const phrase = Object.entries(snapshot.refs).find(([, ref]) => (ref.name ?? '').startsWith(QuickPhrasePrefix));
      if (!phrase) return { jobId: item.jobId, outcome: 'failed', code: 'QUICK_PHRASE_NOT_FOUND' };
      expectedText = Normalize((await this.Facts(signal, deadline)).quickPhrases[0] ?? phrase[1].name?.slice(QuickPhrasePrefix.length).replace(/…【部分内容已截断】$/, ''));
      await this.Persist(job, 'message_sending', plan.batchId, { bossContactMessageHash: item.messageHash, bossContactImageHash: plan.imageHash });
      await this.Click(snapshot, phrase[0], signal, deadline);
    } else if (!messageVerified && item.message.mode === 'custom') {
      expectedText = Normalize(item.message.text); const textbox = this.Find(snapshot, (ref) => ref.role === 'textbox' && !/搜索/.test(ref.name ?? ''));
      if (!textbox) return { jobId: item.jobId, outcome: 'failed', code: 'BOSS_CHAT_NOT_READY' };
      await this.Browser('BrowserFill', { ref: textbox, pageRevision: snapshot.pageRevision, text: item.message.text }, signal, deadline);
      snapshot = await this.WaitSnapshot((value) => Boolean(
        this.Find(value, (ref) => ref.role === 'textbox' && Normalize(ref.name) === expectedText)
        && this.Find(value, (ref) => ref.role === 'button' && ref.name === '发送' && ref.disabled !== true),
      ), signal, deadline);
      const filled = this.Find(snapshot, (ref) => ref.role === 'textbox' && Normalize(ref.name) === expectedText);
      const send = this.Find(snapshot, (ref) => ref.role === 'button' && ref.name === '发送' && ref.disabled !== true);
      if (!filled || !send) return { jobId: item.jobId, outcome: 'failed', code: 'MESSAGE_SEND_FAILED' };
      await this.Persist(job, 'message_sending', plan.batchId, { bossContactMessageHash: item.messageHash, bossContactImageHash: plan.imageHash });
      await this.Click(snapshot, send, signal, deadline);
    }
    if (!messageVerified) {
      messageVerified = await this.WaitForMessage(expectedText, signal, deadline); if (!messageVerified) { await this.Persist(job, 'uncertain', plan.batchId, { bossContactMessageHash: item.messageHash, bossContactImageHash: plan.imageHash }); return { jobId: item.jobId, outcome: 'uncertain', code: 'MESSAGE_STATUS_UNKNOWN' }; }
      await this.Persist(job, 'message_sent', plan.batchId, { bossContactMessageHash: item.messageHash, bossContactImageHash: plan.imageHash });
    }
    let imageVerified = false;
    if (plan.imageAssetId) {
      const imageBefore = (await this.Facts(signal, deadline)).ownImages; snapshot = await this.Snapshot(signal, deadline); const chooser = this.Find(snapshot, (ref) => ref.role === 'filechooser' && ref.name === '发送图片');
      if (!chooser) return { jobId: item.jobId, outcome: 'partial', code: 'IMAGE_UPLOAD_FAILED', message: { mode: item.message.mode, verified: true }, image: { requested: true, verified: false } };
      await this.Persist(job, 'image_sending', plan.batchId, { bossContactMessageHash: item.messageHash, bossContactImageHash: plan.imageHash });
      try { await this.Browser('BrowserUploadFile', { ref: chooser, pageRevision: snapshot.pageRevision, fileId: plan.imageAssetId }, signal, deadline); }
      catch (error) { if (error instanceof BossContactError && error.statusUnknown) { await this.Persist(job, 'uncertain', plan.batchId, { bossContactMessageHash: item.messageHash, bossContactImageHash: plan.imageHash }); throw error; } await this.Persist(job, 'message_sent', plan.batchId, { bossContactMessageHash: item.messageHash, bossContactImageHash: plan.imageHash }); return { jobId: item.jobId, outcome: 'partial', code: 'IMAGE_UPLOAD_FAILED', message: { mode: item.message.mode, verified: true }, image: { requested: true, verified: false } }; }
      imageVerified = await this.WaitForImage(imageBefore, signal, deadline); if (!imageVerified) { await this.Persist(job, 'uncertain', plan.batchId, { bossContactMessageHash: item.messageHash, bossContactImageHash: plan.imageHash }); return { jobId: item.jobId, outcome: 'uncertain', code: 'IMAGE_STATUS_UNKNOWN', message: { mode: item.message.mode, verified: true }, image: { requested: true, verified: false } }; }
      await this.Persist(job, 'image_sent', plan.batchId);
    }
    const verifiedAt = new Date(this.Now()).toISOString(); await this.Persist(job, 'contacted', plan.batchId, { contactStatus: 'contacted', contactedAt: verifiedAt });
    return { jobId: item.jobId, outcome: 'contacted', message: { mode: item.message.mode, verified: true, ...(platformGreeting ? { platformGreeting } : {}) }, image: { requested: Boolean(plan.imageAssetId), verified: imageVerified }, verifiedAt };
  }
  private async WaitForInitialContact(signal?: AbortSignal, deadline?: number): Promise<{ greeting: string; snapshot: Snapshot } | null> {
    const end = Math.min(deadline ?? Date.now() + StepTimeoutMs, Date.now() + StepTimeoutMs);
    while (Date.now() < end) {
      const facts = await this.Facts(signal, deadline);
      const greeting = facts.initialGreetingTexts.map(Normalize).filter(Boolean).sort((left, right) => left.length - right.length)[0] ?? '';
      const snapshot = await this.Snapshot(signal, deadline);
      if (greeting || facts.canContinue || snapshot.currentUrl?.includes('/web/geek/chat') || this.Find(snapshot, (ref) => /继续沟通/.test(ref.name ?? ''))) return { greeting, snapshot };
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    return null;
  }
  private async WaitForMessage(expected: string, signal?: AbortSignal, deadline?: number): Promise<boolean> { const end = Math.min(deadline ?? Date.now() + StepTimeoutMs, Date.now() + StepTimeoutMs); while (Date.now() < end) { const facts = await this.Facts(signal, deadline); if (facts.ownTexts.some((text) => Normalize(text).includes(expected) || (expected.length >= 30 && Normalize(text).includes(expected.slice(0, 30))))) return true; await new Promise((resolve) => setTimeout(resolve, 350)); } return false; }
  private async WaitForImage(before: number, signal?: AbortSignal, deadline?: number): Promise<boolean> { const end = Math.min(deadline ?? Date.now() + StepTimeoutMs, Date.now() + StepTimeoutMs); while (Date.now() < end) { if ((await this.Facts(signal, deadline)).ownImages > before) return true; await new Promise((resolve) => setTimeout(resolve, 350)); } return false; }

  async Execute({ proposal, signal, deadline }: Parameters<BossContactPort['Execute']>[0]): ReturnType<BossContactPort['Execute']> {
    const plan = (proposal.canonicalArguments as any).__bossContactPlan as FrozenPlan; if (!plan || Hash(plan) !== proposal.proposalHash) throw new BossContactError('BOSS_JOB_NOT_ELIGIBLE', 'The frozen BOSS contact proposal is invalid.');
    const batchDeadline = Math.min(deadline ?? Number.POSITIVE_INFINITY, this.Now() + BatchWallTimeMs); const results: any[] = []; let stoppedReason: string | null = null;
    for (const item of plan.items) { try { Active(signal, batchDeadline); const result = await this.ExecuteItem(plan, item, signal, batchDeadline); results.push(result); if (['BOSS_SITE_RISK_DETECTED', 'BOSS_LOGIN_REQUIRED', 'BOSS_BROWSER_UNAVAILABLE'].includes(result.code)) { stoppedReason = result.code; break; } } catch (error) { const code = error instanceof BossContactError ? error.code : 'MESSAGE_SEND_FAILED'; results.push({ jobId: item.jobId, outcome: error instanceof BossContactError && error.statusUnknown ? 'uncertain' : 'failed', code }); if (['BOSS_SITE_RISK_DETECTED', 'BOSS_LOGIN_REQUIRED', 'BOSS_BROWSER_UNAVAILABLE', 'BATCH_CANCELLED', 'BATCH_WALL_TIME_EXCEEDED'].includes(code)) { stoppedReason = code; break; } } }
    const count = (outcome: string) => results.filter((result) => result.outcome === outcome).length; const summary = { requested: plan.items.length, contacted: count('contacted'), partial: count('partial'), skipped: count('skipped'), failed: count('failed'), uncertain: count('uncertain') };
    const status = stoppedReason ? 'stopped' : summary.contacted === summary.requested ? 'completed' : 'completed_with_failures';
    const data = { ok: status === 'completed', batchId: plan.batchId, status, summary, results, stoppedReason };
    await this.input.finishBatch(plan.batchId, status, data);
    return { status: 'succeeded', data };
  }

  async Cancel(proposal: BrowserActionProposal): Promise<void> {
    const plan = (proposal.canonicalArguments as any)?.__bossContactPlan as FrozenPlan | undefined;
    if (plan?.batchId) await this.input.finishBatch(plan.batchId, 'cancelled', { ok: false, batchId: plan.batchId, status: 'cancelled' });
  }
}
