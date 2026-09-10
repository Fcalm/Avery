import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentBrowserError, AgentBrowserRuntime, BuildBrowserCompanionArgs, DetectBossRisk, IsBossBrowserUrl, NormalizePublicBrowserUrl } from '../../../apps/backend/src/electron/backend/agent-browser-runtime';
import { DynamicSelectionVerificationExpression, FormSemanticEnrichmentExpression } from '../../../apps/backend/src/electron/backend/browser-form-driver';
import { PersonalBrowserCdpError, type PersonalBrowserRuntimePort } from '../../../apps/backend/src/electron/backend/personal-browser-cdp-runtime';

const temporaryRoots: string[] = [];

function EvalExpression(args: string[], stdin?: string): string {
  if (args.includes('--stdin')) return stdin ?? '';
  const base64Index = args.indexOf('-b');
  return base64Index >= 0 ? Buffer.from(args[base64Index + 1], 'base64').toString('utf8') : '';
}

function PersonalRuntimeStub(input: {
  connect?: () => Promise<{ anchorUrl: string }>;
  run?: (command: string[], options?: { stdin?: string }) => Promise<{ success: true; data: Record<string, any> }>;
} = {}): PersonalBrowserRuntimePort {
  let connected = false;
  return {
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

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('AgentBrowserRuntime', () => {
  it('Chrome 144+ 使用 DevToolsActivePort 的 WebSocket 附着并只登记 BOSS target', async () => {
    const runtimeRoot = await mkdtemp(join(tmpdir(), 'avery-existing-browser-discovery-'));
    temporaryRoots.push(runtimeRoot);
    const localAppData = join(runtimeRoot, 'local-app-data');
    const portDirectory = join(localAppData, 'Google', 'Chrome', 'User Data');
    await mkdir(portDirectory, { recursive: true });
    await writeFile(join(portDirectory, 'DevToolsActivePort'), '19989\n/devtools/browser/4811f081-d96b-4313-b8e5-6cdd08d2668c\n');
    vi.stubEnv('LOCALAPPDATA', localAppData);
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url === 'http://127.0.0.1:19989/') return { ok: false };
      throw new Error('No CDP endpoint');
    });
    vi.stubGlobal('fetch', fetchMock);
    const createdEndpoints: string[] = [];
    const personalRuntime = PersonalRuntimeStub();
    const runtime = new AgentBrowserRuntime({
      executablePath: process.execPath,
      companionExecutablePath: process.execPath,
      runtimeRoot,
      resolveUploadFile: vi.fn(),
      createPersonalBrowserRuntime: ({ endpoint }) => { createdEndpoints.push(endpoint); return personalRuntime; },
    });

    await runtime.SetEngine('chrome');
    await expect(runtime.GetStatus()).resolves.toMatchObject({ engine: 'chrome', running: false, state: 'ready', profileExists: false });
    await expect(runtime.GetStatus(true)).resolves.toMatchObject({ engine: 'chrome', running: true, state: 'ready', profileExists: false });
    const proposal = await runtime.Prepare({ toolName: 'BrowserSnapshot', arguments: {} });
    const observed = await runtime.Execute({ proposal });

    expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:19989/', expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(createdEndpoints).toEqual(['ws://127.0.0.1:19989/devtools/browser/4811f081-d96b-4313-b8e5-6cdd08d2668c']);
    expect((observed.data as any).tabs).toEqual([
      { tabId: 'avery-task', targetId: 'task-target', url: 'https://www.zhipin.com/web/geek/job', active: true },
    ]);
    await runtime.Close();
  });

  it('DevToolsActivePort 丢失时只从已校验的 Chrome 主进程恢复动态端口', async () => {
    const runtimeRoot = await mkdtemp(join(tmpdir(), 'avery-existing-browser-process-port-'));
    temporaryRoots.push(runtimeRoot);
    vi.stubEnv('LOCALAPPDATA', join(runtimeRoot, 'no-browser-data'));
    const createdEndpoints: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false })));
    const runtime = new AgentBrowserRuntime({
      executablePath: process.execPath,
      companionExecutablePath: process.execPath,
      runtimeRoot,
      externalBrowserPaths: { chrome: process.execPath },
      discoverExternalBrowserPorts: vi.fn(async ({ engine, executablePath }) => {
        expect({ engine, executablePath }).toEqual({ engine: 'chrome', executablePath: process.execPath });
        return [19989];
      }),
      resolveUploadFile: vi.fn(),
      createPersonalBrowserRuntime: ({ endpoint }) => { createdEndpoints.push(endpoint); return PersonalRuntimeStub(); },
    });

    await runtime.SetEngine('chrome');
    await expect(runtime.GetStatus(true)).resolves.toMatchObject({ engine: 'chrome', running: true, state: 'ready' });
    expect(createdEndpoints).toEqual(['ws://127.0.0.1:19989/devtools/browser']);
    await runtime.Close();
  });

  it('Chrome 首次 WebSocket 握手未获批准时返回可等待用户处理的稳定错误', async () => {
    const runtimeRoot = await mkdtemp(join(tmpdir(), 'avery-browser-permission-'));
    temporaryRoots.push(runtimeRoot);
    const runtime = new AgentBrowserRuntime({
      executablePath: process.execPath,
      companionExecutablePath: process.execPath,
      runtimeRoot,
      resolveUploadFile: vi.fn(),
      attachExternalBrowser: vi.fn(async () => ({
        port: 19989,
        cdpEndpoint: 'ws://127.0.0.1:19989/devtools/browser/4811f081-d96b-4313-b8e5-6cdd08d2668c',
        userAttached: true,
        close: vi.fn(async () => undefined),
      })),
      createPersonalBrowserRuntime: () => PersonalRuntimeStub({
        connect: async () => { throw new PersonalBrowserCdpError('BROWSER_CDP_CONNECTION_FAILED', 'Approval timed out.'); },
      }),
    });

    await runtime.SetEngine('chrome');
    const proposal = await runtime.Prepare({ toolName: 'BrowserSnapshot', arguments: {} });
    await expect(runtime.Execute({ proposal })).rejects.toMatchObject({ code: 'BROWSER_EXISTING_BROWSER_PERMISSION_REQUIRED' });
    await runtime.Close();
  });

  it('用户主动检测连接时执行真实握手，并把授权失败保留为可见状态', async () => {
    const runtimeRoot = await mkdtemp(join(tmpdir(), 'avery-browser-status-probe-'));
    temporaryRoots.push(runtimeRoot);
    const closeExternalBrowser = vi.fn(async () => undefined);
    const runtime = new AgentBrowserRuntime({
      executablePath: process.execPath,
      companionExecutablePath: process.execPath,
      runtimeRoot,
      resolveUploadFile: vi.fn(),
      attachExternalBrowser: vi.fn(async () => ({
        port: 19989,
        cdpEndpoint: 'ws://127.0.0.1:19989/devtools/browser/4811f081-d96b-4313-b8e5-6cdd08d2668c',
        userAttached: true,
        close: closeExternalBrowser,
      })),
      createPersonalBrowserRuntime: () => PersonalRuntimeStub({
        connect: async () => { throw new PersonalBrowserCdpError('BROWSER_CDP_CONNECTION_FAILED', 'Chrome did not authorize the debugging connection.'); },
      }),
    });

    await runtime.SetEngine('chrome');
    await expect(runtime.GetStatus(true)).resolves.toMatchObject({
      engine: 'chrome', running: false, state: 'unhealthy',
      message: expect.stringContaining('authorize the debugging connection'),
    });
    expect(closeExternalBrowser).toHaveBeenCalledOnce();
    await runtime.Close();
  });

  it('Chrome/Edge 只附着用户现有 BOSS 标签页，不创建 Profile、暴露其他标签页或接管用户浏览器进程', async () => {
    const runtimeRoot = await mkdtemp(join(tmpdir(), 'avery-external-browser-'));
    temporaryRoots.push(runtimeRoot);
    const calls: string[][] = [];
    let currentUrl = 'https://www.zhipin.com/web/geek/job';
    const personalRuntime = PersonalRuntimeStub({ run: async (command) => {
      calls.push(command);
      if (command[0] === 'open') currentUrl = command[1];
      if (command[0] === 'get') return { success: true, data: { url: currentUrl } };
      if (command[0] === 'snapshot') return { success: true, data: { refs: {} } };
      if (command[0] === 'tab') return { success: true, data: { tabs: [
        { tabId: 'avery-task', targetId: 'task-target', url: currentUrl, active: true },
      ] } };
      return { success: true, data: {} };
    } });
    const launchCompanion = vi.fn();
    const detachExternalBrowser = vi.fn(async () => undefined);
    const attachExternalBrowser = vi.fn(async () => ({
      port: 9650,
      cdpEndpoint: 'ws://127.0.0.1:9650/devtools/browser/test-id',
      homeUrl: 'https://www.zhipin.com/web/geek/job',
      targetId: 'boss-target',
      close: detachExternalBrowser,
    }));
    const runtime = new AgentBrowserRuntime({
      executablePath: process.execPath,
      companionExecutablePath: process.execPath,
      runtimeRoot,
      resolveUploadFile: vi.fn(),
      normalizeNavigationUrl: async (value) => String(value),
      launchCompanion,
      attachExternalBrowser,
      createPersonalBrowserRuntime: () => personalRuntime,
    });

    await runtime.SetEngine('edge');
    const proposal = await runtime.Prepare({ toolName: 'BrowserNavigate', arguments: { url: 'https://www.zhipin.com/web/geek/job?query=agent' } });
    await runtime.Execute({ proposal });
    const secondProposal = await runtime.Prepare({ toolName: 'BrowserNavigate', arguments: { url: 'https://www.zhipin.com/web/geek/job?query=agent&page=2' } });
    await runtime.Execute({ proposal: secondProposal });
    const snapshot = await runtime.Prepare({ toolName: 'BrowserSnapshot', arguments: {} });
    const observed = await runtime.Execute({ proposal: snapshot });

    expect(calls.filter((args) => args[0] === 'open')).toEqual([
      ['open', 'https://www.zhipin.com/web/geek/job?query=agent'],
      ['open', 'https://www.zhipin.com/web/geek/job?query=agent&page=2'],
    ]);
    expect(launchCompanion).not.toHaveBeenCalled();
    expect(attachExternalBrowser).toHaveBeenCalledWith({ engine: 'edge' });
    expect((observed.data as any).tabs).toEqual([
      { tabId: 'avery-task', targetId: 'task-target', url: 'https://www.zhipin.com/web/geek/job?query=agent&page=2', active: true },
    ]);
    await expect(runtime.Prepare({ toolName: 'BrowserSwitchTab', arguments: { tabId: 'mail-tab' } })).rejects.toMatchObject({ code: 'BROWSER_TAB_NOT_FOUND' });
    await expect(runtime.Prepare({ toolName: 'BrowserNavigate', arguments: { url: 'https://example.com/jobs' } })).rejects.toMatchObject({ code: 'BROWSER_NAVIGATION_DENIED' });
    await expect(runtime.GetStatus()).resolves.toMatchObject({ engine: 'edge', available: true, profileExists: false, running: true, state: 'ready' });
    await expect(access(join(runtimeRoot, 'profiles', 'edge'))).rejects.toMatchObject({ code: 'ENOENT' });
    await runtime.Close();
    expect(personalRuntime.Close).toHaveBeenCalledOnce();
    expect(detachExternalBrowser).toHaveBeenCalledOnce();
  });

  it('个人浏览器 CronTask 使用可信任务级授权，连接状态不再充当授权租约', async () => {
    const runtimeRoot = await mkdtemp(join(tmpdir(), 'avery-cron-browser-access-'));
    temporaryRoots.push(runtimeRoot);
    const personalRuntime = PersonalRuntimeStub();
    const runtime = new AgentBrowserRuntime({
      executablePath: process.execPath,
      companionExecutablePath: process.execPath,
      runtimeRoot,
      resolveUploadFile: vi.fn(),
      normalizeNavigationUrl: async (value) => String(value),
      attachExternalBrowser: vi.fn(async () => ({
        port: 9651,
        cdpEndpoint: 'ws://127.0.0.1:9651/devtools/browser/test-id',
        homeUrl: 'https://www.zhipin.com/web/geek/job',
        close: vi.fn(async () => undefined),
      })),
      createPersonalBrowserRuntime: () => personalRuntime,
    });

    await runtime.SetEngine('chrome');
    await runtime.SetUnattended(true, { cronTaskId: 'cron-1', browserAuthorized: true });
    await expect(runtime.Prepare({ toolName: 'BrowserNavigate', arguments: { url: 'https://www.zhipin.com/web/geek/job' } })).resolves.toMatchObject({ toolName: 'BrowserNavigate' });

    await personalRuntime.Close();
    await runtime.SetUnattended(false);
    await runtime.SetUnattended(true, { cronTaskId: 'cron-other', browserAuthorized: false });
    await expect(runtime.Prepare({ toolName: 'BrowserNavigate', arguments: { url: 'https://www.zhipin.com/web/geek/job' } })).rejects.toMatchObject({ code: 'BROWSER_CRON_ACCESS_REQUIRED' });
    await runtime.Close();
  });

  it('BrowserScreenshot 只写入受控临时路径并以内联 PNG 返回后删除文件', async () => {
    const runtimeRoot = await mkdtemp(join(tmpdir(), 'avery-browser-screenshot-'));
    temporaryRoots.push(runtimeRoot);
    let screenshotPath = '';
    const runProcess = vi.fn(async ({ args }: { args: string[] }) => {
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
    const runtime = new AgentBrowserRuntime({
      executablePath: process.execPath,
      companionExecutablePath: process.execPath,
      runtimeRoot,
      resolveUploadFile: vi.fn(),
      runProcess,
      launchCompanion: vi.fn(async () => ({ port: 9640, homeUrl: 'https://93.184.216.34/jobs', isAlive: () => true, close: vi.fn(async () => undefined) })),
    });

    const proposal = await runtime.Prepare({ toolName: 'BrowserScreenshot', arguments: {} });
    const result = await runtime.Execute({ proposal });

    expect(screenshotPath).toMatch(/[\\/]screenshots[\\/][0-9a-f-]+\.png$/i);
    expect(result).toMatchObject({ status: 'succeeded', data: { imageDataUrl: 'data:image/png;base64,iVBORw0KGgo=', byteSize: 8, pageRevision: 0 } });
    await expect(access(screenshotPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await runtime.Close();
  });

  it('隔离伴随进程使用随机本地 CDP 端口且路径保持单参数', () => {
    const args = BuildBrowserCompanionArgs({ appPath: 'D:\\Offer Get\\app', profilePath: 'D:\\Profiles\\name;&unsafe', parentPid: 42 });
    expect(args).toEqual([
      'D:\\Offer Get\\app', '--avery-browser-companion', '--avery-browser-profile=D:\\Profiles\\name;&unsafe',
      '--avery-browser-parent-pid=42', '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0', '--user-data-dir=D:\\Profiles\\name;&unsafe',
    ]);
    expect(BuildBrowserCompanionArgs({ profilePath: 'D:\\Profiles\\scheduled', parentPid: 42, unattended: true })).toContain('--avery-browser-hidden');
  });

  it('交互与无人值守模式切换时淘汰旧 companion，不交叉复用可见性属性', async () => {
    const runtimeRoot = await mkdtemp(join(tmpdir(), 'avery-browser-visibility-'));
    temporaryRoots.push(runtimeRoot);
    const closeCompanions: Array<ReturnType<typeof vi.fn>> = [];
    const launchCompanion = vi.fn(async () => {
      const close = vi.fn(async () => undefined);
      closeCompanions.push(close);
      return { port: 9600 + closeCompanions.length, homeUrl: 'https://93.184.216.34/ready', isAlive: () => true, close };
    });
    const runProcess = vi.fn(async ({ args }: { args: string[] }) => {
      const command = args.find((arg) => ['open', 'get', 'tab', 'close'].includes(arg));
      if (command === 'tab') return { success: true, data: { tabs: [{ tabId: 't1', url: 'https://93.184.216.34/ready', active: true }] } };
      if (command === 'get') return { success: true, data: { url: 'https://93.184.216.34/jobs' } };
      return { success: true, data: {} };
    });
    const runtime = new AgentBrowserRuntime({ executablePath: process.execPath, companionExecutablePath: process.execPath, runtimeRoot, resolveUploadFile: vi.fn(), runProcess, launchCompanion });

    const first = await runtime.Prepare({ toolName: 'BrowserNavigate', arguments: { url: 'https://93.184.216.34/jobs' } });
    await runtime.Execute({ proposal: first });
    await runtime.SetUnattended(true);
    expect(closeCompanions[0]).toHaveBeenCalledOnce();
    const scheduled = await runtime.Prepare({ toolName: 'BrowserNavigate', arguments: { url: 'https://93.184.216.34/scheduled' } });
    await runtime.Execute({ proposal: scheduled });
    expect(launchCompanion).toHaveBeenCalledTimes(2);
    await runtime.SetUnattended(false);
    expect(closeCompanions[1]).toHaveBeenCalledOnce();
    await runtime.Close();
  });

  it('BOSS 只允许可见运行，且连续外部动作应用最小安全间隔', async () => {
    const runtimeRoot = await mkdtemp(join(tmpdir(), 'avery-browser-boss-guard-'));
    temporaryRoots.push(runtimeRoot);
    let currentUrl = 'about:blank';
    let now = 1_000;
    const waits: number[] = [];
    const launchCompanion = vi.fn(async () => ({ port: 9660, homeUrl: 'about:blank', isAlive: () => true, close: vi.fn(async () => undefined) }));
    const runProcess = vi.fn(async ({ args }: { args: string[] }) => {
      const commandIndex = args.findIndex((arg) => ['open', 'get', 'snapshot', 'tab', 'click', 'close'].includes(arg));
      const command = args[commandIndex];
      if (command === 'open') currentUrl = args[commandIndex + 1];
      if (command === 'get') return { success: true, data: { url: currentUrl } };
      if (command === 'snapshot') return { success: true, data: { refs: { e1: { role: 'button', name: '下一页' } } } };
      if (command === 'tab') return { success: true, data: { tabs: [{ tabId: 'boss-tab', url: 'about:blank', active: true }] } };
      return { success: true, data: {} };
    });
    const runtime = new AgentBrowserRuntime({
      executablePath: process.execPath, companionExecutablePath: process.execPath, runtimeRoot, resolveUploadFile: vi.fn(), runProcess, launchCompanion,
      normalizeNavigationUrl: async (value) => String(value), now: () => now,
      delay: async (milliseconds) => { waits.push(milliseconds); now += milliseconds; },
    });

    await runtime.SetUnattended(true);
    await expect(runtime.Prepare({ toolName: 'BrowserNavigate', arguments: { url: 'https://www.zhipin.com/web/geek/job?query=agent' } })).rejects.toMatchObject({ code: 'BROWSER_SITE_VISIBLE_REQUIRED' });
    expect(launchCompanion).not.toHaveBeenCalled();

    await runtime.SetUnattended(false);
    const navigate = await runtime.Prepare({ toolName: 'BrowserNavigate', arguments: { url: 'https://www.zhipin.com/web/geek/job?query=agent' } });
    await runtime.Execute({ proposal: navigate });
    const snapshot = await runtime.Prepare({ toolName: 'BrowserSnapshot', arguments: {} });
    const observed = await runtime.Execute({ proposal: snapshot });
    const click = await runtime.Prepare({ toolName: 'BrowserClick', arguments: { ref: '@e1', pageRevision: (observed.data as any).pageRevision } });
    await runtime.Execute({ proposal: click });

    expect(waits).toEqual([2_000]);
    await runtime.Close();
  });

  it('BOSS 风控跳转停止导航且保留可见页面，不更换实例重试', async () => {
    const runtimeRoot = await mkdtemp(join(tmpdir(), 'avery-browser-boss-risk-'));
    temporaryRoots.push(runtimeRoot);
    const closeCompanion = vi.fn(async () => undefined);
    const runProcess = vi.fn(async ({ args }: { args: string[] }) => {
      const command = args.find((arg) => ['open', 'get', 'tab', 'close'].includes(arg));
      if (command === 'get') return { success: true, data: { url: 'https://www.zhipin.com/web/user/safe' } };
      if (command === 'tab') return { success: true, data: { tabs: [{ tabId: 'boss-tab', url: 'about:blank', active: true }] } };
      return { success: true, data: {} };
    });
    const runtime = new AgentBrowserRuntime({
      executablePath: process.execPath, companionExecutablePath: process.execPath, runtimeRoot, resolveUploadFile: vi.fn(), runProcess,
      launchCompanion: vi.fn(async () => ({ port: 9661, homeUrl: 'about:blank', isAlive: () => true, close: closeCompanion })),
      normalizeNavigationUrl: async (value) => String(value),
    });

    const proposal = await runtime.Prepare({ toolName: 'BrowserNavigate', arguments: { url: 'https://www.zhipin.com/web/geek/job?query=agent' } });
    await expect(runtime.Execute({ proposal })).rejects.toMatchObject({ code: 'BROWSER_SITE_RISK_DETECTED' });
    expect(runProcess.mock.calls.filter(([input]) => input.args.includes('open'))).toHaveLength(1);
    expect(closeCompanion).not.toHaveBeenCalled();
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

  it('构造期导航策略可收窄到测试 origin，默认策略仍拒绝本地地址', async () => {
    const runtimeRoot = await mkdtemp(join(tmpdir(), 'avery-browser-policy-'));
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
    const runtimeRoot = await mkdtemp(join(tmpdir(), 'avery-browser-runtime-'));
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
    expect(openCall).toEqual(expect.arrayContaining(['--namespace', `avery-${process.pid}-1`, '--session', 'avery-default', '--cdp', '9339', '--pin-tab', '--no-auto-dialog', '--content-boundaries', '--json']));
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

  it('BrowserFillForm 从私有档案计划匹配字段并仅通过 JSON stdin 批量填写', async () => {
    const runtimeRoot = await mkdtemp(join(tmpdir(), 'avery-browser-fill-form-'));
    temporaryRoots.push(runtimeRoot);
    const calls: Array<{ args: string[]; stdin?: string }> = [];
    let batchExecuted = false;
    const runProcess = vi.fn(async ({ args, stdin }: { args: string[]; stdin?: string }) => {
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
    const runtime = new AgentBrowserRuntime({
      executablePath: process.execPath,
      companionExecutablePath: process.execPath,
      runtimeRoot,
      resolveUploadFile: vi.fn(),
      runProcess,
      launchCompanion: vi.fn(async () => ({ port: 9630, homeUrl: 'https://93.184.216.34/ready', isAlive: () => true, close: vi.fn(async () => undefined) })),
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
    expect(proposal.canonicalArguments).toMatchObject({ profileIds: ['profile-1', 'education-1', 'project-1'], planId: expect.any(String), planHash: expect.any(String) });
    const outcome = await runtime.Execute({ proposal });

    const batchCalls = calls.filter((call) => call.args.includes('batch'));
    expect(batchCalls).toHaveLength(1);
    expect(batchCalls[0].args).toEqual(expect.arrayContaining(['batch', '--json']));
    expect(batchCalls[0].args).not.toContain('--bail');
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
    expect(JSON.stringify(outcome)).not.toContain(name);
    expect(JSON.stringify(outcome)).not.toContain(email);
    expect(JSON.stringify(outcome)).not.toContain(idNumber);
    expect(JSON.stringify(outcome)).not.toContain(phone);

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
    const runProcess = vi.fn(async ({ args, stdin }: { args: string[]; stdin?: string }) => {
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
    const runtime = new AgentBrowserRuntime({
      executablePath: process.execPath, companionExecutablePath: process.execPath, runtimeRoot, resolveUploadFile: vi.fn(), runProcess,
      launchCompanion: vi.fn(async () => ({ port: 9650, homeUrl: 'https://93.184.216.34/application', isAlive: () => true, close: vi.fn(async () => undefined) })),
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
    expect(outcome).toMatchObject({ data: { filled: [{ fieldId: 'field-e2', concept: 'education.school', strategy: 'semantic' }], ambiguous: [], unmatched: [] } });
    await runtime.Close();
  });

  it('BrowserFillForm 全局保留高分匹配，不让靠前的低分字段占用不可复用资料', async () => {
    const runtimeRoot = await mkdtemp(join(tmpdir(), 'avery-browser-global-form-match-'));
    temporaryRoots.push(runtimeRoot);
    const batchInputs: string[] = [];
    let batchExecuted = false;
    const runProcess = vi.fn(async ({ args, stdin }: { args: string[]; stdin?: string }) => {
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
    const runtime = new AgentBrowserRuntime({
      executablePath: process.execPath, companionExecutablePath: process.execPath, runtimeRoot, resolveUploadFile: vi.fn(), runProcess,
      launchCompanion: vi.fn(async () => ({ port: 9652, homeUrl: 'https://93.184.216.34/application', isAlive: () => true, close: vi.fn(async () => undefined) })),
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
      filled: [{ fieldId: 'field-e3', strategy: 'exact' }],
      unmatched: [{ fieldId: 'field-e2' }],
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
    const runProcess = vi.fn(async ({ args, stdin }: { args: string[]; stdin?: string }) => {
      const command = args.find((arg) => ['open', 'get', 'snapshot', 'tab', 'batch', 'eval', 'close'].includes(arg));
      if (command === 'get') return { success: true, data: { url: 'https://93.184.216.34/application' } };
      if (command === 'snapshot') return { success: true, data: { refs: refs() } };
      if (command === 'tab') return { success: true, data: { tabs: [{ tabId: 't1', url: 'https://93.184.216.34/application', active: true }] } };
      if (command === 'batch') { batchExecuted = true; batchInputs.push(stdin ?? ''); return { success: true, data: { results: [{ success: true }] } }; }
      return { success: true, data: {} };
    });
    const runtime = new AgentBrowserRuntime({
      executablePath: process.execPath, companionExecutablePath: process.execPath, runtimeRoot, resolveUploadFile: vi.fn(), runProcess,
      launchCompanion: vi.fn(async () => ({ port: 9651, homeUrl: 'https://93.184.216.34/application', isAlive: () => true, close: vi.fn(async () => undefined) })),
    });
    const sources = { profiles: [{
      id: 'project-1', category: 'project', title: '项目经历',
      content: '[项目经历]\n项目描述：用于验证混合匹配\n项目职责：负责字段匹配',
    }] };

    await runtime.Execute({ proposal: await runtime.Prepare({ toolName: 'BrowserNavigate', arguments: { url: 'https://93.184.216.34/application' } }) });
    const first = await runtime.Execute({ proposal: await runtime.Prepare({ toolName: 'BrowserFillForm', arguments: {
      profileIds: ['project-1'], __formSources: sources,
    } }) });
    const unresolved = (first.data as any).ambiguous[0] as { fieldId: string; candidates: Array<{ candidateId: string; concept: string }> };
    const candidates = unresolved.candidates;
    const responsibility = candidates.find((candidate) => candidate.concept === 'project.responsibility');
    expect(responsibility).toBeDefined();
    expect(batchInputs).toHaveLength(0);
    await expect(runtime.Prepare({ toolName: 'BrowserFillForm', arguments: {
      continuationId: (first.data as any).continuationId,
      resolutions: [{ fieldId: 'f999', candidateId: 'c999' }],
    } })).rejects.toMatchObject({ code: 'BROWSER_ARGUMENT_INVALID' });

    const second = await runtime.Execute({ proposal: await runtime.Prepare({ toolName: 'BrowserFillForm', arguments: {
      continuationId: (first.data as any).continuationId,
      resolutions: [{ fieldId: unresolved.fieldId, candidateId: responsibility!.candidateId }],
    } }) });
    expect(JSON.parse(batchInputs[0])).toEqual([['fill', '@e4', '负责字段匹配']]);
    expect(second).toMatchObject({ data: { filled: [{ fieldId: 'field-e4', concept: 'project.responsibility', strategy: 'agent' }] } });
    await runtime.Close();
  });

  it('BrowserInspectForm 与 BrowserValidateForm 返回紧凑字段和必填问题且不回显字段值', async () => {
    const runtimeRoot = await mkdtemp(join(tmpdir(), 'avery-browser-form-inspection-'));
    temporaryRoots.push(runtimeRoot);
    const calls: Array<{ args: string[]; stdin?: string }> = [];
    const runProcess = vi.fn(async ({ args, stdin }: { args: string[]; stdin?: string }) => {
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
    const runtime = new AgentBrowserRuntime({
      executablePath: process.execPath,
      companionExecutablePath: process.execPath,
      runtimeRoot,
      resolveUploadFile: vi.fn(),
      runProcess,
      launchCompanion: vi.fn(async () => ({ port: 9631, homeUrl: 'https://93.184.216.34/ready', isAlive: () => true, close: vi.fn(async () => undefined) })),
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
    expect(enrichmentCalls).toHaveLength(6);
    const expressions = enrichmentCalls.map((call) => EvalExpression(call.args, call.stdin));
    const inspectTransport = enrichmentCalls.find((call) => call.stdin === FormSemanticEnrichmentExpression);
    expect(inspectTransport?.args).toContain('--stdin');
    expect(inspectTransport?.args.join(' ').length).toBeLessThan(2_000);
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
    const runProcess = vi.fn(async ({ args, stdin }: { args: string[]; stdin?: string }) => {
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
    const runtime = new AgentBrowserRuntime({
      executablePath: process.execPath,
      companionExecutablePath: process.execPath,
      runtimeRoot,
      resolveUploadFile: vi.fn(),
      runProcess,
      delay: vi.fn(async () => undefined),
      launchCompanion: vi.fn(async () => ({ port: 9632, homeUrl: 'https://93.184.216.34/application', isAlive: () => true, close: vi.fn(async () => undefined) })),
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

    expect(clicks).toEqual(['@e2', '@e10', '@e13', '@e14']);
    expect(evalExpressions.some((expression) => expression.includes('data-avery-dynamic-option'))).toBe(true);
    expect(evalExpressions.some((expression) => expression.includes('typeof element.onclick'))).toBe(true);
    expect(evalExpressions.some((expression) => expression.includes('geographic(display)'))).toBe(true);
    expect(evalExpressions.some((expression) => expression.includes('other.selectionControl && !candidate.selectionControl'))).toBe(true);
    expect(evalExpressions.some((expression) => expression.includes("|| getComputedStyle(element).cursor === 'pointer'"))).toBe(true);
    for (const expression of evalExpressions) expect(() => new Function(expression)).not.toThrow();
    expect(outcome).toMatchObject({ status: 'succeeded', data: { filledCount: 1, missingFields: [] } });
    expect(JSON.stringify(outcome)).not.toContain('广东佛山');
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
    const runProcess = vi.fn(async ({ args, stdin }: { args: string[]; stdin?: string }) => {
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
    const runtime = new AgentBrowserRuntime({
      executablePath: process.execPath, companionExecutablePath: process.execPath, runtimeRoot, resolveUploadFile: vi.fn(), runProcess, delay,
      launchCompanion: vi.fn(async () => ({ port: 9638, homeUrl: 'https://93.184.216.34/application', isAlive: () => true, close: vi.fn(async () => undefined) })),
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
    const runProcess = vi.fn(async ({ args, stdin, deadline }: { args: string[]; stdin?: string; deadline: number }) => {
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
    const runtime = new AgentBrowserRuntime({
      executablePath: process.execPath, companionExecutablePath: process.execPath, runtimeRoot, resolveUploadFile: vi.fn(), runProcess,
      delay: vi.fn(async () => undefined),
      launchCompanion: vi.fn(async () => ({ port: 9640, homeUrl: 'https://93.184.216.34/application', isAlive: () => true, close: vi.fn(async () => undefined) })),
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
    const runProcess = vi.fn(async ({ args, stdin }: { args: string[]; stdin?: string }) => {
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
    const runtime = new AgentBrowserRuntime({
      executablePath: process.execPath, companionExecutablePath: process.execPath, runtimeRoot, resolveUploadFile: vi.fn(), runProcess,
      delay: vi.fn(async () => undefined),
      launchCompanion: vi.fn(async () => ({ port: 9635, homeUrl: 'https://93.184.216.34/application', isAlive: () => true, close: vi.fn(async () => undefined) })),
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
    const runProcess = vi.fn(async ({ args, stdin }: { args: string[]; stdin?: string }) => {
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
    const runtime = new AgentBrowserRuntime({
      executablePath: process.execPath, companionExecutablePath: process.execPath, runtimeRoot, resolveUploadFile: vi.fn(), runProcess,
      delay: vi.fn(async () => undefined),
      launchCompanion: vi.fn(async () => ({ port: 9639, homeUrl: 'https://93.184.216.34/application', isAlive: () => true, close: vi.fn(async () => undefined) })),
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
    const runProcess = vi.fn(async ({ args, stdin }: { args: string[]; stdin?: string }) => {
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
    const runtime = new AgentBrowserRuntime({
      executablePath: process.execPath, companionExecutablePath: process.execPath, runtimeRoot, resolveUploadFile: vi.fn(), runProcess,
      delay: vi.fn(async () => undefined),
      launchCompanion: vi.fn(async () => ({ port: 9642, homeUrl: 'https://93.184.216.34/application', isAlive: () => true, close: vi.fn(async () => undefined) })),
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
    const runProcess = vi.fn(async ({ args, stdin }: { args: string[]; stdin?: string }) => {
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
    const runtime = new AgentBrowserRuntime({
      executablePath: process.execPath, companionExecutablePath: process.execPath, runtimeRoot, resolveUploadFile: vi.fn(), runProcess,
      delay: vi.fn(async () => undefined),
      launchCompanion: vi.fn(async () => ({ port: 9637, homeUrl: 'https://93.184.216.34/application', isAlive: () => true, close: vi.fn(async () => undefined) })),
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
    const runProcess = vi.fn(async ({ args, stdin }: { args: string[]; stdin?: string }) => {
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
    const runtime = new AgentBrowserRuntime({
      executablePath: process.execPath, companionExecutablePath: process.execPath, runtimeRoot, resolveUploadFile: vi.fn(), runProcess,
      delay: vi.fn(async () => undefined),
      launchCompanion: vi.fn(async () => ({ port: 9636, homeUrl: 'https://93.184.216.34/application', isAlive: () => true, close: vi.fn(async () => undefined) })),
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
    const runProcess = vi.fn(async ({ args }: { args: string[] }) => {
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
    const runtime = new AgentBrowserRuntime({
      executablePath: process.execPath,
      companionExecutablePath: process.execPath,
      runtimeRoot,
      resolveUploadFile: vi.fn(),
      runProcess,
      delay: vi.fn(async () => undefined),
      launchCompanion: vi.fn(async () => ({ port: 9634, homeUrl: 'https://93.184.216.34/application', isAlive: () => true, close: vi.fn(async () => undefined) })),
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
    const runProcess = vi.fn(async ({ args }: { args: string[] }) => {
      const commandIndex = args.findIndex((arg) => ['open', 'get', 'snapshot', 'tab', 'click', 'eval', 'close'].includes(arg));
      const command = args[commandIndex];
      if (command === 'tab') return { success: true, data: { tabs: [{ tabId: 't1', url: 'https://93.184.216.34/application', active: true }] } };
      if (command === 'get') return { success: true, data: { url: 'https://93.184.216.34/application' } };
      if (command === 'click') { clicks.push(args[commandIndex + 1]); return { success: true, data: {} }; }
      if (command === 'snapshot') return { success: true, data: { refs: { e2: { role: 'combobox', name: '政治面貌', required: true } } } };
      return { success: true, data: {} };
    });
    const runtime = new AgentBrowserRuntime({
      executablePath: process.execPath,
      companionExecutablePath: process.execPath,
      runtimeRoot,
      resolveUploadFile: vi.fn(),
      runProcess,
      launchCompanion: vi.fn(async () => ({ port: 9633, homeUrl: 'https://93.184.216.34/application', isAlive: () => true, close: vi.fn(async () => undefined) })),
    });

    await runtime.Execute({ proposal: await runtime.Prepare({ toolName: 'BrowserNavigate', arguments: { url: 'https://93.184.216.34/application' } }) });
    const inspection = await runtime.Execute({ proposal: await runtime.Prepare({ toolName: 'BrowserInspectForm', arguments: {} }) });
    const outcome = await runtime.Execute({ proposal: await runtime.Prepare({
      toolName: 'BrowserFillForm',
      arguments: {
        pageRevision: (inspection.data as any).pageRevision,
        profileIds: ['profile-empty'],
        __formSources: { profiles: [{ id: 'profile-empty', category: 'application', title: '空档案', content: '[个人信息]' }] },
      },
    }) });

    expect(clicks).toEqual([]);
    expect(outcome).toMatchObject({ status: 'succeeded', data: {
      filledCount: 0,
      missingFields: [{ key: 'politicalStatus', label: '政治面貌', control: 'select', required: true }],
    } });
    await runtime.Close();
  });

  it('companion 异常退出后重启并拒绝崩溃前的页面引用', async () => {
    const runtimeRoot = await mkdtemp(join(tmpdir(), 'avery-browser-recovery-'));
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
    expect(new Set(attachedNamespaces)).toEqual(new Set([`avery-${process.pid}-1`, `avery-${process.pid}-2`]));

    const recoveredSnapshot = await runtime.Prepare({ toolName: 'BrowserSnapshot', arguments: {} });
    const recovered = await runtime.Execute({ proposal: recoveredSnapshot });
    const recoveredClick = await runtime.Prepare({ toolName: 'BrowserClick', arguments: { ref: '@e1', pageRevision: (recovered.data as any).pageRevision } });
    await runtime.Execute({ proposal: recoveredClick });
    expect(calls.filter((args) => args.includes('click'))).toHaveLength(1);
    await runtime.Close();
  });

  it('导航遇到失效 CDP 时淘汰旧 daemon，并使用新 namespace 仅重试一次', async () => {
    const runtimeRoot = await mkdtemp(join(tmpdir(), 'avery-browser-cdp-recovery-'));
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
    expect(openNamespaces).toEqual([`avery-${process.pid}-1`, `avery-${process.pid}-2`]);
    await expect(runtime.GetStatus()).resolves.toMatchObject({ available: true, running: true, state: 'ready' });
    await runtime.Close();
  });

  it('BrowserFillForm 批次超时返回字段级失败，不关闭仍可见的浏览器实例', async () => {
    const runtimeRoot = await mkdtemp(join(tmpdir(), 'avery-browser-fill-timeout-'));
    temporaryRoots.push(runtimeRoot);
    const closeCompanion = vi.fn(async () => undefined);
    const recordLog = vi.fn();
    const runProcess = vi.fn(async ({ args }: { args: string[] }) => {
      const command = args.find((arg) => ['open', 'get', 'snapshot', 'tab', 'batch', 'eval', 'close'].includes(arg));
      if (command === 'get') return { success: true, data: { url: 'https://93.184.216.34/application' } };
      if (command === 'snapshot') return { success: true, data: { refs: { e1: { role: 'textbox', tag: 'input', name: '姓名', valueLength: 0 } } } };
      if (command === 'tab') return { success: true, data: { tabs: [{ tabId: 't1', url: 'https://93.184.216.34/application', active: true }] } };
      if (command === 'batch') throw new AgentBrowserError('BROWSER_COMMAND_TIMEOUT', 'Browser command timed out.', true);
      return { success: true, data: {} };
    });
    const runtime = new AgentBrowserRuntime({
      executablePath: process.execPath,
      companionExecutablePath: process.execPath,
      runtimeRoot,
      resolveUploadFile: vi.fn(),
      runProcess,
      recordLog,
      launchCompanion: vi.fn(async () => ({
        port: 9655,
        homeUrl: 'https://93.184.216.34/application',
        isAlive: () => true,
        close: closeCompanion,
      })),
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
    expect(closeCompanion).not.toHaveBeenCalled();
    await runtime.Close();
    expect(closeCompanion).toHaveBeenCalledOnce();
  });
});
