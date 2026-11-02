import { createHash } from 'node:crypto';
import { AsRecord, CheckResponse, ParseJson } from './adapters';
import { AtsError, type AtsAdapter, type AtsSource, type CollectionContinuation, type NormalizedJob, type ProbeResult, type PublicTransport, type SourceResult } from './types';

const Text = (value: unknown): string | undefined => typeof value === 'string' && value.trim() ? value.trim() : undefined;
/** 仅解析页面声明的 JSON，不执行远端脚本；路径取自站点元数据，不能从企业名称猜测。 */
export function ParseFeishuWebsite(html: string): { path: string; company?: string } {
  const raw = html.match(/<script\b[^>]*\bid=["']js-websiteInfo["'][^>]*>([\s\S]*?)<\/script>/i)?.[1];
  if (!raw) throw new AtsError('SOURCE_SCHEMA_CHANGED', 'Feishu public website metadata is missing.');
  let root: Record<string, unknown>;
  try { root = AsRecord(JSON.parse(raw)); } catch { throw new AtsError('SOURCE_SCHEMA_CHANGED', 'Feishu website metadata is invalid.'); }
  const path = Text(AsRecord(root.website_info).path);
  if (!path || !/^[\w-]{1,100}$/.test(path)) throw new AtsError('SOURCE_SCHEMA_CHANGED', 'Feishu website path is invalid.');
  return { path, company: Text(AsRecord(root.tenant_info).tenant_name) };
}

export function NormalizeFeishuJob(source: AtsSource, probe: ProbeResult, raw: Record<string, unknown>, at: string): NormalizedJob {
  const id = Text(raw.id), title = Text(raw.title);
  if (!id || !/^\d+$/.test(id) || !title) throw new AtsError('SOURCE_SCHEMA_CHANGED', 'Feishu job ID or title is missing.');
  const info = AsRecord(raw.job_post_info), type = AsRecord(raw.recruit_type ?? info.recruitment_type);
  const labels = [type.name, AsRecord(type.parent).name].map(Text).filter(Boolean).join(' ');
  const locations = (Array.isArray(raw.city_list) ? raw.city_list : []).map((row) => Text(AsRecord(row).name)).filter((name): name is string => Boolean(name));
  const description = Text(raw.description)?.replace(/\\n/g, '\n'), requirements = Text(raw.requirement)?.replace(/\\n/g, '\n');
  const education = Text(AsRecord(info.required_degree).name) ?? Text(info.required_degree);
  const fields = { title, locations, description, requirements, education, department: Text(AsRecord(raw.department_info).name) };
  const fieldIssues: NonNullable<NormalizedJob['fieldIssues']> = {};
  if (!locations.length) fieldIssues.locations = raw.city_list === undefined ? 'source_missing' : 'source_empty';
  if (!description) fieldIssues.description = raw.description === undefined ? 'source_missing' : 'source_empty';
  if (!requirements) fieldIssues.requirements = raw.requirement === undefined ? 'source_missing' : 'source_empty';
  fieldIssues.updatedAt = 'source_missing';
  return { ...fields, id: `feishu:${probe.tenant}:${id}`, sourceId: source.id, ats: 'feishu', tenant: probe.tenant, atsJobId: id,
    company: probe.companyName ?? source.company, sourceUrl: source.url,
    applicationUrl: new URL(`/${probe.feishuPath}/position/${id}/detail`, source.url).toString(),
    jobType: /实习/.test(labels) ? 'intern' : /校招|校园/.test(labels) ? 'campus_recruitment' : /社招|社会/.test(labels) ? 'social_recruitment' : undefined,
    status: raw.channel_online_status === 1 ? 'open' : raw.channel_online_status === 0 ? 'closed' : 'unknown',
    publishedAt: typeof raw.publish_time === 'number' && Number.isFinite(raw.publish_time) && raw.publish_time > 0 ? new Date(raw.publish_time).toISOString() : undefined,
    fieldIssues, rawHash: createHash('sha256').update(JSON.stringify(fields)).digest('hex'), firstSeenAt: at, lastSeenAt: at };
}

/** 仅读取公开列表与详情；遇到站点校验停止，不生成签名、不获取登录 Cookie。 */
export class FeishuPublicAdapter implements AtsAdapter {
  readonly ats = 'feishu' as const;
  async probe(source: AtsSource, transport: PublicTransport, signal: AbortSignal): Promise<ProbeResult> {
    const page = await transport.Request(source.url, { signal }); CheckResponse(page);
    const site = ParseFeishuWebsite(page.body);
    const directJobId = new URL(source.url).pathname.match(/\/(?:position|resume)\/(\d+)(?:\/|$)/)?.[1];
    return { ats: this.ats, tenant: new URL(page.url).hostname, feishuPath: site.path, companyName: site.company, directJobId, transport: 'public_portal_json' };
  }
  async collect(source: AtsSource, probe: ProbeResult, transport: PublicTransport, signal: AbortSignal, continuation?: CollectionContinuation): Promise<Pick<SourceResult, 'jobs' | 'quarantine' | 'snapshotStatus' | 'errors' | 'receivedCount' | 'continuation' | 'publicJobCount' | 'scope'>> {
    const at = new Date().toISOString();
    if (probe.directJobId) {
      const data = ParseJson(await transport.Request(new URL(`/api/v1/job/posts/${probe.directJobId}?portal_type=6`, source.url).toString(), { signal, feishuPath: probe.feishuPath }));
      if (data.code !== 0) throw new AtsError('SOURCE_ACCESS_DENIED', 'Feishu public job detail was rejected.');
      const raw = AsRecord(AsRecord(data.data).job_post_detail);
      if (raw.id !== probe.directJobId) throw new AtsError('SOURCE_SCHEMA_CHANGED', 'Feishu detail identity does not match the requested job.');
      // 单岗位入口不是企业全量，绝不用于关闭其他岗位。
      return { jobs: [NormalizeFeishuJob(source, probe, raw, at)], quarantine: [], snapshotStatus: 'partial', errors: [], receivedCount: 1, scope: 'single_job' };
    }
    const signature = `feishu:${probe.tenant}:${probe.feishuPath}`;
    const read = async (page: number) => {
      const body = { keyword: '', limit: 50, offset: (page - 1) * 50, job_category_id_list: [], tag_id_list: [], location_code_list: [], subject_id_list: [], recruitment_id_list: [], portal_type: 6, job_function_id_list: [], storefront_id_list: [], portal_entrance: 1 };
      const url = new URL('/api/v1/search/job/posts', source.url);
      url.search = new URLSearchParams(Object.entries(body).map(([key, value]) => [key, String(value)])).toString();
      const response = await transport.Request(url.toString(), { signal, method: 'POST', body, feishuPath: probe.feishuPath });
      if (response.status === 405 || /<title[^>]*>字节跳动猎头平台/.test(response.body)) throw new AtsError('SOURCE_BROWSER_REQUIRED', 'Feishu list rejected this HTTP request; enable browser-assisted collection to read the normal recruitment page.');
      const root = ParseJson(response), data = AsRecord(root.data);
      if (root.code !== 0 || !Array.isArray(data.job_post_list) || !Number.isSafeInteger(data.count) || Number(data.count) < 0) throw new AtsError('SOURCE_SCHEMA_CHANGED', 'Feishu public list structure is invalid.');
      return { rows: data.job_post_list, count: Number(data.count) };
    };
    const first = await read(1), firstPageHash = createHash('sha256').update(JSON.stringify(first)).digest('hex');
    const resumed = continuation?.signature === signature && continuation.firstPageHash === firstPageHash && Date.now() - Date.parse(continuation.startedAt) < 30 * 60_000 ? continuation : undefined;
    const jobs = new Map((resumed?.jobs ?? []).map((job) => [job.id, job]));
    const errors: SourceResult['errors'] = [], quarantine: SourceResult['quarantine'] = [];
    let page = resumed?.nextPage ?? 1, receivedCount = resumed?.receivedCount ?? 0, complete = false;
    for (let step = 0; step < (source.maxPages ?? 20); step++, page++) {
      try {
        const result = page === 1 ? first : await read(page);
        if (result.count !== first.count) throw new AtsError('SOURCE_SCHEMA_CHANGED', 'Feishu job count changed during pagination.');
        for (const raw of result.rows) {
          const job = NormalizeFeishuJob(source, probe, AsRecord(raw), at);
          if (jobs.has(job.id)) throw new AtsError('SOURCE_SCHEMA_CHANGED', 'Feishu repeated a job during pagination.');
          jobs.set(job.id, job);
        }
        receivedCount += result.rows.length;
        if (jobs.size >= first.count) { complete = true; break; }
        if (result.rows.length < 50) throw new AtsError('SOURCE_SCHEMA_CHANGED', 'Feishu list ended before its declared count.');
      } catch (error) {
        signal.throwIfAborted();
        errors.push({ code: error instanceof AtsError ? error.code : 'SOURCE_NETWORK_ERROR', message: error instanceof Error ? error.message : String(error) }); break;
      }
    }
    const resumable = !complete && !errors.length;
    if (resumable) errors.push({ code: 'SOURCE_PAGE_LIMIT', message: 'Feishu list segment limit reached.' });
    return { jobs: [...jobs.values()], quarantine, errors, receivedCount, publicJobCount: first.count, snapshotStatus: complete ? 'complete' : 'partial',
      ...(resumable ? { continuation: { signature, startedAt: resumed?.startedAt ?? at, firstPageHash, nextPage: page, receivedCount, count: first.count, jobs: [...jobs.values()] } } : {}) };
  }
}
