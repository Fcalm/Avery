import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ lookup: vi.fn(), request: vi.fn() }));
vi.mock('node:dns/promises', () => ({ lookup: mocks.lookup }));
vi.mock('node:https', () => ({ request: mocks.request }));
import { AtsPublicTransport } from '../../../apps/backend/src/electron/backend/ats/public-transport';

afterEach(() => { vi.useRealTimers(); vi.resetAllMocks(); });
function Setup(statuses = [200], locations: Record<number, string> = {}) {
  mocks.lookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
  let index = 0;
  mocks.request.mockImplementation((_url, options, callback) => {
    const req = new EventEmitter() as EventEmitter & { end: () => void; destroy: (error: Error) => void };
    req.destroy = (error) => req.emit('error', error);
    req.end = vi.fn(() => queueMicrotask(() => {
      const res = new EventEmitter() as EventEmitter & { statusCode: number; headers: Record<string, string> };
      const current = index++;
      res.statusCode = statuses[current] ?? 200;
      res.headers = locations[current] ? { location: locations[current] } : {};
      callback(res);
      res.emit('data', Buffer.from('{}'));
      res.emit('end');
    }));
    options.lookup('example.com', { all: true }, (error: Error | null, addresses: unknown) => {
      expect(error).toBeNull();
      expect(addresses).toEqual([{ address: '93.184.216.34', family: 4 }]);
    });
    return req;
  });
}
const input = () => ({ signal: new AbortController().signal });

describe('ATS public HTTP boundaries', () => {
  it('公开表单编码正确转义，只接受标量，仍不带认证头', async () => {
    Setup();
    await new AtsPublicTransport().Request('https://example.com/jobs', { ...input(), method: 'POST', bodyEncoding: 'form', body: { title: '研发 & 测试', currentPage: 2, isFrompb: true } });
    const options = mocks.request.mock.calls[0][1];
    expect(options.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    expect(mocks.request.mock.results[0].value.end).toHaveBeenCalledWith(new URLSearchParams({ title: '研发 & 测试', currentPage: '2', isFrompb: 'true' }).toString());
    expect(options.headers.Cookie).toBeUndefined();
    expect(options.headers.Authorization).toBeUndefined();
    await expect(new AtsPublicTransport().Request('https://example.com/jobs', { ...input(), method: 'POST', bodyEncoding: 'form', body: { nested: {} } })).rejects.toMatchObject({ code: 'SOURCE_SCHEMA_CHANGED' });
  });
  it('只发必要公开请求头，无 Cookie/Authorization，固定已验证 DNS 地址', async () => {
    Setup();
    const observer = vi.fn();
    const response = await new AtsPublicTransport().Request('https://example.com/jobs', { ...input(), onRequest: observer });
    expect(response.status).toBe(200);
    const headers = mocks.request.mock.calls[0][1].headers;
    expect(headers['User-Agent']).toBe('Avery-Public-Recruitment-Collector/1.0');
    expect(headers.Cookie).toBeUndefined();
    expect(headers.Authorization).toBeUndefined();
    expect(observer).toHaveBeenCalledTimes(1);
  });
  it('拒绝本机、私网、混合解析、凭证与非HTTPS', async () => {
    for (const address of ['127.0.0.1', '10.0.0.1', '192.168.1.2', '169.254.169.254', '::1', '::ffff:127.0.0.1']) {
      mocks.lookup.mockResolvedValue([{ address, family: address.includes(':') ? 6 : 4 }]);
      await expect(new AtsPublicTransport().Request('https://example.com', input())).rejects.toMatchObject({ code: 'SOURCE_ACCESS_DENIED' });
    }
    mocks.lookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }, { address: '127.0.0.1', family: 4 }]);
    await expect(new AtsPublicTransport().Request('https://example.com', input())).rejects.toMatchObject({ code: 'SOURCE_ACCESS_DENIED' });
    for (const url of ['http://example.com', 'https://user:password@example.com', 'https://example.com:8080']) {
      await expect(new AtsPublicTransport().Request(url, input())).rejects.toMatchObject({ code: 'SOURCE_ACCESS_DENIED' });
    }
    expect(mocks.request).not.toHaveBeenCalled();
  });
  it('逐跳检查重定向，拒绝登录与跨域POST', async () => {
    Setup([302], { 0: 'https://example.com/login' });
    await expect(new AtsPublicTransport().Request('https://example.com', input())).rejects.toMatchObject({ code: 'SOURCE_LOGIN_REQUIRED' });
    Setup([307], { 0: 'https://other.example.com/jobs' });
    await expect(new AtsPublicTransport().Request('https://example.com', { ...input(), method: 'POST', body: {} })).rejects.toMatchObject({ code: 'SOURCE_ACCESS_DENIED' });
  });
  it('401/403 不重试；429最多重试两次，退避1秒及3秒', async () => {
    for (const status of [401, 403]) {
      Setup([status]);
      await new AtsPublicTransport().Request('https://example.com', input());
      expect(mocks.request).toHaveBeenCalledTimes(1);
      mocks.request.mockClear();
    }
    Setup([429, 503, 200]);
    const started: number[] = [];
    const request = mocks.request.getMockImplementation()!;
    mocks.request.mockImplementation((...args) => { started.push(Date.now()); return request(...args); });
    const promise = new AtsPublicTransport().Request('https://example.com', input());
    expect((await promise).status).toBe(200);
    expect(mocks.request).toHaveBeenCalledTimes(3);
    expect(started[1] - started[0]).toBeGreaterThanOrEqual(990);
    expect(started[2] - started[1]).toBeGreaterThanOrEqual(2990);
  }, 10_000);
  it('同Host至少间隔400ms，取消排队的请求不再发出', async () => {
    vi.useFakeTimers(); Setup();
    const transport = new AtsPublicTransport();
    await transport.Request('https://example.com/1', input());
    const next = transport.Request('https://example.com/2', input());
    await vi.advanceTimersByTimeAsync(399);
    expect(mocks.request).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await next;
    expect(mocks.request).toHaveBeenCalledTimes(2);
    const controller = new AbortController();
    const cancelled = transport.Request('https://example.com/3', { signal: controller.signal });
    const check = expect(cancelled).rejects.toThrow();
    controller.abort();
    await check;
    expect(mocks.request).toHaveBeenCalledTimes(2);
  });
  it('DNS解析等待也响应来源取消', async () => {
    mocks.lookup.mockImplementation(() => new Promise(() => undefined));
    const controller = new AbortController();
    const promise = new AtsPublicTransport().Request('https://example.com', { signal: controller.signal });
    const check = expect(promise).rejects.toThrow('stop');
    controller.abort(new Error('stop'));
    await check;
    expect(mocks.request).not.toHaveBeenCalled();
  });

  it('全局最多5个连接，同一Host最多2个连接', async () => {
    mocks.lookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
    const pending: Array<() => void> = [];
    let active = 0;
    let maximum = 0;
    mocks.request.mockImplementation((_url, _options, callback) => {
      const req = new EventEmitter() as EventEmitter & { end: () => void };
      req.end = () => {
        active += 1; maximum = Math.max(maximum, active);
        pending.push(() => {
          active -= 1;
          const response = Object.assign(new EventEmitter(), { statusCode: 200, headers: {} });
          callback(response); response.emit('end');
        });
      };
      return req;
    });
    const tick = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    const transport = new AtsPublicTransport();
    const global = Array.from({ length: 12 }, (_, index) => transport.Request(`https://host${index}.example.com`, input()));
    await tick(40);
    expect(active).toBe(5);
    while (pending.length || mocks.request.mock.calls.length < 12) {
      pending.splice(0).forEach((finish) => finish());
      await tick(40);
    }
    await Promise.all(global);
    expect(maximum).toBe(5);
    active = 0; maximum = 0;
    const same = Array.from({ length: 3 }, (_, index) => transport.Request(`https://same.example.com/${index}`, input()));
    await tick(850);
    expect(active).toBe(2);
    pending.splice(0).forEach((finish) => finish());
    await tick(100);
    pending.splice(0).forEach((finish) => finish());
    await Promise.all(same);
    expect(maximum).toBe(2);
  });
});
