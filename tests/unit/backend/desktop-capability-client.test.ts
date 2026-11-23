import { afterEach, describe, expect, it, vi } from 'vitest';
import { CreateDesktopCapabilityClient } from '../../../apps/backend/src/electron/backend/desktop-capability-client';

afterEach(() => vi.useRealTimers());

function Fixture() {
  const messages: Array<{ id: string; capability: string }> = [];
  const post = vi.fn(message => messages.push(message));
  const client = CreateDesktopCapabilityClient(post);
  return { client, post, messages };
}

describe('桌面能力反向 RPC 有界结算', () => {
  it('成功和失败只结算对应请求，清除所有定时器', async () => {
    vi.useFakeTimers(); const { client, messages } = Fixture();
    const first = client.Call('CredentialLoad');
    const second = client.Call('SyncCronWake').catch(error => error);
    client.OnMessage({ kind: 'desktop-result', id: messages[1].id, ok: false, error: 'wake failed' });
    client.OnMessage({ kind: 'desktop-result', id: messages[0].id, ok: true, data: { configured: true } });
    await expect(first).resolves.toEqual({ configured: true });
    expect((await second).message).toBe('wake failed');
    expect(vi.getTimerCount()).toBe(0);
    client.Close();
  });

  it.each([
    ['CredentialLoad', 30_000, false], ['CredentialSave', 30_000, true],
    ['ExportResumeAsset', 120_000, true], ['PreviewResumePdf', 120_000, true],
    ['SelectModuleDirectory', 300_000, false],
  ] as const)('%s 无回执时按能力期限结算，不自动重发', async (capability, timeoutMs, statusUnknown) => {
    vi.useFakeTimers(); const { client, post, messages } = Fixture();
    let settled = false;
    const pending = client.Call(capability, ['isolated-secret']).catch(error => { settled = true; return error; });
    await vi.advanceTimersByTimeAsync(timeoutMs - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const error = await pending;
    expect(error).toMatchObject({ code: 'INTERNAL_ERROR', retryable: false, details: { reason: 'DESKTOP_CAPABILITY_TIMEOUT', capability, statusUnknown } });
    expect(JSON.stringify(error)).not.toContain('isolated-secret');
    client.OnMessage({ kind: 'desktop-result', id: messages[0].id, ok: true, data: 'late' });
    expect(post).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    client.Close();
  });

  it('发送抛错立即拒绝并清除等待，不泄漏原异常内的凭据', async () => {
    vi.useFakeTimers();
    const client = CreateDesktopCapabilityClient(() => { throw new Error('isolated-secret'); });
    const error = await client.Call('CredentialSave').catch(error => error);
    expect(error).toMatchObject({ retryable: false, details: { reason: 'DESKTOP_CAPABILITY_SEND_FAILED' } });
    expect(error.message).not.toContain('isolated-secret');
    expect(vi.getTimerCount()).toBe(0);
    client.Close();
  });

  it('调用前取消不发送，在途取消立即结算且迟到回执无效', async () => {
    vi.useFakeTimers(); const { client, post, messages } = Fixture();
    const controller = new AbortController(); controller.abort();
    await expect(client.Call('ExportResumeAsset', [], { signal: controller.signal })).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(post).not.toHaveBeenCalled();
    const active = new AbortController();
    const pending = client.Call('ExportResumeAsset', [], { signal: active.signal }).catch(error => error);
    active.abort();
    expect(await pending).toMatchObject({ code: 'CANCELLED', retryable: false, details: { statusUnknown: true } });
    client.OnMessage({ kind: 'desktop-result', id: messages[0].id, ok: true, data: 'late' });
    expect(vi.getTimerCount()).toBe(0);
    client.Close();
  });

  it('关闭结算所有请求，拒绝新请求，换代后的相同序号不接收旧回执', async () => {
    vi.useFakeTimers(); const first = Fixture(), second = Fixture();
    const old = first.client.Call('CredentialLoad').catch(error => error);
    const current = second.client.Call('CredentialLoad');
    let currentSettled = false; void current.then(() => { currentSettled = true; });
    second.client.OnMessage({ kind: 'desktop-result', id: first.messages[0].id, ok: true, data: 'old credential' });
    await Promise.resolve(); expect(currentSettled).toBe(false);
    first.client.Close();
    expect(await old).toMatchObject({ details: { reason: 'DESKTOP_CAPABILITY_CLOSED' } });
    await expect(first.client.Call('CredentialLoad')).rejects.toMatchObject({ retryable: false });
    second.client.OnMessage({ kind: 'desktop-result', id: second.messages[0].id, ok: true, data: 'current' });
    await expect(current).resolves.toBe('current');
    second.client.Close(); expect(vi.getTimerCount()).toBe(0);
  });

  it('非法期限不发送，未知或畸形回执不提前结算', async () => {
    vi.useFakeTimers(); const { client, post, messages } = Fixture();
    await expect(client.Call('CredentialLoad', [], { timeoutMs: Infinity })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(post).not.toHaveBeenCalled();
    const pending = client.Call('CredentialLoad', [], { timeoutMs: 10 }).catch(error => error);
    client.OnMessage({ kind: 'desktop-result', id: messages[0].id, ok: 'yes', data: 'invalid' });
    client.OnMessage({ kind: 'desktop-result', id: 'unknown', ok: true });
    await vi.advanceTimersByTimeAsync(10);
    expect(await pending).toMatchObject({ details: { reason: 'DESKTOP_CAPABILITY_TIMEOUT' } });
    client.Close();
  });
});
