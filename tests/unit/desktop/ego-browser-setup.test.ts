import type { BrowserWindow, IpcMainInvokeEvent } from 'electron';
import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import type { AgentBrowserRuntimeStatus } from '@avery/contracts';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { spawn, stat, realpath } = vi.hoisted(() => ({ spawn: vi.fn(), stat: vi.fn(), realpath: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn }));
vi.mock('node:fs/promises', () => ({ stat, realpath }));
vi.mock('electron', () => ({ app: {}, clipboard: {}, ipcMain: {}, Notification: class {}, shell: {} }));
vi.mock('@avery/backend/dist/router', () => ({ FunctionRouteChannels: [], MethodRoutes: {}, WriteCommandChannels: new Set() }));
import { LaunchEgoBrowser, RegisterEgoBrowserSetup, ResolveEgoBrowserApplication, ResolveEgoExtensionExecutable } from '../../../apps/desktop/src/ego-browser-setup';

const Ready: AgentBrowserRuntimeStatus = { engine: 'ego', available: true, running: true, state: 'ready', pageRevision: 0 };
const Stopped: AgentBrowserRuntimeStatus = { ...Ready, running: false, state: 'stopped', message: '等待浏览器启动' };
beforeEach(() => { vi.resetAllMocks(); vi.unstubAllEnvs(); });

function Setup() {
  const handlers = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>();
  const url = 'file:///D:/Avery/project/dist/index.html';
  const contents = { id: 1, getURL: () => url };
  const window = { isDestroyed: () => false, webContents: contents } as unknown as BrowserWindow;
  const resolveApplication = vi.fn(async (): Promise<string | null> => 'D:/ego/Application/ego.exe');
  const launch = vi.fn(async () => {}), openDownload = vi.fn(async () => {}), wait = vi.fn(async () => {});
  const probe = vi.fn(async () => Ready);
  RegisterEgoBrowserSetup({ webContentsGetter: () => window, resolveApplication, launch, openDownload, probe, wait,
    ipcMainApi: { handle: (channel, handler) => { handlers.set(channel, handler); } } });
  return { open: handlers.get('app:open-ego-browser-setup')!, event: { sender: contents, senderFrame: { url } } as unknown as IpcMainInvokeEvent, resolveApplication, launch, openDownload, probe, wait };
}

describe('ego lite 一键接入', () => {
  it('已安装时启动主程序并使用真实握手结果，不走扩展安装或下载入口', async () => {
    const h = Setup();
    await expect(h.open(h.event)).resolves.toEqual({ ok: true, data: { engine: 'ego', action: 'launched', status: Ready } });
    expect(h.launch).toHaveBeenCalledExactlyOnceWith('D:/ego/Application/ego.exe');
    expect(h.probe).toHaveBeenCalledOnce(); expect(h.openDownload).not.toHaveBeenCalled(); expect(h.wait).not.toHaveBeenCalled();
  });
  it('冷启动等待实际服务就绪，不把进程启动直接当成已连接', async () => {
    const h = Setup(); h.probe.mockResolvedValueOnce(Stopped).mockResolvedValueOnce(Ready);
    await expect(h.open(h.event)).resolves.toMatchObject({ ok: true, data: { status: Ready } });
    expect(h.probe).toHaveBeenCalledTimes(2); expect(h.launch).toHaveBeenCalledOnce(); expect(h.wait).toHaveBeenCalledOnce();
  });
  it('启动后服务仍未就绪时有限检测并返回未连接，不无限等待或伪造成功', async () => {
    const h = Setup(); h.probe.mockResolvedValue(Stopped);
    await expect(h.open(h.event)).resolves.toMatchObject({ ok: true, data: { action: 'launched', status: { running: false, state: 'stopped' } } });
    expect(h.probe).toHaveBeenCalledTimes(3); expect(h.wait).toHaveBeenCalledTimes(2);
  });
  it('程序存在但首次引导未注册 CLI 时提示未就绪，不重新下载', async () => {
    const h = Setup(); h.probe.mockResolvedValue({ ...Stopped, available: false, state: 'not_installed' });
    await expect(h.open(h.event)).resolves.toMatchObject({ ok: true, data: { action: 'launched', status: { state: 'not_installed' } } });
    expect(h.probe).toHaveBeenCalledOnce(); expect(h.openDownload).not.toHaveBeenCalled();
  });
  it('未安装时只打开固定官方下载页，不尝试自动安装或报告连接成功', async () => {
    const h = Setup(); h.resolveApplication.mockResolvedValue(null);
    await expect(h.open(h.event)).resolves.toEqual({ ok: true, data: { engine: 'ego', action: 'download_opened' } });
    expect(h.openDownload).toHaveBeenCalledExactlyOnceWith('https://lite.ego.app/');
    expect(h.launch).not.toHaveBeenCalled(); expect(h.probe).not.toHaveBeenCalled();
  });
  it('拒绝其他窗口、网址、脚本和启动参数', async () => {
    const h = Setup();
    await expect(h.open({ ...h.event, sender: {} } as IpcMainInvokeEvent)).resolves.toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } });
    for (const args of [['https://evil.example/'], [{ script: 'evil' }], ['--remote-debugging-port=9222']]) await expect(h.open(h.event, ...args)).resolves.toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } });
    expect(h.resolveApplication).not.toHaveBeenCalled(); expect(h.probe).not.toHaveBeenCalled();
  });
  it('重复点击不并发启动多个浏览器', async () => {
    const h = Setup(); let release: (value: string) => void = () => {};
    h.resolveApplication.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    const first = h.open(h.event);
    await expect(h.open(h.event)).resolves.toMatchObject({ ok: false, error: { code: 'WORKSPACE_BUSY' } });
    release('D:/ego/Application/ego.exe'); await first;
    expect(h.launch).toHaveBeenCalledOnce();
  });
  it.each(['launch', 'probe', 'openDownload'] as const)('%s 失败有明确反馈并释放占用', async (operation) => {
    const h = Setup();
    if (operation === 'openDownload') h.resolveApplication.mockResolvedValue(null);
    h[operation].mockRejectedValueOnce(new Error('unavailable'));
    await expect(h.open(h.event)).resolves.toMatchObject({ ok: false, error: { code: 'INTERNAL_ERROR' } });
    await expect(h.open(h.event)).resolves.toMatchObject({ ok: true });
  });
  it('浏览器设置变化时不能把其他引擎的连接误报为 ego 已连接', async () => {
    const h = Setup(); h.probe.mockResolvedValue({ ...Ready, engine: 'edge' });
    await expect(h.open(h.event)).resolves.toMatchObject({ ok: false, error: { code: 'REVISION_CONFLICT' } });
  });
});

describe.skipIf(process.platform !== 'win32')('Windows ego 程序发现与启动', () => {
  it('未注册 CLI 时仍能从标准安装位置发现主程序', async () => {
    vi.stubEnv('ProgramFiles', 'D:/Programs');
    realpath.mockRejectedValue(new Error('ENOENT'));
    stat.mockResolvedValue({ isFile: () => true });
    await expect(ResolveEgoBrowserApplication()).resolves.toBe(join('D:/Programs', 'Citro Labs', 'ego lite', 'Application', 'ego.exe'));
    await expect(ResolveEgoExtensionExecutable()).resolves.toBe(join('D:/Programs', 'Citro Labs', 'ego lite', 'Application', 'ego.exe'));
  });
  it('通过 CLI 的真实版本目录发现自定义安装，不依赖 Avery 启动时的 PATH 刷新', async () => {
    const binary = join('D:/Custom/ego/Application', '0.6.2.5', '..', 'ego.exe');
    realpath.mockResolvedValue(join('D:/Custom/ego/Application/0.6.2.5', 'ego-browser.exe'));
    stat.mockImplementation(async (path) => { if (path !== binary) throw new Error('ENOENT'); return { isFile: () => true }; });
    await expect(ResolveEgoBrowserApplication()).resolves.toBe(binary);
  });
  it('没有真实主程序时不能把 CLI 或目录当作已安装', async () => {
    realpath.mockRejectedValue(new Error('ENOENT')); stat.mockRejectedValue(new Error('ENOENT'));
    await expect(ResolveEgoBrowserApplication()).resolves.toBeNull();
  });
  it('使用零自定义参数和现有用户配置启动，不开放 Shell', async () => {
    const child = Object.assign(new EventEmitter(), { unref: vi.fn() }); spawn.mockReturnValueOnce(child);
    const result = LaunchEgoBrowser('D:/ego/Application/ego.exe'); child.emit('spawn'); await result;
    expect(spawn).toHaveBeenCalledExactlyOnceWith('D:/ego/Application/ego.exe', [], { shell: false, detached: true, stdio: 'ignore', windowsHide: false });
  });
});
