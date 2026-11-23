import { afterEach, describe, expect, it, vi } from 'vitest';
import { CreateProviderFetch } from '../../../apps/backend/src/infra/provider-fetch';
import { DefaultProviderTransportPolicy, WithProviderRecovery } from '../../../packages/agent-modules-defaults/src/provider-transport';
import { QueryProviderAccountUsage } from '../../../packages/agent-modules-defaults/src/provider-usage';

afterEach(() => vi.useRealTimers());

describe('模型宿主网络传输', () => {
  it('保留认证、请求体、流和取消信号，但不携带登录 Cookie、缓存或跨域跳转', async () => {
    const body = new ReadableStream<Uint8Array>();
    const response = new Response(body);
    const fetcher = vi.fn(async () => response);
    const transport = CreateProviderFetch(fetcher);
    const controller = new AbortController();
    const init = { method: 'POST', body: 'payload', headers: { Authorization: 'Bearer isolated-secret' }, signal: controller.signal, credentials: 'include' as const, redirect: 'follow' as const };
    expect(await transport('https://provider.invalid/chat/completions', init)).toBe(response);
    expect(fetcher).toHaveBeenCalledWith('https://provider.invalid/chat/completions', { ...init, credentials: 'omit', redirect: 'error', cache: 'no-store' });
    expect(response.bodyUsed).toBe(false);
    await response.body!.cancel();
  });

  it.each(['ERR_NAME_NOT_RESOLVED', 'ERR_CONNECTION_RESET', 'ERR_PROXY_CONNECTION_FAILED', 'ERR_TUNNEL_CONNECTION_FAILED'])('%s 保留诊断码且按既定节奏重连', async code => {
    vi.useFakeTimers();
    const fetcher = vi.fn().mockRejectedValueOnce(new Error(`net::${code}`)).mockResolvedValueOnce(new Response('ok'));
    const transport = CreateProviderFetch(fetcher), notices: unknown[] = [];
    const pending = WithProviderRecovery(() => transport('https://provider.invalid'), { stream: true, policy: DefaultProviderTransportPolicy, onRecovery: event => notices.push(event) });
    await vi.advanceTimersByTimeAsync(1999); expect(fetcher).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1); expect((await pending).status).toBe(200);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(notices).toMatchObject([{ delayMs: 2000, code: 'PROVIDER_CONNECTION_INTERRUPTED' }]);
  });

  it('证书错误不作为瞬时断网反复重试，取消保持原始原因', async () => {
    const rejected = vi.fn(async () => { throw new Error('net::ERR_CERT_AUTHORITY_INVALID'); });
    await expect(WithProviderRecovery(() => CreateProviderFetch(rejected)('https://provider.invalid'), { stream: true, policy: DefaultProviderTransportPolicy })).rejects.toMatchObject({ code: 'PROVIDER_REQUEST_FAILED' });
    expect(rejected).toHaveBeenCalledOnce();
    const cancelled = new Error('cancelled'), fetcher = vi.fn(async () => { throw cancelled; });
    await expect(CreateProviderFetch(fetcher)('https://provider.invalid')).rejects.toBe(cancelled);
  });

  it.each(['ERR_CONTENT_LENGTH_MISMATCH', 'ERR_INCOMPLETE_CHUNKED_ENCODING', 'ERR_HTTP2_PROTOCOL_ERROR'])('响应 body 中断 %s 仍恢复，不把半截正文当成功', async code => {
    vi.useFakeTimers();
    const fetcher = vi.fn().mockImplementationOnce(async () => new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode('partial')); controller.error(new Error(`net::${code}`));
    } }))).mockResolvedValueOnce(new Response('完整答复'));
    const transport = CreateProviderFetch(fetcher), notices: unknown[] = [];
    const pending = WithProviderRecovery(async scope => (await transport('https://provider.invalid', { signal: scope.signal })).text(), {
      stream: true, policy: { ...DefaultProviderTransportPolicy, maxAttempts: 2 }, onRecovery: event => notices.push(event),
    });
    await vi.advanceTimersByTimeAsync(2000);
    await expect(pending).resolves.toBe('完整答复');
    expect(fetcher).toHaveBeenCalledTimes(2); expect(notices).toMatchObject([{ mode: 'nonstream', delayMs: 2000 }]);
  });

  it.each([
    ['ERR_NAME_NOT_RESOLVED', '域名'], ['ERR_PROXY_CONNECTION_FAILED', '系统代理'], ['ERR_CONNECTION_TIMED_OUT', '超时'],
  ])('额度查询说明 %s，不显示密钥或上游正文', async (code, expected) => {
    const fetcher = vi.fn(async () => { throw new Error(`net::${code} private-key`); });
    const result = await QueryProviderAccountUsage('DeepSeek', 'private-key', CreateProviderFetch(fetcher));
    expect(result.status).toBe('error'); expect(result.message).toContain(expected);
    expect(JSON.stringify(result)).not.toContain('private-key'); expect(result.balances).toEqual([]);
  });
});
