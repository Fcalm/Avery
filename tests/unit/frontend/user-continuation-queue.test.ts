import { describe, expect, it, vi } from 'vitest';
import { UserContinuationQueue } from '../../../src/features/assistant/userContinuationQueue';

describe('UserContinuationQueue', () => {
  it('确认早于旧 Run 终态时暂存，释放后立即发送且只发送一次', () => {
    let busy = true;
    const scheduled: Array<() => void> = [];
    const send = vi.fn();
    const queue = new UserContinuationQueue(() => busy, send, (callback) => scheduled.push(callback));

    expect(queue.Submit('我已确认创建上述定时任务，任务已经保存，请继续。')).toBe('queued');
    expect(send).not.toHaveBeenCalled();
    busy = false;
    queue.Release();
    expect(scheduled).toHaveLength(1);
    scheduled.shift()?.();

    expect(send).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith('我已确认创建上述定时任务，任务已经保存，请继续。');
    expect(queue.PendingCount()).toBe(0);
    queue.Release();
    expect(send).toHaveBeenCalledOnce();
  });

  it('旧 Run 已结束时在当前事件循环后走标准发送链路', () => {
    const scheduled: Array<() => void> = [];
    const send = vi.fn();
    const queue = new UserContinuationQueue(() => false, send, (callback) => scheduled.push(callback));

    expect(queue.Submit('确认结果')).toBe('scheduled');
    expect(send).not.toHaveBeenCalled();
    scheduled.shift()?.();
    expect(send).toHaveBeenCalledWith('确认结果');
  });

  it('发送前又出现活动 Run 时保留消息，下一次释放后再发送', () => {
    let busy = false;
    const scheduled: Array<() => void> = [];
    const send = vi.fn();
    const queue = new UserContinuationQueue(() => busy, send, (callback) => scheduled.push(callback));

    queue.Submit('确认结果');
    busy = true;
    scheduled.shift()?.();
    expect(send).not.toHaveBeenCalled();
    expect(queue.PendingCount()).toBe(1);

    busy = false;
    queue.Release();
    scheduled.shift()?.();
    expect(send).toHaveBeenCalledOnce();
  });

  it('流式等待终态到达但 IPC 尚未收尾时继续排队，收尾后才发送', () => {
    let streamBusy = true;
    let transportBusy = true;
    const scheduled: Array<() => void> = [];
    const send = vi.fn();
    const queue = new UserContinuationQueue(
      () => streamBusy || transportBusy,
      send,
      (callback) => scheduled.push(callback),
    );

    queue.Submit('【是否接受全球派遣】否');
    streamBusy = false;
    queue.Release();
    expect(scheduled).toHaveLength(0);
    expect(queue.PendingCount()).toBe(1);

    transportBusy = false;
    queue.Release();
    expect(scheduled).toHaveLength(1);
    scheduled.shift()?.();
    expect(send).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith('【是否接受全球派遣】否');
  });
});
