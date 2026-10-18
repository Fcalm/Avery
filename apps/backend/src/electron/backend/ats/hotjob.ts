import { createHash } from 'node:crypto';
import { AsRecord, CheckResponse, ParseJson } from './adapters';
import { AtsError, type AtsAdapter, type AtsSource, type CollectionContinuation, type NormalizedJob, type ProbeResult, type PublicTransport, type SourceResult } from './types';

const Categories = { 'social.html': 2, 'school.html': 1, 'interns.html': 12, 'overseas.html': 13 } as const;
const PageSize = 12;
function Text(value: unknown): string | undefined {
  return typeof value === 'string' || typeof value === 'number' ? String(value).replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').trim() || undefined : undefined;
}
function PublicPortal(value: string): URL | undefined {
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password && (!url.port || url.port === '443') && /(?:^|\.)hotjob\.cn$/.test(url.hostname) ? url : undefined; }
  catch { return undefined; }
}
function PortalLink(html: string, base: string): URL | undefined {
  const urls = new Map<string, URL>();
  for (const match of html.replace(/<!--[\s\S]*?-->/g, '').matchAll(/<(?:a|iframe)\b[^>]*\b(?:href|src)\s*=\s*["']([^"']+)["']/gi)) {
    try { const url = PublicPortal(new URL(match[1].replace(/&amp;/g, '&'), base).toString()); if (url) { url.hash = ''; urls.set(url.toString(), url); } } catch { /* 非URL链接不是公开入口。 */ }
  }
  if (urls.size > 1) throw new AtsError('SOURCE_MULTIPLE_PORTALS', 'Multiple Hotjob portals are linked; provide a specific recruitment URL.', 'hotjob');
  return [...urls.values()][0];
}
function Data(response: Awaited<ReturnType<PublicTransport['Request']>>): Record<string, unknown> {
  const json = ParseJson(response);
  if (String(json.state) !== '200') {
    const message = Text(json.msg) ?? 'Hotjob public response is not successful.';
    throw new AtsError(/登录|登陆|认证|login|unauthorized/i.test(message) ? 'SOURCE_LOGIN_REQUIRED' : 'SOURCE_SCHEMA_CHANGED', message);
  }
  return AsRecord(json.data);
}
function Normalize(source: AtsSource, probe: ProbeResult, row: Record<string, unknown>, detail: Record<string, unknown>, at: string): NormalizedJob | undefined {
  const id = Text(row.postId), title = Text(detail.postName ?? row.postName);
  if (!id || !title || Text(detail.postId) !== id) return undefined;
  const description = Text(detail.workContent), requirements = Text(detail.serviceCondition);
  const locations = Array.isArray(detail.workPlaceList) ? detail.workPlaceList.map((item) => Text(AsRecord(item).name)).filter((item): item is string => Boolean(item))
    : (Text(detail.workPlaceStr ?? row.workPlaceStr)?.split(/、|;/).filter(Boolean) ?? []);
  const fields = { title, description, requirements, locations, department: Text(detail.department) };
  const fieldIssues: NonNullable<NormalizedJob['fieldIssues']> = {};
  for (const [field, value] of Object.entries({ locations: detail.workPlaceList ?? detail.workPlaceStr ?? row.workPlaceStr, description: detail.workContent, requirements: detail.serviceCondition })) {
    if (field === 'locations' ? locations.length : Boolean(fields[field as 'description' | 'requirements'])) continue;
    fieldIssues[field as 'locations' | 'description' | 'requirements'] = value === undefined ? 'source_missing' : value === null || value === '' || (Array.isArray(value) && !value.length) ? 'source_empty' : 'unmapped_value';
  }
  fieldIssues.updatedAt = 'source_missing';
  const publishedAt = Text(detail.publishDate ?? row.publishDate);
  const endDate = Text(detail.endDate ?? row.endDate);
  // canDelivery 在列表中可能只表示需登录；详情显示投递按钮且截止时间有效才认定可投递。
  const status = detail.showDeliverButton === 0 ? 'closed' : detail.showDeliverButton !== 1 ? 'unknown'
    : detail.longTermRelease === 1 ? 'open' : endDate && Number.isFinite(Date.parse(endDate)) ? Date.parse(endDate) >= Date.parse(at) ? 'open' : 'closed' : 'unknown';
  return { ...fields, id: `hotjob:${probe.tenant}:${id}`, sourceId: source.id, ats: 'hotjob', tenant: probe.tenant, atsJobId: id,
    company: Text(detail.company ?? row.company) ?? source.company, sourceUrl: source.url,
    applicationUrl: new URL(`posDetail.html?postId=${encodeURIComponent(id)}&postType=${probe.recruitType === 1 ? 'campus' : probe.recruitType === 2 ? 'society' : probe.recruitType === 12 ? 'intern' : 'overseas'}`, probe.recruitmentUrl).toString(),
    jobType: probe.recruitType === 1 ? 'campus_recruitment' : probe.recruitType === 12 ? 'intern' : 'social_recruitment',
    education: Text(detail.education ?? row.educationStr), experience: Text(detail.workYears), salary: Text(detail.salary),
    publishedAt: publishedAt && Number.isFinite(Date.parse(publishedAt)) ? publishedAt : undefined,
    fieldIssues, rawHash: createHash('sha256').update(JSON.stringify([fields, status, detail.education, detail.salary])).digest('hex'), firstSeenAt: at, lastSeenAt: at, status };
}

/** 公开 pb 分类站适配；不使用用户会话，列表和逐条详情均受统一来源预算约束。 */
export class HotjobPublicAdapter implements AtsAdapter {
  readonly ats = 'hotjob' as const;
  async probe(source: AtsSource, transport: PublicTransport, signal: AbortSignal): Promise<ProbeResult> {
    let portal = PublicPortal(source.url);
    if (!portal) {
      const page = await transport.Request(source.url, { signal }); CheckResponse(page);
      portal = PortalLink(page.body, page.url);
    }
    if (!portal) throw new AtsError('SOURCE_UNSUPPORTED', 'No public Hotjob recruitment portal was found.');
    if (!/^\/SU[0-9a-f]{24}\/pb\//i.test(portal.pathname)) {
      if (portal.pathname !== '/') throw new AtsError('SOURCE_UNSUPPORTED', 'Legacy wt and mobile templates are not supported by the public pb adapter.');
      const entry = Data(await transport.Request(new URL('/wecruit/common/getSLD', portal).toString(), { method: 'POST', bodyEncoding: 'form', body: { sld: portal.hostname }, signal }));
      portal = PublicPortal(String(AsRecord(entry.linkData).link ?? ''));
      if (!portal) throw new AtsError('SOURCE_UNSUPPORTED', 'Hotjob portal uses an unsupported recruitment template.');
    }
    const match = /^\/SU([0-9a-f]{24})\/pb\/([^/]+)$/i.exec(portal.pathname);
    if (!match) throw new AtsError('SOURCE_UNSUPPORTED', 'Only public Hotjob pb category pages are supported.');
    const recruitType = Categories[match[2] as keyof typeof Categories];
    if (!recruitType) throw new AtsError('SOURCE_MULTIPLE_PORTALS', 'Provide a Hotjob social.html, school.html, interns.html or overseas.html category URL.');
    portal.hash = '';
    return { ats: this.ats, tenant: `${portal.hostname}:${match[1]}`, siteId: `SU${match[1]}`, recruitType, recruitmentUrl: portal.toString(), transport: 'public_api' };
  }
  async collect(source: AtsSource, probe: ProbeResult, transport: PublicTransport, signal: AbortSignal, continuation?: CollectionContinuation): Promise<Pick<SourceResult, 'jobs' | 'quarantine' | 'snapshotStatus' | 'errors' | 'receivedCount' | 'continuation' | 'publicJobCount'>> {
    const endpoint = (name: string) => new URL(`/wecruit/positionInfo/${name}/${probe.siteId}`, probe.recruitmentUrl).toString();
    const list = async (page: number) => {
      const data = Data(await transport.Request(endpoint('listPosition'), { method: 'POST', bodyEncoding: 'form', body: { isFrompb: true, recruitType: probe.recruitType!, pageSize: PageSize, currentPage: page }, signal }));
      const form = AsRecord(data.pageForm);
      if (!Array.isArray(form.pageData) || form.currentPage !== page || form.pageSize !== PageSize || typeof form.dataCount !== 'number' || !Number.isInteger(form.dataCount) || form.dataCount < 0) throw new AtsError('SOURCE_SCHEMA_CHANGED', 'Hotjob public pagination contract changed.');
      return { rows: form.pageData.map(AsRecord), count: form.dataCount };
    };
    const first = await list(1);
    // 浏览量和登录相关按钮不参与快照比较；第一页身份及职位事实变化则从头重读。
    const firstPageHash = createHash('sha256').update(JSON.stringify([first.count, first.rows.map((row) => [row.postId, row.postName, row.publishDate, row.workPlaceStr])])).digest('hex');
    const signature = JSON.stringify([this.ats, probe.tenant, probe.recruitType]);
    const resumed = continuation?.signature === signature && continuation.firstPageHash === firstPageHash && Date.now() - Date.parse(continuation.startedAt) < 30 * 60_000 ? continuation : undefined;
    const jobs = new Map((resumed?.jobs ?? []).map((job) => [job.id, job]));
    const at = new Date().toISOString();
    let pending = structuredClone(resumed?.pendingRows ?? first.rows), nextPage = resumed?.nextPage ?? 2;
    let receivedCount = resumed?.receivedCount ?? first.rows.length, pages = 1;
    const quarantine: SourceResult['quarantine'] = [], errors: SourceResult['errors'] = [];
    let complete = false;
    try {
      while (true) {
        while (pending.length) {
          signal.throwIfAborted();
          const row = pending[0], id = Text(row.postId);
          if (!id) { quarantine.push({ sourceId: source.id, reason: 'Missing Hotjob postId.', raw: row, at }); pending.shift(); continue; }
          const detail = Data(await transport.Request(endpoint('listPositionDetail'), { method: 'POST', bodyEncoding: 'form', body: { postId: id }, signal }));
          signal.throwIfAborted();
          const job = Normalize(source, probe, row, detail, at);
          if (!job || jobs.has(job.id)) quarantine.push({ sourceId: source.id, atsJobId: id, reason: 'Invalid or duplicate Hotjob detail.', raw: { row, detail }, at });
          else jobs.set(job.id, job);
          pending.shift();
        }
        if (receivedCount >= first.count) { complete = receivedCount === first.count && !quarantine.length && jobs.size === first.count; break; }
        if (pages >= (source.maxPages ?? 20)) throw new AtsError('SOURCE_PAGE_LIMIT', 'Reached Hotjob page budget before completeness.');
        const page = await list(nextPage);
        if (page.count !== first.count || !page.rows.length) throw new AtsError('SOURCE_SCHEMA_CHANGED', 'Hotjob count changed or pagination ended early.');
        pending = page.rows; receivedCount += pending.length; nextPage += 1; pages += 1;
      }
    } catch (error) {
      if (!jobs.size) throw error;
      errors.push({ code: error instanceof AtsError ? error.code : signal.aborted ? 'SOURCE_TIMEOUT' : 'SOURCE_NETWORK_ERROR', message: error instanceof Error ? error.message : String(error) });
    }
    const resumable = !complete && !quarantine.length && errors.length && errors.every((error) => ['SOURCE_PAGE_LIMIT', 'SOURCE_REQUEST_LIMIT', 'SOURCE_TIMEOUT', 'SOURCE_NETWORK_ERROR'].includes(error.code));
    return { jobs: [...jobs.values()], quarantine, errors, snapshotStatus: complete ? 'complete' : 'partial', receivedCount, publicJobCount: first.count,
      ...(resumable ? { continuation: { signature, firstPageHash, startedAt: resumed?.startedAt ?? at, nextPage, receivedCount, count: first.count, jobs: [...jobs.values()], pendingRows: pending } } : {}) };
  }
}
