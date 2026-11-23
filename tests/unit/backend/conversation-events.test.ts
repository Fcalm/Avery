import { describe, expect, it, vi } from 'vitest';
vi.mock('electron', () => ({ app: {}, clipboard: {}, ipcMain: {}, Notification: {}, shell: {} }));
import { RegisterGateway } from '../../../apps/desktop/src/gateway';

describe('会话后台变更事件', () => {
  it('归档事件送往独立 workspace 通道，不混入 Agent 流；其他流仍原样转发', () => {
    let emit!: (event: unknown) => void;
    const send = vi.fn();
    const window = { isDestroyed: () => false, webContents: { send } };
    RegisterGateway({
      backendHost: { Command: vi.fn(), OnEvent: listener => { emit = listener; }, state: () => 'ready' },
      webContentsGetter: () => window as never,
      ipcMainApi: { handle: vi.fn() },
    });
    emit({ type: 'conversations_changed' });
    expect(send.mock.calls).toEqual([['workspace:conversations-changed']]);
    emit({ type: 'content_delta', requestId: 'run', delta: '正文' });
    expect(send).toHaveBeenLastCalledWith('agent:stream', { type: 'content_delta', requestId: 'run', delta: '正文' });
  });
});
