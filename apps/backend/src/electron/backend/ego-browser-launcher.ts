import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { PersonalBrowserCdpError } from './personal-browser-cdp-runtime';

const ExecuteFile = promisify(execFile);
let windowsElevation: Promise<boolean> | undefined;

/** 生成 Windows argv 引号；参数交给 ShellExecute，不经过 cmd 或 PowerShell 的代码插值。 */
export function QuoteWindowsArgument(value: string): string {
  return `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1')}"`;
}

function PowerShellExecutable(): string {
  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR;
  if (!systemRoot) throw new PersonalBrowserCdpError('BROWSER_EGO_UNAVAILABLE', 'Windows system location is unavailable for the ego user-session launcher.');
  return join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

/** 进程提权状态在生命周期内固定，缓存只读检查；未知状态不得冒充普通用户。 */
export async function IsEgoHostElevated(): Promise<boolean> {
  if (process.platform !== 'win32') return false;
  windowsElevation ??= (async () => {
    const script = '$identity=[Security.Principal.WindowsIdentity]::GetCurrent();$principal=[Security.Principal.WindowsPrincipal]::new($identity);[Console]::Write($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator))';
    const result = await ExecuteFile(PowerShellExecutable(), ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 5_000, maxBuffer: 16_384 });
    const value = result.stdout.trim().toLowerCase();
    if (value !== 'true' && value !== 'false') throw new Error('Windows elevation check returned an invalid result.');
    return value === 'true';
  })().catch(() => {
    windowsElevation = undefined;
    throw new PersonalBrowserCdpError('BROWSER_EGO_UNAVAILABLE', 'Could not determine the Windows user context for the ego browser connection.');
  });
  return windowsElevation;
}

const UserSessionLauncher = `
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
[Console]::InputEncoding=[Text.UTF8Encoding]::new($false)
try {
  $launchEnvelope=[Console]::ReadLine() | ConvertFrom-Json
  $desktopWindows=(New-Object -ComObject Shell.Application).Windows()
  $desktopHandle=0
  $desktopWindow=$desktopWindows.FindWindowSW(0,0,8,[ref]$desktopHandle,1)
  if(-not $desktopWindow){throw 'Windows desktop unavailable'}
  $desktopWindow.Document.Application.ShellExecute([string]$launchEnvelope.executable,[string]$launchEnvelope.arguments,[string]$launchEnvelope.cwd,'open',0)
  [Console]::Out.WriteLine('AVERY_EGO_USER_LAUNCH')
  [Console]::Out.Flush()
  [void][Console]::ReadLine()
} catch {
  [Console]::Error.WriteLine('Error: ego Windows user-session launch failed.')
  exit 1
}
`;

export interface EgoNativeLaunch {
  executable: string;
  args: string[];
  /** 提权时仅向固定辅助进程的 stdin 提交参数，不将令牌或脚本写入磁盘。 */
  input?: string;
}

/**
 * 管理员启动的 Avery 通过已有桌面 Shell，以登录用户身份启动 ego CLI。
 * 不提升浏览器权限，不更改 Avery 权限；辅助进程等 stdin 关闭后退出，任务寿命仍由原生连接决定。
 */
export function BuildEgoNativeLaunch(executable: string, script: string, elevated: boolean): EgoNativeLaunch {
  const args = ['nodejs', '-e', script];
  if (!elevated) return { executable, args };
  return {
    executable: PowerShellExecutable(),
    args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(UserSessionLauncher, 'utf16le').toString('base64')],
    input: `${JSON.stringify({ executable, arguments: args.map(QuoteWindowsArgument).join(' '), cwd: process.cwd() })}\n`,
  };
}
