import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentBrowserError, AgentBrowserRuntime, DetectBossRisk, IsBossBrowserUrl, NormalizePublicBrowserUrl, NormalizePersonalBrowserUrl } from '../../../apps/backend/src/electron/backend/agent-browser-runtime';
import { BrowserExtensionProtocolRevision, type BrowserExtensionBridge } from '../../../apps/backend/src/electron/backend/browser-extension-bridge';
import { DynamicSelectionVerificationExpression, FormSemanticEnrichmentExpression } from '../../../apps/backend/src/electron/backend/browser-form-driver';
import { PersonalBrowserCdpError, type PersonalBrowserRuntimePort } from '../../../apps/backend/src/electron/backend/personal-browser-cdp-runtime';

const temporaryRoots: string[] = [];
let nextTaskId = 0;

function EvalExpression(args: string[], stdin?: string): string {
  const base64Index = args.indexOf('-b');
  return base64Index >= 0 ? Buffer.from(args[base64Index + 1], 'base64').toString('utf8') : '';
}

function PersonalRuntimeStub(input: {
  connect?: () => Promise<{ anchorUrl: string }>;
  run?: (command: string[], options?: { stdin?: string }) => Promise<{ success: true; data: Record<string, any> }>;
} = {}): PersonalBrowserRuntimePort {
  let connected = false;
  const browserTaskId = `test-task-${++nextTaskId}`;
  return {
    GetBrowserTaskId: () => browserTaskId,
    Connect: vi.fn(async () => {
      const result = input.connect ? await input.connect() : { anchorUrl: 'https://www.zhipin.com/web/geek/job' };
      connected = true;
      return result;
    }),
    Run: vi.fn(input.run ?? (async (command) => {
      if (command[0] === 'get') return { success: true as const, data: { url: 'https://www.zhipin.com/web/geek/job' } };
      if (command[0] === 'snapshot') return { success: true as const, data: { refs: {} } };
      if (command[0] === 'tab') return { success: true as const, data: { tabs: [{ tabId: 'avery-task', targetId: 'task-target', url: 'https://www.zhipin.com/web/geek/job', active: true }] } };
      return { success: true as const, data: {} };
    })),
    ResetReferences: vi.fn(),
    IsConnected: vi.fn(() => connected),
    Close: vi.fn(async () => { connected = false; }),
  };
}

/** 表单测试沿用命令回执夹具，但执行端换为扩展任务驱动。 */
function CreateTestRuntime(options: Record<string, any>): AgentBrowserRuntime {
  let connected = false;
  const bridge = options.browserExtensionBridge ?? {
    EnsureConnected: vi.fn(async () => { connected = true; }),
    Start: vi.fn(async () => undefined),
    IsConnected: vi.fn(() => connected),
    Status: vi.fn(() => ({ connected, state: connected ? 'online' : 'offline', port: 17653 })),
    CloseTask: vi.fn(async () => ({ status: 'confirmed', browserTaskId: 'test-task', closedTabs: 1, unknownTabs: 0 })),
    Close: vi.fn(async () => { connected = false; }),
  } as unknown as BrowserExtensionBridge;
  const values = new Map<string, string>();
  const runtime = new AgentBrowserRuntime({
    runtimeRoot: options.runtimeRoot,
    resolveUploadFile: options.resolveUploadFile,
    browserExtensionBridge: bridge,
    externalBrowserPaths: options.externalBrowserPaths ?? { chrome: process.execPath, edge: process.execPath },
    ...(options.normalizeNavigationUrl ? { normalizeNavigationUrl: options.normalizeNavigationUrl } : {}),
    ...(options.delay ? { delay: options.delay } : {}),
    ...(options.recordLog ? { recordLog: options.recordLog } : {}),
    createExtensionRuntime: options.createExtensionRuntime ?? (() => PersonalRuntimeStub({ run: async (command, execution) => {
      const response = options.runBrowserCommand
        ? await options.runBrowserCommand({ args: command, stdin: execution?.stdin, deadline: execution?.deadline })
        : { success: true, data: {} };
      // 夹具在成功写入后保留真实值；只有页面夹具报告已保留时才回读，不能仅因动作成功就通过。
      if (command[0] === 'batch') {
        const rows = JSON.parse(execution?.stdin ?? '[]') as string[][];
        rows.forEach((row, i) => { if (response.data?.results?.[i]?.success === true) values.set(row[1].replace(/^@/, ''), row[2] ?? 'true'); });
      }
      if (command[0] === 'snapshot') for (const [ref, raw] of Object.entries(response.data?.refs ?? {})) {
        const field = raw as Record<string, unknown>;
        if (field.currentValue === undefined && (Number(field.valueLength) > 0 || (field.options as Array<{selected?:boolean}> | undefined)?.some(o => o.selected)) && values.has(ref)) field.currentValue = values.get(ref);
      }
      return response;
    } })),
  });
  const prepare = runtime.Prepare.bind(runtime);
  // 以下既有控件状态机测试用可见候选模拟 Agent 审阅；显式 mode 的协议测试不经过此辅助路径。
  runtime.Prepare = async input => {
    if (input.toolName !== 'BrowserFillForm' || input.arguments.mode !== undefined || input.arguments.planId) return prepare(input);
    const preview = await runtime.Execute({ proposal: await prepare({...input, arguments:{...input.arguments, mode:'plan'}}) });
    const data = preview.data as {continuationId:string; fields:Array<{fieldId:string;suggestedFactId?:string}>};
    return prepare({toolName:'BrowserFillForm', arguments:{mode:'execute',continuationId:data.continuationId,selections:data.fields.flatMap(f=>f.suggestedFactId?[{fieldId:f.fieldId,factId:f.suggestedFactId}]:[])}});
  };
  return runtime;
}

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('AgentBrowserRuntime', () => {
  it('飞书固定提取只允许冻结的招聘域名，后台读取需要导航授权',async()=>{
    const runtimeRoot=await mkdtemp(join(tmpdir(),'avery-feishu-origin-'));temporaryRoots.push(runtimeRoot);
    let currentUrl='https://test.jobs.feishu.cn/campus/';const evals:string[]=[];
    const runtime=CreateTestRuntime({runtimeRoot,resolveUploadFile:async()=>null,normalizeNavigationUrl:async(value:string)=>value,runBrowserCommand:async({args}:{args:string[]})=>{
      if(args[0]==='get')return{success:true,data:{url:currentUrl}};
      if(args[0]==='eval'){evals.push(args[2]);return{success:true,data:{result:{ready:true}}};}return{success:true,data:{}};
    }});
    try{
      expect(await runtime.EvaluateTrustedPage({site:'feishu',expectedOrigin:'https://test.jobs.feishu.cn',expression:'({ready:true})'})).toEqual({ready:true});
      await expect(runtime.EvaluateTrustedPage({site:'feishu',expectedOrigin:'https://other.jobs.feishu.cn',expression:'({})'})).rejects.toMatchObject({code:'BROWSER_NAVIGATION_DENIED'});
      currentUrl='https://test.jobs.feishu.cn.evil.example/campus/';
      await expect(runtime.EvaluateTrustedPage({site:'feishu',expectedOrigin:'https://test.jobs.feishu.cn.evil.example',expression:'({})'})).rejects.toMatchObject({code:'BROWSER_NAVIGATION_DENIED'});
      currentUrl='https://test.jobs.feishu.cn/campus/';await runtime.SetUnattended(true,{cronTaskId:'cron'});
      await expect(runtime.EvaluateTrustedPage({site:'feishu',expectedOrigin:'https://test.jobs.feishu.cn',expression:'({})'})).rejects.toMatchObject({code:'BROWSER_CRON_ACCESS_REQUIRED'});
      await runtime.SetUnattended(true,{cronTaskId:'cron',browserTaskGrant:{mode:'personal_browser_extension',purpose:'job_search',allowNavigation:false,allowFormFill:false,allowExternalSend:false,allowFileUpload:false,resourceIds:[],grantedAt:'2026-11-01T00:00:00Z'}});
      await expect(runtime.EvaluateTrustedPage({site:'feishu',expectedOrigin:'https://test.jobs.feishu.cn',expression:'({})'})).rejects.toMatchObject({code:'BROWSER_CRON_SCOPE_DENIED'});expect(evals).toHaveLength(1);
    }finally{await runtime.Close();}
  });
  it.each([true, false])('新任务冻结 closeTaskTabs=%s，后续切换偏好不改变旧任务，收尾仍撤销引用', async (closeTabs) => {
    const runtimeRoot = await mkdtemp(join(tmpdir(), 'avery-browser-close-policy-'));
    temporaryRoots.push(runtimeRoot);
    const bridge = {
      EnsureConnected: vi.fn(async () => undefined), Close: vi.fn(async () => undefined),
      CloseTask: vi.fn(async () => ({ status: 'confirmed' as const, browserTaskId: 'policy', closedTabs: 0, unknownTabs: 0 })),
    };
    const runtime = CreateTestRuntime({ runtimeRoot, resolveUploadFile: async () => null, browserExtensionBridge: bridge,
      createExtensionRuntime: () => PersonalRuntimeStub() });
    const navigate = async () => runtime.Execute({ proposal: await runtime.Prepare({ toolName: 'BrowserNavigate', arguments: { url: 'https://example.com/' } }) });
    try {
      await runtime.SetEngine('chrome');
      runtime.SetCloseTaskTabs(closeTabs);
      await navigate();
      const firstTask = runtime.GetBrowserTaskId();
      runtime.SetCloseTaskTabs(!closeTabs);
      await runtime.CloseTask();
      expect(bridge.CloseTask).toHaveBeenNthCalledWith(1, 'chrome', firstTask, expect.objectContaining({ closeTabs }));
      expect(runtime.GetBrowserTaskId()).toBeUndefined();
      await runtime.CloseTask();
      expect(bridge.CloseTask).toHaveBeenCalledOnce();
      await navigate();
      const nextTask = runtime.GetBrowserTaskId();
      expect(nextTask).not.toBe(firstTask);
      // 切换浏览器与普通完成共享同一清理策略，仍按新任务创建时的偏好执行。
      await runtime.SetEngine('edge');
      expect(bridge.CloseTask).toHaveBeenNthCalledWith(2, 'chrome', nextTask, expect.objectContaining({ closeTabs: !closeTabs }));
    } finally { await runtime.Close(); }
  });

  it('测评同步只允许指定的本地轮次页面，不向调用方接受任意表达式', async () => {
    const runtimeRoot = await mkdtemp(join(tmpdir(), 'avery-eval-flush-')); temporaryRoots.push(runtimeRoot);
    const url = 'http://127.0.0.1:43210/runs/00000000-0000-4000-8000-000000000000/';
    let currentUrl = url;
    const expressions: string[] = [];
    const runtime = CreateTestRuntime({ runtimeRoot, resolveUploadFile: vi.fn(), runBrowserCommand: async ({ args }: { args: string[] }) => {
      if (args[0] === 'get') return { success: true, data: { url: currentUrl } };
      if (args[0] === 'eval') { expressions.push(Buffer.from(args[2], 'base64').toString('utf8')); return { success: true, data: { result: { synced: true } } }; }
      return { success: true, data: {} };
    } });
    try {
      await runtime.FlushLocalEvaluationPage({ url, signal: new AbortController().signal });
      expect(expressions).toHaveLength(1); expect(expressions[0]).toContain('CareerBench.flush');
      currentUrl = 'https://example.com/';
      await expect(runtime.FlushLocalEvaluationPage({ url, signal: new AbortController().signal })).rejects.toMatchObject({ code: 'BROWSER_NAVIGATION_DENIED' });
      await expect(runtime.FlushLocalEvaluationPage({ url: 'http://127.0.0.1:43210/api/runs', signal: new AbortController().signal })).rejects.toMatchObject({ code: 'BROWSER_NAVIGATION_DENIED' });
      expect(expressions).toHaveLength(1);
    } finally { await runtime.Close(); }
  });
  it('规划不写入，执行只填显式选择；原生校验通过但回读错值仍报告业务失败', async () => {
    const runtimeRoot=await mkdtemp(join(tmpdir(),'avery-reviewed-form-'));temporaryRoots.push(runtimeRoot);
    let written=false;
    const commands: string[][]=[];
    const runtime=CreateTestRuntime({runtimeRoot,resolveUploadFile:vi.fn(),runBrowserCommand:async({args}: {args:string[]})=>{
      commands.push(args);
      if(args[0]==='get')return {success:true,data:{url:'https://example.com/form'}};
      if(args[0]==='snapshot')return {success:true,data:{refs:{e1:{role:'textbox',name:'姓名',required:true,valid:true,valueLength:written?4:0,currentValue:written?'项目经历':''}}}};
      if(args[0]==='batch')written=true;
      return {success:true,data:args[0]==='batch'?{results:[{success:true}]}:{}};
    }});
    const preview=await runtime.Execute({proposal:await runtime.Prepare({toolName:'BrowserFillForm',arguments:{mode:'plan',__formSources:{resume:{id:'r',name:'简历',content:'**张三** | test@example.com\n\n## 项目经历'}}}})});
    expect(commands.some(c=>c[0]==='batch')).toBe(false);
    const p=preview.data as {continuationId:string;facts:Array<{factId:string;field:string}>};
    const execution=await runtime.Execute({proposal:await runtime.Prepare({toolName:'BrowserFillForm',arguments:{mode:'execute',continuationId:p.continuationId,selections:[{fieldId:'f1',factId:p.facts.find(f=>f.field==='name')!.factId}]}})});
    expect(execution).toMatchObject({data:{filledCount:0,skipped:[{reason:'postcondition_failed'}]}});
    const validation=await runtime.Execute({proposal:await runtime.Prepare({toolName:'BrowserValidateForm',arguments:{}})});
    expect(validation).toMatchObject({data:{valid:true,businessValid:false,fieldChecks:[{expected:'张三',actual:'项目经历',status:'mismatch'}]}});
    await runtime.Close();
  });
  it('逐框填写并 Enter 可复用已观察引用，只在整批完成后获取核对快照', async () => {
    const runtimeRoot = await mkdtemp(join(tmpdir(), 'avery-input-enter-sequence-'));
    temporaryRoots.push(runtimeRoot);
    let snapshotCount = 0;
    const actions: string[][] = [];
    const personal = PersonalRuntimeStub({ run: async (command) => {
      if (command[0] === 'get') return { success: true, data: { url: 'https://example.com/form' } };
      if (command[0] === 'snapshot') {
        snapshotCount += 1;
        return { success: true, data: { refs: { e1: { tag: 'input', role: 'textbox', name: '姓名' }, e2: { tag: 'input', role: 'textbox', name: '邮箱' }, e3: { tag: 'input', role: 'textbox', name: '学校' } } } };
      }
      if (command[0] === 'fill' || command[0] === 'press') actions.push(command);
      return { success: true, data: command[0] === 'fill' ? { filled: true } : {} };
    } });
    const runtime = CreateTestRuntime({ runtimeRoot, resolveUploadFile: vi.fn(), createExtensionRuntime: () => personal });
    const execute = async (toolName: Parameters<AgentBrowserRuntime['Prepare']>[0]['toolName'], args: Record<string, unknown> = {}) => runtime.Execute({ proposal: await runtime.Prepare({ toolName, arguments: args }) });
    try {
      // 对比原流程：三个输入框各自观察一次，加上初始快照，共四次结构读取。
      let baseline = await execute('BrowserSnapshot');
      for (const [ref, text] of [['@e1', '测试姓名'], ['@e2', 'test@example.com'], ['@e3', '测试学校']]) {
        await execute('BrowserFill', { ref, pageRevision: (baseline.data as { pageRevision: number }).pageRevision, text });
        await execute('BrowserPressKey', { key: 'Enter' });
        baseline = await execute('BrowserSnapshot');
      }
      expect(snapshotCount).toBe(4);
      snapshotCount = 0;
      actions.length = 0;
      const initial = await execute('BrowserSnapshot');
      const pageRevision = (initial.data as { pageRevision: number }).pageRevision;
      for (const [ref, text] of [['@e1', '测试姓名'], ['@e2', 'test@example.com'], ['@e3', '测试学校']]) {
        await execute('BrowserFill', { ref, pageRevision, text });
        await expect(execute('BrowserPressKey', { key: 'Enter' })).resolves.toMatchObject({ data: { pageRevision, referencesPreserved: true } });
      }
      expect(snapshotCount).toBe(1);
      await execute('BrowserSnapshot');
      expect(snapshotCount).toBe(2);
      expect(actions.map((command) => command[0])).toEqual(['fill', 'press', 'fill', 'press', 'fill', 'press']);
      // 不是紧接填写的独立 Enter 仍清空引用，不能将所有按键都当作输入确认。
      await expect(execute('BrowserPressKey', { key: 'Enter' })).resolves.toMatchObject({ data: { referencesPreserved: false } });
      await expect(execute('BrowserFill', { ref: '@e1', pageRevision, text: '旧引用' })).rejects.toMatchObject({ code: 'BROWSER_STALE_PAGE_REF' });
    } finally { await runtime.Close(); }
  });
  it.each(['other-key', 'intermediate-read', 'failed-fill', 'changed-url'] as const)('输入确认引用保留不适用于 %s', async (scenario) => {
    const runtimeRoot = await mkdtemp(join(tmpdir(), 'avery-input-enter-boundary-'));
    temporaryRoots.push(runtimeRoot);
    let url = 'https://example.com/form';
    let failFill = false;
    const personal = PersonalRuntimeStub({ run: async (command) => {
      if (command[0] === 'get') return { success: true, data: { url } };
      if (command[0] === 'snapshot') return { success: true, data: { refs: { e1: { tag: 'input', role: 'textbox', name: '姓名' } } } };
      if (command[0] === 'fill' && failFill) throw new PersonalBrowserCdpError('BROWSER_STALE_PAGE_REF', 'The input was replaced.');
      return { success: true, data: command[0] === 'fill' ? { filled: true } : {} };
    } });
    const runtime = CreateTestRuntime({ runtimeRoot, resolveUploadFile: vi.fn(), createExtensionRuntime: () => personal });
    const execute = async (toolName: Parameters<AgentBrowserRuntime['Prepare']>[0]['toolName'], args: Record<string, unknown> = {}) => runtime.Execute({ proposal: await runtime.Prepare({ toolName, arguments: args }) });
    try {
      const initial = await execute('BrowserSnapshot');
      const pageRevision = (initial.data as { pageRevision: number }).pageRevision;
      await execute('BrowserFill', { ref: '@e1', pageRevision, text: '测试姓名' });
      if (scenario === 'intermediate-read') await execute('BrowserReadPage');
      if (scenario === 'failed-fill') {
        failFill = true;
        await expect(execute('BrowserFill', { ref: '@e1', pageRevision, text: '失败的填写' })).rejects.toMatchObject({ code: 'BROWSER_STALE_PAGE_REF' });
      }
      if (scenario === 'changed-url') url = 'https://example.com/next-step';
      await expect(execute('BrowserPressKey', { key: scenario === 'other-key' ? 'Tab' : 'Enter' })).resolves.toMatchObject({ data: { referencesPreserved: false } });
      await expect(execute('BrowserFill', { ref: '@e1', pageRevision, text: '过期引用' })).rejects.toMatchObject({ code: 'BROWSER_STALE_PAGE_REF' });
    } finally { await runtime.Close(); }
  });
  it('只通过扩展 Bridge 探测和执行任务，关闭任务不关闭共享 Bridge', async () => {
    const runtimeRoot = await mkdtemp(join(tmpdir(), 'avery-extension-only-runtime-'));
    temporaryRoots.push(runtimeRoot);
    let connected = false;
    const bridge = {
      Start: vi.fn(async () => undefined),
      EnsureConnected: vi.fn(async () => { connected = true; }),
      IsConnected: vi.fn(() => connected),
      Status: vi.fn(() => ({ connected, state: connected ? 'online' : 'offline', port: 17653 })),
      CloseTask: vi.fn(async (_engine: string, browserTaskId: string) => ({ status: 'confirmed', browserTaskId, closedTabs: 1, unknownTabs: 0 })),
      Close: vi.fn(async () => { connected = false; }),
    } as unknown as BrowserExtensionBridge;
    const createExtensionRuntime = vi.fn(() => PersonalRuntimeStub());
    const runtime = new AgentBrowserRuntime({
      runtimeRoot, resolveUploadFile: vi.fn(), browserExtensionBridge: bridge,
      externalBrowserPaths: { chrome: process.execPath }, createExtensionRuntime,
    });
    await runtime.SetEngine('chrome');
    await expect(runtime.GetStatus(true)).resolves.toMatchObject({ available: true, running: true, engine: 'chrome' });
    expect(createExtensionRuntime).not.toHaveBeenCalled();
    expect(await runtime.GetStatus()).not.toHaveProperty('profileExists');
    await expect(runtime.SetEngine('electron' as never)).rejects.toMatchObject({ code: 'BROWSER_ARGUMENT_INVALID' });
    const proposal = await runtime.Prepare({ toolName: 'BrowserSnapshot', arguments: {} });
    await expect(runtime.Execute({ proposal })).resolves.toMatchObject({ status: 'succeeded' });
    expect(createExtensionRuntime).toHaveBeenCalledTimes(1);
    await expect(runtime.CloseTask()).resolves.toMatchObject({ status: 'confirmed', closedTabs: 1 });
    expect((bridge.Close as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    await runtime.Close();
    expect((bridge.Close as ReturnType<typeof vi.fn>)).toHaveBeenCalledOnce();
  });

  it('BOSS SPA 在只读 Snapshot 准备后规范化 URL 时重新冻结观察提案', async () => {
    const runtimeRoot = await mkdtemp(join(tmpdir(), 'avery-browser-readonly-race-'));
    temporaryRoots.push(runtimeRoot);
    let currentUrl = 'https://www.zhipin.com/web/geek/job';
    let getCount = 0;
    const personalRuntime = PersonalRuntimeStub({ run: async (command) => {
      if (command[0] === 'open') currentUrl = command[1];
      if (command[0] === 'get') {
        getCount += 1;
        if (getCount >= 3) currentUrl = 'https://www.zhipin.com/web/geek/jobs';
        return { success: true, data: { url: currentUrl } };
      }
      if (command[0] === 'snapshot') return { success: true, data: { refs: {} } };
      if (command[0] === 'tab') return { success: true, data: { tabs: [{ tabId: 'avery-task', url: currentUrl, active: true }] } };
      return { success: true, data: {} };
    } });
    const runtime = CreateTestRuntime({
      runtimeRoot,
      resolveUploadFile: vi.fn(),
      createExtensionRuntime: () => personalRuntime,
    });

    await runtime.SetEngine('chrome');
    await runtime.Execute({ proposal: await runtime.Prepare({ toolName: 'BrowserNavigate', arguments: { url: currentUrl } }) });
    const proposal = await runtime.Prepare({ toolName: 'BrowserSnapshot', arguments: {} });
    await expect(runtime.Execute({ proposal })).resolves.toMatchObject({ status: 'succeeded', data: { currentUrl: 'https://www.zhipin.com/web/geek/jobs' } });
    await runtime.Close();
  });

  it('个人浏览器 CronTask 使用可信任务级授权，连接状态不再充当授权租约', async () => {
    const runtimeRoot = await mkdtemp(join(tmpdir(), 'avery-cron-browser-access-'));
    temporaryRoots.push(runtimeRoot);
    const personalRuntime = PersonalRuntimeStub();
    const runtime = CreateTestRuntime({
      runtimeRoot,
      resolveUploadFile: vi.fn(),
      normalizeNavigationUrl: async (value) => String(value),
      createExtensionRuntime: () => personalRuntime,
    });

    await runtime.SetEngine('chrome');
    const browserTaskGrant = {
      mode: 'personal_browser_extension' as const, purpose: 'job_search' as const,
      allowNavigation: true, allowFormFill: false, allowFileUpload: false, allowExternalSend: false,
      resourceIds: [], grantedAt: '2026-09-23T02:00:00.000Z',
    };
    await runtime.SetUnattended(true, { cronTaskId: 'cron-1', browserTaskGrant });
    await expect(runtime.Prepare({ toolName: 'BrowserNavigate', arguments: { url: 'https://www.zhipin.com/web/geek/job' } })).resolves.toMatchObject({ toolName: 'BrowserNavigate' });
    await expect(runtime.Prepare({ toolName: 'BrowserFill', arguments: { ref: '@e1', pageRevision: 0, text: 'x' } })).rejects.toMatchObject({ code: 'BROWSER_CRON_SCOPE_DENIED' });

    await runtime.SetUnattended(true, { cronTaskId: 'cron-application', browserTaskGrant: {
      ...browserTaskGrant, purpose: 'job_application', allowFormFill: true,
    } });
    await expect(runtime.Prepare({ toolName: 'BrowserPressKey', arguments: { key: 'Enter' } })).rejects.toMatchObject({ code: 'BROWSER_CRON_SCOPE_DENIED' });
    await expect(runtime.Prepare({ toolName: 'BrowserUploadFile', arguments: { ref: '@e1', pageRevision: 0, fileId: 'resume-file' } })).rejects.toMatchObject({ code: 'BROWSER_CRON_SCOPE_DENIED' });

    await runtime.SetUnattended(true, { cronTaskId: 'cron-revoked', browserTaskGrant: {
      ...browserTaskGrant, revokedAt: '2026-09-23T03:00:00.000Z',
    } });
    await expect(runtime.Prepare({ toolName: 'BrowserNavigate', arguments: { url: 'https://www.zhipin.com/web/geek/job' } })).rejects.toMatchObject({ code: 'BROWSER_CRON_ACCESS_REQUIRED' });

    await personalRuntime.Close();
    await runtime.SetUnattended(false);
    await runtime.SetUnattended(true, { cronTaskId: 'cron-other' });
    await expect(runtime.Prepare({ toolName: 'BrowserNavigate', arguments: { url: 'https://www.zhipin.com/web/geek/job' } })).rejects.toMatchObject({ code: 'BROWSER_CRON_ACCESS_REQUIRED' });
    await runtime.Close();
  });

  it('status_unknown cleanup 永久退役旧 browserTaskId，下一代 Runtime 使用隔离的新 task', async () => {
    const runtimeRoot = await mkdtemp(join(tmpdir(), 'avery-retired-browser-task-'));
    temporaryRoots.push(runtimeRoot);
    const bridge = {
      Status: () => ({
        port: 17653,
        state: 'online' as const,
        version: '0.2.0',
        actualVersion: '0.2.0',
        expectedVersion: '0.2.0',
        handshakeReceived: true,
        handshakeSource: 'hello' as const,
        protocolRevision: BrowserExtensionProtocolRevision,
        actualProtocolRevision: BrowserExtensionProtocolRevision,
        expectedProtocolRevision: BrowserExtensionProtocolRevision,
      }),
      EnsureConnected: vi.fn(async () => undefined),
      Request: vi.fn(async (_engine: string, _operation: string, payload: any) => ({ id: payload.id, result: { targetInfos: [] } })),
      CloseTask: vi.fn(async (_engine: string, browserTaskId: string) => ({
        status: 'status_unknown' as const, browserTaskId, code: 'BROWSER_COMMAND_TIMEOUT', closedTabs: 0, unknownTabs: 3,
      })),
      Close: vi.fn(async () => undefined),
    };
    const runtime = CreateTestRuntime({
      runtimeRoot,
      resolveUploadFile: vi.fn(),
      browserExtensionBridge: bridge as any,
    });

    await runtime.SetEngine('chrome');
    const firstRuntime = await (runtime as any).EnsurePersonalBrowserRuntime();
    const firstTaskId = firstRuntime.GetBrowserTaskId();
    await expect(runtime.CloseTask({ deadline: Date.now() + 1_000 })).resolves.toMatchObject({
      status: 'status_unknown', browserTaskId: firstTaskId, unknownTabs: 3,
    });
    expect((runtime as any).retiredBrowserTaskIds.has(firstTaskId)).toBe(true);

    const nextRuntime = await (runtime as any).EnsurePersonalBrowserRuntime();
    expect(nextRuntime.GetBrowserTaskId()).not.toBe(firstTaskId);
    expect(bridge.CloseTask).toHaveBeenCalledWith('chrome', firstTaskId, expect.objectContaining({ deadline: expect.any(Number) }));
    await runtime.Close();
  });

  it('BrowserScreenshot 只写入受控临时路径并以内联 PNG 返回后删除文件', async () => {
    const runtimeRoot = await mkdtemp(join(tmpdir(), 'avery-browser-screenshot-'));
    temporaryRoots.push(runtimeRoot);
    let screenshotPath = '';
    const runBrowserCommand = vi.fn(async ({ args }: { args: string[] }) => {
      const commandIndex = args.findIndex((arg) => ['open', 'get', 'tab', 'screenshot', 'close'].includes(arg));
      const command = args[commandIndex];
      if (command === 'tab') return { success: true, data: { tabs: [{ tabId: 't1', url: 'https://93.184.216.34/jobs', active: true }] } };
      if (command === 'get') return { success: true, data: { url: 'https://93.184.216.34/jobs' } };
      if (command === 'screenshot') {
        screenshotPath = args[commandIndex + 1];
        await writeFile(screenshotPath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
      }
      return { success: true, data: {} };
    });
    const runtime = CreateTestRuntime({
      runtimeRoot,
      resolveUploadFile: vi.fn(),
      runBrowserCommand,
    });

    const proposal = await runtime.Prepare({ toolName: 'BrowserScreenshot', arguments: {} });
    const result = await runtime.Execute({ proposal });

    expect(screenshotPath).toMatch(/[\\/]screenshots[\\/][0-9a-f-]+\.png$/i);
    expect(result).toMatchObject({ status: 'succeeded', data: { imageDataUrl: 'data:image/png;base64,iVBORw0KGgo=', byteSize: 8, pageRevision: 0 } });
    await expect(access(screenshotPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await runtime.Close();
  });

  it('BOSS 风控跳转停止导航且保留可见页面，不更换实例重试', async () => {
    const runtimeRoot = await mkdtemp(join(tmpdir(), 'avery-browser-boss-risk-'));
    temporaryRoots.push(runtimeRoot);
    const runBrowserCommand = vi.fn(async ({ args }: { args: string[] }) => {
      const command = args.find((arg) => ['open', 'get', 'tab', 'close'].includes(arg));
      if (command === 'get') return { success: true, data: { url: 'https://www.zhipin.com/web/user/safe' } };
      if (command === 'tab') return { success: true, data: { tabs: [{ tabId: 'boss-tab', url: 'about:blank', active: true }] } };
      return { success: true, data: {} };
    });
    const runtime = CreateTestRuntime({
      runtimeRoot, resolveUploadFile: vi.fn(), runBrowserCommand,
      normalizeNavigationUrl: async (value) => String(value),
    });

    const proposal = await runtime.Prepare({ toolName: 'BrowserNavigate', arguments: { url: 'https://www.zhipin.com/web/geek/job?query=agent' } });
    await expect(runtime.Execute({ proposal })).rejects.toMatchObject({ code: 'BROWSER_SITE_RISK_DETECTED' });
    expect(runBrowserCommand.mock.calls.filter(([input]) => input.args.includes('open'))).toHaveLength(1);
    await expect(runtime.GetStatus()).resolves.toMatchObject({ running: true, state: 'unhealthy', currentUrl: 'https://www.zhipin.com/web/user/safe' });
    await runtime.Close();
  });

  it('BOSS 风险识别只作用于真实主域和强特征文案', () => {
    expect(IsBossBrowserUrl('https://www.zhipin.com/job_detail/a.html')).toBe(true);
    expect(IsBossBrowserUrl('https://zhipin.com.evil.example/job')).toBe(false);
    expect(DetectBossRisk({ url: 'https://www.zhipin.com/web/geek/job', pageText: '安全工程岗位，负责验证码系统' })).toBeNull();
    expect(DetectBossRisk({ url: 'https://www.zhipin.com/web/geek/job', pageText: '访问过于频繁，请稍后重试' })).toBe('rate_limit');
  });

  it.each([
    'file:///etc/passwd',
    'javascript:alert(1)',
    'http://user:pass@example.com',
    'http://localhost/test',
    'http://127.0.0.1/test',
    'http://10.0.0.1/test',
    'http://[::1]/test',
  ])('拒绝受限导航地址 %s', async (url) => {
    await expect(NormalizePublicBrowserUrl(url, vi.fn() as never)).rejects.toMatchObject({ code: 'BROWSER_NAVIGATION_DENIED' });
  });

  it('DNS 任一结果落入私网时拒绝，公开地址被规范化', async () => {
    const mixedLookup = vi.fn(async () => [{ address: '93.184.216.34' }, { address: '192.168.1.2' }]);
    await expect(NormalizePublicBrowserUrl('https://example.test/jobs#top', mixedLookup as never)).rejects.toMatchObject({ code: 'BROWSER_NAVIGATION_DENIED' });
    const publicLookup = vi.fn(async () => [{ address: '93.184.216.34' }]);
    await expect(NormalizePublicBrowserUrl('example.test/jobs#top', publicLookup as never)).resolves.toBe('https://example.test/jobs');
  });

  it('个人浏览器保留 Moka 申请页的 hash 路由，同时拒绝危险协议与内嵌凭据', async () => {
    const url = 'https://app.mokahr.com/campus-recruitment/company/123?locale=zh-CN#/job/job-id/apply';
    await expect(NormalizePersonalBrowserUrl(url)).resolves.toBe(url);
    await expect(NormalizePersonalBrowserUrl('javascript:alert(1)')).rejects.toMatchObject({ code: 'BROWSER_NAVIGATION_DENIED' });
    await expect(NormalizePersonalBrowserUrl('https://user:password@app.mokahr.com/#/job/a/apply')).rejects.toMatchObject({ code: 'BROWSER_NAVIGATION_DENIED' });
  });

  it('构造期导航策略可收窄到测试 origin，默认策略仍拒绝本地地址', async () => {
    const runtimeRoot = await mkdtemp(join(tmpdir(), 'avery-browser-policy-'));
    temporaryRoots.push(runtimeRoot);
    const normalizeNavigationUrl = vi.fn(async (value: unknown) => {
      const url = new URL(String(value));
      if (url.origin !== 'http://127.0.0.1:43210') throw Object.assign(new Error('denied'), { code: 'BROWSER_NAVIGATION_DENIED' });
      return url.toString();
    });
    const runtime = CreateTestRuntime({
      runtimeRoot,
      resolveUploadFile: vi.fn(), normalizeNavigationUrl,
    });

    await expect(runtime.Prepare({ toolName: 'BrowserNavigate', arguments: { url: 'http://127.0.0.1:43210/jobs' } })).resolves.toMatchObject({ canonicalArguments: { url: 'http://127.0.0.1:43210/jobs' } });
    await expect(runtime.Prepare({ toolName: 'BrowserNavigate', arguments: { url: 'http://127.0.0.1:43211/jobs' } })).rejects.toMatchObject({ code: 'BROWSER_NAVIGATION_DENIED' });
    await expect(NormalizePublicBrowserUrl('http://127.0.0.1:43210/jobs')).rejects.toMatchObject({ code: 'BROWSER_NAVIGATION_DENIED' });
    expect(normalizeNavigationUrl).toHaveBeenCalledTimes(2);
  });

  it('BrowserFillForm 从私有档案计划匹配字段并通过扩展任务驱动批量填写', async () => {
    const runtimeRoot = await mkdtemp(join(tmpdir(), 'avery-browser-fill-form-'));
    temporaryRoots.push(runtimeRoot);
    const calls: Array<{ args: string[]; stdin?: string }> = [];
    let batchExecuted = false;
    const runBrowserCommand = vi.fn(async ({ args, stdin }: { args: string[]; stdin?: string }) => {
      calls.push({ args, ...(stdin === undefined ? {} : { stdin }) });
      const command = args.find((arg) => ['open', 'get', 'snapshot', 'tab', 'batch', 'close'].includes(arg));
      if (command === 'get') return { success: true, data: { url: 'https://93.184.216.34/application' } };
      if (command === 'snapshot') {
        return {
          success: true,
          data: {
            snapshot: '- textbox "姓名" [ref=e1]\n- textbox "邮箱" [ref=e2]\n- button "提交" [ref=e3]\n- textbox "密码" [ref=e4]',
            refs: {
              e1: { role: 'textbox', name: '姓名', type: 'text', valueLength: batchExecuted ? 1 : 0 },
              e2: { role: 'textbox', name: '邮箱', type: 'email', valueLength: batchExecuted ? 1 : 0 },
              e3: { role: 'button', name: '提交' },
              e4: { role: 'textbox', name: '密码', type: 'password' },
              e5: { tag: 'input', role: 'textbox', name: '身份证号码', type: 'text', valueLength: batchExecuted ? 1 : 0 },
              e6: { tag: 'select', role: 'combobox', name: '性别', options: [{ label: '请选择', value: '' }, { label: '男', value: 'male', selected: batchExecuted }] },
              e7: { role: 'textbox', name: '字段 7', type: 'text' },
              e8: { role: 'textbox', name: '字段 8', type: 'text' },
              e9: { role: 'combobox', name: '手机号码' },
              e10: { role: 'textbox', name: '手机号码', type: 'tel', valueLength: batchExecuted ? 1 : 0 },
              e11: { role: 'textbox', name: '学校名称', type: 'text', valueLength: batchExecuted ? 1 : 0 },
              e12: { role: 'textbox', name: '项目中职责', type: 'text', valueLength: batchExecuted ? 1 : 0 },
            },
          },
        };
      }
      if (command === 'tab') return { success: true, data: { tabs: [
        { tabId: 'home', url: 'https://93.184.216.34/ready', active: true },
        { tabId: 't1', url: 'https://93.184.216.34/application', active: false },
      ] } };
      if (command === 'batch') {
        batchExecuted = true;
        return { success: true, data: { results: JSON.parse(stdin ?? '[]').map((_: unknown, index: number) => index === 0
          ? { success: false, error: 'field rejected the value' }
          : { success: true }) } };
      }
      return { success: true, data: {} };
    });
    const runtime = CreateTestRuntime({
      runtimeRoot,
      resolveUploadFile: vi.fn(),
      runBrowserCommand,
    });

    const navigate = await runtime.Prepare({ toolName: 'BrowserNavigate', arguments: { url: 'https://93.184.216.34/application' } });
    await runtime.Execute({ proposal: navigate });
    const snapshot = await runtime.Prepare({ toolName: 'BrowserSnapshot', arguments: {} });
    const observed = await runtime.Execute({ proposal: snapshot });
    const pageRevision = (observed.data as { pageRevision: number }).pageRevision;
    const name = '张三 "Agent"';
    const email = 'x@example.com"], ["click", "@e3';
    const idNumber = '110101199001011234';
    const phone = '13800138000';
    const school = '测试大学';
    const projectResponsibility = '负责工具编排';
    const proposal = await runtime.Prepare({
      toolName: 'BrowserFillForm',
      arguments: {
        pageRevision,
        profileIds: ['profile-1', 'education-1', 'project-1'],
        __formSources: { profiles: [
          { id: 'profile-1', category: 'application', title: '个人信息', content: `[个人信息]\n姓名：${name}\n邮箱：${email}\n手机号：${phone}\n证件号码：${idNumber}\n性别：男` },
          { id: 'education-1', category: 'education', title: '教育经历', content: `[教育经历]\n学校：${school}` },
          { id: 'project-1', category: 'project', title: '项目经历', content: `[项目经历]\n项目职责：${projectResponsibility}` },
        ] },
      },
    });
    expect(JSON.stringify(proposal)).not.toContain(name);
    expect(JSON.stringify(proposal)).not.toContain(email);
    expect(JSON.stringify(proposal)).not.toContain(idNumber);
    expect(JSON.stringify(proposal)).not.toContain(phone);
    expect(proposal.canonicalArguments).toMatchObject({ mode: 'execute', continuationId: expect.any(String), planId: expect.any(String), planHash: expect.any(String) });
    const outcome = await runtime.Execute({ proposal });

    const batchCalls = calls.filter((call) => call.args.includes('batch'));
    expect(batchCalls).toHaveLength(1);
    expect(batchCalls[0].args).toEqual(['batch']);
    expect(batchCalls[0].args.join(' ')).not.toContain(name);
    expect(batchCalls[0].args.join(' ')).not.toContain(email);
    expect(batchCalls[0].args.join(' ')).not.toContain(idNumber);
    expect(JSON.parse(batchCalls[0].stdin ?? '')).toEqual([
      ['fill', '@e1', name], ['fill', '@e2', email], ['fill', '@e5', idNumber], ['fill', '@e10', phone],
      ['fill', '@e11', school], ['fill', '@e12', projectResponsibility], ['select', '@e6', 'male'],
    ]);
    expect(outcome).toMatchObject({ status: 'succeeded', data: {
      filledCount: 6,
      skipped: [{ fieldId: 'field-e1', label: '姓名', reason: 'command_failed' }],
      pageRevision: expect.any(Number),
      currentUrl: 'https://93.184.216.34/application',
    } });

    await expect(runtime.Prepare({ toolName: 'BrowserFillForm', arguments: { profileIds: ['profile-1'] } })).rejects.toMatchObject({ code: 'BROWSER_FORM_SOURCE_REQUIRED' });
    await expect(runtime.Prepare({ toolName: 'BrowserFillForm', arguments: { pageRevision: pageRevision - 1, profileIds: ['profile-1'], __formSources: { profiles: [] } } })).rejects.toMatchObject({ code: 'BROWSER_STALE_PAGE_REF' });
    expect(calls.filter((call) => call.args.includes('batch'))).toHaveLength(1);
    await runtime.Close();
  });

  it('BrowserInspectForm 使用同组标签和章节生成语义特征并由 BrowserFillForm 自动填写', async () => {
    const runtimeRoot = await mkdtemp(join(tmpdir(), 'avery-browser-semantic-form-'));
    temporaryRoots.push(runtimeRoot);
    const batchInputs: string[] = [];
    let batchExecuted = false;
    const runBrowserCommand = vi.fn(async ({ args, stdin }: { args: string[]; stdin?: string }) => {
      const command = args.find((arg) => ['open', 'get', 'snapshot', 'tab', 'batch', 'eval', 'close'].includes(arg));
      if (command === 'get') return { success: true, data: { url: 'https://93.184.216.34/application' } };
      if (command === 'snapshot') return { success: true, data: { refs: {
        e2: {
          role: 'textbox', tag: 'input', name: '请输入', type: 'text', section: '教育经历',
          nearbyTexts: ['学校名称'], precedingLabels: ['学历'], followingLabels: ['专业名称'], groupHeading: '教育经历 1', recordIndex: 0,
          valueLength: batchExecuted ? 1 : 0,
        },
      } } };
      if (command === 'tab') return { success: true, data: { tabs: [{ tabId: 't1', url: 'https://93.184.216.34/application', active: true }] } };
      if (command === 'batch') { batchExecuted = true; batchInputs.push(stdin ?? ''); return { success: true, data: { results: [{ success: true }] } }; }
      return { success: true, data: {} };
    });
    const runtime = CreateTestRuntime({
      runtimeRoot, resolveUploadFile: vi.fn(), runBrowserCommand,
    });

    await runtime.Execute({ proposal: await runtime.Prepare({ toolName: 'BrowserNavigate', arguments: { url: 'https://93.184.216.34/application' } }) });
    const inspection = await runtime.Execute({ proposal: await runtime.Prepare({ toolName: 'BrowserInspectForm', arguments: {} }) });
    expect(inspection).toMatchObject({ data: { fields: [{
      fieldId: 'field-e2', pageRevision: expect.any(Number), label: '请输入',
      raw: { nearbyTexts: ['学校名称'] },
      context: { section: 'education', recordIndex: 0, groupHeading: '教育经历 1' },
      semantic: { concept: 'education.school', valueType: 'text', confidence: 1 },
      interaction: { kind: 'input', editable: true },
    }] } });

    const outcome = await runtime.Execute({ proposal: await runtime.Prepare({
      toolName: 'BrowserFillForm',
      arguments: {
        pageRevision: (inspection.data as any).pageRevision,
        profileIds: ['education-1'],
        __formSources: { profiles: [{ id: 'education-1', category: 'education', title: '教育经历', content: '[教育经历]\n学校：测试大学' }] },
      },
    }) });
    expect(JSON.parse(batchInputs[0])).toEqual([['fill', '@e2', '测试大学']]);
    expect(outcome).toMatchObject({ data: { filled: [{ fieldId: 'field-e2', concept: 'education.school', strategy: 'agent' }], ambiguous: [], unmatched: [] } });
    await runtime.Close();
  });

  it('BrowserFillForm 全局保留高分匹配，不让靠前的低分字段占用不可复用资料', async () => {
    const runtimeRoot = await mkdtemp(join(tmpdir(), 'avery-browser-global-form-match-'));
    temporaryRoots.push(runtimeRoot);
    const batchInputs: string[] = [];
    let batchExecuted = false;
    const runBrowserCommand = vi.fn(async ({ args, stdin }: { args: string[]; stdin?: string }) => {
      const command = args.find((arg) => ['open', 'get', 'snapshot', 'tab', 'batch', 'close'].includes(arg));
      if (command === 'get') return { success: true, data: { url: 'https://93.184.216.34/application' } };
      if (command === 'snapshot') return { success: true, data: { refs: {
        e2: { role: 'textbox', tag: 'input', name: '请输入', section: '教育经历', nearbyTexts: ['院校信息'], recordIndex: 0 },
        e3: { role: 'textbox', tag: 'input', name: '学校', section: '教育经历', recordIndex: 0, valueLength: batchExecuted ? 1 : 0 },
      } } };
      if (command === 'tab') return { success: true, data: { tabs: [{ tabId: 't1', url: 'https://93.184.216.34/application', active: true }] } };
      if (command === 'batch') { batchExecuted = true; batchInputs.push(stdin ?? ''); return { success: true, data: { results: [{ success: true }] } }; }
      return { success: true, data: {} };
    });
    const runtime = CreateTestRuntime({
      runtimeRoot, resolveUploadFile: vi.fn(), runBrowserCommand,
    });

    await runtime.Execute({ proposal: await runtime.Prepare({ toolName: 'BrowserNavigate', arguments: { url: 'https://93.184.216.34/application' } }) });
    const inspection = await runtime.Execute({ proposal: await runtime.Prepare({ toolName: 'BrowserInspectForm', arguments: {} }) });
    const outcome = await runtime.Execute({ proposal: await runtime.Prepare({
      toolName: 'BrowserFillForm',
      arguments: {
        pageRevision: (inspection.data as any).pageRevision,
        profileIds: ['education-1'],
        __formSources: { profiles: [{ id: 'education-1', category: 'education', title: '教育经历', content: '[教育经历]\n学校：测试大学' }] },
      },
    }) });

    expect(JSON.parse(batchInputs[0])).toEqual([['fill', '@e3', '测试大学']]);
    expect(outcome).toMatchObject({ data: {
      filled: [{ fieldId: 'field-e3', strategy: 'agent' }],
      unmatched: [],
    } });
    await runtime.Close();
  });

  it('BrowserFillForm 对接近候选返回歧义，并接受 Agent 指定的授权 sourcePath 续填', async () => {
    const runtimeRoot = await mkdtemp(join(tmpdir(), 'avery-browser-agent-form-mapping-'));
    temporaryRoots.push(runtimeRoot);
    const batchInputs: string[] = [];
    let batchExecuted = false;
    const refs = () => ({
      e4: { role: 'textbox', tag: 'textarea', name: '项目描述与项目职责', section: '项目经历', required: true, valueLength: batchExecuted ? 1 : 0 },
      e5: { role: 'combobox', tag: 'select', name: '性别', section: '个人信息', options: [{ label: '男', value: 'male' }] },
    });
    const runBrowserCommand = vi.fn(async ({ args, stdin }: { args: string[]; stdin?: string }) => {
      const command = args.find((arg) => ['open', 'get', 'snapshot', 'tab', 'batch', 'eval', 'close'].includes(arg));
      if (command === 'get') return { success: true, data: { url: 'https://93.184.216.34/application' } };
      if (command === 'snapshot') return { success: true, data: { refs: refs() } };
      if (command === 'tab') return { success: true, data: { tabs: [{ tabId: 't1', url: 'https://93.184.216.34/application', active: true }] } };
      if (command === 'batch') { batchExecuted = true; batchInputs.push(stdin ?? ''); return { success: true, data: { results: [{ success: true }] } }; }
      return { success: true, data: {} };
    });
    const runtime = CreateTestRuntime({
      runtimeRoot, resolveUploadFile: vi.fn(), runBrowserCommand,
    });
    const sources = { profiles: [{
      id: 'project-1', category: 'project', title: '项目经历',
      content: '[项目经历]\n项目描述：用于验证混合匹配\n项目职责：负责字段匹配',
    }] };

    await runtime.Execute({ proposal: await runtime.Prepare({ toolName: 'BrowserNavigate', arguments: { url: 'https://93.184.216.34/application' } }) });
    const first = await runtime.Execute({ proposal: await runtime.Prepare({ toolName: 'BrowserFillForm', arguments: {
      mode:'plan', profileIds: ['project-1'], __formSources: sources,
    } }) });
    const candidates = (first.data as any).facts as Array<{factId:string;concept:string}>;
    const unresolved = (first.data as any).fields[0] as {fieldId:string};
    const responsibility = candidates.find((candidate) => candidate.concept === 'project.responsibility');
    expect(responsibility).toBeDefined();
    expect(batchInputs).toHaveLength(0);
    await expect(runtime.Prepare({ toolName: 'BrowserFillForm', arguments: {
      continuationId: (first.data as any).continuationId,
      mode:'execute', selections: [{ fieldId: 'f999', factId: 's999' }],
    } })).rejects.toMatchObject({ code: 'BROWSER_FORM_REVIEW_INVALID' });

    const second = await runtime.Execute({ proposal: await runtime.Prepare({ toolName: 'BrowserFillForm', arguments: {
      continuationId: (first.data as any).continuationId,
      mode:'execute', selections: [{ fieldId: unresolved.fieldId, factId: responsibility!.factId }],
    } }) });
    expect(JSON.parse(batchInputs[0])).toEqual([['fill', '@e4', '负责字段匹配']]);
    expect(second).toMatchObject({ data: { filled: [{ fieldId: 'field-e4', concept: 'project.responsibility', strategy: 'agent' }] } });
    await runtime.Close();
  });

  it('BrowserInspectForm 与 BrowserValidateForm 返回紧凑字段和必填问题且不回显字段值', async () => {
    const runtimeRoot = await mkdtemp(join(tmpdir(), 'avery-browser-form-inspection-'));
    temporaryRoots.push(runtimeRoot);
    const calls: Array<{ args: string[]; stdin?: string }> = [];
    const runBrowserCommand = vi.fn(async ({ args, stdin }: { args: string[]; stdin?: string }) => {
      calls.push({ args, stdin });
      const command = args.find((arg) => ['open', 'get', 'snapshot', 'tab', 'close'].includes(arg));
      if (command === 'get') return { success: true, data: { url: 'https://93.184.216.34/application' } };
      if (command === 'snapshot') return { success: true, data: {
        refs: {
          e1: { tag: 'input', role: 'textbox', name: '姓名', type: 'text', required: true, valueLength: 0, valid: false, validationMessage: '请填写此字段。' },
          e2: { tag: 'select', role: 'combobox', name: '城市', required: true, valid: true, options: [{ label: '请选择', value: '', selected: true }, { label: '上海', value: 'shanghai' }] },
          e3: { tag: 'input', role: 'textbox', name: '密码', type: 'password', required: true, valueLength: 6 },
          e4: { tag: 'button', role: 'button', name: '提交' },
          e5: { tag: 'input', role: 'textbox', name: '__avery_internal_form_control__', type: 'text' },
        },
      } };
      if (command === 'tab') return { success: true, data: { tabs: [
        { tabId: 'home', url: 'https://93.184.216.34/ready', active: true },
        { tabId: 't1', url: 'https://93.184.216.34/application', active: false },
      ] } };
      return { success: true, data: {} };
    });
    const runtime = CreateTestRuntime({
      runtimeRoot,
      resolveUploadFile: vi.fn(),
      runBrowserCommand,
    });

    const navigate = await runtime.Prepare({ toolName: 'BrowserNavigate', arguments: { url: 'https://93.184.216.34/application' } });
    await runtime.Execute({ proposal: navigate });
    const inspection = await runtime.Execute({ proposal: await runtime.Prepare({ toolName: 'BrowserInspectForm', arguments: {} }) });
    expect(inspection.data).toMatchObject({
      fieldCount: 2,
      fields: [
        { ref: '@e1', label: '姓名', control: 'text', required: true, filled: false },
        { ref: '@e2', label: '城市', control: 'select', required: true, filled: false },
      ],
    });
    expect(JSON.stringify(inspection.data)).not.toContain('密码');
    expect(JSON.stringify(inspection.data)).not.toContain('__avery_internal_form_control__');

    const validation = await runtime.Execute({ proposal: await runtime.Prepare({ toolName: 'BrowserValidateForm', arguments: {} }) });
    expect(validation.data).toMatchObject({
      valid: false,
      validationMetadataAvailable: true,
      issues: [
        { ref: '@e1', label: '姓名', code: 'required' },
        { ref: '@e2', label: '城市', code: 'required' },
      ],
    });
    expect(calls.filter((call) => call.args.includes('snapshot'))).toHaveLength(2);
    const enrichmentCalls = calls.filter((call) => call.args.includes('eval'));
    expect(enrichmentCalls).toHaveLength(8);
    const expressions = enrichmentCalls.map((call) => EvalExpression(call.args, call.stdin));
    const inspectTransport = enrichmentCalls.find((call) => EvalExpression(call.args, call.stdin) === FormSemanticEnrichmentExpression);
    expect(inspectTransport?.args.slice(0, 2)).toEqual(['eval', '-b']);
    for (const value of expressions) expect(() => new Function(value)).not.toThrow();
    const expression = expressions.find((value) => value.includes('previousElementSibling')) ?? '';
    expect(expression).toContain('previousElementSibling');
    expect(expression).toContain('depth < 10');
    expect(expression).toContain('data-avery-form-semantic');
    expect(expression).not.toContain(',div,span');
    expect(expression).toContain("v: filled");
    expect(expression).not.toContain("value: String(element.value");
    expect(expressions.some((value) => value.includes("querySelectorAll('[data-avery-form-semantic]')"))).toBe(true);
    await runtime.Close();
  });

  it('BrowserFillForm 在 Host 内连续选择两级自定义所在地菜单', async () => {
    const runtimeRoot = await mkdtemp(join(tmpdir(), 'avery-browser-custom-select-'));
    temporaryRoots.push(runtimeRoot);
    let menu: 'form' | 'province' | 'city' | 'confirm' | 'done' = 'form';
    const clicks: string[] = [];
    const evalExpressions: string[] = [];
    const runBrowserCommand = vi.fn(async ({ args, stdin }: { args: string[]; stdin?: string }) => {
      const commandIndex = args.findIndex((arg) => ['open', 'get', 'snapshot', 'tab', 'click', 'eval', 'close'].includes(arg));
      const command = args[commandIndex];
      if (command === 'eval') {
        const expression = EvalExpression(args, stdin);
        evalExpressions.push(expression);
        if (expression.includes("const triggers = [...document.querySelectorAll('[data-avery-form-semantic=\"custom-select\"]')]")) {
          return { success: true, data: { result: { filled: menu === 'done' } } };
        }
      }
      if (command === 'tab') return { success: true, data: { tabs: [{ tabId: 't1', url: 'https://93.184.216.34/application', active: true }] } };
      if (command === 'get') return { success: true, data: { url: 'https://93.184.216.34/application' } };
      if (command === 'click') {
        const ref = args[commandIndex + 1];
        clicks.push(ref);
        if (ref === '@e2') menu = 'province';
        else if (ref === '@e10') menu = 'city';
        else if (ref === '@e11') menu = 'city';
        else if (ref === '@e12') menu = 'form';
        else if (ref === '@e13') menu = 'confirm';
        else if (ref === '@e14') menu = 'done';
        return { success: true, data: {} };
      }
      if (command === 'snapshot') {
        if (menu === 'province') return { success: true, data: {
          snapshot: '- option "广东省" [ref=e10] clickable\n- radio "广东省" [ref=e12] clickable',
          refs: { e10: { role: 'option', name: '广东省' }, e12: { role: 'radio', name: '广东省' } },
        } };
        if (menu === 'city') return { success: true, data: {
          snapshot: '- option "佛山市" [ref=e11] clickable\n- radio "佛山市" [ref=e13] clickable',
          refs: { e11: { role: 'option', name: '佛山市' }, e13: { role: 'radio', name: '佛山市' } },
        } };
        if (menu === 'confirm') return { success: true, data: { snapshot: '- listitem "确定" [level=1, ref=e14]', refs: { e14: { role: 'listitem', name: '确定' } } } };
        return { success: true, data: { snapshot: '- combobox "期望城市" [ref=e2]', refs: { e2: { role: 'combobox', name: '期望城市' } } } };
      }
      return { success: true, data: {} };
    });
    const runtime = CreateTestRuntime({
      runtimeRoot,
      resolveUploadFile: vi.fn(),
      runBrowserCommand,
      delay: vi.fn(async () => undefined),
    });

    await runtime.Execute({ proposal: await runtime.Prepare({ toolName: 'BrowserNavigate', arguments: { url: 'https://93.184.216.34/application' } }) });
    const inspection = await runtime.Execute({ proposal: await runtime.Prepare({ toolName: 'BrowserInspectForm', arguments: {} }) });
    const pageRevision = (inspection.data as any).pageRevision;
    const proposal = await runtime.Prepare({
      toolName: 'BrowserFillForm',
      arguments: {
        pageRevision,
        profileIds: ['profile-location'],
        __formSources: { profiles: [{ id: 'profile-location', category: 'job_intention', title: '求职意向', content: '[求职意向]\n期望城市：广东佛山' }] },
      },
    });
    const outcome = await runtime.Execute({ proposal });

    expect(clicks).toEqual(['@e2', '@e10', '@e11', '@e13', '@e14']);
    expect(evalExpressions.some((expression) => expression.includes('data-avery-dynamic-option'))).toBe(true);
    expect(evalExpressions.some((expression) => expression.includes('typeof element.onclick'))).toBe(true);
    expect(evalExpressions.some((expression) => expression.includes('geographic(display)'))).toBe(true);
    expect(evalExpressions.some((expression) => expression.includes('other.selectionControl && !candidate.selectionControl'))).toBe(true);
    expect(evalExpressions.some((expression) => expression.includes("|| getComputedStyle(element).cursor === 'pointer'"))).toBe(true);
    for (const expression of evalExpressions) expect(() => new Function(expression)).not.toThrow();
    expect(outcome).toMatchObject({ status: 'succeeded', data: { filledCount: 1, missingFields: [] } });
    expect(outcome).toMatchObject({ data: { filled: [{expected:'广东佛山'}] } });
    await runtime.Close();
  });

  it('地区后置校验拒绝只包含父级的结果', () => {
    const operation = {
      kind: 'custom_select', ref: '@e2', key: 'residence', occurrence: 0, value: '广东省佛山市', label: '现居住地',
      sourceTitle: '投递档案', sourcePath: 'profile:location', sourcePaths: ['profile:location'], concept: 'personal.residence', strategy: 'semantic',
    } as const;
    class ElementStub {
      innerText = '';
      textContent = '';
      constructor(text = '') { this.innerText = text; this.textContent = text; }
      getAttribute(name: string) { return name === 'data-avery-form-key' ? 'residence' : '现居住地'; }
      closest() { return this; }
      querySelectorAll() { return []; }
    }
    const verify = (display: string, selected: string[]) => {
      const trigger = new ElementStub(display);
      const documentStub = { querySelectorAll: () => [trigger] };
      const expression = DynamicSelectionVerificationExpression(operation, selected);
      return new Function('document', 'HTMLElement', `return ${expression}`)(documentStub, ElementStub);
    };

    expect(verify('广东省', ['广东省'])).toEqual({ filled: false });
    expect(verify('广东省 佛山市', ['广东省', '佛山市'])).toEqual({ filled: true });
  });

  it('日期后置校验按年月数值比较，不因页面省略前导零误报失败', () => {
    const operation = {
      kind: 'custom_date', ref: '@e2', key: 'endDate', occurrence: 0, value: '2027-06', label: '毕业时间',
      sourceTitle: '教育经历', sourcePath: 'profile:education', sourcePaths: ['profile:education'], concept: 'education.endDate', strategy: 'semantic',
    } as const;
    class ElementStub {
      innerText = '毕业时间 2027年6月';
      textContent = this.innerText;
      parentElement = undefined;
      getAttribute(name: string) { return name === 'data-avery-form-key' ? 'endDate' : '毕业时间'; }
      querySelectorAll() { return []; }
    }
    const trigger = new ElementStub();
    const expression = DynamicSelectionVerificationExpression(operation, ['2027-06']);
    const result = new Function('document', 'HTMLElement', 'HTMLInputElement', 'HTMLTextAreaElement', `return ${expression}`)(
      { querySelectorAll: () => [trigger] }, ElementStub, class {}, class {},
    );

    expect(result).toEqual({ filled: true });
  });

  it('BrowserFillForm 主动关闭前一弹层后连续填写两个相似下拉菜单', async () => {
    const runtimeRoot = await mkdtemp(join(tmpdir(), 'avery-browser-consecutive-selects-'));
    temporaryRoots.push(runtimeRoot);
    let overlay: 'political' | 'degree' | null = null;
    const clicks: string[] = [];
    const selected = new Set<string>();
    const delay = vi.fn(async () => undefined);
    const runBrowserCommand = vi.fn(async ({ args, stdin }: { args: string[]; stdin?: string }) => {
      const commandIndex = args.findIndex((arg) => ['open', 'get', 'snapshot', 'tab', 'click', 'press', 'eval', 'scrollintoview', 'scroll', 'close'].includes(arg));
      const command = args[commandIndex];
      if (command === 'tab') return { success: true, data: { tabs: [{ tabId: 't1', url: 'https://93.184.216.34/application', active: true }] } };
      if (command === 'get') return { success: true, data: { url: 'https://93.184.216.34/application' } };
      if (command === 'eval') {
        const expression = EvalExpression(args, stdin);
        if (expression.includes('const overlays =')) {
          const toggled = overlay !== null;
          overlay = null;
          return { success: true, data: { result: { toggled } } };
        }
        if (expression.includes("const triggers = [...document.querySelectorAll('[data-avery-form-semantic=\"custom-select\"]')]")) {
          return { success: true, data: { result: { filled: selected.size > 0 } } };
        }
      }
      if (command === 'click') {
        const ref = args[commandIndex + 1];
        clicks.push(ref);
        if (ref === '@e2') {
          if (overlay) throw new AgentBrowserError('BROWSER_COMMAND_FAILED', "Element '@e2' is covered by an earlier dropdown.");
          overlay = 'political';
        } else if (ref === '@e3') {
          if (overlay) throw new AgentBrowserError('BROWSER_COMMAND_FAILED', "Element '@e3' is covered by an earlier dropdown.");
          overlay = 'degree';
        } else if (ref === '@e20') selected.add('群众');
        else if (ref === '@e30') selected.add('本科');
        return { success: true, data: {} };
      }
      if (command === 'snapshot') {
        if (overlay === 'political') return { success: true, data: { snapshot: '- listitem "群众" [level=1, ref=e20]', refs: { e20: { role: 'listitem', name: '群众' } } } };
        if (overlay === 'degree') return { success: true, data: { snapshot: '- listitem "本科" [level=1, ref=e30]', refs: { e30: { role: 'listitem', name: '本科' } } } };
        return { success: true, data: { refs: {
          e2: { role: 'combobox', name: '政治面貌' },
          e3: { role: 'combobox', name: '学历' },
        } } };
      }
      return { success: true, data: {} };
    });
    const runtime = CreateTestRuntime({
      runtimeRoot, resolveUploadFile: vi.fn(), runBrowserCommand, delay,
    });

    await runtime.Execute({ proposal: await runtime.Prepare({ toolName: 'BrowserNavigate', arguments: { url: 'https://93.184.216.34/application' } }) });
    const inspection = await runtime.Execute({ proposal: await runtime.Prepare({ toolName: 'BrowserInspectForm', arguments: {} }) });
    const outcome = await runtime.Execute({ proposal: await runtime.Prepare({
      toolName: 'BrowserFillForm',
      arguments: {
        pageRevision: (inspection.data as any).pageRevision,
        profileIds: ['personal-selects', 'education-selects'],
        __formSources: { profiles: [
          { id: 'personal-selects', category: 'application', title: '个人信息', content: '[个人信息]\n政治面貌：群众' },
          { id: 'education-selects', category: 'education', title: '教育经历', content: '[教育经历]\n学历：本科' },
        ] },
      },
    }) });

    expect(clicks).toEqual(['@e2', '@e20', '@e3', '@e30']);
    expect([...selected]).toEqual(['群众', '本科']);
    expect(delay).toHaveBeenCalledWith(240, undefined);
    expect(outcome).toMatchObject({ status: 'succeeded', data: { filledCount: 2, skipped: [] } });
    await runtime.Close();
  });

  it('BrowserFillForm 不会把未确认的地区选择误报为成功', async () => {
    const runtimeRoot = await mkdtemp(join(tmpdir(), 'avery-browser-region-confirmation-'));
    temporaryRoots.push(runtimeRoot);
    let menu: 'form' | 'province' | 'city' = 'form';
    const dynamicDeadlines: number[] = [];
    const runBrowserCommand = vi.fn(async ({ args, stdin, deadline }: { args: string[]; stdin?: string; deadline: number }) => {
      const commandIndex = args.findIndex((arg) => ['open', 'get', 'snapshot', 'tab', 'click', 'eval', 'press', 'scrollintoview', 'scroll', 'close'].includes(arg));
      const command = args[commandIndex];
      if (command === 'tab') return { success: true, data: { tabs: [{ tabId: 't1', url: 'https://93.184.216.34/application', active: true }] } };
      if (command === 'get') return { success: true, data: { url: 'https://93.184.216.34/application' } };
      if (command === 'eval') {
        const expression = EvalExpression(args, stdin);
        if (expression.includes("const triggers = [...document.querySelectorAll('[data-avery-form-semantic=\"custom-select\"]')]")) {
          return { success: true, data: { result: { filled: false } } };
        }
      }
      if (command === 'click') {
        const ref = args[commandIndex + 1];
        if (ref === '@e2') menu = 'province';
        else if (ref === '@e10') menu = 'city';
        return { success: true, data: {} };
      }
      if (command === 'snapshot') {
        if (menu !== 'form') dynamicDeadlines.push(deadline);
        if (menu === 'province') return { success: true, data: { refs: { e10: { role: 'option', name: '广东省' } } } };
        if (menu === 'city') return { success: true, data: { refs: { e11: { role: 'radio', name: '佛山市' } } } };
        return { success: true, data: { refs: { e2: { role: 'combobox', name: '现居住地' } } } };
      }
      return { success: true, data: {} };
    });
    const runtime = CreateTestRuntime({
      runtimeRoot, resolveUploadFile: vi.fn(), runBrowserCommand,
      delay: vi.fn(async () => undefined),
    });

    await runtime.Execute({ proposal: await runtime.Prepare({ toolName: 'BrowserNavigate', arguments: { url: 'https://93.184.216.34/application' } }) });
    const inspection = await runtime.Execute({ proposal: await runtime.Prepare({ toolName: 'BrowserInspectForm', arguments: {} }) });
    const outcome = await runtime.Execute({ proposal: await runtime.Prepare({
      toolName: 'BrowserFillForm',
      arguments: {
        pageRevision: (inspection.data as any).pageRevision,
        profileIds: ['profile-location'],
        __formSources: { profiles: [{ id: 'profile-location', category: 'application', title: '个人信息', content: '[个人信息]\n现居住地：广东省佛山市' }] },
      },
    }) });

    expect(outcome).toMatchObject({ status: 'succeeded', data: {
      filledCount: 0,
      skipped: [{ label: '现居住地', reason: 'confirmation_not_available' }],
    } });
    expect(dynamicDeadlines.some((deadline) => deadline - Date.now() > 100_000)).toBe(true);
    await runtime.Close();
  });

  it('BrowserFillForm 使用日历弹层输入框填写日期并执行收尾', async () => {
    const runtimeRoot = await mkdtemp(join(tmpdir(), 'avery-browser-date-picker-'));
    temporaryRoots.push(runtimeRoot);
    let calendarOpen = false;
    let calendarSnapshots = 0;
    let verificationAttempts = 0;
    const filled: Array<[string, string]> = [];
    const commands: string[] = [];
    const evalExpressions: string[] = [];
    const runBrowserCommand = vi.fn(async ({ args, stdin }: { args: string[]; stdin?: string }) => {
      const commandIndex = args.findIndex((arg) => ['open', 'get', 'snapshot', 'tab', 'click', 'fill', 'press', 'eval', 'scrollintoview', 'scroll', 'close'].includes(arg));
      const command = args[commandIndex];
      commands.push(command);
      if (command === 'tab') return { success: true, data: { tabs: [{ tabId: 't1', url: 'https://93.184.216.34/application', active: true }] } };
      if (command === 'get') return { success: true, data: { url: 'https://93.184.216.34/application' } };
      if (command === 'eval') {
        const expression = EvalExpression(args, stdin);
        evalExpressions.push(expression);
        if (expression.includes("const triggers = [...document.querySelectorAll('[data-avery-form-semantic=\"custom-select\"]')]")) {
          if (expression.includes('dateParts(displayText)')) verificationAttempts += 1;
          return { success: true, data: { result: { filled: filled.length > 0 && verificationAttempts >= 2 } } };
        }
      }
      if (command === 'click' && args[commandIndex + 1] === '@e2') { calendarOpen = true; return { success: true, data: {} }; }
      if (command === 'fill') { filled.push([args[commandIndex + 1], args[commandIndex + 2]]); return { success: true, data: {} }; }
      if (command === 'snapshot' && calendarOpen) {
        calendarSnapshots += 1;
        return calendarSnapshots === 1
          ? { success: true, data: { refs: {} } }
          : { success: true, data: { refs: { e10: { role: 'textbox', name: '__avery_date_editor__' } } } };
      }
      if (command === 'snapshot') return { success: true, data: { refs: { e2: { role: 'combobox', name: '出生日期' } } } };
      return { success: true, data: {} };
    });
    const runtime = CreateTestRuntime({
      runtimeRoot, resolveUploadFile: vi.fn(), runBrowserCommand,
      delay: vi.fn(async () => undefined),
    });

    await runtime.Execute({ proposal: await runtime.Prepare({ toolName: 'BrowserNavigate', arguments: { url: 'https://93.184.216.34/application' } }) });
    const inspection = await runtime.Execute({ proposal: await runtime.Prepare({ toolName: 'BrowserInspectForm', arguments: {} }) });
    const outcome = await runtime.Execute({ proposal: await runtime.Prepare({
      toolName: 'BrowserFillForm',
      arguments: {
        pageRevision: (inspection.data as any).pageRevision,
        profileIds: ['profile-date'],
        __formSources: { profiles: [{ id: 'profile-date', category: 'application', title: '投递档案', content: '[个人信息]\n出生日期：2005-01-15' }] },
      },
    }) });

    expect(filled).toEqual([['@e10', '2005-01-15']]);
    expect(calendarSnapshots).toBeGreaterThanOrEqual(2);
    expect(verificationAttempts).toBe(2);
    expect(commands.filter((command) => command === 'press').length).toBeGreaterThanOrEqual(2);
    expect(evalExpressions.some((expression) => expression.includes('__avery_date_year_option__'))).toBe(true);
    expect(evalExpressions.some((expression) => expression.includes('dateParts(displayText)'))).toBe(true);
    for (const expression of evalExpressions) expect(() => new Function(expression)).not.toThrow();
    expect(outcome).toMatchObject({ status: 'succeeded', data: { filledCount: 1 } });
    await runtime.Close();
  });

  it('BrowserFillForm 在日期辅助输入框被遮挡时回退到年份和月份点选', async () => {
    const runtimeRoot = await mkdtemp(join(tmpdir(), 'avery-browser-month-picker-'));
    temporaryRoots.push(runtimeRoot);
    let panel: 'form' | 'months' | 'years' | 'days' | 'done' = 'form';
    const clicks: string[] = [];
    const fills: string[] = [];
    const runBrowserCommand = vi.fn(async ({ args, stdin }: { args: string[]; stdin?: string }) => {
      const commandIndex = args.findIndex((arg) => ['open', 'get', 'snapshot', 'tab', 'click', 'fill', 'press', 'eval', 'scrollintoview', 'scroll', 'close'].includes(arg));
      const command = args[commandIndex];
      if (command === 'tab') return { success: true, data: { tabs: [{ tabId: 't1', url: 'https://93.184.216.34/application', active: true }] } };
      if (command === 'get') return { success: true, data: { url: 'https://93.184.216.34/application' } };
      if (command === 'eval') {
        const expression = EvalExpression(args, stdin);
        if (expression.includes("const triggers = [...document.querySelectorAll('[data-avery-form-semantic=\"custom-select\"]')]")) {
          return { success: true, data: { result: { filled: panel === 'done' } } };
        }
      }
      if (command === 'fill') {
        fills.push(args[commandIndex + 2]);
        throw new AgentBrowserError('BROWSER_COMMAND_FAILED', "Element '@e9' is covered by the calendar panel.");
      }
      if (command === 'click') {
        const ref = args[commandIndex + 1];
        clicks.push(ref);
        if (ref === '@e2') panel = 'months';
        else if (ref === '@e10') panel = 'years';
        else if (ref === '@e20') panel = 'months';
        else if (ref === '@e26') panel = 'days';
        else if (ref === '@e27') panel = 'done';
        return { success: true, data: {} };
      }
      if (command === 'snapshot') {
        if (panel === 'months') return { success: true, data: {
          snapshot: '- combobox "毕业时间" [ref=e2]\n- textbox "__avery_date_editor__" [ref=e9]\n- button "__avery_date_year_header__:2026" [ref=e10]\n- option "__avery_date_month_option__:6" [ref=e26]',
          refs: {
            e2: { role: 'combobox', name: '毕业时间' },
            e9: { role: 'textbox', name: '__avery_date_editor__' },
            e10: { role: 'button', name: '__avery_date_year_header__:2026' },
            e26: { role: 'option', name: '__avery_date_month_option__:6' },
          },
        } };
        if (panel === 'years') return { success: true, data: {
          snapshot: '- option "__avery_date_year_option__:2027" [ref=e20]', refs: { e20: { role: 'option', name: '__avery_date_year_option__:2027' } },
        } };
        if (panel === 'days') return { success: true, data: {
          snapshot: '- gridcell "__avery_date_day_option__:1" [ref=e27]', refs: { e27: { role: 'gridcell', name: '__avery_date_day_option__:1' } },
        } };
        return { success: true, data: { refs: { e2: { role: 'combobox', name: '毕业时间' } } } };
      }
      return { success: true, data: {} };
    });
    const runtime = CreateTestRuntime({
      runtimeRoot, resolveUploadFile: vi.fn(), runBrowserCommand,
      delay: vi.fn(async () => undefined),
    });

    await runtime.Execute({ proposal: await runtime.Prepare({ toolName: 'BrowserNavigate', arguments: { url: 'https://93.184.216.34/application' } }) });
    const inspection = await runtime.Execute({ proposal: await runtime.Prepare({ toolName: 'BrowserInspectForm', arguments: {} }) });
    const outcome = await runtime.Execute({ proposal: await runtime.Prepare({
      toolName: 'BrowserFillForm',
      arguments: {
        pageRevision: (inspection.data as any).pageRevision,
        profileIds: ['profile-month'],
        __formSources: { profiles: [{ id: 'profile-month', category: 'education', title: '教育经历', content: '[教育经历]\n毕业时间：2027-06' }] },
      },
    }) });

    expect(clicks).toEqual(['@e2', '@e10', '@e20', '@e26', '@e27']);
    expect(fills).toEqual(['2027-06']);
    expect(outcome).toMatchObject({ status: 'succeeded', data: { filledCount: 1, skipped: [] } });
    await runtime.Close();
  });

  it('BrowserFillForm 对教育经历纯年月控件选中月份后立即提交', async () => {
    const runtimeRoot = await mkdtemp(join(tmpdir(), 'avery-browser-education-month-picker-'));
    temporaryRoots.push(runtimeRoot);
    let panel: 'form' | 'months' | 'years' | 'done' = 'form';
    const clicks: string[] = [];
    const runBrowserCommand = vi.fn(async ({ args, stdin }: { args: string[]; stdin?: string }) => {
      const commandIndex = args.findIndex((arg) => ['open', 'get', 'snapshot', 'tab', 'click', 'eval', 'press', 'scrollintoview', 'scroll', 'close'].includes(arg));
      const command = args[commandIndex];
      if (command === 'tab') return { success: true, data: { tabs: [{ tabId: 't1', url: 'https://93.184.216.34/application', active: true }] } };
      if (command === 'get') return { success: true, data: { url: 'https://93.184.216.34/application' } };
      if (command === 'eval') {
        const expression = EvalExpression(args, stdin);
        if (expression.includes("const triggers = [...document.querySelectorAll('[data-avery-form-semantic=\"custom-select\"]')]")) {
          return { success: true, data: { result: { filled: panel === 'done' } } };
        }
      }
      if (command === 'click') {
        const ref = args[commandIndex + 1];
        clicks.push(ref);
        if (ref === '@e2') panel = 'months';
        else if (ref === '@e10') panel = 'years';
        else if (ref === '@e20') panel = 'months';
        else if (ref === '@e26') panel = 'done';
        return { success: true, data: {} };
      }
      if (command === 'snapshot') {
        if (panel === 'months') return { success: true, data: { refs: {
          e2: { role: 'combobox', name: '开始时间', section: '教育经历' },
          e10: { role: 'button', name: '__avery_date_month_year_header__:2026' },
          e26: { role: 'option', name: '__avery_date_month_option__:9' },
        } } };
        if (panel === 'years') return { success: true, data: { refs: {
          e20: { role: 'option', name: '__avery_date_year_option__:2021' },
        } } };
        return { success: true, data: { refs: {
          e2: { role: 'combobox', name: '开始时间', section: '教育经历' },
        } } };
      }
      return { success: true, data: {} };
    });
    const runtime = CreateTestRuntime({
      runtimeRoot, resolveUploadFile: vi.fn(), runBrowserCommand,
      delay: vi.fn(async () => undefined),
    });

    await runtime.Execute({ proposal: await runtime.Prepare({ toolName: 'BrowserNavigate', arguments: { url: 'https://93.184.216.34/application' } }) });
    const inspection = await runtime.Execute({ proposal: await runtime.Prepare({ toolName: 'BrowserInspectForm', arguments: {} }) });
    const outcome = await runtime.Execute({ proposal: await runtime.Prepare({
      toolName: 'BrowserFillForm',
      arguments: {
        pageRevision: (inspection.data as any).pageRevision,
        profileIds: ['education-months'],
        __formSources: { profiles: [{ id: 'education-months', category: 'education', title: '教育经历', content: '[教育经历]\n开始时间：2021-09' }] },
      },
    }) });

    expect(clicks).toEqual(['@e2', '@e10', '@e20', '@e26']);
    expect(outcome).toMatchObject({ status: 'succeeded', data: { filledCount: 1, skipped: [] } });
    await runtime.Close();
  });

  it('BrowserFillForm 按全局同名序号定位多段经历中的日期控件', async () => {
    const runtimeRoot = await mkdtemp(join(tmpdir(), 'avery-browser-repeated-dates-'));
    temporaryRoots.push(runtimeRoot);
    let calendarOpen = false;
    const clicked: string[] = [];
    const filledDates: string[] = [];
    let sawStableEndDateKey = false;
    const formRefs = {
      e2: { role: 'combobox', name: '毕业时间', section: '教育经历' },
      e3: { role: 'combobox', name: '开始时间', section: '工作经历' },
      e4: { role: 'combobox', name: '结束时间', section: '工作经历' },
      e5: { role: 'combobox', name: '开始时间', section: '项目经历' },
      e6: { role: 'combobox', name: '结束时间', section: '项目经历' },
    };
    const runBrowserCommand = vi.fn(async ({ args, stdin }: { args: string[]; stdin?: string }) => {
      const commandIndex = args.findIndex((arg) => ['open', 'get', 'snapshot', 'tab', 'click', 'fill', 'press', 'eval', 'scrollintoview', 'scroll', 'close'].includes(arg));
      const command = args[commandIndex];
      if (command === 'tab') return { success: true, data: { tabs: [{ tabId: 't1', url: 'https://93.184.216.34/application', active: true }] } };
      if (command === 'get') return { success: true, data: { url: 'https://93.184.216.34/application' } };
      if (command === 'eval') {
        const expression = EvalExpression(args, stdin);
        if (expression.includes('const overlays =')) {
          const toggled = calendarOpen;
          calendarOpen = false;
          return { success: true, data: { result: { toggled } } };
        }
        if (expression.includes("const triggers = [...document.querySelectorAll('[data-avery-form-semantic=\"custom-select\"]')]")) {
          if (expression.includes('data-avery-form-key') && expression.includes('endDate')) sawStableEndDateKey = true;
          return { success: true, data: { result: { filled: filledDates.length > 0 } } };
        }
      }
      if (command === 'click') {
        if (calendarOpen) throw new AgentBrowserError('BROWSER_COMMAND_FAILED', 'The previous date picker still covers this field.');
        clicked.push(args[commandIndex + 1]);
        calendarOpen = true;
        return { success: true, data: {} };
      }
      if (command === 'fill') { filledDates.push(args[commandIndex + 2]); return { success: true, data: {} }; }
      if (command === 'snapshot') return calendarOpen
        ? { success: true, data: { refs: { e20: { role: 'textbox', name: '__avery_date_editor__' } } } }
        : { success: true, data: { refs: formRefs } };
      return { success: true, data: {} };
    });
    const runtime = CreateTestRuntime({
      runtimeRoot, resolveUploadFile: vi.fn(), runBrowserCommand,
      delay: vi.fn(async () => undefined),
    });

    await runtime.Execute({ proposal: await runtime.Prepare({ toolName: 'BrowserNavigate', arguments: { url: 'https://93.184.216.34/application' } }) });
    const outcome = await runtime.Execute({ proposal: await runtime.Prepare({
      toolName: 'BrowserFillForm',
      arguments: {
        profileIds: ['education-dates', 'work-dates', 'project-dates'],
        __formSources: { profiles: [
          { id: 'education-dates', category: 'education', title: '教育经历', content: '[教育经历]\n入学时间：2020-09\n毕业时间：2024-06' },
          { id: 'work-dates', category: 'work', title: '工作经历', content: '[工作经历]\n开始时间：2024-07\n结束时间：2025-07' },
          { id: 'project-dates', category: 'project', title: '项目经历', content: '[项目经历]\n开始时间：2025-08\n结束时间：2026-08' },
        ] },
      },
    }) });
    expect(clicked).toEqual(['@e2', '@e3', '@e4', '@e5', '@e6']);
    expect(filledDates).toEqual(['2024-06', '2024-07', '2025-07', '2025-08', '2026-08']);
    expect(sawStableEndDateKey).toBe(true);
    expect(outcome).toMatchObject({ status: 'succeeded', data: { done: true, filledCount: 5, remainingCount: 0 } });
    await runtime.Close();
  });

  it('BrowserFillForm 将单个被遮挡字段记为失败并继续填写后续字段', async () => {
    const runtimeRoot = await mkdtemp(join(tmpdir(), 'avery-browser-covered-field-'));
    temporaryRoots.push(runtimeRoot);
    let menuOpen = false;
    const selected: string[] = [];
    const runBrowserCommand = vi.fn(async ({ args, stdin }: { args: string[]; stdin?: string }) => {
      const commandIndex = args.findIndex((arg) => ['open', 'get', 'snapshot', 'tab', 'click', 'press', 'eval', 'scrollintoview', 'scroll', 'close'].includes(arg));
      const command = args[commandIndex];
      if (command === 'tab') return { success: true, data: { tabs: [{ tabId: 't1', url: 'https://93.184.216.34/application', active: true }] } };
      if (command === 'get') return { success: true, data: { url: 'https://93.184.216.34/application' } };
      if (command === 'eval') {
        const expression = EvalExpression(args, stdin);
        if (expression.includes("const triggers = [...document.querySelectorAll('[data-avery-form-semantic=\"custom-select\"]')]")) {
          return { success: true, data: { result: { filled: selected.length > 0 } } };
        }
      }
      if (command === 'click') {
        const ref = args[commandIndex + 1];
        if (ref === '@e2') throw new AgentBrowserError('BROWSER_COMMAND_FAILED', "Element '@e2' is covered by <footer> at its click point.");
        if (ref === '@e3') menuOpen = true;
        if (ref === '@e30') selected.push('群众');
        return { success: true, data: {} };
      }
      if (command === 'snapshot') return menuOpen
        ? { success: true, data: { snapshot: '- listitem "群众" [level=1, ref=e30] clickable', refs: { e30: { role: 'listitem', name: '群众' } } } }
        : { success: true, data: { refs: {
          e2: { role: 'combobox', name: '民族' },
          e3: { role: 'combobox', name: '政治面貌' },
        } } };
      return { success: true, data: {} };
    });
    const runtime = CreateTestRuntime({
      runtimeRoot, resolveUploadFile: vi.fn(), runBrowserCommand,
      delay: vi.fn(async () => undefined),
    });

    await runtime.Execute({ proposal: await runtime.Prepare({ toolName: 'BrowserNavigate', arguments: { url: 'https://93.184.216.34/application' } }) });
    const inspection = await runtime.Execute({ proposal: await runtime.Prepare({ toolName: 'BrowserInspectForm', arguments: {} }) });
    const outcome = await runtime.Execute({ proposal: await runtime.Prepare({
      toolName: 'BrowserFillForm',
      arguments: {
        pageRevision: (inspection.data as any).pageRevision,
        profileIds: ['profile-selects'],
        __formSources: { profiles: [{ id: 'profile-selects', category: 'application', title: '投递档案', content: '[个人信息]\n民族：汉族\n政治面貌：群众' }] },
      },
    }) });

    expect(selected).toEqual(['群众']);
    expect(outcome).toMatchObject({ status: 'succeeded', data: {
      filledCount: 1,
      skipped: [{ label: '民族', reason: 'element_covered' }],
    } });
    await runtime.Close();
  });

  it('BrowserFillForm 找不到匹配的动态选项时只打开控件并报告跳过', async () => {
    const runtimeRoot = await mkdtemp(join(tmpdir(), 'avery-browser-unmatched-select-'));
    temporaryRoots.push(runtimeRoot);
    let opened = false;
    const clicks: string[] = [];
    const runBrowserCommand = vi.fn(async ({ args }: { args: string[] }) => {
      const commandIndex = args.findIndex((arg) => ['open', 'get', 'snapshot', 'tab', 'click', 'eval', 'close'].includes(arg));
      const command = args[commandIndex];
      if (command === 'tab') return { success: true, data: { tabs: [{ tabId: 't1', url: 'https://93.184.216.34/application', active: true }] } };
      if (command === 'get') return { success: true, data: { url: 'https://93.184.216.34/application' } };
      if (command === 'click') { opened = true; clicks.push(args[commandIndex + 1]); return { success: true, data: {} }; }
      if (command === 'snapshot') return opened
        ? { success: true, data: { refs: { e10: { role: 'option', name: '北京市' } } } }
        : { success: true, data: { refs: { e2: { role: 'combobox', name: '期望城市' } } } };
      return { success: true, data: {} };
    });
    const runtime = CreateTestRuntime({
      runtimeRoot,
      resolveUploadFile: vi.fn(),
      runBrowserCommand,
      delay: vi.fn(async () => undefined),
    });

    await runtime.Execute({ proposal: await runtime.Prepare({ toolName: 'BrowserNavigate', arguments: { url: 'https://93.184.216.34/application' } }) });
    const inspection = await runtime.Execute({ proposal: await runtime.Prepare({ toolName: 'BrowserInspectForm', arguments: {} }) });
    const outcome = await runtime.Execute({ proposal: await runtime.Prepare({
      toolName: 'BrowserFillForm',
      arguments: {
        pageRevision: (inspection.data as any).pageRevision,
        profileIds: ['profile-location'],
        __formSources: { profiles: [{ id: 'profile-location', category: 'job_intention', title: '求职意向', content: '[求职意向]\n期望城市：广东佛山' }] },
      },
    }) });

    expect(clicks).toEqual(['@e2']);
    expect(outcome).toMatchObject({ status: 'succeeded', data: {
      filledCount: 0,
      skipped: [{ label: '期望城市', reason: 'option_not_found' }],
    } });
    await runtime.Close();
  });

  it('BrowserFillForm 汇总缺少来源的字段且不猜测下拉选项', async () => {
    const runtimeRoot = await mkdtemp(join(tmpdir(), 'avery-browser-missing-form-field-'));
    temporaryRoots.push(runtimeRoot);
    const clicks: string[] = [];
    const runBrowserCommand = vi.fn(async ({ args }: { args: string[] }) => {
      const commandIndex = args.findIndex((arg) => ['open', 'get', 'snapshot', 'tab', 'click', 'eval', 'close'].includes(arg));
      const command = args[commandIndex];
      if (command === 'tab') return { success: true, data: { tabs: [{ tabId: 't1', url: 'https://93.184.216.34/application', active: true }] } };
      if (command === 'get') return { success: true, data: { url: 'https://93.184.216.34/application' } };
      if (command === 'click') { clicks.push(args[commandIndex + 1]); return { success: true, data: {} }; }
      if (command === 'snapshot') return { success: true, data: { refs: { e2: { role: 'combobox', name: '政治面貌', required: true } } } };
      return { success: true, data: {} };
    });
    const runtime = CreateTestRuntime({
      runtimeRoot,
      resolveUploadFile: vi.fn(),
      runBrowserCommand,
    });

    await runtime.Execute({ proposal: await runtime.Prepare({ toolName: 'BrowserNavigate', arguments: { url: 'https://93.184.216.34/application' } }) });
    const inspection = await runtime.Execute({ proposal: await runtime.Prepare({ toolName: 'BrowserInspectForm', arguments: {} }) });
    const outcome = await runtime.Execute({ proposal: await runtime.Prepare({
      toolName: 'BrowserFillForm',
      arguments: {
        pageRevision: (inspection.data as any).pageRevision,
        mode:'plan', profileIds: ['profile-empty'],
        __formSources: { profiles: [{ id: 'profile-empty', category: 'application', title: '空档案', content: '[个人信息]' }] },
      },
    }) });

    expect(clicks).toEqual([]);
    expect(outcome).toMatchObject({ status: 'succeeded', data: {
      phase:'plan',executed:false,
      missingFields: [{ key: 'politicalStatus', label: '政治面貌', control: 'select', required: true }],
    } });
    await runtime.Close();
  });

  it('BrowserFillForm 批次超时返回字段级失败，不关闭仍可见的浏览器实例', async () => {
    const runtimeRoot = await mkdtemp(join(tmpdir(), 'avery-browser-fill-timeout-'));
    temporaryRoots.push(runtimeRoot);
    const recordLog = vi.fn();
    const runBrowserCommand = vi.fn(async ({ args }: { args: string[] }) => {
      const command = args.find((arg) => ['open', 'get', 'snapshot', 'tab', 'batch', 'eval', 'close'].includes(arg));
      if (command === 'get') return { success: true, data: { url: 'https://93.184.216.34/application' } };
      if (command === 'snapshot') return { success: true, data: { refs: { e1: { role: 'textbox', tag: 'input', name: '姓名', valueLength: 0 } } } };
      if (command === 'tab') return { success: true, data: { tabs: [{ tabId: 't1', url: 'https://93.184.216.34/application', active: true }] } };
      if (command === 'batch') throw new AgentBrowserError('BROWSER_COMMAND_TIMEOUT', 'Browser command timed out.', true);
      return { success: true, data: {} };
    });
    const runtime = CreateTestRuntime({
      runtimeRoot,
      resolveUploadFile: vi.fn(),
      runBrowserCommand,
      recordLog,
    });

    await runtime.Execute({ proposal: await runtime.Prepare({ toolName: 'BrowserNavigate', arguments: { url: 'https://93.184.216.34/application' } }) });
    const proposal = await runtime.Prepare({
      toolName: 'BrowserFillForm',
      arguments: {
        profileIds: ['profile-1'],
        __formSources: { profiles: [{ id: 'profile-1', category: 'application', title: '个人信息', content: '[个人信息]\n姓名：张三' }] },
      },
    });
    await expect(runtime.Execute({ proposal })).resolves.toMatchObject({
      status: 'succeeded',
      data: {
        filledCount: 0,
        skipped: [{ label: '姓名', reason: 'field_timeout' }],
      },
    });
    expect(recordLog).toHaveBeenCalledWith('WARN', 'browser.form_field', expect.stringContaining('field=personal.name:0 kind=fill'));
    expect(recordLog.mock.calls.flat().join(' ')).not.toContain('张三');
    await runtime.Close();
  });
});
