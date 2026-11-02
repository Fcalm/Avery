import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { JobCollectionRequest, JobCollectionTask, RecruitmentSource } from '@avery/contracts';
import { CreateSource } from './ats/source-runner';
import { AtsPublicTransport } from './ats/public-transport';
import { AtsError, type PublicTransport } from './ats/types';
import { CheckResponse } from './ats/adapters';
import { JobCityMatches } from '../repositories/job-query';

export const CampusRecruitmentUrl = 'https://campus.sma-wiki.cn/campus/campus_recruit.html?channel=bz';
const BaseUrl = new URL('.', CampusRecruitmentUrl);
const CacheTtl = 15 * 60_000;
// 首批清理范围由业务明确指定；不随公历换年自动扩大，后续再补充已确认失效的规则。
export const CampusExpiredThroughYear = 2026;
const ExpiredReason = `过期届别或批次（${CampusExpiredThroughYear}及以前）`;
const RowSchema = z.object({ company: z.string().trim().min(1).max(500), batch: z.string().max(500).default(''), location: z.string().max(10000).default(''), positions: z.string().max(20000).default(''), appLink: z.string().max(5000).default('') });
const ManifestSchema = z.object({ ver: z.union([z.string(), z.number()]).transform(String), files: z.array(z.string().regex(/^p\d+\.[\w-]+$/)).min(1).max(100), total: z.number().int().nonnegative().max(200000), comm: z.array(RowSchema).max(10000).default([]) });
const FileSchema = z.object({ rows: z.array(RowSchema).max(10000), discardedRows: z.number().int().nonnegative().optional(), etag: z.string().max(500).optional(), lastModified: z.string().max(500).optional() });
const CacheSchema = z.object({ schemaVersion: z.literal(1), checkedAt: z.number(), manifest: ManifestSchema, discardedCommRows: z.number().int().nonnegative().optional(), etag: z.string().max(500).optional(), lastModified: z.string().max(500).optional(), files: z.record(z.string(), FileSchema) });
type Cache = z.infer<typeof CacheSchema>;

/** 只根据明确届别或春招/补招批次清理；发布日期、未标届别、跨新旧届及开放范围均不能据此判旧。 */
export function IsExpiredCampusRecruitment(value: string): boolean {
  const text = value.normalize('NFKC');
  if (/不限届别|不限毕业年份|届\s*(?:及|或)?\s*(?:以后|之后|以上)|届\s*起/.test(text)) return false;
  const years: number[] = [];
  for (const match of text.matchAll(/(?<!\d)((?:20)?\d{2}(?:\s*[/、,，&及和—–~～至到-]\s*(?:20)?\d{2})*)\s*(?:届|年?\s*(?:春招|提前批|补招|补录))/g)) {
    for (const year of match[1].match(/(?:20)?\d{2}/g) ?? []) years.push(year.length === 2 ? 2000 + Number(year) : Number(year));
  }
  return years.length > 0 && years.every((year) => year <= CampusExpiredThroughYear);
}

/** 删除可再下载的公告缓存，保留计数和版本标记，304/重启后不会复活或重复累计。 */
function PruneExpiredAnnouncements(cache: Cache): boolean {
  let changed = false;
  const Remove = (rows: z.infer<typeof RowSchema>[]) => rows.filter((row) => !IsExpiredCampusRecruitment(row.batch));
  const comm = Remove(cache.manifest.comm);
  if (comm.length !== cache.manifest.comm.length) {
    cache.discardedCommRows = (cache.discardedCommRows ?? 0) + cache.manifest.comm.length - comm.length;
    cache.manifest.comm = comm; changed = true;
  }
  for (const file of Object.values(cache.files)) {
    const rows = Remove(file.rows);
    if (rows.length === file.rows.length) continue;
    file.discardedRows = (file.discardedRows ?? 0) + file.rows.length - rows.length;
    file.rows = rows; changed = true;
  }
  return changed;
}

/** 只提取公开 JSON 常量，不执行网页 JS；结构变化必须显式失败，不能将失败缓存为空列表。 */
export function ParseCampusManifest(html: string): Cache['manifest'] {
  const json = html.match(/\bconst\s+META\s*=\s*([\s\S]*?);\s*const\s+COMM_DATA\b/)?.[1];
  if (!json) throw new AtsError('SOURCE_SCHEMA_CHANGED', 'Campus recruitment manifest is missing.');
  try {
    const manifest = ManifestSchema.parse(JSON.parse(json));
    if (new Set(manifest.files).size !== manifest.files.length) throw new Error('Duplicate files');
    return manifest;
  } catch { throw new AtsError('SOURCE_SCHEMA_CHANGED', 'Campus recruitment manifest is invalid.'); }
}

/** 发现阶段只输出受支持的企业入口；公告缓存不是岗位库，也不建立招聘线索表。 */
export class CampusRecruitmentSource {
  constructor(private readonly path: string, private readonly transport: PublicTransport = new AtsPublicTransport()) {}
  private async Persist(cache: Cache): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    try { await writeFile(temporary, JSON.stringify(cache), 'utf8'); await rename(temporary, this.path); }
    finally { await unlink(temporary).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; }); }
  }
  async Discover(request: JobCollectionRequest, signal: AbortSignal): Promise<{ sources: RecruitmentSource[]; discovery: NonNullable<JobCollectionTask['discovery']> }> {
    signal.throwIfAborted();
    let cache: Cache | undefined;
    try { cache = CacheSchema.parse(JSON.parse(await readFile(this.path, 'utf8'))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && !request.refresh) throw new AtsError('STORAGE_ERROR', 'Campus cache is unreadable; refresh or repair the cache before collecting.'); }
    if (cache && PruneExpiredAnnouncements(cache)) { signal.throwIfAborted(); await this.Persist(cache); }
    const complete = cache && cache.manifest.files.every((name) => cache!.files[name]);
    const cacheHit = Boolean(complete && !request.refresh && Date.now() - cache!.checkedAt < CacheTtl);
    if (!cacheHit) {
      const response = await this.transport.Request(CampusRecruitmentUrl, { signal, ifNoneMatch: cache?.etag, ifModifiedSince: cache?.lastModified });
      if (response.status !== 304) {
        CheckResponse(response);
        const manifest = ParseCampusManifest(response.body);
        cache = { schemaVersion: 1, checkedAt: 0, manifest, etag: response.etag, lastModified: response.lastModified,
          files: Object.fromEntries(manifest.files.filter((name) => cache?.files[name]).map((name) => [name, cache!.files[name]])) };
      } else if (!cache) throw new AtsError('SOURCE_SCHEMA_CHANGED', 'Campus source returned 304 without a local cache.');
      const current = cache!;
      PruneExpiredAnnouncements(current);
      // 已完成版本化分片跨查询复用；新版本文件名变化时必须重新下载，不能假称逐条增量。
      for (const name of current.manifest.files) {
        signal.throwIfAborted();
        if (current.files[name] && !request.refresh) continue;
        const old = current.files[name];
        const response = await this.transport.Request(new URL(`data/${name}.json`, BaseUrl).toString(), { signal, ifNoneMatch: old?.etag, ifModifiedSince: old?.lastModified });
        if (response.status === 304) {
          if (!old) throw new AtsError('SOURCE_SCHEMA_CHANGED', 'Campus shard returned 304 without a local copy.');
        } else {
          CheckResponse(response);
          let rows: z.infer<typeof RowSchema>[];
          try { rows = z.array(RowSchema).max(10000).parse(JSON.parse(response.body)); }
          catch { throw new AtsError('SOURCE_SCHEMA_CHANGED', `Campus shard ${name} is invalid.`); }
          current.files[name] = { rows, etag: response.etag, lastModified: response.lastModified };
          PruneExpiredAnnouncements(current);
        }
        // 分片逐个落盘；取消后可续拉尚未下载的分片，但未完整的版本不能提供筛选结果。
        await this.Persist(current);
      }
      current.checkedAt = Date.now(); await this.Persist(current);
    }
    const current = cache!;
    const rows = [...current.manifest.files.flatMap((name) => current.files[name].rows), ...current.manifest.comm];
    const discarded = (current.discardedCommRows ?? 0) + current.manifest.files.reduce((sum, name) => sum + (current.files[name].discardedRows ?? 0), 0);
    const matched = rows.filter((row) => {
      if (request.company && !row.company.toLowerCase().includes(request.company.toLowerCase())) return false;
      if (request.graduationYear && !row.batch.includes(`${String(request.graduationYear).slice(-2)}届`) && !row.batch.includes(`${String(request.graduationYear).slice(-2)}提前批`) && !row.batch.includes(String(request.graduationYear))) return false;
      if (request.batch && !row.batch.includes(request.batch)) return false;
      if (request.city && request.city !== '全国' && row.location && !/全国|各地|多地|多城市/.test(row.location) && !JobCityMatches(row.location, request.city)) return false;
      // 公告摘要缺失或以“等”省略时保留候选，最终由官网岗位条件筛选。
      if (request.keyword && row.positions && !/等|\.\.\.|…/.test(row.positions) && !row.positions.toLowerCase().includes(request.keyword.toLowerCase())) return false;
      return true;
    });
    const sources = new Map<string, RecruitmentSource>(), reasons: Record<string, number> = {};
    let skipped = discarded;
    if (discarded) reasons[ExpiredReason] = discarded;
    const Skip = (reason: string) => { skipped++; reasons[reason] = (reasons[reason] ?? 0) + 1; };
    for (const row of matched) {
      let url: URL;
      try { url = new URL(row.appLink); } catch { Skip('入口缺失或无效'); continue; }
      const host = url.hostname.toLowerCase();
      if (host === 'mp.weixin.qq.com') { Skip('仅微信公众号'); continue; }
      const platform: RecruitmentSource['platform'] | undefined = /(?:^|\.)(?:zhiye\.com|italent\.cn)$/.test(host) ? 'beisen'
        : /(?:^|\.)mokahr\.com$/.test(host) ? 'moka' : /(?:^|\.)hotjob\.cn$/.test(host) ? 'hotjob'
          : /(?:^|\.)(?:jobs\.feishu\.cn|jobs\.larkoffice\.com)$/.test(host) ? 'feishu' : undefined;
      if (!platform) { Skip('暂不支持的招聘入口'); continue; }
      if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) { Skip('入口不符合公开HTTPS要求'); continue; }
      // 去除来源追踪参数；保留ATS的租户、活动与门户标识，不能合并不同招聘门户。
      for (const key of [...url.searchParams.keys()]) if (/^(?:utm_.+|channel|source|from|fromPage|ref)$/i.test(key)) url.searchParams.delete(key);
      url.hash = ''; url.searchParams.sort();
      const source = CreateSource({ company: row.company, url: url.toString(), ats: platform });
      if (!sources.has(source.id)) sources.set(source.id, { sourceId: source.id, companyId: source.companyId, company: source.company, url: source.url, platform, category: 'campus', enabled: true, origin: 'custom' });
    }
    signal.throwIfAborted();
    return { sources: [...sources.values()], discovery: { total: rows.length + discarded, matched: matched.length, sources: sources.size, skipped, cacheHit, fetchedAt: current.checkedAt, url: CampusRecruitmentUrl, reasons } };
  }
}
