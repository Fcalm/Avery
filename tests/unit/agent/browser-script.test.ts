import { describe, expect, it, vi } from 'vitest';
import { RunBrowserScript } from '../../../packages/agent-modules-defaults/src/browser-script';
import { CreateToolsModule } from '../../../packages/agent-modules-defaults/src/tools';
import type { BrowserActionProposal, BrowserToolName } from '../../../packages/agent-sdk/src/index';
import { CreateToolContext, CreateKernelHarness } from './test-helpers';
import { RunAgentLoop } from '../../../packages/agent-core/src/kernel';

function Harness(options: { confirmationMode?: 'always_confirm' | 'fully_trusted'; failAt?: number; revision?: number; data?: Record<string, unknown>; delay?: number } = {}) {
  let revision = options.revision ?? 1;
  let executed = 0;
  const browser = {
    Prepare: vi.fn(async ({ toolName, arguments: args }: { toolName: BrowserToolName; arguments: Record<string, unknown> }): Promise<BrowserActionProposal> => ({
      proposalId: `${toolName}-${revision}-${JSON.stringify(args)}`, proposalHash: `${toolName}-${revision}-${JSON.stringify(args)}`,
      toolName, canonicalArguments: args, summary: toolName, risk: 'medium', forceConfirmation: false, pageRevision: revision, resourceIds: [], url: 'https://example.test/form',
    })),
    Execute: vi.fn(async ({ proposal, signal }: { proposal: BrowserActionProposal; signal?: AbortSignal }) => {
      executed++;
      if (options.delay) await new Promise<void>((resolve, reject) => { const timer = setTimeout(resolve, options.delay); signal?.addEventListener('abort', () => { clearTimeout(timer); reject(Object.assign(new Error('cancelled'), { code: 'CANCELLED' })); }, { once: true }); });
      if (options.failAt === executed) throw Object.assign(new Error('test failure'), { code: 'BROWSER_STALE_PAGE_REF' });
      if (proposal.toolName === 'BrowserSnapshot') revision++;
      return { status: 'succeeded' as const, data: {
        pageRevision: revision, currentUrl: 'https://example.test/form', documentId: 'doc-1', referencesPreserved: true,
        refs: Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`e${i + 1}`, { role: 'textbox', name: `input-${i}` }])), ...options.data,
      } };
    }),
    GetStatus: vi.fn(async () => ({ available: true, running: true, pageRevision: revision, currentUrl: 'https://example.test/form' })),
    ResetPageReferences: vi.fn(), Close: vi.fn(async () => {}),
  };
  const trace = vi.fn();
  const tools = CreateToolsModule({ getConfig: vi.fn(async () => null), saveConfig: vi.fn(), getStoredSettings: vi.fn(async () => ({})), observabilityStore: { AppendTraceEvent: trace } } as never);
  const base = CreateToolContext();
  const context = CreateToolContext({
    confirmationMode: options.confirmationMode ?? 'fully_trusted', ports: { ...base.ports, browser }, pendingBrowserActions: new Map(),
    allowedToolNames: new Set(tools.GetToolDefinitions('application').map((t) => t.definition.function.name)),
  });
  const run = (script: string, args: Record<string, unknown> = {}, id = 'script-1') => tools.ExecuteToolCall({ id, type: 'function', function: { name: 'BrowserRunScript', arguments: JSON.stringify({ script, ...args }) } }, context);
  return { browser, context, tools, run, trace };
}

describe('受限浏览器脚本解释器', () => {
  it('支持变量、循环、条件和选择输出，顺序 await 动作', async () => {
    const call = vi.fn(async () => ({ saved: true }));
    const result = await RunBrowserScript({ script: `const fields=[{ref:'@e1',text:'学校'},{ref:'@e2',text:'专业'}];
      for(const field of fields) { const result=await page.fill(field.ref,field.text); if(result.saved) await page.press('Enter'); }
      let count=0; for(let i=0;i<3;i++) { count=count+1; } console.log(count); return 'done';`, call });
    expect(call.mock.calls.map((args) => args[0])).toEqual(['fill', 'press', 'fill', 'press']);
    expect(result).toEqual({ output: [[3]], value: 'done' });
  });

  it.each([
    `await page.press('Tab'); import('node:fs')`, `await page.press('Tab'); if(false) eval('1')`,
    `await page.press('Tab'); const x=()=>1;`, `await page.evaluate('document.cookie')`,
    `page.press('Tab')`, `await page['press']('Tab')`, `const page={};`, `while(true){}`,
    `new Function('return process')()`, `try { await page.press('Tab'); } catch(e) {}`,
  ])('整个脚本预检，拒绝未授权语法且没有前置副作用：%s', async (script) => {
    const call = vi.fn();
    await expect(RunBrowserScript({ script, call })).rejects.toMatchObject({ code: 'BROWSER_SCRIPT_INVALID' });
    expect(call).not.toHaveBeenCalled();
  });

  it('拒绝通过原型、宿主函数和未知全局逃逸', async () => {
    for (const script of [`return {}.constructor`, `return console.log.constructor`, `return process`, `return page.press.constructor`, `return {['constructor']:1}`]) {
      await expect(RunBrowserScript({ script, call: vi.fn() })).rejects.toMatchObject({ code: 'BROWSER_SCRIPT_INVALID' });
    }
  });

  it('循环和数据增长均有预算，取消可及时生效', async () => {
    await expect(RunBrowserScript({ script: 'for(;;){}', call: vi.fn() })).rejects.toMatchObject({ code: 'BROWSER_SCRIPT_LIMIT' });
    await expect(RunBrowserScript({ script: 'let x=[1]; for(let i=0;i<100;i++){x=[x,x];} return x;', call: vi.fn() })).rejects.toMatchObject({ code: 'BROWSER_SCRIPT_LIMIT' });
    const controller = new AbortController();
    setImmediate(() => controller.abort(new Error('stop')));
    await expect(RunBrowserScript({ script: 'for(;;){}', call: vi.fn(), signal: controller.signal })).rejects.toThrow('stop');
  });

  it('输出过大时停止，后续浏览器动作不执行', async () => {
    const call = vi.fn();
    await expect(RunBrowserScript({ script: `let text='x'; for(let i=0;i<15;i++) text=text+text; console.log(text); await page.press('Enter');`, call })).rejects.toMatchObject({ code: 'BROWSER_SCRIPT_LIMIT' });
    expect(call).not.toHaveBeenCalled();
  });
});

describe('BrowserRunScript 工具与执行边界', () => {
  it('多个填写和 Enter 一次完成，仅最终观察，并展示逐步轨迹', async () => {
    const h = Harness();
    const result = await h.run(`for(const field of [{ref:'@e1',text:'A'},{ref:'@e2',text:'B'}]) { await page.fill(field.ref,field.text); await page.press('Enter'); } await page.snapshot();`, { pageRevision: 1 });
    expect(JSON.parse(result.content)).toMatchObject({ ok: true, steps: [{ tool: 'BrowserFill' }, { tool: 'BrowserPressKey' }, { tool: 'BrowserFill' }, { tool: 'BrowserPressKey' }, { tool: 'BrowserSnapshot' }], observations: [{ data: { mode: 'full' } }] });
    expect(h.browser.Execute).toHaveBeenCalledTimes(5);
    expect(h.trace).toHaveBeenCalledTimes(5);
    expect(h.context.emit).toHaveBeenCalledWith(expect.objectContaining({ activity: expect.objectContaining({ toolCallId: 'script-1:browser:3', name: 'BrowserFill', toolStatus: 'succeeded' }) }));
    expect(h.trace.mock.calls.some((call) => JSON.stringify(call).includes('text'))).toBe(false);
  });

  it('任一步失败立即停止，已完成步骤保留，同 call ID 不重放', async () => {
    const h = Harness({ failAt: 2 });
    const script = `await page.press('Tab'); await page.press('ArrowDown'); await page.press('Enter');`;
    const result = await h.run(script);
    expect(JSON.parse(result.content)).toMatchObject({ ok: false, code: 'BROWSER_STALE_PAGE_REF', failedStep: 2, steps: [{ ok: true }, { ok: false }] });
    expect(h.browser.Execute).toHaveBeenCalledTimes(2);
    await h.run(script);
    expect(h.browser.Execute).toHaveBeenCalledTimes(2);
  });

  it('冻结白名单限制子操作，不能借脚本调用被禁用的工具', async () => {
    const h = Harness(); h.context.allowedToolNames = new Set(['BrowserRunScript', 'BrowserSnapshot']);
    const result = await h.run(`await page.press('Enter');`);
    expect(JSON.parse(result.content)).toMatchObject({ ok: false, code: 'TOOL_NOT_ALLOWED' });
    expect(h.browser.Prepare).not.toHaveBeenCalled();
  });

  it('聊天场景拒绝脚本，未注入冻结白名单也拒绝', async () => {
    const h = Harness(); h.context.scenarioId = 'default';
    expect(JSON.parse((await h.run(`await page.press('Tab')`)).content)).toMatchObject({ code: 'TOOL_NOT_ALLOWED' });
    h.context.scenarioId = 'application'; h.context.allowedToolNames = undefined;
    expect(JSON.parse((await h.run(`await page.press('Tab')`, {}, 'missing-snapshot')).content)).toMatchObject({ code: 'BROWSER_SCRIPT_UNAVAILABLE' });
    expect(h.browser.Prepare).not.toHaveBeenCalled();
  });

  it('需要确认时只生成一个原子动作提案，绑定外层调用且不执行后续按键', async () => {
    const h = Harness({ confirmationMode: 'always_confirm' });
    const result = await h.run(`await page.press('Enter'); await page.press('Tab');`);
    expect(result.disposition).toBe('wait_confirmation');
    const payload = JSON.parse(result.content);
    expect(payload).toMatchObject({ ok: false, code: 'CONFIRMATION_REQUIRED', failedStep: 1 });
    expect(h.context.pendingBrowserActions?.get(payload.confirmationId)).toMatchObject({ toolCallId: 'script-1', proposal: { toolName: 'BrowserPressKey' } });
    expect(h.browser.Prepare).toHaveBeenCalledOnce(); expect(h.browser.Execute).not.toHaveBeenCalled();
  });

  it('文件授权和视觉能力仍按每个原子工具校验', async () => {
    const h = Harness();
    expect(JSON.parse((await h.run(`await page.uploadFile('@e1','C:/private.pdf')`, { pageRevision: 1 })).content)).toMatchObject({ code: 'BROWSER_FILE_NOT_AUTHORIZED' });
    expect(JSON.parse((await h.run(`await page.screenshot()`, {}, 'vision')).content)).toMatchObject({ code: 'BROWSER_VISION_UNAVAILABLE' });
    expect(h.browser.Execute).not.toHaveBeenCalled();
  });

  it('简历上传选项透传到原子工具，解析未就绪时不执行后续填写', async () => {
    const h=Harness({confirmationMode:'fully_trusted',data:{readyForFill:false,parseStatus:'pending'}});
    h.context.attachments.push({path:'resume-file',name:'resume.pdf'});
    const result=await h.run(`await page.uploadFile('@e1','resume-file',{purpose:'resume'}); await page.fillForm({mode:'plan',useBoundResume:true});`,{pageRevision:1});
    expect(JSON.parse(result.content)).toMatchObject({ok:false,code:'BROWSER_RESUME_PARSE_PENDING'});
    expect(h.browser.Prepare).toHaveBeenCalledOnce();
    expect(h.browser.Prepare.mock.calls[0][0].arguments).toMatchObject({fileId:'resume-file',purpose:'resume'});
    expect(h.browser.Execute).toHaveBeenCalledOnce();
  });

  it('脚本只携带最新截图，不把图片 Base64 放入工具结果', async () => {
    const h = Harness({ data: { imageDataUrl: 'data:image/png;base64,iVBORw0KGgo=', byteSize: 8 } });
    h.context.supportsVisionInput = true;
    const result = await h.run(`await page.screenshot(); await page.screenshot();`);
    expect(JSON.parse(result.content).ok).toBe(true);
    expect(result.followupMessages).toHaveLength(1);
    expect(result.content).not.toContain('base64');
    expect(h.browser.Execute).toHaveBeenCalledTimes(2);
  });

  it('实际导航后不能继续盲按，状态未知也停止后续操作', async () => {
    const h = Harness({ data: { currentUrl: 'https://example.test/next' } });
    const navigated = await h.run(`await page.press('Enter'); await page.press('Tab');`);
    expect(JSON.parse(navigated.content)).toMatchObject({ code: 'BROWSER_SNAPSHOT_CONTEXT_LOST', completedSteps: 1 });
    expect(h.browser.Execute).toHaveBeenCalledOnce();
    const uncertain = Harness();
    uncertain.browser.Execute.mockResolvedValueOnce({ status: 'status_unknown', data: {} } as never);
    const stopped = await uncertain.run(`await page.press('Enter'); await page.press('Tab');`);
    expect(stopped.disposition).toBe('pause');
    expect(JSON.parse(stopped.content)).toMatchObject({ code: 'STATUS_UNKNOWN' });
    expect(uncertain.browser.Execute).toHaveBeenCalledOnce();
  });

  it('压缩丢失上下文时必须先观察；脚本快照与下一轮增量依赖外层真实回执', async () => {
    const h = Harness(); h.context.requiresBrowserSnapshot = true;
    expect(JSON.parse((await h.run(`await page.fill('@e1','x')`, { pageRevision: 1 })).content)).toMatchObject({ code: 'BROWSER_SNAPSHOT_CONTEXT_LOST' });
    const first = await h.run(`await page.snapshot(); await page.fill('@e1','A'); await page.snapshot();`, {}, 'observe');
    expect(JSON.parse(first.content).observations.map((s: { data: { mode: string } }) => s.data.mode)).toEqual(['full', 'unchanged']);
    h.context.requiresBrowserSnapshot = false;
    h.context.hasToolResultInContext = (id) => id === 'observe';
    const next = await h.tools.ExecuteToolCall({ id: 'next', type: 'function', function: { name: 'BrowserSnapshot', arguments: '{}' } }, h.context);
    expect(JSON.parse(next.content).data.mode).toBe('unchanged');
  });

  it('点击后需要新快照，连续按键无需在每个键之间观察', async () => {
    const h = Harness();
    expect(JSON.parse((await h.run(`await page.click('@e1'); await page.fill('@e2','B')`, { pageRevision: 1 })).content)).toMatchObject({ ok: false, code: 'BROWSER_SNAPSHOT_CONTEXT_LOST' });
    expect(h.browser.Execute).toHaveBeenCalledOnce();
    const keys = await h.run(`await page.press('Tab'); await page.press('ArrowDown'); await page.press('Enter');`, {}, 'keys');
    expect(JSON.parse(keys.content).ok).toBe(true);
  });

  it('30 步上限、输出预算和取消均阻止后续动作', async () => {
    const h = Harness();
    const limited = await h.run(`for(let i=0;i<100;i++) await page.press('Tab');`);
    expect(JSON.parse(limited.content)).toMatchObject({ ok: false, code: 'BROWSER_SCRIPT_LIMIT', completedSteps: 30 });
    expect(h.browser.Execute).toHaveBeenCalledTimes(30);
    const slow = Harness({ delay: 1000 }); const controller = new AbortController(); slow.context.signal = controller.signal;
    const flight = slow.run(`await page.press('Tab'); await page.press('Enter');`);
    setTimeout(() => controller.abort(), 20);
    expect(JSON.parse((await flight).content).ok).toBe(false);
    expect(slow.browser.Execute).toHaveBeenCalledOnce();
  });

  it('Kernel 把冻结白名单注入脚本，减少模型往返且只提交一个外层工具结果', async () => {
    const h = Harness();
    const script = `await page.press('Tab'); await page.press('ArrowDown'); await page.press('Enter');`;
    const k = CreateKernelHarness({ tools: h.tools.GetToolDefinitions('application'),
      executeTool: (call, context) => h.tools.ExecuteToolCall(call, context),
      completions: [{ content: '', toolCalls: [{ id: 'kernel-script', type: 'function', function: { name: 'BrowserRunScript', arguments: JSON.stringify({ script }) } }] }, { content: 'done', toolCalls: [] }],
    });
    k.input.toolContext = h.context;
    k.input.toolContext.allowedToolNames = undefined;
    const outcome = await RunAgentLoop(k.input);
    expect(outcome.outcome).toBe('completed');
    expect(h.browser.Execute).toHaveBeenCalledTimes(3);
    expect(k.modules.modelProvider.StreamCompletion).toHaveBeenCalledTimes(2);
    expect(outcome.transcript.filter((m) => m.role === 'tool')).toHaveLength(1);
  });

  it('脚本子动作也计入场景工具总预算', async () => {
    const h = Harness();
    const k = CreateKernelHarness({ tools: h.tools.GetToolDefinitions('application'), executeTool: (call, context) => h.tools.ExecuteToolCall(call, context),
      completions: [{ content: '', toolCalls: [{ id: 'budget-script', type: 'function', function: { name: 'BrowserRunScript', arguments: JSON.stringify({ script: `for(let i=0;i<10;i++) await page.press('Tab');` }) } }] }, { content: 'done', toolCalls: [] }],
    });
    k.input.toolContext = h.context;
    k.input.scenario!.budgets.maxToolCalls = 3;
    const outcome = await RunAgentLoop(k.input);
    expect(h.browser.Execute).toHaveBeenCalledTimes(2);
    expect(JSON.parse(outcome.transcript.find((m) => m.role === 'tool')!.content)).toMatchObject({ code: 'TOOL_CALL_BUDGET_EXHAUSTED', completedSteps: 2 });
  });

  it('相同按键的新调用正常执行，同一调用重试仍保持幂等', async () => {
    const h = Harness();
    const call = (id: string) => h.tools.ExecuteToolCall({ id, type: 'function', function: { name: 'BrowserPressKey', arguments: '{"key":"Enter"}' } }, h.context);
    await call('enter-first'); await call('enter-second'); await call('enter-second');
    expect(h.browser.Execute).toHaveBeenCalledTimes(2);
  });
});
