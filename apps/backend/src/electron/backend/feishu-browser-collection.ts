import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { setTimeout as Delay } from 'node:timers/promises';
import { z } from 'zod';
import type { BrowserAutomationPort } from '@avery/agent-sdk';
import type { JobCollectionRequest, RecruitmentSource } from '@avery/contracts';
import { AsRecord, ParseJson } from './ats/adapters';
import { NormalizeFeishuJob } from './ats/feishu';
import { CreateSource } from './ats/source-runner';
import { AtsPublicTransport } from './ats/public-transport';
import { AtsError, type NormalizedJob, type PublicTransport } from './ats/types';

const PageSchema = z.object({ url: z.string().url(), ready: z.boolean(), risk: z.string().optional(), path: z.string().regex(/^[\w-]{1,100}$/).optional(), company: z.string().max(500).optional(), page: z.number().int().positive().optional(), total: z.number().int().nonnegative().max(100000).optional(), ids: z.array(z.string().regex(/^\d+$/)).max(100), titles: z.record(z.string(),z.string().max(300)).default({}) });
export type FeishuBrowserPage = z.infer<typeof PageSchema>;
export type FeishuPageReader = (url: string, signal: AbortSignal, deadline: number) => Promise<FeishuBrowserPage>;
const CacheSchema = z.object({ schemaVersion: z.literal(1), pages: z.record(z.string(), z.object({ at: z.number(), page: PageSchema })), details: z.record(z.string(), z.object({ at: z.number(), body: z.string().max(200000) })) });
type Cache = z.infer<typeof CacheSchema>;
const Hash = (value: string) => createHash('sha256').update(value).digest('hex');
const Check = (signal: AbortSignal, deadline: number) => { signal.throwIfAborted(); if (Date.now() >= deadline) throw new AtsError('SOURCE_TIMEOUT', 'Feishu source deadline reached; already stored jobs remain available.'); };

/** 固定只读DOM提取：不读Cookie、不调用页面私有接口，不允许模型或网页构造表达式。 */
export const FeishuListExpression = `(() => {
  const text = document.body?.innerText || '';
  const result = { url: location.href, ready: false, ids: [] };
  if (/captcha|verify|passport|login/i.test(location.pathname) || /人机验证|请完成安全验证|扫码登录后/.test(text)) return {...result, risk: 'login_or_verification'};
  let meta; try { meta = JSON.parse(document.querySelector('#js-websiteInfo')?.textContent || '{}'); } catch { return result; }
  const path = meta.website_info?.path;
  if (typeof path !== 'string' || !/^[\\w-]{1,100}$/.test(path)) return result;
  const count = text.match(/(?:开启新的工作|开放职位|招聘职位)[（(]\\s*(\\d+)\\s*[）)]/);
  if (!count) return result;
  const jobs = [...document.querySelectorAll('a[href]')].flatMap(a => {
    const u = new URL(a.href, location.href), m = u.pathname.match(/^\\/([^/]+)\\/position\\/(\\d+)\\/detail\\/?$/);
    return u.origin === location.origin && m?.[1] === path ? [{id:m[2],title:String(a.innerText || '').trim().split('\\n')[0].slice(0,300)}] : [];
  });
  const unique = [...new Set(jobs.map(job=>job.id))], total = Number(count[1]);
  const page = Number(document.querySelector('.atsx-pagination-item-active')?.textContent || new URL(location.href).searchParams.get('current') || '1');
  return {...result, path, company: String(meta.tenant_info?.tenant_name || '').slice(0,500), page, total, ids: unique, titles:Object.fromEntries(jobs.map(job=>[job.id,job.title])),
    ready: unique.length > 0 || total === 0 && /暂无职位|暂无相关职位|没有找到|暂无符合|No (?:jobs|positions)/i.test(text)};
})()`;

/** 浏览器只负责官网原生筛选后的列表；导航与定时授权仍走既有Prepare/Execute。 */
export function CreateFeishuPageReader(browser: BrowserAutomationPort): FeishuPageReader {
  return async (url, signal, deadline) => {
    const expected = new URL(url);
    if (expected.protocol !== 'https:' || !/(?:^|\.)(?:jobs\.feishu\.cn|jobs\.larkoffice\.com)$/.test(expected.hostname) || expected.username || expected.password || expected.port && expected.port !== '443') throw new AtsError('SOURCE_ACCESS_DENIED', 'Unsupported Feishu browser origin.');
    if (!browser.EvaluateTrustedPage) throw new AtsError('BROWSER_UNAVAILABLE', 'Browser does not support trusted Feishu reading.');
    Check(signal, deadline);
    const proposal = await browser.Prepare({ toolName: 'BrowserNavigate', arguments: { url } });
    if (proposal.forceConfirmation) throw new AtsError('BROWSER_CONFIRMATION_REQUIRED', 'Feishu collection navigation requires confirmation.');
    const result = await browser.Execute({ proposal, signal, deadline });
    if (result.status !== 'succeeded') throw new AtsError('BROWSER_STATUS_UNKNOWN', 'Feishu navigation outcome is unknown.');
    const until = Math.min(deadline, Date.now() + 15000);
    do {
      Check(signal, deadline);
      const state = PageSchema.parse(await browser.EvaluateTrustedPage({ site: 'feishu', expectedOrigin: expected.origin, expression: FeishuListExpression, signal, deadline }));
      const actual = new URL(state.url);
      if (actual.origin !== expected.origin) throw new AtsError('SOURCE_ACCESS_DENIED', 'Feishu page changed origin.');
      if (state.risk) throw new AtsError('SOURCE_LOGIN_REQUIRED', 'Feishu recruitment page requires login or verification.');
      if (state.ready && state.page === Number(expected.searchParams.get('current') ?? '1') && actual.searchParams.get('keywords') === expected.searchParams.get('keywords')) return state;
      await Delay(300, undefined, { signal });
    } while (Date.now() < until);
    throw new AtsError('SOURCE_TIMEOUT', 'Feishu job list did not become ready; no empty result was assumed.');
  };
}

/** 派生缓存与岗位库分离；列表按企业+关键词+页码分区，不把过滤结果当企业全量快照。 */
export class FeishuBrowserCollector {
  private cache: Cache | undefined;
  constructor(private readonly path: string, private readonly transport: PublicTransport = new AtsPublicTransport()) {}
  private async Load(refresh = false): Promise<Cache> {
    if (this.cache) return this.cache;
    try { this.cache = CacheSchema.parse(JSON.parse(await readFile(this.path, 'utf8'))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && !refresh) throw new AtsError('STORAGE_ERROR', 'Feishu derived cache is unreadable; refresh before collecting.'); }
    return this.cache ??= { schemaVersion: 1, pages: {}, details: {} };
  }
  private Url(source: RecruitmentSource, keyword: string, page = 1): string {
    const url = new URL(source.url), path = url.pathname.split('/').filter(Boolean)[0];
    if (url.protocol !== 'https:' || url.username || url.password || url.port && url.port !== '443' || !/(?:^|\.)(?:jobs\.feishu\.cn|jobs\.larkoffice\.com)$/.test(url.hostname) || !path || !/^[\w-]{1,100}$/.test(path)) throw new AtsError('SOURCE_UNSUPPORTED', 'Feishu browser collection needs a recognized recruitment portal path.');
    // 品牌首页未必包含岗位，统一使用官网导航中公开的标准职位列表路由。
    url.pathname = `/${path}/position/list`; url.hash = ''; url.search = new URLSearchParams({ keywords: keyword, current: String(page), limit: '10' }).toString();
    return url.toString();
  }
  async HasCachedQuery(source: RecruitmentSource, request: JobCollectionRequest): Promise<boolean> {
    // 单岗位入口不能因为同企业列表已有缓存而扩展成整个招聘门户。
    if (/\/(?:position|resume)\/\d+(?:\/|$)/.test(new URL(source.url).pathname)) return false;
    const cache = await this.Load(request.refresh), page = cache.pages[Hash(this.Url(source, request.keyword))];
    return !request.refresh && Boolean(page && Date.now() - page.at < 15 * 60_000);
  }
  private async Persist(): Promise<void> {
    const cache = this.cache!;
    cache.pages = Object.fromEntries(Object.entries(cache.pages).sort((a,b) => b[1].at-a[1].at).slice(0,128));
    let size = 0;
    cache.details = Object.fromEntries(Object.entries(cache.details).sort((a,b) => b[1].at-a[1].at).filter(([,value], index) => { size += value.body.length; return index < 2000 && size <= 8_000_000; }));
    await mkdir(dirname(this.path), { recursive: true }); const temporary = `${this.path}.${randomUUID()}.tmp`;
    try { await writeFile(temporary, JSON.stringify(cache), 'utf8'); await rename(temporary, this.path); }
    finally { await unlink(temporary).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; }); }
  }
  async Run(input: { source: RecruitmentSource; request: JobCollectionRequest; readPage: FeishuPageReader; signal: AbortSignal; deadline: number; accept(job: NormalizedJob): Promise<boolean> }): Promise<{ received: number; complete: boolean; errors: string[] }> {
    const { source, request, signal, deadline } = input, cache = await this.Load(request.refresh);
    let total: number | undefined, received = 0; const seen = new Set<string>(), errors: string[] = [];
    try {
    for (let index = 1; ; index++) {
      Check(signal, deadline);
      const url = this.Url(source, request.keyword, index), key = Hash(url), old = cache.pages[key];
      const page = old && !request.refresh && Date.now() - old.at < 15 * 60_000 ? old.page : PageSchema.parse(await input.readPage(url, signal, deadline));
      if (!page.ready || page.total === undefined || page.page !== index || page.path !== new URL(url).pathname.split('/')[1] || new URL(page.url).origin !== new URL(url).origin || new URL(page.url).searchParams.get('keywords') !== request.keyword) throw new AtsError('SOURCE_SCHEMA_CHANGED', 'Feishu browser returned a different or incomplete search page.');
      if (total !== undefined && total !== page.total) throw new AtsError('SOURCE_SCHEMA_CHANGED', 'Feishu search count changed during pagination.');
      total = page.total; cache.pages[key] = { at: old?.page === page ? old.at : Date.now(), page };
      if (page.ids.some(id => seen.has(id))) throw new AtsError('SOURCE_SCHEMA_CHANGED', 'Feishu browser repeated a list page.');
      for (const id of page.ids) seen.add(id);
      if (seen.size > total) throw new AtsError('SOURCE_SCHEMA_CHANGED', 'Feishu list contains more job IDs than its declared count.');
      if (!page.ids.length && total > 0) throw new AtsError('SOURCE_SCHEMA_CHANGED', 'Feishu search ended before its declared count.');
      // 原生搜索可能匹配JD；明确选择名称范围时，已读到名称的非匹配项无需再请求详情。
      const candidates = request.keyword && request.keywordScope === 'title' ? page.ids.filter(id=>!page.titles[id] || page.titles[id].toLowerCase().includes(request.keyword.toLowerCase())) : page.ids;
      // 详情并发最多3个；写入逐条串行，避免共享批次计数和目标数量竞争。
      for (let offset = 0; offset < candidates.length; offset += 3) {
        const jobs = await Promise.allSettled(candidates.slice(offset, offset + 3).map(async id => {
          Check(signal, deadline); const detailKey = `${new URL(url).hostname}:${id}`, old = cache.details[detailKey];
          let body = old && !request.refresh && Date.now() - old.at < 6 * 60 * 60_000 ? old.body : undefined;
          if (!body) {
            const response = await this.transport.Request(new URL(`/api/v1/job/posts/${id}?portal_type=6`, url).toString(), { signal, feishuPath: page.path });
            const root = ParseJson(response); if (root.code !== 0) throw new AtsError('SOURCE_ACCESS_DENIED', 'Feishu detail request was rejected.');
            body = response.body; if (body.length > 200000) throw new AtsError('SOURCE_SCHEMA_CHANGED', 'Feishu detail exceeds its cache limit.');
          }
          const raw = AsRecord(AsRecord(AsRecord(JSON.parse(body)).data).job_post_detail);
          if (raw.id !== id) throw new AtsError('SOURCE_SCHEMA_CHANGED', 'Feishu detail identity mismatch.');
          const at = old && !request.refresh && body === old.body ? old.at : Date.now();
          const job = NormalizeFeishuJob({ ...CreateSource({ company: source.company, url: source.url, ats: 'feishu' }), id: source.sourceId }, { ats: 'feishu', tenant: new URL(url).hostname, feishuPath: page.path, companyName: page.company, transport: 'browser' }, raw, new Date(at).toISOString());
          cache.details[detailKey] = { at, body }; return job;
        }));
        for (const job of jobs) {
          Check(signal, deadline); received++;
          if (job.status === 'rejected') { if (errors.length < 10) errors.push(job.reason instanceof Error ? job.reason.message : 'Feishu detail failed.'); continue; }
          if (job.value.status === 'open' && !await input.accept(job.value)) return { received, complete: false, errors };
        }
      }
      if (seen.size >= total) return { received, complete: !errors.length, errors };
    }
    } finally {
      // 派生缓存按企业段统一落盘；避免每3个详情都重写整个缓存，业务岗位仍按原批次提交。
      await this.Persist();
    }
  }
}
