import { BrowserWindow, dialog, safeStorage } from 'electron';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, basename, join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ExportResume, PreviewResumePdf, type ResumeExportInput } from './resume-export';
import { ResumeDocumentInputSchema } from '@avery/contracts';

type WindowGetter = () => BrowserWindow | undefined;
type CredentialConfig = { provider: 'DeepSeek' | 'Z.AI' | 'MIMO' | '自定义'; baseUrl: unknown; model: unknown; thinkingEnabled: unknown; contextLimit: unknown; contextLimitMode?: unknown; compressionThreshold: unknown; apiKey: string };
const ExecFile = promisify(execFile);
export const CronTaskSchedulerName = 'Avery Cron Runner';
const LegacyCronTaskSchedulerName = `${['Offer', 'Get'].join('')} Cron Runner`;

async function RemoveLegacyWindowsCronWake(): Promise<void> {
  const taskName = LegacyCronTaskSchedulerName.replace(/'/g, "''");
  const script = `$task=Get-ScheduledTask -TaskName '${taskName}' -ErrorAction SilentlyContinue;if($null-ne $task){Unregister-ScheduledTask -TaskName '${taskName}' -Confirm:$false -ErrorAction Stop};exit 0`;
  await ExecFile('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true });
}

/** Windows 用户级 Task Scheduler 只维护一个最近唤醒；任务内部数据始终留在 Avery 数据库。 */
export async function SyncWindowsCronWake(nextRunAt: number | null, executablePath: string): Promise<{ registered: boolean; nextRunAt: number | null; supported: boolean }> {
  if (process.platform !== 'win32') return { registered: false, nextRunAt, supported: false };
  // 旧版任务可能由管理员创建。清理失败不应阻止当前用户的任务调度或后端启动。
  try { await RemoveLegacyWindowsCronWake(); }
  catch (error) { console.warn('Could not remove legacy CronTask wake:', error instanceof Error ? error.message : error); }
  const taskName = CronTaskSchedulerName.replace(/'/g, "''");
  if (nextRunAt === null) {
    const script = `$task=Get-ScheduledTask -TaskName '${taskName}' -ErrorAction SilentlyContinue;if($null-ne $task){Unregister-ScheduledTask -TaskName '${taskName}' -Confirm:$false -ErrorAction Stop};exit 0`;
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
  const decryptCredential = (value: unknown): string => {
    if (typeof value !== 'string' || !value || !safeStorage.isEncryptionAvailable()) return '';
    try { return safeStorage.decryptString(Buffer.from(value, 'base64')); }
    catch { return ''; }
  };
  const readCredentialDocument = async (): Promise<Record<string, any>> => {
    try {
      const stored = JSON.parse(await readFile(configPath, 'utf8')) as Record<string, any>;
      if (stored?.schemaVersion === 2 && stored.providerConfigs && typeof stored.providerConfigs === 'object') return stored;
      // 旧版单 Provider 文件在首次读取/保存时映射为 v2 内存结构，不丢失原加密 Key。
      if (stored?.provider) {
        return { schemaVersion: 2, activeProvider: stored.provider, providerConfigs: { [stored.provider]: stored } };
      }
    } catch { /* 未配置或旧文件损坏时返回空注册表。 */ }
    return { schemaVersion: 2, activeProvider: 'DeepSeek', providerConfigs: {} };
  };
  return {
    SelectProjectDirectory: async () => { const selected = await selectDirectory(getWindow, ['openDirectory']); return selected ? { path: selected, name: basename(selected) } : null; },
    SelectModuleDirectory: async () => { const selected = await selectDirectory(getWindow, ['openDirectory']); return selected ? { path: selected, name: basename(selected) } : null; },
    SelectWorkspaceDirectory: () => selectDirectory(getWindow, ['openDirectory', 'createDirectory']),
    PreviewResumePdf: async ({ resume }: { resume: ResumeExportInput }) => PreviewResumePdf(BrowserWindow, ResumeDocumentInputSchema.parse(resume)),
    ExportResume: async ({ workspacePath, resume, format }: { workspacePath: string; resume: ResumeExportInput; format: 'html' | 'pdf' | 'docx' | 'png' }) => {
      const result = await ExportResume({ BrowserWindow, workspacePath, resume: ResumeDocumentInputSchema.parse(resume), format });
      return { fileName: result.fileName, exported: true };
    },
    /** 仅供 Backend AgentHost 使用；Renderer 的导出 IPC 不返回物理路径。 */
    ExportResumeAsset: async ({ workspacePath, resume, format, assetId }: { workspacePath: string; resume: { name: string; summary: string; content: string }; format: 'pdf' | 'png'; assetId: string }) => {
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(assetId) || !['pdf', 'png'].includes(format)) throw new Error('Invalid resume asset request.');
      return ExportResume({ BrowserWindow, workspacePath, resume, format, outputDirectory: join(workspacePath, 'exports', 'agent-resume-files', assetId), requireCompleteImage: true });
    },
    CredentialLoad: async () => {
      try {
        const stored = await readCredentialDocument();
        const providerConfigs = Object.fromEntries(Object.entries(stored.providerConfigs ?? {}).map(([provider, value]) => {
          const config = value && typeof value === 'object' ? value as Record<string, unknown> : {};
          return [provider, { ...config, provider, apiKey: decryptCredential(config.encryptedApiKey), encryptedApiKey: undefined }];
        }));
        const activeProvider = typeof stored.activeProvider === 'string' ? stored.activeProvider : 'DeepSeek';
        const active = providerConfigs[activeProvider];
        return active ? { ...active, provider: activeProvider, providerConfigs } : { provider: activeProvider, providerConfigs };
      } catch { return null; }
    },
    CredentialSave: async (config: CredentialConfig) => {
      if (!safeStorage.isEncryptionAvailable()) throw new Error('Secure storage is unavailable on this device.');
      await mkdir(dirname(configPath), { recursive: true });
      const stored = await readCredentialDocument();
      const providerConfigs = { ...(stored.providerConfigs ?? {}) };
      providerConfigs[config.provider] = {
        provider: config.provider,
        baseUrl: config.baseUrl,
        model: config.model,
        thinkingEnabled: config.thinkingEnabled,
        contextLimit: config.contextLimit,
        contextLimitMode: config.contextLimitMode,
        compressionThreshold: config.compressionThreshold,
        encryptedApiKey: safeStorage.encryptString(config.apiKey).toString('base64'),
      };
      await writeFile(configPath, JSON.stringify({ schemaVersion: 2, activeProvider: config.provider, providerConfigs }, null, 2), 'utf8');
    },
    SyncCronWake: (nextRunAt: number | null) => enableSystemCron ? SyncWindowsCronWake(nextRunAt, executablePath) : { registered: false, nextRunAt, supported: false },
  };
}
