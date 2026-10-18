import { createHash } from 'node:crypto';
import { AtsError, type AtsSource, type CollectionContinuation, type NormalizedJob, type ProbeResult, type PublicTransport, type SourceResult } from './types';

type RawJob = Record<string, unknown>;
type LegacyItem = { id: string; title: string; url: string; raw: RawJob };

/** 只解析已经验证的旧 CMS 表格，不运行页面脚本、不把热招卡片当完整列表。 */
export function LegacyText(html: string): string {
  return html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '').replace(/<br\s*\/?\s*>/gi, '\n').replace(/<[^>]*>/g, ' ')
    .replace(/&#(x[\da-f]+|\d+);/gi, (_, code: string) => { const value = code[0].toLowerCase() === 'x' ? parseInt(code.slice(1), 16) : Number(code); return value > 0 && value <= 0x10ffff ? String.fromCodePoint(value) : ''; })
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#39;/g, "'")
    .replace(/[ \t\r]+/g, ' ').replace(/ *\n */g, '\n').trim();
}

export function ParseLegacyList(html: string, pageUrl: string): { items: LegacyItem[]; lastPage: number; currentPage: number } {
  const clean = html.replace(/<!--[\s\S]*?-->/g, '').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
  const standardTable = clean.match(/<table\b[^>]*class=["'][^"']*\bjobsTable\b[^"']*["'][^>]*>([\s\S]*?)<\/table>/i)?.[1];
  const table = standardTable ?? (/class=["'][^"']*\bpositionlist-newdefault\b/.test(clean)
    ? [...clean.matchAll(/<table\b[^>]*>([\s\S]*?)<\/table>/gi)].map((match) => match[1]).find((value) => /\bjnameT\b/.test(value)) : undefined);
  if (!table || !/职位名称/.test(table)) throw new AtsError('SOURCE_UNSUPPORTED', 'Legacy Beisen public list uses an unsupported custom layout; no complete job table was detected.');
  const base = new URL(pageUrl);
  const currentPage = Number(base.searchParams.get('PageIndex') ?? 1);
  if (!Number.isSafeInteger(currentPage) || currentPage < 1) throw new AtsError('SOURCE_SCHEMA_CHANGED', 'Invalid legacy list page index.');
  const items: LegacyItem[] = [];
  const rows = [...table.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map((match) => match[1]);
  const headers = [...(rows[0] ?? '').matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((match) => LegacyText(match[1]));
  for (const row of rows.slice(1)) {
    const anchor = row.match(/<a\b[^>]*href=["']([^"']*\/zpdetail\/(\d+)[^"']*)["'][^>]*>([\s\S]*?)<\/a>/i);
    if (!anchor) {
      if (/无任何在招职位/.test(LegacyText(row))) continue;
      if (LegacyText(row)) throw new AtsError('SOURCE_SCHEMA_CHANGED', 'Unrecognized legacy job row.');
      continue;
    }
    const url = new URL(anchor[1].replace(/&amp;/g, '&'), base);
    if (url.origin !== base.origin || !/^\/zpdetail\/\d+\/?$/.test(url.pathname)) throw new AtsError('SOURCE_ACCESS_DENIED', 'Legacy detail link must stay on the public recruitment origin.');
    const title = LegacyText(anchor[3]);
    if (!title) throw new AtsError('SOURCE_SCHEMA_CHANGED', 'Legacy job title is empty.');
    const cells = [...row.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map((match) => LegacyText(match[1]));
    const field = (label: string) => cells[headers.findIndex((header) => header.includes(label))];
    items.push({ id: anchor[2], title, url: url.toString(), raw: {
      JobAdId: anchor[2], JobAdName: title, Status: 1, LocNames: field('工作地点')?.split(/[,，]/).filter(Boolean), PostDate: field('发布时间'),
      Category: field('招聘类别'),
    } });
  }
  let lastPage = currentPage;
  for (const match of clean.matchAll(/href\s*=\s*["']([^"']*PageIndex=\d+[^"']*)["']/gi)) {
    const url = new URL(match[1].replace(/&amp;/g, '&'), base);
    if (url.origin !== base.origin || url.pathname.replace(/\/$/, '') !== base.pathname.replace(/\/$/, '')) continue;
    const page = Number(url.searchParams.get('PageIndex'));
    if (Number.isSafeInteger(page) && page > lastPage) lastPage = page;
  }
  return { items, lastPage, currentPage };
}

export function ParseLegacyDetail(html: string, item: LegacyItem): RawJob {
  const clean = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<!--[\s\S]*?-->/g, '');
  if (!/id=["']apply["']/.test(clean) || !/(?:xiangqingtext|class=["']detail["'])/.test(clean)) throw new AtsError('SOURCE_SCHEMA_CHANGED', 'Legacy detail no longer exposes the expected application and description blocks.');
  const raw = { ...item.raw };
  const fields: Record<string, string> = { RecruitCategories: 'Category', Cities: 'LocNames', PostDate: 'PostDate', Salaries: 'Salary', Degree: 'Degree', YearsOfWorking: 'YearsOfWorking' };
  for (const [name, target] of Object.entries(fields)) {
    const pattern = new RegExp(`<(li|td)\\b[^>]*class=["'][^"']*\\btd-Has${name}\\b[^"']*["'][^>]*>[\\s\\S]*?<\\/\\1>\\s*<(?:li|td)\\b[^>]*>([\\s\\S]*?)<\\/(?:li|td)>`, 'i');
    const value = LegacyText(clean.match(pattern)?.[2] ?? '');
    if (value) raw[target] = target === 'LocNames' ? value.split(/[,，]/).filter(Boolean) : value;
  }
  const sections = [...clean.matchAll(/<(p|h4)\b[^>]*>\s*(工作职责|岗位职责|任职资格|任职要求)[:：]?\s*<\/\1>\s*<(p|span)\b[^>]*>([\s\S]*?)<\/\3>/gi)];
  for (const section of sections) raw[/职责/.test(section[2]) ? 'Duty' : 'Require'] = LegacyText(section[4]);
  if (!raw.Duty && !raw.Require) throw new AtsError('SOURCE_SCHEMA_CHANGED', 'Legacy detail responsibilities and requirements could not be mapped.');
  return raw;
}

/** 单来源沿用 30s 信号；任何缺页、详情失败或页数上限都保留 partial，不证明岗位关闭。 */
export async function CollectLegacyBeisen(source: AtsSource, probe: ProbeResult, transport: PublicTransport, signal: AbortSignal,
  normalize: (source: AtsSource, probe: ProbeResult, raw: RawJob, at: string) => NormalizedJob | null,
  continuation?: CollectionContinuation,
): Promise<Pick<SourceResult, 'jobs' | 'quarantine' | 'snapshotStatus' | 'errors' | 'receivedCount' | 'continuation'>> {
  const first = ParseLegacyList(probe.listHtml!, probe.listUrl!);
  const firstPageHash = createHash('sha256').update(JSON.stringify(first)).digest('hex');
  const signature = `${source.id}:legacy:${probe.listUrl}`;
  const resumed = continuation?.signature === signature && continuation.firstPageHash === firstPageHash
    && Date.now() - Date.parse(continuation.startedAt) < 30 * 60_000 ? continuation : undefined;
  const jobs = new Map<string, NormalizedJob>((resumed?.jobs ?? []).map((job) => [job.atsJobId, job]));
  const errors: SourceResult['errors'] = [];
  const quarantine: SourceResult['quarantine'] = [];
  let receivedCount = resumed?.receivedCount ?? 0;
  let snapshotStatus: SourceResult['snapshotStatus'] = 'partial';
  const at = new Date().toISOString();
  const lastPage = first.lastPage;
  let nextPage = resumed?.nextPage ?? 2;
  let pending = structuredClone(resumed?.pendingRows ?? first.items) as LegacyItem[];
  let pages = 1;
  try {
    while (true) {
      signal.throwIfAborted();
      while (pending.length) {
        const item = pending[0];
        if (jobs.has(item.id)) throw new AtsError('SOURCE_SCHEMA_CHANGED', 'Legacy list repeated a job across pages.');
        const detail = await transport.Request(item.url, { signal });
        receivedCount += 1;
        let raw: RawJob;
        try { raw = ParseLegacyDetail(detail.body, item); }
        catch (error) {
          if (!(error instanceof AtsError) || error.code !== 'SOURCE_SCHEMA_CHANGED') throw error;
          // 单条详情结构异常隔离，继续读取其他职位；整个快照仍不能据此认定完整。
          quarantine.push({ sourceId: source.id, atsJobId: item.id, at, reason: error.message,
            raw: { url: item.url, title: item.title, responseTitle: detail.body.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1], bodySample: detail.body.slice(0, 2048) } });
          errors.push({ code: error.code, message: `${item.url}: ${error.message}` });
          pending.shift();
          continue;
        }
        const job = normalize(source, probe, raw, at);
        if (!job) throw new AtsError('SOURCE_SCHEMA_CHANGED', 'Legacy job normalization failed.');
        jobs.set(item.id, { ...job, applicationUrl: item.url });
        pending.shift();
      }
      if (nextPage > lastPage) { snapshotStatus = errors.length || quarantine.length ? 'partial' : 'complete'; break; }
      if (pages >= (source.maxPages ?? 20)) throw new AtsError('SOURCE_PAGE_LIMIT', 'Reached legacy page limit before proving completeness.');
      const url = new URL(probe.listUrl!); url.searchParams.set('PageIndex', String(nextPage));
      const page = ParseLegacyList((await transport.Request(url.toString(), { signal })).body, url.toString());
      if (page.lastPage !== lastPage || !page.items.length) throw new AtsError('SOURCE_SCHEMA_CHANGED', 'Legacy pagination changed during collection.');
      pending = page.items; nextPage++; pages++;
    }
  } catch (error) {
    if (!jobs.size) throw error;
    errors.push({ code: signal.aborted ? 'SOURCE_TIMEOUT' : error instanceof AtsError ? error.code : 'SOURCE_NETWORK_ERROR', message: error instanceof Error ? error.message : String(error) });
  }
  const resumable = snapshotStatus !== 'complete' && !quarantine.length && errors.length
    && errors.every((error) => ['SOURCE_PAGE_LIMIT', 'SOURCE_REQUEST_LIMIT', 'SOURCE_TIMEOUT', 'SOURCE_NETWORK_ERROR'].includes(error.code));
  return { jobs: [...jobs.values()], quarantine, errors, receivedCount, snapshotStatus,
    ...(resumable ? { continuation: { signature, firstPageHash, startedAt: resumed?.startedAt ?? at, nextPage, receivedCount, jobs: [...jobs.values()], pendingRows: pending } } : {}),
  };
}
