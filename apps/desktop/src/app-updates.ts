import type { AppUpdateState } from '@avery/contracts';
import type { AppUpdaterEvents } from 'electron-updater/out/AppUpdater';

type UpdateEvents = Pick<AppUpdaterEvents, 'update-available' | 'update-not-available' | 'update-downloaded' | 'download-progress' | 'error'>;

/** 仅描述 Main 所需的 updater 能力，便于在不下载或安装真实版本的情况下验证状态机。 */
export interface AppUpdaterPort {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  allowPrerelease: boolean;
  allowDowngrade: boolean;
  on<E extends keyof UpdateEvents>(event: E, listener: UpdateEvents[E]): unknown;
  removeListener<E extends keyof UpdateEvents>(event: E, listener: UpdateEvents[E]): unknown;
  checkForUpdates(): Promise<unknown>;
  downloadUpdate(): Promise<unknown>;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
}

const StartupDelayMs = 15_000;
const CheckIntervalMs = 6 * 60 * 60 * 1000;
const ManualCheckIntervalMs = 30_000;

/** 更新检查不阻塞启动；下载遵循保存的偏好，安装始终由用户明确确认。 */
export class AppUpdateService {
  private state: AppUpdateState;
  private updater?: Promise<AppUpdaterPort>;
  private checkFlight?: Promise<AppUpdateState>;
  private downloadFlight?: Promise<AppUpdateState>;
  private lastCheckStarted?: number;
  private startupTimer?: ReturnType<typeof setTimeout>;
  private intervalTimer?: ReturnType<typeof setInterval>;
  private listeners: Array<{ event: keyof UpdateEvents; remove: () => void }> = [];
  private stopped = false;

  constructor(private readonly options: {
    supported: boolean;
    currentVersion: string;
    loadUpdater: () => Promise<AppUpdaterPort>;
    readAutoDownload: () => Promise<boolean>;
    publish: (state: AppUpdateState) => void;
    log: (error: unknown) => void;
    now?: () => number;
  }) {
    this.state = { revision: 0, currentVersion: options.currentVersion, status: options.supported ? 'idle' : 'unavailable',
      ...(!options.supported ? { message: '自动更新仅在 Windows 安装版中可用。' } : {}) };
  }

  GetState(): AppUpdateState { return { ...this.state }; }

  /** 自动任务只在交互式正式客户端启动；定时 Runner、开发和冒烟实例不会联网检查。 */
  Start(): void {
    if (!this.options.supported || this.startupTimer || this.intervalTimer || this.stopped) return;
    this.startupTimer = setTimeout(() => { void this.Check(); }, StartupDelayMs);
    this.intervalTimer = setInterval(() => { void this.Check(); }, CheckIntervalMs);
    this.startupTimer.unref?.();
    this.intervalTimer.unref?.();
  }

  Stop(): void {
    this.stopped = true;
    clearTimeout(this.startupTimer);
    clearInterval(this.intervalTimer);
    void this.updater?.then(() => {
      // 退出时可能仍有网络失败回调；保留 error 监听直到进程结束，避免未处理事件。
      for (const listener of this.listeners) if (listener.event !== 'error') listener.remove();
      this.listeners = this.listeners.filter(listener => listener.event === 'error');
    }).catch(() => undefined);
  }

  private SetState(patch: Partial<AppUpdateState>): void {
    if (this.stopped) return;
    this.state = { ...this.state, ...patch, revision: this.state.revision + 1 };
    this.options.publish(this.GetState());
  }

  private async LoadUpdater(): Promise<AppUpdaterPort> {
    if (!this.updater) {
      this.updater = this.options.loadUpdater().then(updater => {
        // 关闭库的自动安装，避免退出或后台下载完成时打断 Agent；只有 Install 可以重启。
        updater.autoDownload = false;
        updater.autoInstallOnAppQuit = false;
        // 当前 Avery 发布包含 GitHub prerelease，但仍禁止降级。
        updater.allowPrerelease = true;
        updater.allowDowngrade = false;
        const listen = <E extends keyof UpdateEvents>(event: E, listener: UpdateEvents[E]) => {
          updater.on(event, listener); this.listeners.push({ event, remove: () => { updater.removeListener(event, listener); } });
        };
        listen('update-available', (info: { version: string }) => {
          this.SetState({ status: 'available', version: info.version, progress: undefined, message: undefined, checkedAt: this.Now() });
        });
        listen('update-not-available', () => {
          this.SetState({ status: 'not_available', version: undefined, progress: undefined, message: undefined, checkedAt: this.Now() });
        });
        listen('download-progress', (progress: { percent: number }) => {
          if (!Number.isFinite(progress.percent) || this.state.status !== 'downloading') return;
          const percent = Math.max(0, Math.min(100, Math.floor(progress.percent)));
          if (percent !== this.state.progress) this.SetState({ progress: percent });
        });
        listen('update-downloaded', (info: { version: string }) => {
          this.SetState({ status: 'downloaded', version: info.version, progress: 100, message: undefined });
        });
        // electron-updater 的 error 事件必须有监听；最终回执仍由相应 Promise 收敛。
        listen('error', (error: unknown) => {
          this.options.log(error);
          if (this.state.status === 'installing') this.SetState({ status: 'error', message: '安装更新失败，请重新下载后再试。' });
        });
        return updater;
      }).catch(error => { this.updater = undefined; throw error; });
    }
    return this.updater;
  }

  private Now(): number { return this.options.now?.() ?? Date.now(); }

  /** 合并重复检查，限制手动连点；正在下载或等待安装时保留已有更新。 */
  Check(): Promise<AppUpdateState> {
    if (this.checkFlight) return this.checkFlight;
    if (!this.options.supported || this.stopped || ['downloading', 'downloaded', 'installing'].includes(this.state.status)) return Promise.resolve(this.GetState());
    if (this.lastCheckStarted !== undefined && this.Now() - this.lastCheckStarted < ManualCheckIntervalMs) return Promise.resolve(this.GetState());
    this.lastCheckStarted = this.Now();
    this.SetState({ status: 'checking', message: undefined, version: undefined, progress: undefined });
    this.checkFlight = (async () => {
      try {
        const updater = await this.LoadUpdater();
        await updater.checkForUpdates();
        if (this.state.status === 'checking') throw new Error('Updater did not report an update result.');
        await this.PreferencesChanged();
      } catch (error) {
        this.options.log(error);
        this.SetState({ status: 'error', message: '更新检查失败，请稍后重试。' });
      }
      return this.GetState();
    })().finally(() => { this.checkFlight = undefined; });
    return this.checkFlight;
  }

  /** 保存偏好后重新读取后端；读取失败只停止自动下载，不假定用户同意。 */
  async PreferencesChanged(): Promise<void> {
    if (this.state.status !== 'available' || this.stopped) return;
    try {
      if (await this.options.readAutoDownload()) void this.Download();
    } catch (error) { this.options.log(error); }
  }

  Download(): Promise<AppUpdateState> {
    if (this.downloadFlight) return this.downloadFlight;
    if (!this.options.supported || this.stopped || !this.state.version || !['available', 'error'].includes(this.state.status)) return Promise.resolve(this.GetState());
    this.SetState({ status: 'downloading', progress: 0, message: undefined });
    this.downloadFlight = (async () => {
      try {
        const updater = await this.LoadUpdater();
        await updater.downloadUpdate();
        if (this.state.status !== 'downloaded') throw new Error('Updater did not confirm the downloaded package.');
      } catch (error) {
        this.options.log(error);
        this.SetState({ status: 'error', message: '更新下载失败，请重试。' });
      }
      return this.GetState();
    })().finally(() => { this.downloadFlight = undefined; });
    return this.downloadFlight;
  }

  /** 调用者必须先完成原生确认；此入口不接受 URL、文件路径或可执行参数。 */
  async Install(): Promise<boolean> {
    if (this.stopped || this.state.status !== 'downloaded') return false;
    const updater = await this.LoadUpdater();
    if (this.stopped || this.state.status !== 'downloaded') return false;
    this.SetState({ status: 'installing', message: undefined });
    setImmediate(() => {
      try { updater.quitAndInstall(false, true); }
      catch (error) { this.options.log(error); this.SetState({ status: 'error', message: '安装更新失败，请重试。' }); }
    });
    return true;
  }
}
