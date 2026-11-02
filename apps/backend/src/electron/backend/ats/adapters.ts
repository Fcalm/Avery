import { createHash } from 'node:crypto';
import { AtsError, type AtsAdapter, type AtsSource, type AtsType, type CollectionContinuation, type NormalizedJob, type ProbeResult, type PublicResponse, type PublicTransport, type QuarantinedJob, type SourceResult } from './types';
import { CollectLegacyBeisen, ParseLegacyList } from './beisen-legacy';
import { DiscoverMokaRecruitment, ParseMokaRecruitmentUrl } from './moka-discovery';

type Row = Record<string, unknown>;
export function AsRecord(value: unknown): Row { return value && typeof value === 'object' && !Array.isArray(value) ? value as Row : {}; }
function Text(value: unknown): string | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  const text = String(value).replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').trim();
  return text || undefined;
}
function DateText(value: unknown): string | undefined {
  const text = Text(value);
  return text && !text.startsWith('0001-') && Number.isFinite(Date.parse(text)) ? text : undefined;
}

/** 公开响应中的认证、验证及私有接口错误必须显式停止；不尝试 Cookie 或解密。 */
export function CheckResponse(response: PublicResponse): void {
  if (/"(?:msg|message|error)"\s*:\s*"[^"\n]*(?:IP not allowed|IP (?:is )?not authorized|IP whitelist|IP不在白名单)/i.test(response.body)) throw new AtsError('SOURCE_ACCESS_DENIED', 'Public source restricts access to approved IP addresses.');
  if (response.status === 401 || response.status === 403) throw new AtsError(`SOURCE_${response.status}`, `Public source returned HTTP ${response.status}.`);
  if (response.status < 200 || response.status >= 300) throw new AtsError('SOURCE_NETWORK_ERROR', `Public source returned HTTP ${response.status}.`);
  // 招聘页可加载验证码 SDK 但仍公开可读；仅拦截实际挑战响应，不因资源名误报。
  if (/"(?:code|error)"\s*:\s*"(?:CAPTCHA_REQUIRED|captcha)"|<title[^>]*>[^<]*(?:captcha|安全验证|人机验证)|<form[^>]+(?:action|id)=["'][^"']*captcha/i.test(response.body)) throw new AtsError('SOURCE_CAPTCHA', 'Public source requires verification.');
  if (/"(?:code|Code)"\s*:\s*(?:401|403)\b|"(?:error|message|Message)"\s*:\s*"[^"\n]*(?:unauthorized|login required|authentication required|请登录)/i.test(response.body)) {
    throw new AtsError('SOURCE_LOGIN_REQUIRED', 'Public source requires authentication.');
  }
}

export function ParseJson(response: PublicResponse): Row {
  CheckResponse(response);
  try { return AsRecord(JSON.parse(response.body)); }
  catch { throw new AtsError('SOURCE_SCHEMA_CHANGED', 'Expected public JSON response.'); }
}

function Hash(job: Pick<NormalizedJob, 'title' | 'description' | 'requirements' | 'locations' | 'department'>): string {
  return createHash('sha256').update(JSON.stringify([job.title, job.description ?? null, job.requirements ?? null, [...job.locations].sort(), job.department ?? null])).digest('hex');
}

function Normalize(source: AtsSource, probe: ProbeResult, raw: Row, at: string): NormalizedJob | null {
  const beisen = probe.ats === 'beisen';
  const id = Text(beisen ? raw.JobAdId : raw.id);
  const title = Text(beisen ? raw.JobAdName : raw.title ?? raw.name);
  if (!id || !title || !source.company || !source.url) return null;
  const rawLocations = beisen ? raw.LocNames : raw.locations ?? raw.location;
  const locations = (Array.isArray(rawLocations) ? rawLocations : rawLocations ? [rawLocations] : [])
    .flatMap((item) => {
      const record = AsRecord(item);
      const structured = [record.province, record.city, record.area].map(Text).filter(Boolean).join('·');
      const text = Text(typeof item === 'object' ? record.name ?? (structured || undefined) ?? record.address ?? record.label : item);
      return text ? [text] : [];
    });
  const applicationUrl = beisen
    ? new URL(`/jobdetail?jobAdId=${encodeURIComponent(Text(raw.Id) ?? id)}`, source.url).toString()
    : `${(probe.recruitmentUrl ?? source.url).split('#')[0]}#/job/${encodeURIComponent(id)}`;
  const fields = {
    title, department: Text(beisen ? raw.Org ?? raw.Department : AsRecord(raw.department).name ?? raw.department), locations,
    description: Text(beisen ? raw.Duty : raw.description), requirements: Text(beisen ? raw.Require : raw.requirements),
  };
  const updatedAt = DateText(beisen ? raw.ChangeDate : raw.updatedAt);
  const fieldIssues: NonNullable<NormalizedJob['fieldIssues']> = {};
  const supplied = { locations: rawLocations, description: beisen ? raw.Duty : raw.description, requirements: beisen ? raw.Require : raw.requirements, updatedAt: beisen ? raw.ChangeDate : raw.updatedAt };
  const mapped = { locations: locations.length > 0, description: Boolean(fields.description), requirements: Boolean(fields.requirements), updatedAt: Boolean(updatedAt) };
  for (const key of Object.keys(mapped) as Array<keyof typeof mapped>) {
    if (mapped[key]) continue;
    const value = supplied[key];
    fieldIssues[key] = value === undefined ? 'source_missing' : value === null || value === '' || (Array.isArray(value) && !value.length)
      ? 'source_empty' : key === 'updatedAt' ? 'source_invalid' : 'unmapped_value';
  }
  return {
    ...fields, id: `${probe.ats}:${probe.tenant}:${id}`, sourceId: source.id, ats: probe.ats, tenant: probe.tenant,
    atsJobId: id, company: source.company, sourceUrl: source.url, applicationUrl,
    jobType: beisen ? /实习/.test(Text(raw.Category) ?? '') ? 'intern' : /校园|校招/.test(Text(raw.Category) ?? '') ? 'campus_recruitment' : /社会|社招/.test(Text(raw.Category) ?? '') ? 'social_recruitment' : undefined
      : raw.commitment === '实习' || raw.commitment === 3 ? 'intern' : probe.mode === 'campus' ? 'campus_recruitment' : 'social_recruitment',
    salary: Text(beisen ? raw.Salary : raw.salary) ?? (!beisen && typeof raw.minSalary === 'number' && typeof raw.maxSalary === 'number' ? `${raw.minSalary}-${raw.maxSalary}K` : undefined),
    education: Text(beisen ? raw.Degree : raw.education),
    experience: Text(beisen ? raw.YearsOfWorking : raw.minExperience !== undefined ? `${String(raw.minExperience)}${raw.maxExperience === undefined ? '' : `-${String(raw.maxExperience)}`}年` : undefined),
    publishedAt: DateText(beisen ? raw.PostDate : raw.publishedAt ?? raw.createdAt),
    updatedAt, fieldIssues, rawHash: Hash(fields), firstSeenAt: at, lastSeenAt: at,
    status: beisen ? raw.Status === 1 ? 'open' : 'unknown' : raw.status === 'closed' ? 'closed' : raw.status === 'open' ? 'open' : 'unknown',
  };
}

type Page = { rows: unknown[]; count?: number };
async function CollectPages(source: AtsSource, probe: ProbeResult, page: (index: number) => Promise<Page>, continuation?: CollectionContinuation): Promise<Pick<SourceResult, 'jobs' | 'quarantine' | 'snapshotStatus' | 'errors' | 'receivedCount' | 'continuation' | 'publicJobCount'>> {
  const signature = JSON.stringify([probe.ats, probe.tenant, probe.portalId, probe.orgId, probe.siteId, probe.mode]);
  const firstPage = await page(1);
  const firstPageHash = createHash('sha256').update(JSON.stringify(firstPage)).digest('hex');
  // 每段重新验证第一页与总数；租户、列表或检查点过期时从头开始，不拼接不同快照。
  const resumed = continuation && continuation.signature === signature && continuation.firstPageHash === firstPageHash
    && Date.now() - Date.parse(continuation.startedAt) < 30 * 60_000 ? continuation : undefined;
  const jobs = new Map<string, NormalizedJob>((resumed?.jobs ?? []).map((job) => [job.id, job]));
  const quarantine: QuarantinedJob[] = [];
  const errors: SourceResult['errors'] = [];
  let snapshotStatus: SourceResult['snapshotStatus'] = 'partial';
  let receivedCount = resumed?.receivedCount ?? 0;
  const at = new Date().toISOString();
  let previousCount: number | undefined = resumed?.count;
  let nextPage = resumed?.nextPage ?? 1;
  for (let step = 0; step < (source.maxPages ?? 20); step += 1) {
    const index = nextPage;
    let result: Page;
    try { result = index === 1 ? firstPage : await page(index); }
    catch (error) {
      if (!jobs.size) throw error;
      errors.push({ code: error instanceof AtsError ? error.code : error instanceof Error && ['AbortError', 'TimeoutError'].includes(error.name) ? 'SOURCE_TIMEOUT' : 'SOURCE_NETWORK_ERROR', message: error instanceof Error ? error.message : 'Page request failed.' });
      break;
    }
    receivedCount += result.rows.length;
    let duplicates = 0;
    for (const raw of result.rows) {
      const job = Normalize(source, probe, AsRecord(raw), at);
      if (!job) quarantine.push({ sourceId: source.id, atsJobId: Text(AsRecord(raw).JobAdId ?? AsRecord(raw).id), reason: 'Missing ATS job ID or title.', raw, at });
      else if (jobs.has(job.id)) duplicates += 1;
      else jobs.set(job.id, job);
    }
    // 总数变化、重复页或隔离记录不能证明完整集合，绝不据此关闭旧岗位。
    if (previousCount !== undefined && result.count !== undefined && previousCount !== result.count) {
      errors.push({ code: 'SOURCE_SCHEMA_CHANGED', message: 'Job count changed during pagination.' });
      break;
    }
    previousCount = result.count ?? previousCount;
    if (duplicates) {
      errors.push({ code: 'SOURCE_SCHEMA_CHANGED', message: 'The server repeated a page.' });
      break;
    }
    nextPage = index + 1;
    const reachedCount = result.count !== undefined && receivedCount >= result.count;
    const ended = result.rows.length < 50;
    if (reachedCount || ended) {
      const inconsistent = result.count !== undefined && jobs.size < result.count;
      snapshotStatus = quarantine.length || inconsistent ? 'partial' : 'complete';
      break;
    }
    if (step === (source.maxPages ?? 20) - 1) errors.push({ code: 'SOURCE_PAGE_LIMIT', message: 'Reached source page limit before proving completeness.' });
  }
  const resumable = snapshotStatus === 'partial' && !quarantine.length && errors.length > 0
    && errors.every((error) => ['SOURCE_PAGE_LIMIT', 'SOURCE_REQUEST_LIMIT', 'SOURCE_TIMEOUT', 'SOURCE_NETWORK_ERROR'].includes(error.code));
  return { jobs: [...jobs.values()], quarantine, snapshotStatus, errors, receivedCount, publicJobCount: previousCount,
    ...(resumable ? { continuation: { signature, startedAt: resumed?.startedAt ?? at, firstPageHash, nextPage, count: previousCount, receivedCount, jobs: [...jobs.values()] } } : {}),
  };
}

export class BeisenCareerAdapter implements AtsAdapter {
  readonly ats = 'beisen' as const;
  async probe(source: AtsSource, transport: PublicTransport, signal: AbortSignal): Promise<ProbeResult> {
    const response = await transport.Request(new URL('/portal/registerSystemInfo', source.url).toString(), { signal });
    CheckResponse(response);
    // registerSystemInfo 在部分租户返回 BSGlobal HTML；只提取数据，不执行页面脚本。
    const match = response.body.match(/"PortalId"\s*:\s*"([^"\s]+)"/i);
    if (!match) {
      // 仅已知旧接口的 Not Found 响应进入公开 CMS 探测，任意结构变化不静默兜底。
      if (!/<title[^>]*>\s*Not Found\s*<\/title>/i.test(response.body)) throw new AtsError('SOURCE_SCHEMA_CHANGED', 'Beisen PortalId is missing.');
      const list = await transport.Request(new URL('/alljob/', source.url).toString(), { signal });
      CheckResponse(list);
      ParseLegacyList(list.body, list.url);
      return { ats: this.ats, tenant: new URL(list.url).hostname, protocol: 'beisen_cms', listUrl: list.url, listHtml: list.body, transport: 'public_portal_html' };
    }
    return { ats: this.ats, tenant: new URL(response.url).hostname, portalId: match[1], transport: 'public_portal_json' };
  }
  async collect(source: AtsSource, probe: ProbeResult, transport: PublicTransport, signal: AbortSignal, continuation?: CollectionContinuation) {
    if (probe.protocol === 'beisen_cms') return CollectLegacyBeisen(source, probe, {
      Request: async (url, input) => { const response = await transport.Request(url, input); CheckResponse(response); return response; },
    }, signal, Normalize, continuation);
    return CollectPages(source, probe, async (index) => {
      const data = ParseJson(await transport.Request(new URL('/api/Jobad/GetJobAdPageList', source.url).toString(), {
        // 北森 PageIndex 从 0 开始；从 1 开始会漏掉第一页甚至把小站误判为空。
        method: 'POST', body: { PortalId: probe.portalId, PageIndex: index - 1, PageSize: 50, DisplayFields: ['Category', 'Kind', 'LocId', 'PostDate', 'Salary', 'Org', 'Degree', 'YearsOfWorking'] }, signal,
      }));
      if (data.Code !== undefined && data.Code !== 200) throw new AtsError('SOURCE_SCHEMA_CHANGED', `Beisen business response code: ${String(data.Code)}`);
      if (!Array.isArray(data.Data)) throw new AtsError('SOURCE_SCHEMA_CHANGED', 'Beisen Data is not a job array.');
      return { rows: data.Data, count: typeof data.Count === 'number' && data.Count >= 0 ? data.Count : undefined };
    }, continuation);
  }
}

export class MokaPublicAdapter implements AtsAdapter {
  readonly ats = 'moka' as const;
  async probe(source: AtsSource, transport: PublicTransport, signal: AbortSignal): Promise<ProbeResult> {
    let portal = ParseMokaRecruitmentUrl(source.url);
    if (!portal) {
      const page = await transport.Request(source.url, { signal });
      CheckResponse(page);
      portal = DiscoverMokaRecruitment(page.body, page.url);
    }
    if (!portal) throw new AtsError('SOURCE_UNSUPPORTED', 'Moka public page does not expose a supported tenant recruitment URL.');
    signal.throwIfAborted();
    return { ats: this.ats, tenant: portal.orgId, ...portal, recruitmentUrl: portal.url, transport: 'public_api' };
  }
  async collect(source: AtsSource, probe: ProbeResult, transport: PublicTransport, signal: AbortSignal, continuation?: CollectionContinuation) {
    return CollectPages(source, probe, async (index) => {
      const url = new URL(`https://api.mokahr.com/api-platform/v1/jobs/${encodeURIComponent(probe.orgId!)}`);
      url.search = new URLSearchParams({ mode: probe.mode!, limit: '50', offset: String((index - 1) * 50), status: 'open' }).toString();
      if (probe.siteId) url.searchParams.set('siteId', probe.siteId);
      const response = await transport.Request(url.toString(), { signal });
      if (/\/api\/outer\/ats-apply\/website\/jobs\/v2|"encrypted"\s*:\s*true/i.test(response.body)) throw new AtsError('SOURCE_PRIVATE_API', 'Only a private encrypted recruitment API is available.');
      const data = ParseJson(response);
      if (!Array.isArray(data.jobs)) throw new AtsError('SOURCE_SCHEMA_CHANGED', 'Moka public jobs array is missing; authenticated or encrypted APIs are not used.');
      return { rows: data.jobs, count: typeof data.total === 'number' && data.total >= 0 ? data.total : undefined };
    }, continuation);
  }
}

/** 自定义域名北森使用页面特征识别；不把任意域名静默归类成 ATS。 */
export async function DetectAts(source: AtsSource, transport: PublicTransport, signal: AbortSignal): Promise<AtsType> {
  if (source.ats) return source.ats;
  const host = new URL(source.url).hostname;
  if (/(?:^|\.)(?:zhiye\.com|italent\.cn)$/.test(host)) return 'beisen';
  if (/(?:^|\.)mokahr\.com$/.test(host)) return 'moka';
  if (/(?:^|\.)hotjob\.cn$/.test(host)) return 'hotjob';
  if (/(?:^|\.)(?:jobs\.feishu\.cn|jobs\.larkoffice\.com)$/.test(host)) return 'feishu';
  const recognizedPlatform = /(?:^|\.)dayee\.com$/.test(host) ? 'dayee'
    : /(?:^|\.)chinahr\.com$/.test(host) ? 'chinahr'
    : /(?:^|\.)zhaopin\.com$/.test(host) ? 'zhaopin' : undefined;
  // 域名识别不代表来源可访问；先检查真实响应，保留平台线索但不把网络失败算成待适配来源。
  if (recognizedPlatform) {
    try { CheckResponse(await transport.Request(source.url, { signal })); }
    catch (error) {
      signal.throwIfAborted();
      throw new AtsError(error instanceof AtsError ? error.code : 'SOURCE_NETWORK_ERROR', error instanceof Error ? error.message : String(error), recognizedPlatform);
    }
    signal.throwIfAborted();
    throw new AtsError('SOURCE_ADAPTER_UNAVAILABLE', `Public ${recognizedPlatform} recruitment source is reachable but not yet supported.`, recognizedPlatform);
  }
  const page = await transport.Request(source.url, { signal });
  CheckResponse(page);
  if (/\bBSGlobal\b|portal-oss\.zhiye\.com|\/api\/Jobad\/GetJobAdPageList/.test(page.body)) return 'beisen';
  try { if (DiscoverMokaRecruitment(page.body, page.url)) return 'moka'; }
  catch (error) { if (error instanceof AtsError && error.code === 'SOURCE_MULTIPLE_PORTALS') return 'moka'; throw error; }
  // 飞书自定义域名必须同时声明招聘站元数据及平台招聘资源，普通供应商字符串不能作为归属依据。
  if (/"website_info"\s*:/.test(page.body)
    && /https?:\/\/(?:[\w-]+\.)*(?:feishucdn\.com|bytescm\.com)\/[^"'\s<>]*(?:atsx|ATSX)/.test(page.body)) {
    return 'feishu';
  }
  if (/https?:\/\/[^"'\s<>]*jobs\.feishu\.cn\//i.test(page.body)) throw new AtsError('SOURCE_ADAPTER_UNAVAILABLE', 'Public page links a Feishu recruitment source; adapter is not yet available.', 'feishu');
  if (/<(?:a|iframe)\b[^>]*\b(?:href|src)\s*=\s*["']https:\/\/(?:[\w-]+\.)*hotjob\.cn(?:\/|["'])/i.test(page.body)) return 'hotjob';
  if (/https?:\/\/[^"'\s<>]*(?:dayee\.com|hotjob\.cn)\//i.test(page.body)) throw new AtsError('SOURCE_ADAPTER_UNAVAILABLE', 'Public page exposes a Dayee/Hotjob recruitment source; adapter is not yet available.', /dayee\.com/.test(page.body) ? 'dayee' : 'hotjob');
  throw new AtsError('SOURCE_UNKNOWN_PLATFORM', 'Public recruitment platform was not recognized; source is not assumed to be empty.');
}
