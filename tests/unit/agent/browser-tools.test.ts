import { describe, expect, it, vi } from 'vitest';
import type { BrowserActionProposal } from '../../../packages/agent-sdk/src/index';
import { CreateToolsModule } from '../../../packages/agent-modules-defaults/src/tools';
import { CreateToolContext } from './test-helpers';

function CreatePorts() {
  return { getConfig: vi.fn(async () => null), saveConfig: vi.fn(async () => undefined), getStoredSettings: vi.fn(async () => ({})) };
}

function Proposal(overrides: Partial<BrowserActionProposal> = {}): BrowserActionProposal {
  return {
    proposalId: 'proposal-browser-test', proposalHash: 'proposal-hash', toolName: 'BrowserClick', canonicalArguments: { ref: '@e1', pageRevision: 1 },
    summary: '点击下一步', risk: 'medium', forceConfirmation: false, pageRevision: 1, url: 'https://example.com/jobs', resourceIds: ['browser:avery-default'],
    ...overrides,
  };
}

describe('浏览器工具 Harness', () => {
  it('始终确认模式下规划仍为只读，执行阶段继续遵守确认策略', async () => {
    const browser={Prepare:vi.fn(async({arguments:args}:{arguments:Record<string,unknown>})=>Proposal({toolName:'BrowserFillForm',canonicalArguments:args,risk:'low'})),Execute:vi.fn(async()=>({status:'succeeded' as const,data:{phase:'plan',executed:false}}))};
    const base=CreateToolContext();
    const context=CreateToolContext({scenarioId:'application',confirmationMode:'always_confirm',pendingBrowserActions:new Map(),profileSnapshot:[{id:'p1',category:'application',title:'个人信息',content:'[个人信息]\n姓名：张三'}],ports:{...base.ports,browser:browser as never}});
    const tools=CreateToolsModule(CreatePorts());
    const plan=await tools.ExecuteToolCall({id:'plan',type:'function',function:{name:'BrowserFillForm',arguments:JSON.stringify({profileIds:['p1']})}},context);
    expect(JSON.parse(plan.content)).toMatchObject({ok:true,data:{executed:false}});
    expect(browser.Execute).toHaveBeenCalledOnce();
    const execute=await tools.ExecuteToolCall({id:'execute',type:'function',function:{name:'BrowserFillForm',arguments:JSON.stringify({mode:'execute',continuationId:'form-abcdef',selections:[]})}},context);
    expect(execute.disposition).toBe('wait_confirmation');
    expect(browser.Execute).toHaveBeenCalledOnce();
  });
  it.each(['fully_trusted', 'allow_low_risk', 'always_confirm'] as const)('上传和 Enter 在 %s 下使用对应确认策略', async (confirmationMode) => {
    for (const toolName of ['BrowserUploadFile', 'BrowserPressKey'] as const) {
      const args = toolName === 'BrowserUploadFile' ? { ref: '@e1', pageRevision: 1, fileId: 'attachment://resume.pdf' } : { key: 'Enter' };
      const browser = {
        Prepare: vi.fn(async () => Proposal({ toolName, canonicalArguments: args, forceConfirmation: true, risk: 'high' })),
        Execute: vi.fn(async () => ({ status: 'succeeded' as const, data: { completed: true } })),
      };
      const base = CreateToolContext();
      const context = CreateToolContext({ confirmationMode, pendingBrowserActions: new Map(), attachments: [{ path: 'attachment://resume.pdf', name: 'resume.pdf' }], ports: { ...base.ports, browser: browser as never } });
      const result = await CreateToolsModule(CreatePorts()).ExecuteToolCall({ id: toolName, type: 'function', function: { name: toolName, arguments: JSON.stringify(args) } }, context);
      if (confirmationMode === 'fully_trusted') {
        expect(JSON.parse(result.content)).toMatchObject({ ok: true });
        expect(result.receipt?.toolDefinitionId).toBe(toolName);
        expect(browser.Execute).toHaveBeenCalledOnce();
        expect(context.emit).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'browser_confirmation' }));
      } else {
        expect(result.disposition).toBe('wait_confirmation');
        expect(browser.Execute).not.toHaveBeenCalled();
      }
    }
  });
  it.each(['BROWSER_EXTENSION_STALE', 'BROWSER_EXTENSION_REQUIRED', 'BROWSER_EXTENSION_DISCONNECTED'])('扩展连接故障 %s 等待用户处理，不让模型反复重试', async (code) => {
    const browser = { Prepare: vi.fn(async () => { throw Object.assign(new Error('extension unavailable'), { code }); }), Execute: vi.fn() };
    const base = CreateToolContext();
    const context = CreateToolContext({ scenarioId: 'application', ports: { ...base.ports, browser: browser as never } });
    const result = await CreateToolsModule(CreatePorts()).ExecuteToolCall({ id: 'extension-failure', type: 'function', function: { name: 'BrowserNavigate', arguments: '{"url":"https://example.test"}' } }, context);
    expect(result.disposition).toBe('wait_user_input');
    expect(context.emit).toHaveBeenCalledWith(expect.objectContaining({ type: 'browser_user_action' }));
    expect(browser.Execute).not.toHaveBeenCalled();
  });
  it('压缩后重新观察必须返回全量，即使旧增量基线仍在内存', async () => {
    const data = { documentId: 'document-one', url: 'https://example.com/form', pageRevision: 1, refs: Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`e${i}`, { role: 'textbox', name: `字段${i}` }])) };
    const browser = {
      Prepare: vi.fn(async () => Proposal({ toolName: 'BrowserSnapshot', canonicalArguments: {}, risk: 'low' })),
      Execute: vi.fn(async () => ({ status: 'succeeded' as const, data })),
    };
    const base = CreateToolContext();
    const context = CreateToolContext({ ports: { ...base.ports, browser: browser as never }, hasToolResultInContext: () => true });
    const tools = CreateToolsModule(CreatePorts());
    const snapshot = (id: string) => tools.ExecuteToolCall({ id, type: 'function', function: { name: 'BrowserSnapshot', arguments: '{}' } }, context);
    expect(JSON.parse((await snapshot('first')).content).data.mode).toBe('full');
    expect(JSON.parse((await snapshot('second')).content).data.mode).toBe('unchanged');
    context.requiresBrowserSnapshot = true;
    expect(JSON.parse((await snapshot('after-compaction')).content).data.mode).toBe('full');
  });

  it.each([{ type: 'password' }, { name: '验证码' }])('长快照尾部的验证控件仍要求用户接管：%j', async (verification) => {
    const refs = Object.fromEntries(Array.from({ length: 200 }, (_, index) => [`e${index + 1}`, { role: 'textbox', name: '普通字段', value: 'x'.repeat(500) }]));
    refs.e201 = { role: 'textbox', name: '验证字段', value: '', ...verification };
    const browser = {
      Prepare: vi.fn(async () => Proposal({ toolName: 'BrowserSnapshot', canonicalArguments: {}, risk: 'low' })),
      Execute: vi.fn(async () => ({ status: 'succeeded' as const, data: { refs } })),
      GetStatus: vi.fn(), ResetPageReferences: vi.fn(), Close: vi.fn(),
    };
    const base = CreateToolContext();
    const result = await CreateToolsModule(CreatePorts()).ExecuteToolCall({ id: 'long-verification', type: 'function', function: { name: 'BrowserSnapshot', arguments: '{}' } }, CreateToolContext({ ports: { ...base.ports, browser } }));
    expect(result.disposition).toBe('wait_user_input');
    expect(JSON.parse(result.content)).toMatchObject({ ok: false, code: 'AWAITING_USER' });
  });

  it('BOSS 风控错误经 Harness 暂停并请求用户接管', async () => {
    const error = Object.assign(new Error('BOSS requires security verification.'), { code: 'BROWSER_SITE_RISK_DETECTED' });
    const browser = { Prepare: vi.fn(async () => { throw error; }), Execute: vi.fn(), GetStatus: vi.fn(), ClearProfile: vi.fn(), ResetPageReferences: vi.fn(), Close: vi.fn() };
    const base = CreateToolContext();
    const context = CreateToolContext({ scenarioId: 'application', ports: { ...base.ports, browser } });

    const result = await CreateToolsModule(CreatePorts()).ExecuteToolCall({
      id: 'boss-risk', type: 'function', function: { name: 'BrowserSnapshot', arguments: '{}' },
    }, context);

    expect(result.disposition).toBe('wait_user_input');
    expect(JSON.parse(result.content)).toMatchObject({ ok: false, code: 'BROWSER_SITE_RISK_DETECTED' });
    expect(context.emit).toHaveBeenCalledWith(expect.objectContaining({ type: 'browser_user_action' }));
    expect(browser.Execute).not.toHaveBeenCalled();
  });

  it('无人值守 BOSS 请求经 Harness 暂停且不启动浏览器', async () => {
    const error = Object.assign(new Error('BOSS requires a visible browser.'), { code: 'BROWSER_SITE_VISIBLE_REQUIRED' });
    const browser = { Prepare: vi.fn(async () => { throw error; }), Execute: vi.fn(), GetStatus: vi.fn(), ClearProfile: vi.fn(), ResetPageReferences: vi.fn(), Close: vi.fn() };
    const base = CreateToolContext();
    const context = CreateToolContext({ scenarioId: 'application', unattended: true, ports: { ...base.ports, browser } });

    const result = await CreateToolsModule(CreatePorts()).ExecuteToolCall({
      id: 'boss-headless', type: 'function', function: { name: 'BrowserNavigate', arguments: JSON.stringify({ url: 'https://www.zhipin.com/web/geek/job' }) },
    }, context);

    expect(result.disposition).toBe('pause');
    expect(JSON.parse(result.content)).toMatchObject({ ok: false, code: 'BROWSER_SITE_VISIBLE_REQUIRED' });
    expect(browser.Execute).not.toHaveBeenCalled();
  });

  it('CronTask 个人浏览器授权失效时暂停并保留待接管会话', async () => {
    const error = Object.assign(new Error('Authorize this CronTask again.'), { code: 'BROWSER_CRON_ACCESS_REQUIRED' });
    const browser = { Prepare: vi.fn(async () => { throw error; }), Execute: vi.fn(), GetStatus: vi.fn(), ClearProfile: vi.fn(), ResetPageReferences: vi.fn(), Close: vi.fn() };
    const base = CreateToolContext();
    const context = CreateToolContext({ scenarioId: 'application', unattended: true, ports: { ...base.ports, browser } });

    const result = await CreateToolsModule(CreatePorts()).ExecuteToolCall({
      id: 'cron-browser-expired', type: 'function', function: { name: 'BrowserSnapshot', arguments: '{}' },
    }, context);

    expect(result.disposition).toBe('pause');
    expect(JSON.parse(result.content)).toMatchObject({ ok: false, code: 'BROWSER_CRON_ACCESS_REQUIRED' });
    expect(browser.Execute).not.toHaveBeenCalled();
  });

  it.each(['BROWSER_EXISTING_BROWSER_UNAVAILABLE', 'BROWSER_EXISTING_BROWSER_PERMISSION_REQUIRED', 'BROWSER_BOSS_TAB_REQUIRED', 'BROWSER_USER_BROWSER_INTERACTIVE_ONLY'])('%s 经 Harness 等待用户准备个人浏览器', async (code) => {
    const error = Object.assign(new Error('Prepare the logged-in browser.'), { code });
    const browser = { Prepare: vi.fn(async () => { throw error; }), Execute: vi.fn(), GetStatus: vi.fn(), ClearProfile: vi.fn(), ResetPageReferences: vi.fn(), Close: vi.fn() };
    const base = CreateToolContext();
    const context = CreateToolContext({ scenarioId: 'application', ports: { ...base.ports, browser } });

    const result = await CreateToolsModule(CreatePorts()).ExecuteToolCall({
      id: `personal-${code}`, type: 'function', function: { name: 'BrowserSnapshot', arguments: '{}' },
    }, context);

    expect(result.disposition).toBe('wait_user_input');
    expect(JSON.parse(result.content)).toMatchObject({ ok: false, code });
    expect(browser.Execute).not.toHaveBeenCalled();
  });

  it('BrowserScreenshot 仅为视觉模型注入图片且不在 tool result 中回显 Base64', async () => {
    const imageDataUrl = 'data:image/png;base64,iVBORw0KGgo=';
    const browser = {
      Prepare: vi.fn(async () => Proposal({ toolName: 'BrowserScreenshot', canonicalArguments: {}, risk: 'low', pageRevision: 2 })),
      Execute: vi.fn(async () => ({ status: 'succeeded' as const, data: { imageDataUrl, byteSize: 8, pageRevision: 2, currentUrl: 'https://example.com/jobs' } })),
      GetStatus: vi.fn(), ClearProfile: vi.fn(), ResetPageReferences: vi.fn(), Close: vi.fn(),
    };
    const base = CreateToolContext();
    const module = CreateToolsModule(CreatePorts());
    const call = { id: 'screenshot-1', type: 'function' as const, function: { name: 'BrowserScreenshot', arguments: '{}' } };

    const unsupported = await module.ExecuteToolCall(call, CreateToolContext({ scenarioId: 'application', ports: { ...base.ports, browser } }));
    expect(JSON.parse(unsupported.content)).toMatchObject({ ok: false, code: 'BROWSER_VISION_UNAVAILABLE' });
    expect(browser.Prepare).not.toHaveBeenCalled();

    const result = await module.ExecuteToolCall(call, CreateToolContext({ scenarioId: 'application', supportsVisionInput: true, ports: { ...base.ports, browser } }));
    expect(result.content).not.toContain('base64');
    expect(result.followupMessages).toEqual([expect.objectContaining({
      role: 'user',
      providerContent: expect.arrayContaining([expect.objectContaining({ type: 'image_url', image_url: { url: imageDataUrl, detail: 'auto' } })]),
    })]);
  });

  it('未加入当前 Run 的文件不能进入 Runtime', async () => {
    const browser = { Prepare: vi.fn(), Execute: vi.fn(), GetStatus: vi.fn(), ClearProfile: vi.fn(), ResetPageReferences: vi.fn(), Close: vi.fn() };
    const base = CreateToolContext();
    const context = CreateToolContext({ scenarioId: 'application', pendingBrowserActions: new Map(), ports: { ...base.ports, browser } });
    const result = await CreateToolsModule(CreatePorts()).ExecuteToolCall({
      id: 'upload-1', type: 'function', function: { name: 'BrowserUploadFile', arguments: JSON.stringify({ ref: '@e1', pageRevision: 1, fileId: 'attachment://not-authorized.pdf' }) },
    }, context);

    expect(browser.Prepare).not.toHaveBeenCalled();
    expect(JSON.parse(result.content)).toMatchObject({ ok: false, code: 'BROWSER_FILE_NOT_AUTHORIZED' });
  });

  it('强制确认不受 fully_trusted 绕过，确认前 CLI 调用次数为零', async () => {
    const browser = { Prepare: vi.fn(async () => Proposal({ forceConfirmation: true, risk: 'high', summary: '提交申请' })), Execute: vi.fn(), GetStatus: vi.fn(), ClearProfile: vi.fn(), ResetPageReferences: vi.fn(), Close: vi.fn() };
    const base = CreateToolContext();
    const pendingBrowserActions = new Map<string, unknown>();
    const context = CreateToolContext({ scenarioId: 'application', confirmationMode: 'fully_trusted', pendingBrowserActions, ports: { ...base.ports, browser } });
    const result = await CreateToolsModule(CreatePorts()).ExecuteToolCall({
      id: 'click-submit', type: 'function', function: { name: 'BrowserClick', arguments: JSON.stringify({ ref: '@e1', pageRevision: 1 }) },
    }, context);

    expect(browser.Execute).not.toHaveBeenCalled();
    expect(result.disposition).toBe('wait_confirmation');
    expect(pendingBrowserActions.size).toBe(1);
    expect(context.emit).toHaveBeenCalledWith(expect.objectContaining({ type: 'browser_confirmation' }));
  });

  it('已开始的浏览器写动作取消后进入 status_unknown，不返回可重试取消', async () => {
    const controller = new AbortController();
    const browser = { Prepare: vi.fn(async () => Proposal()), Execute: vi.fn(() => new Promise<never>(() => undefined)), GetStatus: vi.fn(), ClearProfile: vi.fn(), ResetPageReferences: vi.fn(), Close: vi.fn() };
    const base = CreateToolContext();
    const context = CreateToolContext({ scenarioId: 'application', signal: controller.signal, ports: { ...base.ports, browser } });
    const execution = CreateToolsModule(CreatePorts()).ExecuteToolCall({
      id: 'click-cancel', type: 'function', function: { name: 'BrowserClick', arguments: JSON.stringify({ ref: '@e1', pageRevision: 1 }) },
    }, context);
    await vi.waitFor(() => expect(browser.Execute).toHaveBeenCalledOnce());
    controller.abort(new Error('user stopped'));
    const result = await execution;

    expect(result.disposition).toBe('pause');
    expect(JSON.parse(result.content)).toMatchObject({ ok: false, code: 'STATUS_UNKNOWN', retryable: false });
    expect(context.ledger?.Finish).toHaveBeenCalledWith(expect.any(String), 'status_unknown', expect.objectContaining({ errorCode: 'CANCELLED' }));
  });
});
