import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentBrowserError, AgentBrowserRuntime, BuildBrowserCompanionArgs, NormalizePublicBrowserUrl } from '../../../apps/backend/src/electron/backend/agent-browser-runtime';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('AgentBrowserRuntime', () => {
  it('隔离伴随进程使用随机本地 CDP 端口且路径保持单参数', () => {
    const args = BuildBrowserCompanionArgs({ appPath: 'D:\\Offer Get\\app', profilePath: 'D:\\Profiles\\name;&unsafe', parentPid: 42 });
    expect(args).toEqual([
      'D:\\Offer Get\\app', '--offerget-browser-companion', '--offerget-browser-profile=D:\\Profiles\\name;&unsafe',
      '--offerget-browser-parent-pid=42', '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0', '--user-data-dir=D:\\Profiles\\name;&unsafe',
    ]);
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

  it('构造期导航策略可收窄到测试 origin，默认策略仍拒绝本地地址', async () => {
    const runtimeRoot = await mkdtemp(join(tmpdir(), 'offerget-browser-policy-'));
    temporaryRoots.push(runtimeRoot);
    const normalizeNavigationUrl = vi.fn(async (value: unknown) => {
      const url = new URL(String(value));
      if (url.origin !== 'http://127.0.0.1:43210') throw Object.assign(new Error('denied'), { code: 'BROWSER_NAVIGATION_DENIED' });
      return url.toString();
    });
    const runtime = new AgentBrowserRuntime({
      executablePath: process.execPath, companionExecutablePath: process.execPath, runtimeRoot,
      resolveUploadFile: vi.fn(), normalizeNavigationUrl,
    });

    await expect(runtime.Prepare({ toolName: 'BrowserNavigate', arguments: { url: 'http://127.0.0.1:43210/jobs' } })).resolves.toMatchObject({ canonicalArguments: { url: 'http://127.0.0.1:43210/jobs' } });
    await expect(runtime.Prepare({ toolName: 'BrowserNavigate', arguments: { url: 'http://127.0.0.1:43211/jobs' } })).rejects.toMatchObject({ code: 'BROWSER_NAVIGATION_DENIED' });
    await expect(NormalizePublicBrowserUrl('http://127.0.0.1:43210/jobs')).rejects.toMatchObject({ code: 'BROWSER_NAVIGATION_DENIED' });
    expect(normalizeNavigationUrl).toHaveBeenCalledTimes(2);
  });

  it('固定 CLI 身份与参数，页面引用在动作和新 Run 后失效', async () => {
    const runtimeRoot = await mkdtemp(join(tmpdir(), 'offerget-browser-runtime-'));
    temporaryRoots.push(runtimeRoot);
    const calls: string[][] = [];
    const closeCompanion = vi.fn(async () => undefined);
    const runProcess = vi.fn(async ({ args }: { args: string[] }) => {
      calls.push(args);
      const commandIndex = args.findIndex((arg) => ['open', 'get', 'snapshot', 'tab', 'click', 'close'].includes(arg));
      const command = args[commandIndex];
      if (command === 'get') return { success: true, data: { url: 'https://93.184.216.34/jobs' } };
      if (command === 'snapshot') return { success: true, data: { snapshot: '- button "Next" [ref=e1]', refs: { e1: { role: 'button', name: 'Next' } } } };
      if (command === 'tab') return { success: true, data: { tabs: [{ tabId: 't1', url: 'https://93.184.216.34/jobs' }] } };
      return { success: true, data: {} };
    });
    const launchCompanion = vi.fn(async () => ({ port: 9339, homeUrl: 'https://93.184.216.34/jobs', close: closeCompanion }));
    const runtime = new AgentBrowserRuntime({ executablePath: process.execPath, companionExecutablePath: process.execPath, runtimeRoot, resolveUploadFile: vi.fn(), runProcess, launchCompanion });

    const navigate = await runtime.Prepare({ toolName: 'BrowserNavigate', arguments: { url: 'https://93.184.216.34/jobs?q=a;b' } });
    await runtime.Execute({ proposal: navigate });
    const snapshot = await runtime.Prepare({ toolName: 'BrowserSnapshot', arguments: {} });
    const snapshotResult = await runtime.Execute({ proposal: snapshot });
    expect(snapshotResult.data).toMatchObject({ pageRevision: 2 });
    const click = await runtime.Prepare({ toolName: 'BrowserClick', arguments: { ref: '@e1', pageRevision: 2 } });
    await runtime.Execute({ proposal: click });
    runtime.ResetPageReferences();
    await expect(runtime.Prepare({ toolName: 'BrowserClick', arguments: { ref: '@e1', pageRevision: 2 } })).rejects.toMatchObject({ code: 'BROWSER_STALE_PAGE_REF' });

    const openCall = calls.find((args) => args.includes('open'))!;
    expect(openCall).toEqual(expect.arrayContaining(['--namespace', `offerget-${process.pid}-1`, '--session', 'offerget-default', '--cdp', '9339', '--pin-tab', '--no-auto-dialog', '--content-boundaries', '--json']));
    expect(openCall).not.toEqual(expect.arrayContaining(['--profile', '--headed']));
    expect(openCall[openCall.indexOf('open') + 1]).toBe('https://93.184.216.34/jobs?q=a;b');
    await expect(runtime.GetStatus()).resolves.toMatchObject({ available: true, running: true });
    expect(launchCompanion).toHaveBeenCalledOnce();

    const competing = new AgentBrowserRuntime({ executablePath: process.execPath, companionExecutablePath: process.execPath, runtimeRoot, resolveUploadFile: vi.fn(), runProcess, launchCompanion });
    const competingNavigate = await competing.Prepare({ toolName: 'BrowserNavigate', arguments: { url: 'https://93.184.216.34/other' } });
    await expect(competing.Execute({ proposal: competingNavigate })).rejects.toMatchObject({ code: 'BROWSER_PROFILE_BUSY' });
    await runtime.Close();
    expect(closeCompanion).toHaveBeenCalledOnce();
  });

  it('BrowserFillForm 仅以 JSON stdin 批量填写同页普通输入框且不回显正文', async () => {
    const runtimeRoot = await mkdtemp(join(tmpdir(), 'offerget-browser-fill-form-'));
    temporaryRoots.push(runtimeRoot);
    const calls: Array<{ args: string[]; stdin?: string }> = [];
    const runProcess = vi.fn(async ({ args, stdin }: { args: string[]; stdin?: string }) => {
      calls.push({ args, ...(stdin === undefined ? {} : { stdin }) });
      const command = args.find((arg) => ['open', 'get', 'snapshot', 'tab', 'batch', 'close'].includes(arg));
      if (command === 'get') return { success: true, data: { url: 'https://93.184.216.34/application' } };
      if (command === 'snapshot') return { success: true, data: { snapshot: 'fixture', refs: {
        e1: { role: 'textbox', name: '姓名', type: 'text' },
        e2: { role: 'textbox', name: '邮箱', type: 'email' },
        e3: { role: 'button', name: '提交' },
        e4: { role: 'textbox', name: '密码', type: 'password' },
        e5: { role: 'textbox', name: '字段 5', type: 'text' },
        e6: { role: 'textbox', name: '字段 6', type: 'text' },
        e7: { role: 'textbox', name: '字段 7', type: 'text' },
        e8: { role: 'textbox', name: '字段 8', type: 'text' },
      } } };
      if (command === 'tab') return { success: true, data: { tabs: [
        { tabId: 'home', url: 'https://93.184.216.34/ready', active: true },
        { tabId: 't1', url: 'https://93.184.216.34/application', active: false },
      ] } };
      if (command === 'batch') return { success: true, data: { results: [{ success: true }, { success: true }] } };
      return { success: true, data: {} };
    });
    const runtime = new AgentBrowserRuntime({
      executablePath: process.execPath, companionExecutablePath: process.execPath, runtimeRoot, resolveUploadFile: vi.fn(), runProcess,
      launchCompanion: vi.fn(async () => ({ port: 9630, homeUrl: 'https://93.184.216.34/ready', isAlive: () => true, close: vi.fn(async () => undefined) })),
    });

    const navigate = await runtime.Prepare({ toolName: 'BrowserNavigate', arguments: { url: 'https://93.184.216.34/application' } });
    await runtime.Execute({ proposal: navigate });
    const snapshot = await runtime.Prepare({ toolName: 'BrowserSnapshot', arguments: {} });
    const observed = await runtime.Execute({ proposal: snapshot });
    const pageRevision = (observed.data as { pageRevision: number }).pageRevision;
    const name = '张三 "Agent"\n第二行';
    const email = 'x@example.com"], ["click", "@e3';
    const proposal = await runtime.Prepare({ toolName: 'BrowserFillForm', arguments: { pageRevision, fields: [{ ref: '@e1', text: name }, { ref: '@e2', text: email }] } });
    const outcome = await runtime.Execute({ proposal });

    const batchCalls = calls.filter((call) => call.args.includes('batch'));
    expect(batchCalls).toHaveLength(1);
    expect(batchCalls[0].args).toEqual(expect.arrayContaining(['batch', '--bail', '--json']));
    expect(batchCalls[0].args.join(' ')).not.toContain(name);
    expect(batchCalls[0].args.join(' ')).not.toContain(email);
    expect(JSON.parse(batchCalls[0].stdin ?? '')).toEqual([['fill', '@e1', name], ['fill', '@e2', email]]);
    expect(outcome).toMatchObject({ status: 'succeeded', data: { filledCount: 2, pageRevision, currentUrl: 'https://93.184.216.34/application' } });
    expect(JSON.stringify(outcome)).not.toContain(name);
    expect(JSON.stringify(outcome)).not.toContain(email);
    await expect(runtime.Prepare({ toolName: 'BrowserFillForm', arguments: { pageRevision, fields: [{ ref: '@e1', text: 'a' }, { ref: '@e1', text: 'b' }] } })).rejects.toMatchObject({ code: 'BROWSER_ARGUMENT_INVALID' });
    await expect(runtime.Prepare({ toolName: 'BrowserFillForm', arguments: { pageRevision, fields: [{ ref: '@e3', text: 'submit' }] } })).rejects.toMatchObject({ code: 'BROWSER_ARGUMENT_INVALID' });
    await expect(runtime.Prepare({ toolName: 'BrowserFillForm', arguments: { pageRevision, fields: [{ ref: '@e4', text: 'secret' }] } })).rejects.toMatchObject({ code: 'BROWSER_ARGUMENT_INVALID' });
    await expect(runtime.Prepare({
      toolName: 'BrowserFillForm',
      arguments: { pageRevision, fields: ['@e1', '@e2', '@e5', '@e6', '@e7', '@e8'].map((ref) => ({ ref, text: 'x'.repeat(20_000) })) },
    })).rejects.toMatchObject({ code: 'BROWSER_ARGUMENT_INVALID' });
    await expect(runtime.Prepare({ toolName: 'BrowserFillForm', arguments: { pageRevision: pageRevision - 1, fields: [{ ref: '@e1', text: 'stale' }] } })).rejects.toMatchObject({ code: 'BROWSER_STALE_PAGE_REF' });
    expect(calls.filter((call) => call.args.includes('batch'))).toHaveLength(1);
    await runtime.Close();
  });

  it('companion 异常退出后重启并拒绝崩溃前的页面引用', async () => {
    const runtimeRoot = await mkdtemp(join(tmpdir(), 'offerget-browser-recovery-'));
    temporaryRoots.push(runtimeRoot);
    let firstAlive = true;
    let launchCount = 0;
    const calls: string[][] = [];
    const launchCompanion = vi.fn(async () => {
      launchCount += 1;
      const alive = launchCount === 1 ? () => firstAlive : () => true;
      return { port: 9400 + launchCount, homeUrl: 'https://93.184.216.34/jobs', isAlive: alive, close: vi.fn(async () => undefined) };
    });
    const runProcess = vi.fn(async ({ args }: { args: string[] }) => {
      calls.push(args);
      const command = args.find((arg) => ['open', 'get', 'snapshot', 'tab', 'click', 'close'].includes(arg));
      if (command === 'get') return { success: true, data: { url: 'https://93.184.216.34/jobs' } };
      if (command === 'snapshot') return { success: true, data: { snapshot: '- button "Next" [ref=e1]', refs: { e1: { role: 'button', name: 'Next' } } } };
      if (command === 'tab') return { success: true, data: { tabs: [{ tabId: 't1', url: 'https://93.184.216.34/jobs', active: true }] } };
      return { success: true, data: {} };
    });
    const runtime = new AgentBrowserRuntime({ executablePath: process.execPath, companionExecutablePath: process.execPath, runtimeRoot, resolveUploadFile: vi.fn(), runProcess, launchCompanion });

    const navigate = await runtime.Prepare({ toolName: 'BrowserNavigate', arguments: { url: 'https://93.184.216.34/jobs' } });
    await runtime.Execute({ proposal: navigate });
    const snapshot = await runtime.Prepare({ toolName: 'BrowserSnapshot', arguments: {} });
    const observed = await runtime.Execute({ proposal: snapshot });
    const staleClick = await runtime.Prepare({ toolName: 'BrowserClick', arguments: { ref: '@e1', pageRevision: (observed.data as any).pageRevision } });

    firstAlive = false;
    await expect(runtime.Execute({ proposal: staleClick })).rejects.toMatchObject({ code: 'BROWSER_STALE_PAGE_REF' });
    expect(launchCompanion).toHaveBeenCalledTimes(2);
    expect(calls.filter((args) => args.includes('click'))).toHaveLength(0);
    const attachedNamespaces = calls.filter((args) => args.includes('tab') && args.includes('--cdp')).map((args) => args[args.indexOf('--namespace') + 1]);
    expect(new Set(attachedNamespaces)).toEqual(new Set([`offerget-${process.pid}-1`, `offerget-${process.pid}-2`]));

    const recoveredSnapshot = await runtime.Prepare({ toolName: 'BrowserSnapshot', arguments: {} });
    const recovered = await runtime.Execute({ proposal: recoveredSnapshot });
    const recoveredClick = await runtime.Prepare({ toolName: 'BrowserClick', arguments: { ref: '@e1', pageRevision: (recovered.data as any).pageRevision } });
    await runtime.Execute({ proposal: recoveredClick });
    expect(calls.filter((args) => args.includes('click'))).toHaveLength(1);
    await runtime.Close();
  });

  it('导航遇到失效 CDP 时淘汰旧 daemon，并使用新 namespace 仅重试一次', async () => {
    const runtimeRoot = await mkdtemp(join(tmpdir(), 'offerget-browser-cdp-recovery-'));
    temporaryRoots.push(runtimeRoot);
    let launchCount = 0;
    let openCount = 0;
    const calls: string[][] = [];
    const closeCompanions: Array<ReturnType<typeof vi.fn>> = [];
    const launchCompanion = vi.fn(async () => {
      launchCount += 1;
      const close = vi.fn(async () => undefined);
      closeCompanions.push(close);
      return { port: 9500 + launchCount, homeUrl: 'https://93.184.216.34/ready', isAlive: () => true, close };
    });
    const runProcess = vi.fn(async ({ args }: { args: string[] }) => {
      calls.push(args);
      const command = args.find((arg) => ['open', 'get', 'tab', 'close'].includes(arg));
      if (command === 'tab') return { success: true, data: { tabs: [{ tabId: 't1', url: 'https://93.184.216.34/ready', active: true }] } };
      if (command === 'open') {
        openCount += 1;
        if (openCount === 1) throw new AgentBrowserError('BROWSER_COMMAND_FAILED', 'Failed to read: connection timed out (os error 10060)');
        return { success: true, data: {} };
      }
      if (command === 'get') return { success: true, data: { url: 'https://93.184.216.34/jobs' } };
      return { success: true, data: {} };
    });
    const runtime = new AgentBrowserRuntime({ executablePath: process.execPath, companionExecutablePath: process.execPath, runtimeRoot, resolveUploadFile: vi.fn(), runProcess, launchCompanion });

    const proposal = await runtime.Prepare({ toolName: 'BrowserNavigate', arguments: { url: 'https://93.184.216.34/jobs' } });
    await expect(runtime.Execute({ proposal, deadline: Date.now() + 120_000 })).resolves.toMatchObject({ status: 'succeeded' });

    expect(openCount).toBe(2);
    expect(launchCompanion).toHaveBeenCalledTimes(2);
    expect(closeCompanions[0]).toHaveBeenCalledOnce();
    const openNamespaces = calls.filter((args) => args.includes('open')).map((args) => args[args.indexOf('--namespace') + 1]);
    expect(openNamespaces).toEqual([`offerget-${process.pid}-1`, `offerget-${process.pid}-2`]);
    await expect(runtime.GetStatus()).resolves.toMatchObject({ available: true, running: true, state: 'ready' });
    await runtime.Close();
  });
});
