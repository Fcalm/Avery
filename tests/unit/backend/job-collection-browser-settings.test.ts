import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import { AgentHost } from '../../../apps/backend/src/electron/backend/agent-host';
import { EgoBrowserRuntimeProvider } from '../../../apps/backend/src/electron/backend/ego-browser-runtime';
import { BrowserExtensionBridge, BrowserExtensionProtocolRevision } from '../../../apps/backend/src/electron/backend/browser-extension-bridge';

describe('岗位页采集浏览器设置', () => {
  it('每次采集读取最新设置，Chrome、Edge、ego 连续切换时不借用其他浏览器在线连接', async () => {
    const root = await mkdtemp(join(tmpdir(), 'avery-collection-browser-settings-'));
    const externalBrowserPaths = { chrome: process.execPath, edge: process.execPath, ego: process.execPath };
    const settings = { browserEngine: 'chrome', closeTaskTabs: true };
    const nativeStatus = vi.spyOn(EgoBrowserRuntimeProvider.prototype, 'GetStatus').mockResolvedValue({ available: true, connected: true });
    const launchBrowser = vi.fn(async (_engine: string, url: string) => {
      const params = new URLSearchParams(new URL(url).hash.slice(1));
      const response = await fetch(`http://127.0.0.1:${params.get('port')}/bridge/hello`, {
        method: 'POST', headers: { authorization: `Bearer ${params.get('token')}`, 'content-type': 'application/json' },
        body: JSON.stringify({ version: '0.2.0', protocolRevision: BrowserExtensionProtocolRevision, workerInstanceId: 'collection-worker' }),
      });
      expect(response.status).toBe(200);
    });
    const bridge = new BrowserExtensionBridge({ statePath: join(root, 'bridge.json'), port: 0, browserPaths: externalBrowserPaths, launchBrowser });
    const host = new AgentHost({
      userDataPath: join(root, 'user-data'), workspacePath: root, Emit: () => undefined,
      business: { GetStoredSettings: async () => ({ ...settings }) }, observability: {}, credentialPort: { Load: async () => null },
      externalBrowserPaths, browserExtensionBridge: bridge,
    });
    try {
      await host.Ready();
      for (const engine of ['chrome', 'edge', 'ego', 'chrome'] as const) {
        settings.browserEngine = engine;
        await host.WithCollectionBrowser(`collection-${engine}`, async browser => {
          expect(await browser.GetStatus(true)).toMatchObject({ engine, running: true, state: 'ready' });
          // 保存新偏好不能在当前采集中途切断所用浏览器，下一次任务才切换。
          settings.browserEngine = engine === 'edge' ? 'ego' : 'edge';
          expect(await host.GetBrowserRuntimeStatus(true)).toMatchObject({ engine, running: true });
          await expect(host.WithCollectionBrowser('overlapping-collection', async () => undefined)).rejects.toMatchObject({ code: 'AGENT_BUSY' });
        });
        expect(host.IsBusy()).toBe(false);
      }
      expect(launchBrowser.mock.calls.map(([engine]) => engine)).toEqual(['chrome', 'edge']);
      for (const engine of ['chrome', 'edge'] as const) expect(bridge.IsConnected(engine)).toBe(true);
      expect(bridge.IsConnected('ego')).toBe(false);
      expect(nativeStatus).toHaveBeenCalled();
      settings.browserEngine = 'ego';
      await expect(host.WithCollectionBrowser('failed-collection', async browser => {
        expect(await browser.GetStatus()).toMatchObject({ engine: 'ego' });
        throw new Error('采集失败');
      })).rejects.toThrow('采集失败');
      settings.browserEngine = 'edge';
      await host.WithCollectionBrowser('after-failure', async browser => {
        expect(await browser.GetStatus()).toMatchObject({ engine: 'edge', running: true });
      });
      expect(host.IsBusy()).toBe(false);
    } finally { nativeStatus.mockRestore(); await host.Close(); await bridge.Close(); await rm(root, { recursive: true, force: true }); }
  });

  it('正式采集入口按任务创建 ego 原生空间，同次采集复用，结束后释放且下次使用新空间', async () => {
    const root = await mkdtemp(join(tmpdir(), 'avery-collection-ego-space-'));
    const records: Array<{ id: string; connected: boolean; closed: boolean }> = [];
    const nativeStatus = vi.spyOn(EgoBrowserRuntimeProvider.prototype, 'GetStatus').mockResolvedValue({ available: true, connected: true });
    const create = vi.spyOn(EgoBrowserRuntimeProvider.prototype, 'CreateRuntime').mockImplementation(async () => {
      const record = { id: `ego-collection-${records.length + 1}`, connected: false, closed: false }; records.push(record);
      let url = '';
      return {
        GetBrowserTaskId: () => record.id, IsConnected: () => record.connected, ResetReferences() {},
        async Connect() { record.connected = true; return { anchorUrl: '' }; },
        async Run(command: string[]) { if (command[0] === 'open') url = command[1]; return { success: true as const, data: { url } }; },
        async CloseTask() { record.closed = true; return { status: 'confirmed' as const, browserTaskId: record.id, closedTabs: 1, unknownTabs: 0 }; },
        async Close() { record.connected = false; },
      };
    });
    const bridge = new BrowserExtensionBridge({ statePath: join(root, 'bridge.json'), port: 0 });
    const extensionConnect = vi.spyOn(bridge, 'EnsureConnected');
    const host = new AgentHost({ userDataPath: join(root, 'user-data'), workspacePath: root, Emit() {},
      business: { GetStoredSettings: async () => ({ browserEngine: 'ego', closeTaskTabs: true }) }, observability: {}, credentialPort: { Load: async () => null }, browserExtensionBridge: bridge });
    try {
      await host.Ready();
      expect(await host.GetBrowserRuntimeStatus(true)).toMatchObject({ engine: 'ego', state: 'ready' });
      expect(create).not.toHaveBeenCalled();
      for (let task = 0; task < 2; task++) {
        await host.WithCollectionBrowser(`collection-${task}`, async browser => {
          for (let page = 0; page < 2; page++) {
            const proposal = await browser.Prepare({ toolName: 'BrowserNavigate', arguments: { url: `https://example.com/${task}/${page}` } });
            expect(await browser.Execute({ proposal })).toMatchObject({ status: 'succeeded' });
            expect(create).toHaveBeenCalledTimes(task + 1);
          }
        });
        expect(records[task]).toMatchObject({ closed: true, connected: false });
      }
      expect(records.map(record => record.id)).toEqual(['ego-collection-1', 'ego-collection-2']);
      expect(extensionConnect).not.toHaveBeenCalled();
      expect(host.IsBusy()).toBe(false);
    } finally { await host.Close(); await bridge.Close(); nativeStatus.mockRestore(); create.mockRestore(); await rm(root, { recursive: true, force: true, maxRetries: 10 }); }
  });
});
