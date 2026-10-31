import type { BrowserWindow, IpcMainInvokeEvent } from 'electron';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn }));
vi.mock('electron', () => ({ app: {}, clipboard: {}, ipcMain: {}, Notification: class {}, shell: {} }));
vi.mock('@avery/backend/dist/router', () => ({ FunctionRouteChannels: [], MethodRoutes: {}, WriteCommandChannels: new Set() }));
import { LaunchExtensionPage, RegisterBrowserExtensionSetup } from '../../../apps/desktop/src/browser-extension-setup';

let fixtureRoot: string, executable: string, extensionDirectory: string;
beforeAll(async () => {
  fixtureRoot = await mkdtemp(join(tmpdir(), 'avery-extension-setup-'));
  executable = join(fixtureRoot, 'browser.exe');
  extensionDirectory = join(fixtureRoot, 'browser extension');
  await mkdir(extensionDirectory);
  await writeFile(executable, 'test fixture, never executed');
  await writeFile(join(extensionDirectory, 'manifest.json'), JSON.stringify({ name: 'Avery Browser', manifest_version: 3 }));
  await writeFile(join(extensionDirectory, 'service-worker.js'), '');
});
afterAll(async () => {
  // 只清理本测试在系统临时目录创建的唯一目录。
  if (dirname(resolve(fixtureRoot)) !== resolve(tmpdir()) || !fixtureRoot.includes('avery-extension-setup-')) throw new Error('Unsafe fixture cleanup');
  await rm(fixtureRoot, { recursive: true, force: true });
});
beforeEach(() => vi.clearAllMocks());

function Setup(options: { extensionDirectory?: string; browserPaths?: { chrome?: string; edge?: string; ego?: string } } = {}) {
  const handlers = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>();
  const url = 'file:///D:/Avery/project/dist/index.html';
  const contents = { id: 1, getURL: () => url };
  const window = { isDestroyed: () => false, webContents: contents } as unknown as BrowserWindow;
  const launch = vi.fn<typeof LaunchExtensionPage>().mockResolvedValue(undefined);
  const openDirectory = vi.fn<(path: string) => Promise<string>>().mockResolvedValue('');
  RegisterBrowserExtensionSetup({
    webContentsGetter: () => window, browserPaths: { chrome: executable, edge: executable, ego: executable }, extensionDirectory,
    launch, openDirectory, ...options,
    ipcMainApi: { handle: (channel, handler) => { handlers.set(channel, handler); } },
  });
  return { open: handlers.get('app:open-browser-extension-setup')!, event: { sender: contents, senderFrame: { url } } as unknown as IpcMainInvokeEvent, launch, openDirectory };
}

describe('浏览器扩展接入引导', () => {
  it.each(['chrome', 'edge', 'ego'] as const)('明确打开所选 %s 的扩展页，不使用默认浏览器或其他用户配置', async (engine) => {
    const { open, event, launch, openDirectory } = Setup();
    await expect(open(event, engine)).resolves.toEqual({ ok: true, data: { engine, extensionDirectory, directoryOpened: true } });
    expect(launch).toHaveBeenCalledExactlyOnceWith(executable, `${engine === 'ego' ? 'chrome' : engine}://extensions/`);
    expect(openDirectory).toHaveBeenCalledExactlyOnceWith(extensionDirectory);
  });
  it('拒绝其他窗口、未知浏览器、任意路径和额外参数', async () => {
    const { open, event, launch, openDirectory } = Setup();
    await expect(open({ ...event, sender: {} } as IpcMainInvokeEvent, 'chrome')).resolves.toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } });
    for (const args of [[], ['firefox'], ['file:///C:/secret'], [{ engine: 'chrome' }], ['chrome', '--load-extension=evil']]) {
      await expect(open(event, ...args)).resolves.toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } });
    }
    expect(launch).not.toHaveBeenCalled(); expect(openDirectory).not.toHaveBeenCalled();
  });
  it('浏览器未安装或已被卸载时明确失败，不回退默认浏览器', async () => {
    for (const browserPaths of [{}, { chrome: join(fixtureRoot, 'missing.exe') }]) {
      const { open, event, launch, openDirectory } = Setup({ browserPaths });
      await expect(open(event, 'chrome')).resolves.toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
      expect(launch).not.toHaveBeenCalled(); expect(openDirectory).not.toHaveBeenCalled();
    }
  });
  it('打包资源缺失时拒绝继续，避免向用户打开无效的安装目录', async () => {
    const { open, event, launch, openDirectory } = Setup({ extensionDirectory: join(fixtureRoot, 'missing') });
    await expect(open(event, 'edge')).resolves.toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
    expect(launch).not.toHaveBeenCalled(); expect(openDirectory).not.toHaveBeenCalled();
  });
  it('ego lite 未安装时不调用其他已安装浏览器', async () => {
    const { open, event, launch, openDirectory } = Setup({ browserPaths: { chrome: executable, edge: executable } });
    await expect(open(event, 'ego')).resolves.toMatchObject({ ok: false, error: { code: 'NOT_FOUND', message: expect.stringContaining('ego lite') } });
    expect(launch).not.toHaveBeenCalled();
    expect(openDirectory).not.toHaveBeenCalled();
  });
  it.each(['返回错误', '抛出异常'])('目录打开失败（%s）仍可打开安装页并提供真实路径', async (mode) => {
    const { open, event, launch, openDirectory } = Setup();
    if (mode === '返回错误') openDirectory.mockResolvedValueOnce('Access denied');
    else openDirectory.mockRejectedValueOnce(new Error('Access denied'));
    await expect(open(event, 'chrome')).resolves.toMatchObject({ ok: true, data: { directoryOpened: false, extensionDirectory } });
    expect(launch).toHaveBeenCalledOnce();
  });
  it('浏览器启动失败有明确错误，释放占用后允许重试', async () => {
    const { open, event, launch } = Setup();
    launch.mockRejectedValueOnce(new Error('spawn failed'));
    await expect(open(event, 'edge')).resolves.toMatchObject({ ok: false, error: { code: 'INTERNAL_ERROR' } });
    await expect(open(event, 'edge')).resolves.toMatchObject({ ok: true });
  });
  it('并发点击不能重复启动浏览器', async () => {
    const { open, event, launch } = Setup();
    let release: () => void = () => {};
    launch.mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve; }));
    const first = open(event, 'chrome');
    await expect(open(event, 'chrome')).resolves.toMatchObject({ ok: false, error: { code: 'WORKSPACE_BUSY' } });
    await vi.waitFor(() => expect(launch).toHaveBeenCalledOnce());
    release();
    await expect(first).resolves.toMatchObject({ ok: true });
  });
  it('连续重复请求受频率限制', async () => {
    const { open, event, launch } = Setup();
    await open(event, 'edge'); await open(event, 'edge');
    await expect(open(event, 'edge')).resolves.toMatchObject({ ok: false, error: { code: 'WORKSPACE_BUSY' } });
    expect(launch).toHaveBeenCalledTimes(2);
  });
});

describe('浏览器原生启动', () => {
  it('使用分离参数且禁用 Shell，不添加加载扩展或调试开关', async () => {
    const child = Object.assign(new EventEmitter(), { unref: vi.fn() });
    spawn.mockReturnValueOnce(child);
    const launched = LaunchExtensionPage('C:/Program Files/Browser/browser.exe', 'chrome://extensions/');
    child.emit('spawn'); await launched;
    expect(spawn).toHaveBeenCalledExactlyOnceWith('C:/Program Files/Browser/browser.exe', ['chrome://extensions/'], { shell: false, detached: true, stdio: 'ignore', windowsHide: false });
    expect(child.unref).toHaveBeenCalledOnce();
  });
  it('异步进程错误向上返回，不能误报启动成功', async () => {
    const child = Object.assign(new EventEmitter(), { unref: vi.fn() });
    spawn.mockReturnValueOnce(child);
    const launched = LaunchExtensionPage('missing.exe', 'edge://extensions/');
    child.emit('error', new Error('ENOENT'));
    await expect(launched).rejects.toThrow('ENOENT');
  });
});
