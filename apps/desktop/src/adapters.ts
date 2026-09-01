import { BrowserWindow, dialog, safeStorage } from 'electron';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, basename, join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ExportResume } from './resume-export';

type WindowGetter = () => BrowserWindow | undefined;
type CredentialConfig = { provider: unknown; baseUrl: unknown; model: unknown; thinkingEnabled: unknown; contextLimit: unknown; contextLimitMode?: unknown; compressionThreshold: unknown; apiKey: string };
const ExecFile = promisify(execFile);
export const CronTaskSchedulerName = 'OfferGet Cron Runner';

/** Windows 用户级 Task Scheduler 只维护一个最近唤醒；任务内部数据始终留在 OfferGet 数据库。 */
export async function SyncWindowsCronWake(nextRunAt: number | null, executablePath: string): Promise<{ registered: boolean; nextRunAt: number | null; supported: boolean }> {
  if (process.platform !== 'win32') return { registered: false, nextRunAt, supported: false };
  const taskName = CronTaskSchedulerName.replace(/'/g, "''");
  if (nextRunAt === null) {
    const script = `$task=Get-ScheduledTask -TaskName '${taskName}' -ErrorAction SilentlyContinue;if($null-ne $task){Unregister-ScheduledTask -TaskName '${taskName}' -Confirm:$false -ErrorAction Stop}`;
    await ExecFile('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true });
    return { registered: false, nextRunAt: null, supported: true };
  }
  if (!Number.isFinite(nextRunAt) || nextRunAt <= 0) throw new Error('Cron wake time is invalid.');
  const wakeAt = Math.trunc(Math.max(nextRunAt, Date.now() + 60_000));
  const escapedExecutable = executablePath.replace(/'/g, "''");
  const script = [
    `$at=[DateTimeOffset]::FromUnixTimeMilliseconds(${wakeAt}).LocalDateTime`,
    `$action=New-ScheduledTaskAction -Execute '${escapedExecutable}' -Argument '--cron-runner'`,
    '$trigger=New-ScheduledTaskTrigger -Once -At $at',
    '$settings=New-ScheduledTaskSettingsSet -StartWhenAvailable -WakeToRun -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew',
    `Register-ScheduledTask -TaskName '${taskName}' -Action $action -Trigger $trigger -Settings $settings -RunLevel Limited -Force -ErrorAction Stop|Out-Null`,
  ].join(';');
  await ExecFile('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true });
  return { registered: true, nextRunAt, supported: true };
}

async function selectDirectory(getWindow: WindowGetter, properties: Array<'openDirectory' | 'createDirectory'>): Promise<string | null> {
  const window = getWindow();
  const result = window && !window.isDestroyed() ? await dialog.showOpenDialog(window, { properties }) : await dialog.showOpenDialog({ properties });
  return result.canceled || !result.filePaths[0] ? null : result.filePaths[0];
}

/** 仅在 Main 进程接触原生目录、文件系统与 safeStorage。 */
export function CreateDesktopAdapters({ getWindow, userDataPath, executablePath = process.execPath, enableSystemCron = false }: { getWindow: WindowGetter; userDataPath: string; executablePath?: string; enableSystemCron?: boolean }) {
  const configPath = join(userDataPath, 'agent-config.json');
  return {
    SelectProjectDirectory: async () => { const selected = await selectDirectory(getWindow, ['openDirectory']); return selected ? { path: selected, name: basename(selected) } : null; },
    SelectModuleDirectory: async () => { const selected = await selectDirectory(getWindow, ['openDirectory']); return selected ? { path: selected, name: basename(selected) } : null; },
    SelectWorkspaceDirectory: () => selectDirectory(getWindow, ['openDirectory', 'createDirectory']),
    ExportResume: async ({ workspacePath, resume, format }: { workspacePath: string; resume: { name: string; summary: string; content: string }; format: 'html' | 'pdf' | 'docx' | 'png' }) => {
      const result = await ExportResume({ BrowserWindow, workspacePath, resume, format });
      return { fileName: result.fileName, exported: true };
    },
    CredentialLoad: async () => {
      try {
        const stored = JSON.parse(await readFile(configPath, 'utf8')) as Record<string, unknown>;
        const encrypted = typeof stored.encryptedApiKey === 'string' ? stored.encryptedApiKey : '';
        return { ...stored, apiKey: encrypted && safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(Buffer.from(encrypted, 'base64')) : '' };
      } catch { return null; }
    },
    CredentialSave: async (config: CredentialConfig) => {
      if (!safeStorage.isEncryptionAvailable()) throw new Error('Secure storage is unavailable on this device.');
      await mkdir(dirname(configPath), { recursive: true });
      await writeFile(configPath, JSON.stringify({ provider: config.provider, baseUrl: config.baseUrl, model: config.model, thinkingEnabled: config.thinkingEnabled, contextLimit: config.contextLimit, contextLimitMode: config.contextLimitMode, compressionThreshold: config.compressionThreshold, encryptedApiKey: safeStorage.encryptString(config.apiKey).toString('base64') }, null, 2), 'utf8');
    },
    SyncCronWake: (nextRunAt: number | null) => enableSystemCron ? SyncWindowsCronWake(nextRunAt, executablePath) : { registered: false, nextRunAt, supported: false },
  };
}
