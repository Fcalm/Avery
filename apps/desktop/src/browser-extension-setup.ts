import { ipcMain, shell } from 'electron';
import type { BrowserWindow, IpcMain } from 'electron';
import { spawn } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { BrowserExtensionSetup, ExtensionBrowserEngine, ResultEnvelope } from '@avery/contracts';
import { CreateGatewayLimiter, ValidateSender } from './gateway';

const ExtensionPages = { chrome: 'chrome://extensions/', edge: 'edge://extensions/', ego: 'chrome://extensions/' } as const;

/** 使用所选浏览器的现有用户配置；不设置加载扩展参数，也不操作用户的浏览器授权。 */
export async function LaunchExtensionPage(executable: string, url: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(executable, [url], { shell: false, detached: true, stdio: 'ignore', windowsHide: false });
    child.once('error', reject);
    child.once('spawn', () => { child.unref(); resolve(); });
  });
}

interface BrowserSetupOptions {
  webContentsGetter: () => BrowserWindow | undefined;
  browserPaths: Partial<Record<ExtensionBrowserEngine, string>>;
  extensionDirectory: string;
  ipcMainApi?: Pick<IpcMain, 'handle'>;
  launch?: typeof LaunchExtensionPage;
  openDirectory?: (directory: string) => Promise<string>;
}

/** 安装入口仅接受浏览器枚举；URL、可执行文件和扩展目录全部由 Main 固定，禁止 Renderer 指定。 */
export function RegisterBrowserExtensionSetup({ webContentsGetter, browserPaths, extensionDirectory, ipcMainApi = ipcMain, launch = LaunchExtensionPage, openDirectory = shell.openPath }: BrowserSetupOptions): void {
  const limiter = CreateGatewayLimiter({ burst: 2, refillPerSecond: 0.2 });
  let opening = false;
  ipcMainApi.handle('app:open-browser-extension-setup', async (event, ...args: unknown[]): Promise<ResultEnvelope<BrowserExtensionSetup>> => {
    if (!ValidateSender(event, webContentsGetter)) return { ok: false, error: { code: 'PERMISSION_DENIED', message: '浏览器接入请求来源无效。', retryable: false } };
    const engine = args[0];
    if (args.length !== 1 || (engine !== 'chrome' && engine !== 'edge' && engine !== 'ego')) return { ok: false, error: { code: 'VALIDATION_ERROR', message: '请选择 Chrome、Edge 或 ego lite 接入扩展。', retryable: false } };
    if (opening || !limiter.Allow(String(event.sender.id))) return { ok: false, error: { code: 'WORKSPACE_BUSY', message: '正在打开接入引导，请稍后重试。', retryable: true } };
    opening = true;
    try {
      const executable = browserPaths[engine];
      if (!executable) return { ok: false, error: { code: 'NOT_FOUND', message: `未找到 ${engine === 'chrome' ? 'Google Chrome' : engine === 'ego' ? 'ego lite' : 'Microsoft Edge'}，请先安装该浏览器。`, retryable: false } };
      try { await access(executable); }
      catch { return { ok: false, error: { code: 'NOT_FOUND', message: '所选浏览器已移动或卸载，请重新安装后重启 Avery。', retryable: false } }; }
      try {
        const manifest = JSON.parse(await readFile(join(extensionDirectory, 'manifest.json'), 'utf8')) as { name?: unknown; manifest_version?: unknown };
        if (manifest.name !== 'Avery Browser' || manifest.manifest_version !== 3) throw new Error('Invalid extension');
        await access(join(extensionDirectory, 'service-worker.js'));
      } catch { return { ok: false, error: { code: 'NOT_FOUND', message: 'Avery 随附扩展缺失或损坏，请重新安装 Avery。', retryable: false } }; }
      // 目录打开失败不阻止用户在安装页粘贴路径；明确返回失败状态，不伪装已打开。
      let directoryOpened = false;
      try { directoryOpened = (await openDirectory(extensionDirectory)) === ''; } catch { /* 前端提供路径复制作为替代。 */ }
      await launch(executable, ExtensionPages[engine]);
      return { ok: true, data: { engine, extensionDirectory, directoryOpened } };
    } catch { return { ok: false, error: { code: 'INTERNAL_ERROR', message: '无法打开所选浏览器，请稍后重试。', retryable: true } }; }
    finally { opening = false; }
  });
}
