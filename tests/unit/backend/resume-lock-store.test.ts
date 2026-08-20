import { afterEach, describe, expect, it, vi } from 'vitest';
import { ResumeLockStore } from '../../../apps/backend/src/electron/backend/resume-lock-store';

describe('ResumeLockStore', () => {
  afterEach(() => vi.useRealTimers());

  it('拒绝其他 owner，并允许同一 owner 刷新租约', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-20T00:00:00.000Z'));
    const store = new ResumeLockStore({ leaseMs: 1_000 });

    const first = store.Acquire('resume-1', 'user', 'user-main', 3);
    vi.advanceTimersByTime(500);
    const refreshed = store.Acquire('resume-1', 'user', 'user-main', 3);

    expect(first).toMatchObject({ ownerId: 'user-main', baseRevision: 3 });
    expect(refreshed?.leaseExpiresAt).toBe(Date.now() + 1_000);
    expect(store.Acquire('resume-1', 'agent', 'agent-1')).toBeNull();
  });

  it('租约过期后允许新的 owner 获取锁', () => {
    vi.useFakeTimers();
    const store = new ResumeLockStore({ leaseMs: 1_000 });
    store.Acquire('resume-1', 'user', 'user-main');
    vi.advanceTimersByTime(1_001);

    expect(store.Acquire('resume-1', 'agent', 'agent-1')).toMatchObject({ owner: 'agent', ownerId: 'agent-1' });
  });
});
