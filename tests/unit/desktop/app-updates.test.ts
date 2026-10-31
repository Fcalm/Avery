import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppUpdateStateSchema, type AppUpdateState } from '../../../packages/contracts/src/app-update';
import { AppUpdateService, type AppUpdaterPort } from '../../../apps/desktop/src/app-updates';

class Updater extends EventEmitter implements AppUpdaterPort {
  autoDownload = true;
  autoInstallOnAppQuit = true;
  allowPrerelease = false;
  allowDowngrade = true;
  checkForUpdates = vi.fn(async () => { this.emit('update-available', { version: '0.3.0' }); });
  downloadUpdate = vi.fn(async () => { this.emit('update-downloaded', { version: '0.3.0' }); });
  quitAndInstall = vi.fn();
}

function Fixture(options: { supported?: boolean; autoDownload?: boolean } = {}) {
  const updater = new Updater(), states: AppUpdateState[] = [];
  const load = vi.fn(async () => updater), preference = vi.fn(async () => options.autoDownload === true), log = vi.fn();
  const service = new AppUpdateService({ supported: options.supported !== false, currentVersion: '0.2.0',
    loadUpdater: load, readAutoDownload: preference, publish: state => { AppUpdateStateSchema.parse(state); states.push(state); }, log });
  return { updater, states, service, load, preference, log };
}
afterEach(() => vi.useRealTimers());

describe('Main 自动更新服务', () => {
  it('开发环境不加载 updater 或联网，不可安装', async () => {
    const f = Fixture({ supported: false });
    f.service.Start();
    expect((await f.service.Check()).status).toBe('unavailable');
    await f.service.Download();
    expect(await f.service.Install()).toBe(false);
    expect(f.load).not.toHaveBeenCalled();
    f.service.Stop();
  });

  it('延迟启动检查并每六小时检查；退出后停止定时器', async () => {
    vi.useFakeTimers(); const f = Fixture();
    f.updater.checkForUpdates.mockImplementation(async () => { f.updater.emit('update-not-available', { version: '0.2.0' }); });
    f.service.Start(); f.service.Start();
    await vi.advanceTimersByTimeAsync(14_999); expect(f.load).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); expect(f.updater.checkForUpdates).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000); expect(f.updater.checkForUpdates).toHaveBeenCalledTimes(2);
    f.service.Stop(); await vi.advanceTimersByTimeAsync(12 * 60 * 60 * 1000);
    expect(f.updater.checkForUpdates).toHaveBeenCalledTimes(2);
  });

  it('并发检查合并，短时间再次点击不重复请求', async () => {
    const f = Fixture();
    const first = f.service.Check(), second = f.service.Check();
    expect(first).toBe(second);
    await first; await f.service.Check();
    expect(f.updater.checkForUpdates).toHaveBeenCalledTimes(1);
    expect(f.service.GetState()).toMatchObject({ status: 'available', version: '0.3.0' });
    expect(f.updater).toMatchObject({ autoDownload: false, autoInstallOnAppQuit: false, allowPrerelease: true, allowDowngrade: false });
    expect(f.updater.downloadUpdate).not.toHaveBeenCalled();
  });

  it('自动下载开启时下载，完成后等待用户安装，不在退出时自动安装', async () => {
    const f = Fixture({ autoDownload: true }); await f.service.Check(); await f.service.Download();
    expect(f.service.GetState()).toMatchObject({ status: 'downloaded', progress: 100 });
    expect(f.updater.downloadUpdate).toHaveBeenCalledTimes(1);
    await f.service.Check(); expect(f.updater.checkForUpdates).toHaveBeenCalledTimes(1);
    expect(f.updater.quitAndInstall).not.toHaveBeenCalled();
  });

  it('保存开启自动下载后应用偏好，读取偏好失败不擅自下载', async () => {
    const f = Fixture(); await f.service.Check();
    f.preference.mockRejectedValueOnce(new Error('store unavailable'));
    await f.service.PreferencesChanged(); expect(f.updater.downloadUpdate).not.toHaveBeenCalled();
    f.preference.mockResolvedValue(true); await f.service.PreferencesChanged(); await f.service.Download();
    expect(f.service.GetState().status).toBe('downloaded');
  });

  it('网络或元数据缺失不能误报最新版本', async () => {
    const f = Fixture();
    f.updater.checkForUpdates.mockImplementation(async () => { const error = new Error('latest.yml not found'); f.updater.emit('error', error); throw error; });
    expect((await f.service.Check()).status).toBe('error');
    expect(f.states.some(state => state.status === 'not_available')).toBe(false);
    expect(f.updater.downloadUpdate).not.toHaveBeenCalled();
  });

  it('下载合并，进度有界；失败后可重试且不会丢失版本', async () => {
    const f = Fixture(); await f.service.Check();
    f.updater.downloadUpdate.mockRejectedValueOnce(new Error('offline'));
    const first = f.service.Download(); expect(f.service.Download()).toBe(first);
    expect(await first).toMatchObject({ status: 'error', version: '0.3.0' });
    f.updater.downloadUpdate.mockImplementationOnce(async () => {
      f.updater.emit('download-progress', { percent: 150 });
      expect(f.service.GetState().progress).toBe(100);
      f.updater.emit('update-downloaded', { version: '0.3.0' });
    });
    expect((await f.service.Download()).status).toBe('downloaded');
  });

  it('只允许已下载的更新安装，重复安装不会重复退出', async () => {
    vi.useFakeTimers(); const f = Fixture();
    expect(await f.service.Install()).toBe(false);
    await f.service.Check(); await f.service.Download();
    expect(await f.service.Install()).toBe(true);
    expect(await f.service.Install()).toBe(false);
    await vi.runAllTimersAsync();
    expect(f.updater.quitAndInstall).toHaveBeenCalledTimes(1);
    expect(f.updater.quitAndInstall).toHaveBeenCalledWith(false, true);
  });

  it('下载回执未确认时不允许安装；退出后的下载错误仍有处理器', async () => {
    const f = Fixture(); await f.service.Check();
    f.updater.downloadUpdate.mockResolvedValueOnce(undefined);
    expect((await f.service.Download()).status).toBe('error');
    expect(await f.service.Install()).toBe(false);
    f.service.Stop(); await Promise.resolve();
    expect(() => f.updater.emit('error', new Error('late failure'))).not.toThrow();
  });
});
