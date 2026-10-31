import { createServer, type Socket } from 'node:net';
import { createInterface } from 'node:readline';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EgoBrowserBootstrap } from '../../../apps/backend/src/electron/backend/ego-browser-bootstrap';
import { AgentBrowserRuntime } from '../../../apps/backend/src/electron/backend/agent-browser-runtime';
import type { BrowserExtensionBridge } from '../../../apps/backend/src/electron/backend/browser-extension-bridge';
import { PersonalBrowserCdpError, type PersonalBrowserRuntimePort } from '../../../apps/backend/src/electron/backend/personal-browser-cdp-runtime';
import { DescribeEgoCliExit, EgoBrowserRuntimeProvider } from '../../../apps/backend/src/electron/backend/ego-browser-runtime';
import { BuildEgoNativeLaunch, QuoteWindowsArgument } from '../../../apps/backend/src/electron/backend/ego-browser-launcher';
import * as EgoBrowserLauncher from '../../../apps/backend/src/electron/backend/ego-browser-launcher';
import { SettingsSubmitSchema } from '../../../packages/contracts/src/write-schemas';

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

/** 运行固定引导脚本，通过真实本机传输核对原生调用边界，不启动用户浏览器。 */
async function CreateNativeHarness(closeTabs = true) {
  let closedSpace = false;
  let ownership = 'agent';
  const tabs = [{ targetId: 'own-page', title: '任务页面', url: 'https://example.com/', active: true }];
  const native = {
    createTaskSpace: vi.fn(async () => ({ id: 7 })),
    useTaskSpace: vi.fn(async (_id: number): Promise<unknown> => 7),
    listTabs: vi.fn(async () => ({ tabs })),
    listTaskSpaces: vi.fn(async () => ({ taskSpaces: closedSpace ? [] : [{ id: 7, ownership }] })),
    createTab: vi.fn(async (url: string) => { const tab = { targetId: 'new-page', title: '', url, active: true }; tabs.push(tab); return { targetId: tab.targetId }; }),
    closeTaskSpace: vi.fn(async () => { closedSpace = true; return { done: true }; }),
    completeTaskSpace: vi.fn(async () => { ownership = 'user'; return { done: true }; }),
    sendCDPMessage: vi.fn((data: string) => {
      const message = JSON.parse(data) as { id: number; method: string; sessionId?: string };
      queueMicrotask(() => native.onCDPMessage?.(JSON.stringify({ id: message.id, sessionId: message.sessionId, result: message.method === 'Target.attachToTarget' ? { sessionId: 'own-session' } : { result: { type: 'string', value: '任务内容' } } })));
    }),
    onCDPMessage: undefined as ((data: string) => void) | undefined,
    onSendCDPMessageError: undefined as ((message: string, code?: string) => void) | undefined,
  };
  vi.stubGlobal('ego', native);
  let socket!: Socket;
  const queue: Record<string, unknown>[] = [];
  const waiters: Array<(message: Record<string, unknown>) => void> = [];
  const server = createServer((connection) => {
    socket = connection;
    const lines = createInterface({ input: connection, crlfDelay: Infinity });
    lines.on('line', (line) => {
      const message = JSON.parse(line) as Record<string, unknown>;
      if (message.token) { connection.write('accepted\n'); return; }
      const resolve = waiters.shift();
      if (resolve) resolve(message); else queue.push(message);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No local test port.');
  const work = EgoBrowserBootstrap({ port: address.port, token: 'test-token', name: 'Avery test', closeTabs });
  const next = () => queue.length ? Promise.resolve(queue.shift()!) : new Promise<Record<string, unknown>>((resolve) => waiters.push(resolve));
  expect(await next()).toEqual({ ready: true, spaceId: 7 });
  let id = 0;
  return {
    native,
    async command(method: string, params: Record<string, unknown> = {}, sessionId?: string) {
      socket.write(`${JSON.stringify({ id: ++id, method, params, sessionId })}\n`);
      return next();
    },
    async close(shouldCloseTabs = closeTabs) {
      socket.write(`${JSON.stringify({ close: true, closeTabs: shouldCloseTabs })}\n`);
      const result = await next();
      await work;
      await new Promise<void>((resolve) => server.close(() => resolve()));
      return result;
    },
    async disconnect() {
      socket.destroy();
      await work;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

describe('ego lite 空间与 CDP 适配', () => {
  it.each([
    ['nodejs', '"nodejs"'],
    ['a b', '"a b"'],
    ['a"b', '"a\\"b"'],
    ['C:\\folder\\', '"C:\\folder\\\\"'],
    ['& | $() %PATH%', '"& | $() %PATH%"'],
  ])('Windows 参数 %s 保持为单个原生参数', (value, expected) => {
    expect(QuoteWindowsArgument(value)).toBe(expected);
  });

  it('普通权限直接启动；管理员只把固定 CLI 交给用户桌面，不提权浏览器或落盘令牌', () => {
    vi.stubEnv('SystemRoot', 'C:\\Windows');
    const executable = 'C:\\Program Files\\ego\\ego-browser.exe';
    const script = 'console.log("中文\\\\路径 & | %PATH%");';
    expect(BuildEgoNativeLaunch(executable, script, false)).toEqual({ executable, args: ['nodejs', '-e', script] });
    const launch = BuildEgoNativeLaunch(executable, script, true);
    expect(launch.executable).toMatch(/powershell\.exe$/);
    expect(launch.args).toEqual(expect.arrayContaining(['-NoProfile', '-NonInteractive', '-EncodedCommand']));
    const helper = Buffer.from(launch.args.at(-1)!, 'base64').toString('utf16le');
    expect(helper).toContain('FindWindowSW');
    expect(helper).toContain('ShellExecute');
    expect(helper).not.toContain(script);
    expect(helper).not.toContain('RunAs');
    expect(helper).not.toContain('Bypass');
    const envelope = JSON.parse(launch.input!);
    expect(envelope.executable).toBe(executable);
    expect(envelope.arguments).toContain('中文');
    expect(envelope.arguments).toContain('& | %PATH%');
  });

  it('原生退出摘要保留真正错误，丢弃脚本正文、令牌和本地路径', () => {
    const token = 'a'.repeat(64);
    const output = `host script with token ${token}\nError: Cannot find module 'D:\\private\\user\\native.js' ${token}\n at hidden stack`;
    const message = DescribeEgoCliExit(output, 1, null);
    expect(message).toContain('exit=1');
    expect(message).toContain('Error: Cannot find module');
    expect(message).toContain('[PATH]');
    expect(message).not.toContain(token);
    expect(message).not.toContain('private');
    expect(message).not.toContain('host script');
    expect(message).not.toContain('hidden stack');
    expect(DescribeEgoCliExit("Error: Cannot load '/Users/private/module.js'", 1, null)).not.toContain('/Users/private');
  });
  it('设置契约接受 ego，仍拒绝未支持的引擎', () => {
    expect(SettingsSubmitSchema.parse({ browserEngine: 'ego' })).toEqual({ browserEngine: 'ego' });
    expect(SettingsSubmitSchema.safeParse({ browserEngine: 'unknown' }).success).toBe(false);
    expect(SettingsSubmitSchema.parse({ closeTaskTabs: false })).toEqual({ closeTaskTabs: false });
    expect(SettingsSubmitSchema.safeParse({ closeTaskTabs: 'false' }).success).toBe(false);
  });

  it('未安装时明确报告不可用，不创建空间', async () => {
    const provider = new EgoBrowserRuntimeProvider(async () => null);
    expect(await provider.GetStatus(true)).toMatchObject({ available: false, connected: false });
    await expect(provider.CreateRuntime()).rejects.toMatchObject({ code: 'BROWSER_EGO_UNAVAILABLE' });
  });

  it('原生引导进程提前退出时立即结束连接等待，不挂到 CDP 总超时', async () => {
    // 普通 Node 无 ego 的 nodejs 子命令，模拟 CLI 启动即失败；不依赖本机安装状态。
    const elevation = vi.spyOn(EgoBrowserLauncher, 'IsEgoHostElevated').mockResolvedValue(false);
    const provider = new EgoBrowserRuntimeProvider(async () => process.execPath);
    const runtime = await provider.CreateRuntime();
    try {
      await expect(runtime.Connect({ deadline: Date.now() + 5_000 })).rejects.toMatchObject({ code: 'BROWSER_EGO_UNAVAILABLE', message: expect.stringContaining('Cannot find module') });
      expect(runtime.IsConnected()).toBe(false);
    } finally { await runtime.Close(); elevation.mockRestore(); }
  });
  it('一次创建专属空间，列表和查询只来自该空间，拒绝外部目标及未知会话', async () => {
    const h = await CreateNativeHarness();
    try {
      expect(await h.command('Target.getTargets')).toMatchObject({ result: { targetInfos: [{ targetId: 'own-page', title: '任务页面' }] } });
      expect(await h.command('Target.getTargetInfo', { targetId: 'own-page' })).toMatchObject({ result: { targetInfo: { targetId: 'own-page' } } });
      for (const method of ['Target.getTargetInfo', 'Target.attachToTarget', 'Target.activateTarget']) {
        expect(await h.command(method, { targetId: 'personal-page' })).toMatchObject({ error: { code: 'BROWSER_TASK_RETIRED' } });
      }
      expect(await h.command('Runtime.evaluate', { expression: 'document.title' }, 'foreign-session')).toMatchObject({ error: { code: 'BROWSER_TASK_RETIRED' } });
      expect(h.native.sendCDPMessage).not.toHaveBeenCalled();
      expect(h.native.createTaskSpace).toHaveBeenCalledOnce();
      expect(h.native.useTaskSpace.mock.calls.every(([id]) => id === 7)).toBe(true);
    } finally { expect(await h.close()).toMatchObject({ closed: true, closedTabs: 1 }); }
    expect(h.native.listTaskSpaces).toHaveBeenCalled();
  });

  it('通过原生 createTab 在自有空间导航，附着后使用真实 CDP session，阻止其他 CDP 扩权', async () => {
    const h = await CreateNativeHarness();
    try {
      expect(await h.command('Target.createTarget', { url: 'https://example.com/apply' })).toMatchObject({ result: { targetId: 'new-page' } });
      expect(h.native.createTab).toHaveBeenCalledWith('https://example.com/apply');
      expect(await h.command('Target.attachToTarget', { targetId: 'new-page' })).toMatchObject({ result: { sessionId: 'own-session' } });
      expect(await h.command('Runtime.evaluate', { expression: 'document.title' }, 'own-session')).toMatchObject({ result: { result: { value: '任务内容' } } });
      const before = h.native.sendCDPMessage.mock.calls.length;
      expect(await h.command('Browser.close', {}, 'own-session')).toHaveProperty('error');
      expect(await h.command('Target.closeTarget', { targetId: 'new-page' })).toHaveProperty('error');
      expect(h.native.sendCDPMessage).toHaveBeenCalledTimes(before);
      expect(await h.command('Target.createTarget', { url: 'file:///private' })).toHaveProperty('error');
      expect(h.native.createTab).toHaveBeenCalledOnce();
    } finally { await h.close(); }
  });

  it('用户接管或空间消失时停下，不接管、不新建替代空间', async () => {
    const h = await CreateNativeHarness();
    try {
      h.native.useTaskSpace.mockImplementationOnce(async () => ({ error: '用户正在操作', error_code: 'EGO_TASK_SPACE_USER_IN_CONTROL' }));
      expect(await h.command('Target.getTargets')).toMatchObject({ error: { code: 'BROWSER_VISIBLE_USER_ACTION_REQUIRED' } });
      h.native.useTaskSpace.mockImplementationOnce(async () => ({ error: '空间已删除', error_code: 'EGO_TASK_SPACE_NOT_FOUND' }));
      expect(await h.command('Target.getTargets')).toMatchObject({ error: { code: 'BROWSER_TASK_RETIRED' } });
      expect(h.native.createTaskSpace).toHaveBeenCalledOnce();
      expect(h.native.sendCDPMessage).not.toHaveBeenCalled();
    } finally { await h.close(); }
  });

  it('原生关闭回执早于空间移除时，等待真实移除后才报告成功', async () => {
    const h = await CreateNativeHarness();
    h.native.listTaskSpaces.mockResolvedValueOnce({ taskSpaces: [{ id: 7 }] });
    expect(await h.close()).toMatchObject({ closed: true });
    expect(h.native.listTaskSpaces).toHaveBeenCalledTimes(2);
    expect(h.native.closeTaskSpace).toHaveBeenCalledOnce();
  });

  it('关闭自动关闭后保留空间、解除 CDP 会话并确认已交还用户', async () => {
    const h = await CreateNativeHarness(false);
    await h.command('Target.attachToTarget', { targetId: 'own-page' });
    expect(await h.close()).toMatchObject({ closed: true, closedTabs: 0, retainedTabs: 1 });
    expect(h.native.completeTaskSpace).toHaveBeenCalledOnce();
    expect(h.native.closeTaskSpace).not.toHaveBeenCalled();
    expect(h.native.sendCDPMessage.mock.calls.map(([data]) => JSON.parse(data).method)).toEqual(['Target.attachToTarget', 'Target.detachFromTarget']);
  });

  it('保留模式断线时也交还空间，不在 finally 删除页面', async () => {
    const h = await CreateNativeHarness(false);
    await h.disconnect();
    expect(h.native.completeTaskSpace).toHaveBeenCalledOnce();
    expect(h.native.closeTaskSpace).not.toHaveBeenCalled();
  });

  it('交还回执未改变空间归属时不能报告保留成功，也不能回退为删除', async () => {
    const h = await CreateNativeHarness(false);
    h.native.completeTaskSpace.mockImplementation(async () => ({ done: true }));
    expect(await h.close()).toMatchObject({ failure: true });
    expect(h.native.closeTaskSpace).not.toHaveBeenCalled();
  });

  it('ego 检测和导航使用扩展通道；同一任务复用驱动并由扩展清理标签页', async () => {
    let connected = false;
    const personal: PersonalBrowserRuntimePort = {
      Connect: vi.fn(async () => { connected = true; return { anchorUrl: '' }; }),
      Run: vi.fn(async (command) => ({ success: true as const, data: command[0] === 'open' ? { url: command[1] } : {} })),
      IsConnected: () => connected, GetBrowserTaskId: () => 'ego-extension-task', ResetReferences: vi.fn(),
      Close: vi.fn(async () => { connected = false; }),
    };
    const bridge = {
      Start: vi.fn(), EnsureConnected: vi.fn(), IsConnected: () => true,
      Status: () => ({ connected: true, state: 'online', port: 17653 }),
      CloseTask: vi.fn(async () => ({ status: 'confirmed', browserTaskId: 'ego-extension-task', closedTabs: 2, unknownTabs: 0 })), Close: vi.fn(),
    };
    const createExtensionRuntime = vi.fn(() => personal);
    const runtime = new AgentBrowserRuntime({ runtimeRoot: 'D:/Avery/项目外部产物-20261030/ego-unit', resolveUploadFile: async () => null, browserExtensionBridge: bridge as unknown as BrowserExtensionBridge, externalBrowserPaths: { ego: process.execPath }, createExtensionRuntime, closeBridgeOnClose: false });
    try {
      await runtime.SetEngine('ego');
      expect(await runtime.GetStatus(true)).toMatchObject({ engine: 'ego', state: 'ready', extension: { connected: true } });
      expect(createExtensionRuntime).not.toHaveBeenCalled();
      for (const url of ['https://example.com/first', 'https://example.com/second']) {
        const proposal = await runtime.Prepare({ toolName: 'BrowserNavigate', arguments: { url } });
        expect(await runtime.Execute({ proposal })).toMatchObject({ status: 'succeeded' });
      }
      expect(createExtensionRuntime).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ engine: 'ego', bridge }));
      expect(personal.Connect).toHaveBeenCalledOnce();
      expect(bridge.EnsureConnected).toHaveBeenCalledWith('ego', expect.any(Object));
      runtime.SetCloseTaskTabs(false);
      expect(await runtime.CloseTask()).toMatchObject({ status: 'confirmed', closedTabs: 2 });
      expect(bridge.CloseTask).toHaveBeenCalledWith('ego', 'ego-extension-task', expect.objectContaining({ closeTabs: true }));
    } finally { await runtime.Close(); }
  });

  it('ego 扩展清理结果未知时不能回报成功关闭', async () => {
    const personal: PersonalBrowserRuntimePort = {
      Connect: async () => ({ anchorUrl: '' }), Run: async () => ({ success: true, data: { url: 'https://example.com/' } }),
      IsConnected: () => true, GetBrowserTaskId: () => 'ego-unknown', ResetReferences: () => undefined, Close: vi.fn(async () => undefined),
    };
    const bridge = { EnsureConnected: vi.fn(), CloseTask: vi.fn(async () => ({ status: 'status_unknown', browserTaskId: 'ego-unknown', closedTabs: 0, unknownTabs: null })) };
    const runtime = new AgentBrowserRuntime({ runtimeRoot: 'D:/Avery/项目外部产物-20261030/ego-unit', resolveUploadFile: async () => null, browserExtensionBridge: bridge as unknown as BrowserExtensionBridge, createExtensionRuntime: () => personal, closeBridgeOnClose: false });
    await runtime.SetEngine('ego');
    const proposal = await runtime.Prepare({ toolName: 'BrowserNavigate', arguments: { url: 'https://example.com/' } });
    await runtime.Execute({ proposal });
    expect(await runtime.CloseTask()).toMatchObject({ status: 'status_unknown', unknownTabs: null });
    expect(personal.Close).toHaveBeenCalledOnce();
    await runtime.Close();
  });

  it('ego 扩展未连接时检测不能误报原生连接成功', async () => {
    const bridge = { Start: vi.fn(), IsConnected: () => false, Status: () => ({ connected: false, state: 'offline', port: 17653 }) };
    const runtime = new AgentBrowserRuntime({ runtimeRoot: 'D:/Avery/项目外部产物-20261030/ego-unit', resolveUploadFile: async () => null, browserExtensionBridge: bridge as unknown as BrowserExtensionBridge, externalBrowserPaths: { ego: process.execPath }, closeBridgeOnClose: false });
    await runtime.SetEngine('ego');
    expect(await runtime.GetStatus()).toMatchObject({ engine: 'ego', available: true, running: false, state: 'stopped', extension: { connected: false } });
    await runtime.Close();
  });
});
