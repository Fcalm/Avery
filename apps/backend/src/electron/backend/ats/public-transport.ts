import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { request } from 'node:https';
import { setTimeout as delay } from 'node:timers/promises';
import { AtsError, type PublicResponse, type PublicRequest, type PublicTransport } from './types';

const MaxBodyBytes = 8 * 1024 * 1024;
const RetryStatus = new Set([429, 502, 503, 504]);

async function WithAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let stop: () => void = () => undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    stop = () => reject(signal.reason);
    signal.addEventListener('abort', stop, { once: true });
  });
  try { return await Promise.race([promise, aborted]); }
  finally { signal.removeEventListener('abort', stop); }
}

function IsPublicIp(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
      || (a === 198 && (b === 18 || b === 19)));
  }
  // 公共采集只使用可验证的全球单播地址；拒绝 IPv4 映射和特殊用途 IPv6。
  return isIP(address) === 6 && /^[23][0-9a-f]{3}:/i.test(address);
}

/** URL 和每次重定向均校验，DNS 结果固定到本次连接，不携带 Cookie 或认证头。 */
export class AtsPublicTransport implements PublicTransport {
  private active = 0;
  private readonly hosts = new Map<string, { active: number; nextAt: number }>();

  async Request(url: string, input: PublicRequest): Promise<PublicResponse> {
    for (let attempt = 0; ; attempt += 1) {
      input.signal.throwIfAborted();
      try {
        const response = await this.Follow(url, input);
        if (!RetryStatus.has(response.status) || attempt === 2) return response;
      } catch (error) {
        const code = (error as { code?: string }).code;
        if (input.signal.aborted || attempt === 2 || !['ETIMEDOUT', 'ECONNRESET', 'EAI_AGAIN'].includes(code ?? '')) throw error;
      }
      await delay(attempt === 0 ? 1000 : 3000, undefined, { signal: input.signal });
    }
  }

  private async Follow(value: string, input: PublicRequest, redirects = 0): Promise<PublicResponse> {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) {
      throw new AtsError('SOURCE_ACCESS_DENIED', 'Only public HTTPS recruitment URLs without credentials are supported.');
    }
    const requestSignal = AbortSignal.any([input.signal, AbortSignal.timeout(10_000)]);
    let addresses;
    try { addresses = await WithAbort(lookup(url.hostname.replace(/^\[|\]$/g, ''), { all: true }), requestSignal); }
    catch (error) {
      if (!input.signal.aborted && requestSignal.aborted) throw Object.assign(new Error('DNS lookup timed out.'), { code: 'ETIMEDOUT' });
      throw error;
    }
    requestSignal.throwIfAborted();
    if (!addresses.length || addresses.some(({ address }) => !IsPublicIp(address))) throw new AtsError('SOURCE_ACCESS_DENIED', 'Recruitment host resolves to a non-public address.');
    const host = this.hosts.get(url.host) ?? { active: 0, nextAt: 0 };
    this.hosts.set(url.host, host);
    while (this.active >= 5 || host.active >= 2 || host.nextAt > Date.now()) {
      await delay(Math.max(10, Math.min(100, host.nextAt - Date.now())), undefined, { signal: input.signal });
    }
    input.signal.throwIfAborted();
    this.active += 1;
    host.active += 1;
    host.nextAt = Date.now() + 400;
    let result: PublicResponse & { location?: string };
    try {
      result = await new Promise((resolve, reject) => {
        // 只增加公开协议的编码选项，不开放自定义认证头或 Cookie。
        let body: string | undefined;
        if (input.body !== undefined && input.bodyEncoding === 'form') {
          if (!input.body || typeof input.body !== 'object' || Array.isArray(input.body)
            || Object.values(input.body).some((value) => !['string', 'number', 'boolean'].includes(typeof value))) {
            throw new AtsError('SOURCE_SCHEMA_CHANGED', 'Public form body must contain scalar values only.');
          }
          body = new URLSearchParams(Object.fromEntries(Object.entries(input.body).map(([key, value]) => [key, String(value)]))).toString();
        } else body = input.body === undefined ? undefined : JSON.stringify(input.body);
        const signal = requestSignal;
        input.onRequest?.();
        const req = request(url, {
          method: input.method ?? 'GET', signal,
          headers: { 'User-Agent': 'Avery-Public-Recruitment-Collector/1.0', Accept: 'application/json,text/html', ...(body ? { 'Content-Type': input.bodyEncoding === 'form' ? 'application/x-www-form-urlencoded' : 'application/json', 'Content-Length': Buffer.byteLength(body) } : {}) },
          lookup: (_hostname, options, callback) => options.all ? callback(null, addresses) : callback(null, addresses[0].address, addresses[0].family),
        }, (res) => {
          const chunks: Buffer[] = [];
          let size = 0;
          res.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > MaxBodyBytes) req.destroy(new AtsError('SOURCE_PARSE_FAILED', 'Public response exceeds 8 MiB.'));
            else chunks.push(chunk);
          });
          res.on('error', reject);
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8'), url: url.toString(), location: res.headers.location }));
        });
        req.on('error', (error) => {
          if (!input.signal.aborted && signal.aborted) reject(Object.assign(new Error('HTTP request timed out.'), { code: 'ETIMEDOUT' }));
          else reject(error);
        });
        req.end(body);
      });
    } finally { this.active -= 1; host.active -= 1; }
    if ([301, 302, 303, 307, 308].includes(result.status) && result.location) {
      if (redirects >= 3) throw new AtsError('SOURCE_NETWORK_ERROR', 'Too many public redirects.');
      const next = new URL(result.location, url);
      if (/login|signin|passport|captcha|verify/i.test(next.pathname)) throw new AtsError('SOURCE_LOGIN_REQUIRED', 'Public source redirects to authentication or verification.');
      // 不跨域重发 POST 内容；公开 GET 重定向仍逐跳验证出口。
      if (input.method === 'POST' && next.origin !== url.origin) throw new AtsError('SOURCE_ACCESS_DENIED', 'Cross-origin POST redirect is unsupported.');
      return this.Follow(next.toString(), result.status === 303 ? { signal: input.signal, onRequest: input.onRequest } : input, redirects + 1);
    }
    return result;
  }
}
