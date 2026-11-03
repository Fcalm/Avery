import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
const electron = vi.hoisted(() => ({ fork: vi.fn() }));
vi.mock('electron', () => ({ utilityProcess: { fork: electron.fork } }));
import { CreateBackendHost } from '../../../apps/backend/src/host';

afterEach(() => vi.useRealTimers());
function Fixture() {
  const child = Object.assign(new EventEmitter(), { postMessage: vi.fn(), kill: vi.fn() });
  child.postMessage.mockImplementation((message: { kind: string }) => {
    if (message.kind === 'ping') queueMicrotask(() => child.emit('message', { kind: 'pong' }));
  });
  electron.fork.mockReturnValue(child);
  const host = CreateBackendHost({ appContext: {} });
  child.emit('message', { kind: 'ready' });
  return { host, child };
}
describe('对话 IPC 生命周期', () => {
  it.each(['agent:send', 'agent:respond-interaction', 'agent:compact-session'])('%s 长任务不因普通 IPC 超时误报，仍接受真实结果', async channel => {
    vi.useFakeTimers(); const { host, child } = Fixture();
    let settled = false;
    const result = host.Command(channel, 'write-key', { requestId: 'run' }).finally(() => { settled = true; });
    try {
      await vi.advanceTimersByTimeAsync(11 * 60 * 1000);
      expect(settled).toBe(false);
      const command = child.postMessage.mock.calls.map(([message]) => message).find(message => message.kind === 'command');
      child.emit('message', { kind: 'result', requestId: command.requestId, result: { accepted: true } });
      await expect(result).resolves.toEqual({ accepted: true });
    } finally { host.Shutdown(); await vi.runOnlyPendingTimersAsync(); }
  });
  it('普通读取保持超时，长任务在进程退出时立即拒绝', async () => {
    vi.useFakeTimers(); const { host, child } = Fixture();
    const ordinary = host.Command('agent:status', undefined).catch(error => error);
    const running = host.Command('agent:send', 'key', {}).catch(error => error);
    try {
      await vi.advanceTimersByTimeAsync(30_001);
      expect((await ordinary).message).toContain('timed out');
      child.emit('exit', 1);
      expect((await running).message).toContain('Backend exited');
    } finally { host.Shutdown(); await vi.runOnlyPendingTimersAsync(); }
  });
});
