import { ipcMain, shell } from 'electron';
import type { BrowserWindow, IpcMain } from 'electron';
import { spawn } from 'node:child_process';
import { readFile, realpath, stat } from 'node:fs/promises';
import { basename, delimiter, dirname, join } from 'node:path';
import { homedir } from 'node:os';
import type { AgentBrowserRuntimeStatus, EgoBrowserSetup, ResultEnvelope } from '@avery/contracts';
import { CreateGatewayLimiter, ValidateSender } from './gateway';

/** 固定官方入口；不接受 Renderer 提供安装脚本、网址或浏览器启动参数。 */
const EgoDownloadUrl = 'https://lite.ego.app/';
const ConnectionAttempts = 3;

/** 标准安装位置优先；CLI 的版本目录可定位自定义安装的主程序，首次引导未完成也可启动。 */
export async function ResolveEgoBrowserApplication(): Promise<string | null> {
  const candidates = process.platform === 'win32'
    ? [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA].filter((root): root is string => Boolean(root)).map((root) => join(root, 'Citro Labs', 'ego lite', 'Application', 'ego.exe'))
    : process.platform === 'darwin' ? ['/Applications/ego lite.app', join(homedir(), 'Applications', 'ego lite.app')] : [];
  if (process.platform === 'win32') {
    const cliPaths = [
      join(homedir(), '.local', 'share', 'ego', 'active_version_dir', 'ego-browser.exe'),
      ...String(process.env.PATH ?? '').split(delimiter).filter(Boolean).map((directory) => join(directory.replace(/^"|"$/g, ''), 'ego-browser.exe')),
    ];
    for (const cliPath of cliPaths) {
      try { candidates.push(join(dirname(await realpath(cliPath)), '..', 'ego.exe')); }
      catch { /* 未完成引导或 PATH 尚未刷新时，仍使用标准安装目录。 */ }
    }
  }
  for (const candidate of candidates) {
    try {
      const info = await stat(candidate);
      if (process.platform === 'darwin' ? info.isDirectory() : info.isFile()) return candidate;
    } catch { /* 继续检查其他已安装位置，不修改用户环境。 */ }
  }
  return null;
}

/** 扩展通道使用浏览器可执行文件；macOS 从包声明读取名称，避免猜测二进制路径。 */
export async function ResolveEgoExtensionExecutable(): Promise<string | null> {
  const application = await ResolveEgoBrowserApplication();
  if (!application || process.platform !== 'darwin') return application;
  try {
    const plist = await readFile(join(application, 'Contents', 'Info.plist'), 'utf8');
    const executable = plist.match(/<key>CFBundleExecutable<\/key>\s*<string>([^<]+)<\/string>/)?.[1];
    if (!executable || basename(executable) !== executable) return null;
    const path = join(application, 'Contents', 'MacOS', executable);
    return (await stat(path)).isFile() ? path : null;
  } catch { return null; }
}

/** 打开已有浏览器配置；不新建配置目录、不导入个人数据，也不创建任务空间。 */
export async function LaunchEgoBrowser(executable: string): Promise<void> {
  if (process.platform === 'darwin') {
    const error = await shell.openPath(executable);
    if (error) throw new Error(error);
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const child = spawn(executable, [], { shell: false, detached: true, stdio: 'ignore', windowsHide: false });
    child.once('error', reject);
    child.once('spawn', () => { child.unref(); resolve(); });
  });
}

interface EgoSetupOptions {
  webContentsGetter: () => BrowserWindow | undefined;
  probe: () => Promise<AgentBrowserRuntimeStatus>;
  ipcMainApi?: Pick<IpcMain, 'handle'>;
  resolveApplication?: typeof ResolveEgoBrowserApplication;
  launch?: typeof LaunchEgoBrowser;
  openDownload?: (url: string) => Promise<void>;
  wait?: (milliseconds: number) => Promise<void>;
}

/** 启动由 Main 调度，握手复用 Backend 的只读检测；任何时候都不把进程启动当成已连接。 */
export function RegisterEgoBrowserSetup({ webContentsGetter, probe, ipcMainApi = ipcMain, resolveApplication = ResolveEgoBrowserApplication, launch = LaunchEgoBrowser, openDownload = shell.openExternal, wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)) }: EgoSetupOptions): void {
  const limiter = CreateGatewayLimiter({ burst: 2, refillPerSecond: 0.2 });
  let opening = false;
  ipcMainApi.handle('app:open-ego-browser-setup', async (event, ...args: unknown[]): Promise<ResultEnvelope<EgoBrowserSetup>> => {
    if (!ValidateSender(event, webContentsGetter)) return { ok: false, error: { code: 'PERMISSION_DENIED', message: 'ego lite 接入请求来源无效。', retryable: false } };
    if (args.length) return { ok: false, error: { code: 'VALIDATION_ERROR', message: 'ego lite 接入不接受自定义参数。', retryable: false } };
    if (opening || !limiter.Allow(String(event.sender.id))) return { ok: false, error: { code: 'WORKSPACE_BUSY', message: '正在接入 ego lite，请稍后重试。', retryable: true } };
    opening = true;
    try {
      const executable = await resolveApplication();
      if (!executable) {
        await openDownload(EgoDownloadUrl);
        return { ok: true, data: { engine: 'ego', action: 'download_opened' } };
      }
      await launch(executable);
      let status: AgentBrowserRuntimeStatus | undefined;
      // 冷启动服务需要时间：最多三次真实握手，每次 Backend 自带 5 秒超时，不轮询个人页面。
      for (let attempt = 0; attempt < ConnectionAttempts; attempt += 1) {
        status = await probe();
        if (status.engine !== 'ego') return { ok: false, error: { code: 'REVISION_CONFLICT', message: '浏览器选择已变化，请重新选择 ego lite 后接入。', retryable: true } };
        if (status.running && status.state === 'ready' || status.state === 'not_installed') break;
        if (attempt + 1 < ConnectionAttempts) await wait(1000);
      }
      return { ok: true, data: { engine: 'ego', action: 'launched', status: status! } };
    } catch { return { ok: false, error: { code: 'INTERNAL_ERROR', message: 'ego lite 启动或连接检测失败，请打开浏览器完成首次引导后重试。', retryable: true } }; }
    finally { opening = false; }
  });
}
