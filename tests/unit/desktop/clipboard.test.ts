import type { BrowserWindow, IpcMainInvokeEvent } from 'electron';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { writeText } = vi.hoisted(() => ({ writeText: vi.fn() }));
vi.mock('electron', () => ({ app: {}, clipboard: { writeText }, ipcMain: {}, Notification: class {}, shell: {} }));
vi.mock('@avery/backend/dist/router', () => ({ FunctionRouteChannels: [], MethodRoutes: {}, WriteCommandChannels: new Set() }));

import { RegisterGeneralControls } from '../../../apps/desktop/src/gateway';

function Setup(url = 'file:///D:/Avery/project/dist/index.html') {
  const handlers = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>();
  const contents = { id: 1, getURL: () => url };
  const window = { isDestroyed: () => false, webContents: contents } as unknown as BrowserWindow;
  RegisterGeneralControls({
    webContentsGetter: () => window, workspacePath: 'D:/test-workspace',
    ipcMainApi: { handle: (channel, handler) => { handlers.set(channel, handler); } },
  });
  const event = { sender: contents, senderFrame: { url } } as unknown as IpcMainInvokeEvent;
  return { copy: handlers.get('app:write-clipboard-text')!, event };
}

beforeEach(() => writeText.mockReset());

describe('桌面文本复制通道', () => {
  it.each(['file:///D:/Avery/project/dist/index.html', 'http://127.0.0.1:5173'])('开发与生产页面复制完整岗位URL：%s', (url) => {
    const { copy, event } = Setup(url);
    const jobUrl = `https://www.zhipin.com/job_detail/test.html?securityId=${'abc'.repeat(1000)}&ka=company_more_job`;
    expect(copy(event, jobUrl)).toEqual({ ok: true, data: true });
    expect(writeText).toHaveBeenCalledExactlyOnceWith(jobUrl);
  });

  it('拒绝外部页面或其他窗口，不写入系统剪贴板', () => {
    const { copy, event } = Setup('http://127.0.0.1:5173');
    expect(copy({ ...event, senderFrame: { url: 'https://example.com' } } as IpcMainInvokeEvent, 'url')).toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } });
    expect(copy({ ...event, sender: { id: 2 } } as IpcMainInvokeEvent, 'url')).toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } });
    expect(writeText).not.toHaveBeenCalled();
  });

  it('缺失、非文本、多参数和超长内容明确失败，不静默成功', () => {
    const { copy, event } = Setup();
    for (const args of [[], [''], [null], [42], ['url', 'extra'], ['中'.repeat(22_000)]]) {
      expect(copy(event, ...args)).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } });
    }
    expect(writeText).not.toHaveBeenCalled();
  });

  it('系统剪贴板写入异常返回失败，不伪报已复制', () => {
    const { copy, event } = Setup();
    writeText.mockImplementationOnce(() => { throw new Error('clipboard unavailable'); });
    expect(copy(event, 'https://example.com/job')).toMatchObject({ ok: false, error: { code: 'INTERNAL_ERROR' } });
  });

  it('限制失控的复制循环，不影响正常单次复制', () => {
    const { copy, event } = Setup();
    for (let index = 0; index < 30; index++) expect(copy(event, 'https://example.com/job')).toMatchObject({ ok: true });
    expect(copy(event, 'https://example.com/job')).toMatchObject({ ok: false, error: { code: 'WORKSPACE_BUSY' } });
    expect(writeText).toHaveBeenCalledTimes(30);
  });
});
