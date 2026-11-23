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
  it('致命异常结算在途对话，丢弃迟到事件并退避重启，不重发原请求', async () => {
    vi.useFakeTimers(); const { host, child } = Fixture(); const events: unknown[] = [];
    host.OnEvent(event => events.push(event));
    const pending = host.Command('agent:send', 'key', { requestId: 'fatal-run', sessionId: 'fatal-session' }).catch(error => error);
    try {
      child.emit('message', { kind: 'backend-fatal', code: 'UNCAUGHT' });
      expect(await pending).toMatchObject({ retryable: false, details: { statusUnknown: true } });
      child.emit('message', { kind: 'event', payload: { type: 'content_delta', requestId: 'fatal-run', delta: 'late' } });
      child.emit('exit', 1);
      expect(events).toEqual([
        expect.objectContaining({ type: 'error', requestId: 'fatal-run', sessionId: 'fatal-session' }),
        { type: 'run_released', requestId: 'fatal-run', sessionId: 'fatal-session' },
      ]);
      expect(child.kill).toHaveBeenCalledTimes(1);
      const replacement = Object.assign(new EventEmitter(), { postMessage: vi.fn(), kill: vi.fn() });
      electron.fork.mockReturnValueOnce(replacement);
      await vi.advanceTimersByTimeAsync(1000);
      expect(host.GetChild()).toBe(replacement);
      expect(replacement.postMessage.mock.calls.some(([message]) => message.kind === 'command')).toBe(false);
    } finally { host.Shutdown(); await vi.runOnlyPendingTimersAsync(); }
  });
  it.each([false, true])('旧代桌面能力迟到回执（失败=%s）不会转发给新后端', async fail => {
    vi.useFakeTimers();
    const first = Object.assign(new EventEmitter(), { postMessage: vi.fn(), kill: vi.fn() });
    const second = Object.assign(new EventEmitter(), { postMessage: vi.fn(), kill: vi.fn() });
    electron.fork.mockReturnValueOnce(first).mockReturnValueOnce(second);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const capability = vi.fn(async () => { await gate; if (fail) throw new Error('old failure'); return 'old credential'; });
    const host = CreateBackendHost({ appContext: {}, desktopCapabilities: { CredentialLoad: capability } });
    try {
      first.emit('message', { kind: 'ready' });
      first.emit('message', { kind: 'desktop', id: 'old', capability: 'CredentialLoad' });
      expect(capability).toHaveBeenCalledTimes(1);
      first.emit('exit', 1);
      await vi.advanceTimersByTimeAsync(1001);
      second.emit('message', { kind: 'ready' });
      release(); await vi.advanceTimersByTimeAsync(0);
      expect(second.postMessage.mock.calls.map(([message]) => message).filter(message => message.kind === 'desktop-result')).toEqual([]);
      expect(first.postMessage.mock.calls.map(([message]) => message).filter(message => message.kind === 'desktop-result')).toEqual([]);
      first.emit('message', { kind: 'ready' });
      first.emit('exit', 1);
      expect(host.GetChild()).toBe(second);
    } finally { release(); host.Shutdown(); await vi.runOnlyPendingTimersAsync(); }
  });
  it.each(['agent:send', 'agent:respond-interaction', 'agent:compact-session', 'workspace:conversations-delete', 'workspace:conversations-delete-archived'])('%s 长任务不因普通 IPC 超时误报，仍接受真实结果', async channel => {
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
