import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InstallBackendFatalHandlers } from '../../../apps/backend/src/infra/backend-fatal';

afterEach(() => vi.useRealTimers());
describe('Backend 不可恢复异常', () => {
  it.each(['uncaughtException', 'unhandledRejection'])('%s 只报告一次并退出，不保留失效进程', async event => {
    vi.useFakeTimers(); const events = new EventEmitter(), post = vi.fn(), exit = vi.fn();
    const dispose = InstallBackendFatalHandlers(post, { events, exit });
    try {
      events.emit(event, Object.assign(new Error('isolated-sensitive-body'), { code: 'ECONNRESET' }));
      events.emit('unhandledRejection', new Error('second failure'));
      expect(post).toHaveBeenCalledTimes(1);
      expect(post).toHaveBeenCalledWith(expect.objectContaining({ kind: 'backend-fatal', causeCode: 'ECONNRESET' }));
      expect(JSON.stringify(post.mock.calls)).not.toContain('isolated-sensitive-body');
      await vi.advanceTimersByTimeAsync(25);
      expect(exit).toHaveBeenCalledExactlyOnceWith(1);
    } finally { dispose(); }
  });
  it('主通道也抛错时仍退出', async () => {
    vi.useFakeTimers(); const events = new EventEmitter(), exit = vi.fn();
    const dispose = InstallBackendFatalHandlers(() => { throw new Error('port closed'); }, { events, exit });
    try { events.emit('uncaughtException', new Error('fixture')); await vi.advanceTimersByTimeAsync(25); expect(exit).toHaveBeenCalledWith(1); }
    finally { dispose(); }
  });
});
