import { describe, expect, it, vi } from 'vitest';
import type { BrowserAutomationPort } from '../../../packages/agent-sdk/src';
import { BossContactService } from '../../../apps/backend/src/electron/backend/boss-contact-service';

function CreateHarness(initialGreetingEnabled = true) {
  let state: 'detail' | 'modal' | 'continued' | 'chat' | 'sent' = 'detail';
  let draft = '';
  let disabledSendSnapshots = 0;
  const job = { id: 'job-1', revision: 3, company: '示例科技', title: '产品经理', channel: 'boss_zhipin', url: 'https://www.zhipin.com/job_detail/a1.html', city: '佛山', experience: '3-5年', jobSeekingType: 'social_recruitment', jd: '岗位职责' };
  const refs = () => state === 'detail' ? { e1: { role: 'button', name: '立即沟通' } }
    : state === 'modal' ? { e2: { role: 'button', name: '关闭' } }
      : state === 'continued' ? { e3: { role: 'button', name: '继续沟通' } }
        : state === 'chat' ? { e4: { role: 'textbox', name: draft || '输入消息' }, e5: { role: 'button', name: '发送', disabled: disabledSendSnapshots-- > 0 } } : {};
  const browser: BrowserAutomationPort = {
    Prepare: vi.fn(async ({ toolName, arguments: args }) => ({ proposalHash: `${toolName}-${JSON.stringify(args)}`, toolName, canonicalArguments: args, summary: toolName, risk: 'low', forceConfirmation: false, pageRevision: 1, resourceIds: [] })),
    Execute: vi.fn(async ({ proposal }) => {
      if (proposal.toolName === 'BrowserNavigate') state = 'detail';
      if (proposal.toolName === 'BrowserClick') {
        const ref = String(proposal.canonicalArguments.ref);
        if (ref === 'e1') state = 'modal'; else if (ref === 'e2') state = 'continued'; else if (ref === 'e3') state = 'chat'; else if (ref === 'e5') state = 'sent';
      }
      if (proposal.toolName === 'BrowserFill') { draft = String(proposal.canonicalArguments.text ?? ''); disabledSendSnapshots = 1; }
      if (proposal.toolName === 'BrowserPressKey' && proposal.canonicalArguments.key === 'Enter') state = 'sent';
      return { status: 'succeeded' as const, data: proposal.toolName === 'BrowserSnapshot' ? { refs: refs(), pageRevision: 1, currentUrl: ['chat', 'sent'].includes(state) ? 'https://www.zhipin.com/web/geek/chat' : job.url } : {} };
    }),
    EvaluateTrustedPage: vi.fn(async () => ({ url: state === 'modal' ? job.url : 'https://www.zhipin.com/web/geek/chat', body: `示例科技 产品经理`, ownTexts: state === 'sent' ? ['自定义消息'] : [], ownImages: 0, initialGreetingTexts: state === 'modal' && initialGreetingEnabled ? ['这是完整的第一条常用语'] : [], quickPhrases: ['这是完整的第一条常用语'], canContinue: state === 'modal' || state === 'continued' })),
  };
  const saveJob = vi.fn(async () => ({ jobId: job.id, jobRevision: 4 }));
  const service = new BossContactService({ browser, loadViewModel: () => ({ jobs: [job], applications: [] }), saveJob, resolveAsset: () => null, readResume: () => ({ id: 'resume-1', revision: 2 }), getBrowserStatus: async () => ({ running: true, engine: 'chrome' }), createBatch: vi.fn(), checkpointBatch: vi.fn(), finishBatch: vi.fn() });
  return { service, browser, saveJob };
}

describe('BossContactService', () => {
  it('冻结岗位库 URL，并以“立即沟通”的已发送回执认定首条常用语送达', async () => {
    const { service, browser, saveJob } = CreateHarness();
    const proposal = await service.Prepare({ sessionId: 'session-1', items: [{ jobId: 'job-1', message: { mode: 'first_quick_phrase' } }], authorizedAssetIds: [], resume: { id: 'resume-1', name: '产品简历', revision: 2 } });
    const outcome = await service.Execute({ proposal, deadline: Date.now() + 20_000 });

    expect(outcome.data).toMatchObject({ ok: true, status: 'completed', summary: { requested: 1, contacted: 1 } });
    expect(browser.Prepare).toHaveBeenCalledWith({ toolName: 'BrowserNavigate', arguments: { url: 'https://www.zhipin.com/job_detail/a1.html' } });
    expect(browser.Prepare).not.toHaveBeenCalledWith(expect.objectContaining({ toolName: 'BrowserClick', canonicalArguments: expect.objectContaining({ ref: 'e4' }) }));
    expect(saveJob).toHaveBeenLastCalledWith(expect.objectContaining({ jobId: 'job-1', contactStatus: 'contacted', bossContactCheckpoint: 'contacted' }));
  });

  it('自定义消息在平台预设招呼语后进入聊天页发送，并验证自己的消息', async () => {
    const { service, browser, saveJob } = CreateHarness(false);
    const proposal = await service.Prepare({ sessionId: 'session-1', items: [{ jobId: 'job-1', message: { mode: 'custom', text: '自定义消息' } }], authorizedAssetIds: [], resume: { id: 'resume-1', revision: 2 } });
    const outcome = await service.Execute({ proposal, deadline: Date.now() + 20_000 });

    expect(outcome.data).toMatchObject({ status: 'completed', summary: { contacted: 1 } });
    expect(saveJob).toHaveBeenCalledWith(expect.objectContaining({ bossContactCheckpoint: 'initial_contact_starting' }));
    expect(saveJob).toHaveBeenCalledWith(expect.objectContaining({ bossContactCheckpoint: 'contact_started' }));
    expect(saveJob).toHaveBeenCalledWith(expect.objectContaining({ bossContactCheckpoint: 'message_sent' }));
    expect(browser.Prepare).toHaveBeenCalledWith({ toolName: 'BrowserClick', arguments: { ref: 'e5', pageRevision: 1 } });
    expect(browser.Prepare).not.toHaveBeenCalledWith(expect.objectContaining({ toolName: 'BrowserPressKey' }));
  });

  it('拒绝非 BOSS 岗位以及未授权图片资源', async () => {
    const { service } = CreateHarness();
    await expect(service.Prepare({ sessionId: 'session-1', items: [{ jobId: 'missing', message: { mode: 'first_quick_phrase' } }], authorizedAssetIds: [], resume: { id: 'resume-1' } })).rejects.toMatchObject({ code: 'BOSS_JOB_NOT_FOUND' });
    await expect(service.Prepare({ sessionId: 'session-1', items: [{ jobId: 'job-1', message: { mode: 'first_quick_phrase' } }], imageAssetId: 'attachment://unauthorized/image.png', authorizedAssetIds: [], resume: { id: 'resume-1' } })).rejects.toMatchObject({ code: 'IMAGE_ASSET_NOT_AUTHORIZED' });
  });
});
