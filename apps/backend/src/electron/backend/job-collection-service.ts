import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as Delay } from 'node:timers/promises';
import type {
  BrowserAutomationPort,
  JobCollectionCandidate,
  JobCollectionFilters,
  JobCollectionPort,
  JobCollectionQuery,
} from '@avery/agent-sdk';

const CollectionTtlMs = 15 * 60 * 1000;
const CollectionSweepMs = 60 * 1000;
const MaxCollectionsPerSession = 3;
const MaxResults = 10;

const BossCityCodes: Record<string, string> = {
  全国: '100010000', 北京: '101010100', 上海: '101020100', 天津: '101030100', 重庆: '101040100',
  广州: '101280100', 深圳: '101280600', 佛山: '101280800', 东莞: '101281600', 珠海: '101280700',
  杭州: '101210100', 宁波: '101210400', 南京: '101190100', 苏州: '101190400', 无锡: '101190200',
  成都: '101270100', 武汉: '101200100', 西安: '101110100', 长沙: '101250100', 郑州: '101180100',
  济南: '101120100', 青岛: '101120200', 合肥: '101220100', 福州: '101230100', 厦门: '101230200',
  南昌: '101240100', 昆明: '101290100', 沈阳: '101070100', 大连: '101070200', 长春: '101060100',
  哈尔滨: '101050100', 石家庄: '101090100', 太原: '101100100', 南宁: '101300100', 海口: '101310100',
};

const BossExperienceCodes: Record<string, string> = {
  经验不限: '101', 应届生: '102', '1年以内': '103', '1-3年': '104', '3-5年': '105', '5-10年': '106', '10年以上': '107', 在校生: '108',
};
const BossEducationCodes: Record<string, string> = {
  学历不限: '201', 大专: '202', 本科: '203', 硕士: '204', 博士: '205', 高中: '206', '中专/中技': '208', 初中及以下: '209',
};
const BossCompanySizeCodes: Record<string, string> = {
  '0-20人': '301', '20-99人': '302', '100-499人': '303', '500-999人': '304', '1000-9999人': '305', '10000人以上': '306',
};
const BossJobTypeCodes: Partial<Record<'intern' | 'campus_recruitment' | 'social_recruitment', string>> = {
  intern: '2', social_recruitment: '0',
};

const BossExtractListExpression = `(() => {
  const clean = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
  return [...document.querySelectorAll('.job-card-wrap')].map((wrap) => {
    const box = wrap.querySelector('.job-card-box') || wrap;
    const name = box.querySelector('.job-name');
    const tags = [...box.querySelectorAll('.tag-list li')];
    return {
      title: clean(name?.textContent),
      salary: clean(box.querySelector('.job-salary')?.textContent),
      experience: clean(tags[0]?.textContent),
      education: clean(tags[1]?.textContent),
      company: clean((box.querySelector('.company-name') || box.querySelector('.boss-name'))?.textContent),
      city: clean((box.querySelector('.job-area') || box.querySelector('.company-location'))?.textContent),
      url: box.getAttribute('href') || name?.closest('a')?.getAttribute('href') || wrap.querySelector('a[href*="job_detail"]')?.getAttribute('href') || ''
    };
  }).filter((job) => job.title && job.url);
})()`;

const BossExtractDetailExpression = `(() => {
  const clean = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
  const tags = [...document.querySelectorAll('.info-primary .tag-list span')].map((item) => clean(item.textContent));
  const companyTags = [...document.querySelectorAll('.sider-company .res-industry-item, .company-info-item')].map((item) => clean(item.textContent));
  const companyLinks = [...document.querySelectorAll('.sider-company .company-info a')].map((item) => clean(item.textContent)).filter(Boolean);
  const pageText = String(document.body?.innerText || '');
  const titleCompany = document.title.match(/_(.+?)招聘/);
  return {
    title: clean(document.querySelector('.info-primary .name h1')?.textContent || document.querySelector('.name h1')?.textContent || document.title.split('-')[0]),
    salary: clean(document.querySelector('.info-primary .salary')?.textContent || document.querySelector('.salary')?.textContent),
    experience: tags[0] || '',
    education: tags[1] || '',
    jd: clean(document.querySelector('.job-sec-text')?.textContent),
    company: companyLinks.find((item) => !item.includes('http')) || clean(titleCompany?.[1]),
    companySize: companyTags.find((item) => item.includes('人')) || '',
    industry: companyTags.find((item) => item && !item.includes('人')) || '',
    recruiter: clean((document.querySelector('.boss-info-attr') || document.querySelector('.job-boss-info'))?.querySelector('.name')?.textContent),
    recruitmentType: /实习生|实习岗位|\\b实习\\b/.test(pageText) ? 'intern' : /校招|校园招聘|应届|毕业生|管培生/.test(pageText) ? 'campus_recruitment' : 'social_recruitment',
    url: location.href
  };
})()`;

const BossRiskExpression = `(() => {
  const text = String(document.body?.innerText || '').slice(0, 10000);
  const url = String(location.href || '');
  const title = String(document.title || '');
  const expected = Boolean(document.querySelector('.job-card-wrap, .job-sec-text, .job-detail, .job-primary'));
  if (document.querySelector('.geetest_panel, .captcha, [class*="captcha"], [id*="captcha"], iframe[src*="captcha"], iframe[src*="verify"]')) return { risk: 'verification' };
  if (/captcha|security-check|\\/verify/i.test(url)) return { risk: 'verification' };
  if (/\\/web\\/user\\/(?:login|\\?ka=header-login)/i.test(url)) return { risk: 'login_required' };
  if (!expected && /访问过于频繁|操作过于频繁|请求过于频繁|访问频率过高/.test(text)) return { risk: 'rate_limit' };
  if (!expected && (/请完成安全验证|检测到异常访问|当前访问存在风险|账号(?:存在)?异常|账号访问受限/.test(text) || /403|forbidden|access denied/i.test(title))) return { risk: 'verification' };
  return { risk: null };
})()`;

type TrustedBrowser = BrowserAutomationPort & {
  EvaluateTrustedPage(input: { site: 'boss_zhipin'; expression: string; signal?: AbortSignal; deadline?: number }): Promise<unknown>;
};

type RawBossJob = {
  title?: unknown;
  salary?: unknown;
  experience?: unknown;
  education?: unknown;
  company?: unknown;
  city?: unknown;
  url?: unknown;
};

type RawBossDetail = RawBossJob & {
  jd?: unknown;
  companySize?: unknown;
  industry?: unknown;
  recruiter?: unknown;
  recruitmentType?: unknown;
};

type CachedCandidate = JobCollectionCandidate & {
  companySize: string;
  industry: string;
  recruiter: string;
  collectedAt: string;
};

type CachedCollection = {
  collectionId: string;
  createdAt: number;
  expiresAt: number;
  candidates: CachedCandidate[];
  savedCandidateIds: Set<string>;
};

export class JobCollectionError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'JobCollectionError';
    this.code = code;
  }
}

function Text(value: unknown, maxLength = 200_000): string {
  return String(value ?? '').trim().slice(0, maxLength);
}

function DecodeBossText(value: unknown, maxLength = 200_000): string {
  return Text(value, maxLength).replace(/[\uE031-\uE03A]/g, (character) => String(character.codePointAt(0)! - 0xE031));
}

function NormalizeUrl(value: unknown): string | null {
  try {
    const url = new URL(String(value ?? ''), 'https://www.zhipin.com');
    if (url.protocol !== 'https:' || !(url.hostname === 'zhipin.com' || url.hostname.endsWith('.zhipin.com'))) return null;
    url.hash = '';
    return url.toString();
  } catch { return null; }
}

function SourceJobId(url: string): string {
  return url.match(/\/job_detail\/([^.\/?#]+)/)?.[1]
    ?? createHash('sha256').update(url).digest('hex').slice(0, 20);
}

function Remaining(deadline?: number): number {
  if (!Number.isFinite(deadline)) return 120_000;
  return Math.max(0, (deadline as number) - Date.now());
}

function AssertActive(signal?: AbortSignal, deadline?: number): void {
  if (signal?.aborted) throw new JobCollectionError('CANCELLED', 'Job collection was cancelled.');
  if (Remaining(deadline) <= 0) throw new JobCollectionError('TIMEOUT', 'Job collection timed out.');
}

function SalaryMinimum(value: string): number | null {
  const match = value.toUpperCase().match(/(\d+(?:\.\d+)?)\s*K(?:\s*[-–—~至]\s*(\d+(?:\.\d+)?)\s*K)?/);
  return match ? Number(match[1]) : null;
}

function MatchesFilter(candidate: CachedCandidate, filters: JobCollectionFilters): boolean {
  const searchable = `${candidate.title}\n${candidate.company}\n${candidate.jd}`.toLocaleLowerCase();
  if (filters.excludeKeywords?.some((keyword) => searchable.includes(keyword.toLocaleLowerCase()))) return false;
  if (filters.jobTypes?.length && !filters.jobTypes.includes(candidate.jobType)) return false;
  if (filters.experience?.length && !filters.experience.some((value) => candidate.experience.includes(value))) return false;
  if (filters.education?.length && !filters.education.some((value) => candidate.education.includes(value))) return false;
  if (filters.companySizes?.length && !filters.companySizes.some((value) => candidate.companySize.includes(value))) return false;
  if (filters.industries?.length && !filters.industries.some((value) => candidate.industry.includes(value))) return false;
  const minimum = SalaryMinimum(candidate.salary);
  if (typeof filters.salaryMinMonthlyK === 'number' && (minimum === null || minimum < filters.salaryMinMonthlyK)) return false;
  return true;
}

function AppendMapped(search: URLSearchParams, name: string, values: string[] | undefined, mapping: Record<string, string>): void {
  const encoded = (values ?? []).flatMap((value) => mapping[value] ? [mapping[value]] : []);
  if (encoded.length) search.set(name, [...new Set(encoded)].join(','));
}

function BuildBossSearchUrl(query: JobCollectionQuery, filters: JobCollectionFilters, sort: 'relevance' | 'newest'): string {
  const cityCode = BossCityCodes[query.city.trim()];
  if (!cityCode) throw new JobCollectionError('JOB_COLLECTION_CITY_UNSUPPORTED', `BOSS city is unsupported: ${query.city}`);
  const url = new URL('https://www.zhipin.com/web/geek/job');
  url.searchParams.set('query', query.keyword.trim());
  url.searchParams.set('city', cityCode);
  AppendMapped(url.searchParams, 'jobType', filters.jobTypes, BossJobTypeCodes as Record<string, string>);
  AppendMapped(url.searchParams, 'experience', filters.experience, BossExperienceCodes);
  AppendMapped(url.searchParams, 'degree', filters.education, BossEducationCodes);
  AppendMapped(url.searchParams, 'scale', filters.companySizes, BossCompanySizeCodes);
  if (sort === 'newest') url.searchParams.set('sortType', '2');
  return url.toString();
}

async function Navigate(browser: TrustedBrowser, url: string, signal?: AbortSignal, deadline?: number): Promise<void> {
  AssertActive(signal, deadline);
  const proposal = await browser.Prepare({ toolName: 'BrowserNavigate', arguments: { url } });
  const result = await browser.Execute({ proposal, signal, deadline });
  if (result.status !== 'succeeded') throw new JobCollectionError('BROWSER_STATUS_UNKNOWN', 'BOSS page navigation outcome is unknown.');
}

async function Evaluate<T>(browser: TrustedBrowser, expression: string, signal?: AbortSignal, deadline?: number): Promise<T> {
  AssertActive(signal, deadline);
  return await browser.EvaluateTrustedPage({ site: 'boss_zhipin', expression, signal, deadline }) as T;
}

async function AssertBossPage(browser: TrustedBrowser, signal?: AbortSignal, deadline?: number): Promise<void> {
  const result = await Evaluate<{ risk?: unknown }>(browser, BossRiskExpression, signal, deadline);
  if (result?.risk === 'login_required') throw new JobCollectionError('BOSS_LOGIN_REQUIRED', 'BOSS login is required before collecting jobs.');
  if (result?.risk) throw new JobCollectionError('BOSS_SITE_RISK_DETECTED', `BOSS collection stopped because the page reported ${String(result.risk)}.`);
}

async function ExtractBossList(browser: TrustedBrowser, signal?: AbortSignal, deadline?: number): Promise<RawBossJob[]> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await AssertBossPage(browser, signal, deadline);
    const value = await Evaluate<unknown>(browser, BossExtractListExpression, signal, deadline);
    if (Array.isArray(value) && value.length) return value as RawBossJob[];
    if (attempt < 4) await Delay(Math.min(500, Remaining(deadline)), undefined, signal ? { signal } : undefined);
  }
  return [];
}

type PlatformCollector = {
  platform: JobCollectionCandidate['platform'];
  BuildSearchUrl(query: JobCollectionQuery, filters: JobCollectionFilters, sort: 'relevance' | 'newest'): string;
  ExtractList(browser: TrustedBrowser, signal?: AbortSignal, deadline?: number): Promise<RawBossJob[]>;
  ExtractDetail(browser: TrustedBrowser, signal?: AbortSignal, deadline?: number): Promise<RawBossDetail>;
};

const BossCollector: PlatformCollector = {
  platform: 'boss_zhipin',
  BuildSearchUrl: BuildBossSearchUrl,
  ExtractList: ExtractBossList,
  ExtractDetail: (browser, signal, deadline) => Evaluate<RawBossDetail>(browser, BossExtractDetailExpression, signal, deadline),
};

/** 多平台采集编排的第一版实现；注册表已独立，当前只登记 BOSS Collector。 */
export class JobCollectionService implements JobCollectionPort {
  private readonly browser: TrustedBrowser;
  private readonly loadViewModel: () => Promise<any>;
  private readonly saveJob: (input: Record<string, unknown>) => Promise<any>;
  private readonly now: () => number;
  private readonly collectorRegistry = new Map<string, PlatformCollector>([[BossCollector.platform, BossCollector]]);
  private readonly collections = new Map<string, Map<string, CachedCollection>>();
  private readonly sweepTimer: ReturnType<typeof setInterval>;

  constructor(input: {
    browser: BrowserAutomationPort;
    loadViewModel: () => Promise<any> | any;
    saveJob: (input: Record<string, unknown>) => Promise<any> | any;
    now?: () => number;
  }) {
    if (typeof input.browser.EvaluateTrustedPage !== 'function') {
      throw new Error('The browser runtime does not provide trusted page extraction.');
    }
    this.browser = input.browser as TrustedBrowser;
    this.loadViewModel = async () => await input.loadViewModel();
    this.saveJob = async (value) => await input.saveJob(value);
    this.now = input.now ?? Date.now;
    this.sweepTimer = setInterval(() => this.SweepExpired(), CollectionSweepMs);
    this.sweepTimer.unref?.();
  }

  private SweepExpired(): void {
    const now = this.now();
    for (const [sessionId, sessionCollections] of this.collections) {
      for (const [collectionId, collection] of sessionCollections) {
        if (collection.expiresAt <= now) sessionCollections.delete(collectionId);
      }
      if (!sessionCollections.size) this.collections.delete(sessionId);
    }
  }

  private Store(sessionId: string, candidates: CachedCandidate[]): string {
    this.SweepExpired();
    const collectionId = `collection-${randomUUID()}`;
    const sessionCollections = this.collections.get(sessionId) ?? new Map<string, CachedCollection>();
    while (sessionCollections.size >= MaxCollectionsPerSession) {
      const oldest = [...sessionCollections.values()].sort((left, right) => left.createdAt - right.createdAt)[0];
      if (!oldest) break;
      sessionCollections.delete(oldest.collectionId);
    }
    const createdAt = this.now();
    sessionCollections.set(collectionId, {
      collectionId, createdAt, expiresAt: createdAt + CollectionTtlMs, candidates, savedCandidateIds: new Set(),
    });
    this.collections.set(sessionId, sessionCollections);
    return collectionId;
  }

  async Collect(input: Parameters<JobCollectionPort['Collect']>[0]): ReturnType<JobCollectionPort['Collect']> {
    AssertActive(input.signal, input.deadline);
    const collector = input.platforms.length === 1 ? this.collectorRegistry.get(input.platforms[0]) : undefined;
    if (!collector) throw new JobCollectionError('JOB_COLLECTION_PLATFORM_UNSUPPORTED', 'The requested job platform is not supported.');
    const limit = Math.min(MaxResults, input.maxResults);
    const filters = input.filters ?? {};
    const candidates: CachedCandidate[] = [];
    const seenSourceIds = new Set<string>();
    let duplicates = 0;
    let filtered = 0;
    let discovered = 0;
    let truncated = false;

    for (const [queryIndex, query] of input.queries.entries()) {
      AssertActive(input.signal, input.deadline);
      await Navigate(this.browser, collector.BuildSearchUrl(query, filters, input.sort), input.signal, input.deadline);
      const list = await collector.ExtractList(this.browser, input.signal, input.deadline);
      for (const [listIndex, raw] of list.entries()) {
        AssertActive(input.signal, input.deadline);
        const url = NormalizeUrl(raw.url);
        if (!url) { filtered += 1; continue; }
        const sourceJobId = SourceJobId(url);
        if (seenSourceIds.has(sourceJobId)) { duplicates += 1; continue; }
        seenSourceIds.add(sourceJobId);
        discovered += 1;
        await Navigate(this.browser, url, input.signal, input.deadline);
        await AssertBossPage(this.browser, input.signal, input.deadline);
        const detail = await collector.ExtractDetail(this.browser, input.signal, input.deadline);
        const detailUrl = NormalizeUrl(detail?.url) ?? url;
        const title = DecodeBossText(detail?.title || raw.title, 300);
        const company = DecodeBossText(detail?.company || raw.company, 200);
        const jd = DecodeBossText(detail?.jd, 200_000);
        if (!title || !company || !jd) { filtered += 1; continue; }
        const collected: CachedCandidate = {
          candidateId: `candidate-${candidates.length + 1}`,
          platform: collector.platform, sourceJobId, title, company,
          city: DecodeBossText(raw.city || query.city, 100),
          salary: DecodeBossText(detail?.salary || raw.salary, 100),
          experience: DecodeBossText(detail?.experience || raw.experience, 100),
          education: DecodeBossText(detail?.education || raw.education, 100),
          jobType: detail?.recruitmentType === 'intern' || detail?.recruitmentType === 'campus_recruitment'
            ? detail.recruitmentType as 'intern' | 'campus_recruitment' : 'social_recruitment',
          jd, url: detailUrl, alreadySaved: false, contactStatus: 'not_contacted',
          companySize: DecodeBossText(detail?.companySize, 100),
          industry: DecodeBossText(detail?.industry, 200),
          recruiter: DecodeBossText(detail?.recruiter, 200),
          collectedAt: new Date(this.now()).toISOString(),
        };
        if (!MatchesFilter(collected, filters)) { filtered += 1; continue; }
        candidates.push(collected);
        if (candidates.length >= limit) {
          truncated = listIndex < list.length - 1 || queryIndex < input.queries.length - 1;
          break;
        }
      }
      if (candidates.length >= limit) break;
    }

    const view = await this.loadViewModel();
    const jobs = Array.isArray(view?.jobs) ? view.jobs : [];
    const applications = Array.isArray(view?.applications) ? view.applications : [];
    const existingById = new Map(jobs.map((job: any) => [String(job.id), job]));
    const existingByUrl = new Map<string, any>(jobs.flatMap((job: any) => {
      const url = NormalizeUrl(job.url);
      return url ? [[url, job] as [string, any]] : [];
    }));
    const publicCandidates = candidates.map((candidate) => {
      const jobId = `job-boss-${candidate.sourceJobId}`;
      const existing = existingById.get(jobId) ?? existingByUrl.get(candidate.url);
      const application = existing ? applications.find((item: any) => item.jobId === existing.id && item.status !== 'saved') : undefined;
      candidate.alreadySaved = Boolean(existing);
      candidate.contactStatus = application?.status ?? 'not_contacted';
      return candidate;
    });
    const collectionId = this.Store(input.sessionId, publicCandidates);
    return {
      status: publicCandidates.length >= limit ? 'completed' : 'completed_with_shortage',
      collectionId,
      candidates: publicCandidates.map(({ companySize: _size, industry: _industry, recruiter: _recruiter, collectedAt: _collectedAt, ...candidate }) => candidate),
      counts: { collected: publicCandidates.length, duplicates, filtered },
      truncated,
      warnings: discovered === 0 ? ['BOSS returned no readable job cards for the requested search.'] : [],
    };
  }

  async SaveCandidate(input: Parameters<JobCollectionPort['SaveCandidate']>[0]): ReturnType<JobCollectionPort['SaveCandidate']> {
    this.SweepExpired();
    const sessionCollections = this.collections.get(input.sessionId);
    const collection = sessionCollections?.get(input.collectionId);
    if (!collection || collection.expiresAt <= this.now()) {
      sessionCollections?.delete(input.collectionId);
      throw new JobCollectionError('JOB_COLLECTION_EXPIRED', 'The collected job data has expired. Call CollectJobs again.');
    }
    const candidate = collection.candidates.find((item) => item.candidateId === input.candidateId);
    if (!candidate) throw new JobCollectionError('JOB_COLLECTION_CANDIDATE_NOT_FOUND', 'The candidate does not exist in this job collection.');
    const jobId = `job-boss-${candidate.sourceJobId}`;
    const saved = await this.saveJob({
      jobId, company: candidate.company, title: candidate.title, city: candidate.city, salary: candidate.salary,
      experience: candidate.experience, jobSeekingType: candidate.jobType, channel: 'boss_zhipin', favorite: false,
      url: candidate.url, jd: candidate.jd, ...(input.matchScore === undefined ? {} : { matchScore: input.matchScore }),
      sourceJobId: candidate.sourceJobId, education: candidate.education, collectedAt: candidate.collectedAt,
    });
    collection.savedCandidateIds.add(candidate.candidateId);
    if (collection.savedCandidateIds.size === collection.candidates.length) {
      sessionCollections?.delete(collection.collectionId);
      if (sessionCollections && !sessionCollections.size) this.collections.delete(input.sessionId);
    }
    return { jobId: String(saved?.jobId ?? jobId), jobRevision: Number(saved?.jobRevision ?? 0) };
  }

  DeleteSession(sessionId: string): void {
    this.collections.delete(sessionId);
  }

  Close(): void {
    clearInterval(this.sweepTimer);
    this.collections.clear();
  }
}
