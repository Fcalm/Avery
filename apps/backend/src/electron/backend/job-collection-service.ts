import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as Delay } from 'node:timers/promises';
import { AtsFactStore, AtsSourceRunner, CreateSource } from './ats/source-runner';
import { AtsCandidateMatcher } from './ats/candidate-matcher';
import type { NormalizedJob } from './ats/types';
import type { CollectedJob, JobCollectionRequest } from '@avery/contracts';
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
const CollectionEducationLabels: Record<JobCollectionRequest['educations'][number], string> = {
  college: '大专', bachelor: '本科', master: '硕士', doctor: '博士',
};

// 只识别当前岗位自身的明确类型/实习安排；“有实习经验”等经历要求不代表实习岗位。
const BossReadJobTypeExpression = `const readJobType = (text, jd = '') => {
  if (/实习|\\bintern(?:ship)?\\b/i.test(text)) return 'intern';
  if (/校招|校园招聘/.test(text)) return 'campus_recruitment';
  if (/社招|社会招聘/.test(text)) return 'social_recruitment';
  if (/(?:本?岗位|本?职位)(?:为|是|性质[:：]?|类型[:：]?)[^。;；\\n]{0,8}实习|(?:^|[。;；\\n])\\s*(?:招聘|招募|招收)[^。;；\\n]{0,15}实习生|实习(?:时间|时长|周期|期限|期)(?:[:：]|[^。;；\\n]{0,20}(?:至少|不少于|不低于|[一二三四五六七八九\\d]+(?:个)?月))/.test(jd)) return 'intern';
  return undefined;
};`;

// 仅接受完整人数/人数区间，避免把“人工智能”等行业名称误作公司规模。
const BossReadCompanySizeExpression = `const readCompanySize = (value) => {
  const text = String(value || '').replace(/\\s+/g, ' ').trim().replace(/^(?:公司|企业)?规模\\s*[:：]\\s*/, '');
  return /^(?:少于|小于)?\\d+(?:[,，]\\d{3})*(?:\\s*[-–—~～至]\\s*\\d+(?:[,，]\\d{3})*)?\\s*\\+?人(?:及以上|以上|以下|以内)?$/.test(text) ? text : '';
};`;

const BossExtractListExpression = `(() => {
  const clean = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
  ${BossReadJobTypeExpression}
  ${BossReadCompanySizeExpression}
  return [...document.querySelectorAll('.job-card-wrap')].map((wrap) => {
    const box = wrap.querySelector('.job-card-box') || wrap;
    const name = box.querySelector('.job-name');
    const tags = [...box.querySelectorAll('.tag-list li')].map((item) => clean(item.textContent));
    return {
      title: clean(name?.textContent),
      salary: clean(box.querySelector('.job-salary')?.textContent),
      experience: tags[0] || '',
      education: tags.find((text) => /^(?:高中|中专|大专|专科|本科|硕士|研究生|博士)(?:及以上|以上)?$/.test(text)) || '',
      explicitRecruitmentType: readJobType([clean(name?.textContent), ...tags].join(' ')),
      company: clean((box.querySelector('.company-name') || box.querySelector('.boss-name'))?.textContent),
      companySize: [...box.querySelectorAll('.company-tag-list em, .company-info .tag-list li')].map((item) => readCompanySize(item.textContent)).find(Boolean) || '',
      city: clean((box.querySelector('.job-area') || box.querySelector('.company-location'))?.textContent),
      url: box.getAttribute('href') || name?.closest('a')?.getAttribute('href') || wrap.querySelector('a[href*="job_detail"]')?.getAttribute('href') || ''
    };
  }).filter((job) => job.title && job.url);
})()`;

const BossExtractDetailExpression = `(() => {
  const clean = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
  ${BossReadJobTypeExpression}
  ${BossReadCompanySizeExpression}
  const tags = [...document.querySelectorAll('.info-primary .tag-list span, .job-primary .tag-list span, .job-primary .job-limit p, .job-detail-header .tag-list li')].map((item) => clean(item.textContent));
  const companyTags = [...document.querySelectorAll('.sider-company p, .sider-company .res-industry-item, .sider-company .company-info-item, .job-sider .company-info-item')].map((item) => clean(item.textContent));
  const companyLinks = [...document.querySelectorAll('.sider-company .company-info a')].map((item) => clean(item.textContent)).filter(Boolean);
  const pageText = String(document.body?.innerText || '');
  const titleCompany = document.title.match(/_(.+?)招聘/);
  const title = clean(document.querySelector('.info-primary .name h1')?.textContent || document.querySelector('.name h1')?.textContent || document.querySelector('.job-detail-header .job-name')?.textContent || document.title.split('-')[0]);
  const jdElement = document.querySelector('.job-sec-text') || document.querySelector('.job-detail-body .desc');
  // innerText保留浏览器渲染的段落、br和列表换行；正文不使用单行字段的空白压缩规则。
  const jd = String(jdElement?.innerText || jdElement?.textContent || '').replace(/\\r\\n?/g, '\\n').replace(/\\u00a0/g, ' ').replace(/[ \\t]+\\n/g, '\\n').trim();
  // 标题/主标签优先，JD只读取当前职位描述中的明确实习安排，不扫描推荐岗位。
  const typeText = [title, ...tags].join(' ');
  return {
    title,
    salary: clean(document.querySelector('.info-primary .salary')?.textContent || document.querySelector('.salary')?.textContent || document.querySelector('.job-detail-header .job-salary')?.textContent),
    experience: tags[0] || '',
    education: tags.find((text) => /^(?:高中|中专|大专|专科|本科|硕士|研究生|博士)(?:及以上|以上)?$/.test(text)) || '',
    jd,
    company: companyLinks.find((item) => !item.includes('http')) || clean(titleCompany?.[1]),
    companySize: companyTags.map(readCompanySize).find(Boolean) || '',
    industry: companyTags.find((item) => item && !readCompanySize(item)) || '',
    recruiter: clean((document.querySelector('.boss-info-attr') || document.querySelector('.job-boss-info'))?.querySelector('.name')?.textContent),
    recruitmentType: /实习生|实习岗位|\\b实习\\b/.test(pageText) ? 'intern' : /校招|校园招聘|应届|毕业生|管培生/.test(pageText) ? 'campus_recruitment' : 'social_recruitment',
    explicitRecruitmentType: readJobType(typeText, jd),
    url: location.href
  };
})()`;

/** BOSS 新列表使用滚动加载；仅读取已挂载列表组件的公开加载状态，不调用站点方法/API。 */
const BossListContinuationExpression = `(() => {
  const list = document.querySelector('.job-list-container .rec-job-list');
  for (let element = list, depth = 0; element && depth < 10; element = element.parentElement, depth++) {
    for (let view = element.__vue__, level = 0; view && level < 10; view = view.$parent, level++) {
      if (view.$options?.name === 'PageJobs' && typeof view.hasMore === 'boolean') {
        return { infinite: true, hasMore: view.hasMore, loading: view.moreLoading === true };
      }
    }
  }
  const roots = [...document.querySelectorAll('.options-pages, .pagination, .page-list, .job-list-pager')];
  const enabled = (item) => !item.disabled && item.getAttribute('aria-disabled') !== 'true'
    && !item.classList.contains('disabled') && !item.classList.contains('is-disabled');
  return { infinite: Boolean(list), hasNext: roots.some((root) => [...root.querySelectorAll('a, button')].some((item) => enabled(item)
    && (item.matches('.next, .btn-next, [aria-label="下一页"], [title="下一页"]') || /^\\d+$/.test(String(item.textContent || '').trim())
      && Number(item.textContent) > Number(root.querySelector('.selected, .active, .cur')?.textContent || 1)))) };
})()`;

// 仅读取当前登录页面提供的筛选选项和已加载列表，不调用组件方法或修改站点状态。
const BossNativeFiltersExpression = `(() => {
  const filter = document.querySelector('.c-filter-condition')?.__vue__;
  for (let page = filter, depth = 0; page && depth < 10; page = page.$parent, depth++) {
    if (page.$options?.name !== 'PageJobs') continue;
    return {
      url: location.href,
      ready: page.loading === false && page.moreLoading === false && page.isSearch === true,
      query: String(page.formData?.query || ''), city: String(page.formData?.city || ''),
      jobType: String(page.formData?.jobType || ''), selectedJobType: String(filter.formData?.jobType || ''),
      jobTypes: (Array.isArray(filter.jobTypeList) ? filter.jobTypeList : []).map((item) => ({
        code: String(item.code), name: String(item.name || '').trim()
      })).filter((item) => /^\\d{1,10}$/.test(item.code)),
      jobIds: (Array.isArray(page.jobList) ? page.jobList : []).map((job) => String(job.encryptJobId || '')).filter(Boolean)
    };
  }
  return null;
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
  companySize?: unknown;
  city?: unknown;
  url?: unknown;
  explicitRecruitmentType?: unknown;
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
  if (filters.jobTypes?.length && (!candidate.jobType || !filters.jobTypes.includes(candidate.jobType))) return false;
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
  // 旧候选协议保留关键词检索；岗位库路径另从登录页面读取实习编码，不把全职冒充社招。
  const internOnly = filters.jobTypes?.length === 1 && filters.jobTypes[0] === 'intern';
  url.searchParams.set('query', internOnly && !/实习|\bintern(?:ship)?\b/i.test(query.keyword) ? `${query.keyword.trim()} 实习` : query.keyword.trim());
  url.searchParams.set('city', cityCode);
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

type BossNativeFilters = {
  url: string; ready: boolean; query: string; city: string; jobType: string; selectedJobType: string;
  jobTypes: Array<{ code: string; name: string }>; jobIds: string[];
};

/** URL本身不是筛选成功证据；必须同时等待站点组件完成搜索并确认当前选择。 */
async function WaitBossNativeFilters(browser: TrustedBrowser, signal: AbortSignal, deadline: number, expected?: URL): Promise<BossNativeFilters> {
  const until = Math.min(deadline, Date.now() + 5000);
  do {
    await AssertBossPage(browser, signal, deadline);
    const state = await Evaluate<BossNativeFilters | null>(browser, BossNativeFiltersExpression, signal, deadline);
    if (state?.ready && state.jobTypes.length) {
      if (!expected) return state;
      const current = new URL(state.url);
      const type = expected.searchParams.get('jobType');
      if (current.pathname === '/web/geek/jobs' || current.pathname === '/web/geek/job') {
        if (['query', 'city', 'degree', 'jobType'].every((key) => current.searchParams.get(key) === expected.searchParams.get(key))
          && state.query === expected.searchParams.get('query') && state.city === expected.searchParams.get('city')
          && state.jobType === type && state.selectedJobType === type
          && state.jobTypes.some((option) => option.code === type && option.name === '实习')) return state;
      }
    }
    await Delay(Math.min(250, Math.max(0, until - Date.now())), undefined, { signal });
  } while (Date.now() < until);
  AssertActive(signal, deadline);
  throw new JobCollectionError('BOSS_FILTER_UNVERIFIED', 'BOSS 原生实习筛选未能确认生效，已停止采集；请检查登录状态和页面筛选。');
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

/** 页面批量采集复用固定 BOSS 提取器，不经过候选缓存，也不调用沟通或发送动作。 */
export async function CollectBossJobsToLibrary(browserPort: BrowserAutomationPort, input: {
  keyword: string; city: string; signal: AbortSignal; deadline: number;
  jobSeekingTypes?: JobCollectionRequest['jobSeekingTypes']; educations?: JobCollectionRequest['educations'];
  accept(job: CollectedJob): Promise<boolean>;
}): Promise<void> {
  if (!browserPort.EvaluateTrustedPage) throw new JobCollectionError('BOSS_BROWSER_UNAVAILABLE', '浏览器不支持 BOSS 只读提取。');
  const browser = browserPort as TrustedBrowser;
  const seen = new Set<string>(), pages = new Set<string>();
  const search = new URL(BuildBossSearchUrl({ keyword: input.keyword, city: input.city }, {
    education: input.educations?.map((value) => CollectionEducationLabels[value]),
  }, 'relevance'));
  const Act = async (toolName: 'BrowserGoBack' | 'BrowserSnapshot' | 'BrowserClick' | 'BrowserPressKey', args: Record<string, unknown> = {}) => {
    AssertActive(input.signal, input.deadline);
    const proposal = await browser.Prepare({ toolName, arguments: args });
    if (proposal.forceConfirmation) throw new JobCollectionError('BOSS_COLLECTION_ACTION_DENIED', '采集不能执行需要发送或提交授权的动作。');
    const result = await browser.Execute({ proposal, signal: input.signal, deadline: input.deadline });
    if (result.status !== 'succeeded') throw new JobCollectionError('BROWSER_STATUS_UNKNOWN', 'BOSS 分页结果未知，已停止采集。');
    return result.data;
  };
  await Navigate(browser, search.toString(), input.signal, input.deadline);
  const internOnly = input.jobSeekingTypes?.length === 1 && input.jobSeekingTypes[0] === 'intern';
  if (internOnly) {
    const state = await WaitBossNativeFilters(browser, input.signal, input.deadline);
    const option = state.jobTypes.find((item) => item.name === '实习');
    if (!option) throw new JobCollectionError('BOSS_FILTER_UNAVAILABLE', '当前 BOSS 页面没有提供“实习”筛选选项，未使用其他求职类型替代。');
    search.searchParams.set('jobType', option.code);
    await Navigate(browser, search.toString(), input.signal, input.deadline);
  }
  for (let page = 1; ; page++) {
    AssertActive(input.signal, input.deadline);
    const native = internOnly ? await WaitBossNativeFilters(browser, input.signal, input.deadline, search) : undefined;
    const nativeIds = native ? new Set(native.jobIds) : undefined;
    const extracted = await ExtractBossList(browser, input.signal, input.deadline);
    // 不将推荐区或其他列表的卡片当成当前筛选结果。
    const list = nativeIds ? extracted.filter((raw) => { const url = NormalizeUrl(raw.url); return url && nativeIds.has(SourceJobId(url)); }) : extracted;
    if (nativeIds && extracted.length && !list.length) throw new JobCollectionError('BOSS_FILTER_RESULTS_UNVERIFIED', 'BOSS 岗位卡片与已筛选列表的身份不一致，已停止采集。');
    if (!list.length) return;
    const fingerprint = list.map((item) => SourceJobId(NormalizeUrl(item.url) ?? '')).join('\n');
    if (pages.has(fingerprint)) throw new JobCollectionError('BOSS_PAGINATION_STALLED', 'BOSS 返回重复列表页，已停止采集；已入库岗位保留。');
    pages.add(fingerprint);
    for (const raw of list) {
      const url = NormalizeUrl(raw.url);
      if (!url) continue;
      const originalJobId = SourceJobId(url);
      if (seen.has(originalJobId)) continue;
      seen.add(originalJobId);
      await Navigate(browser, url, input.signal, input.deadline);
      await AssertBossPage(browser, input.signal, input.deadline);
      const detail = await BossCollector.ExtractDetail(browser, input.signal, input.deadline);
      const title = DecodeBossText(detail?.title || raw.title, 300);
      const company = DecodeBossText(detail?.company || raw.company, 200);
      const jd = DecodeBossText(detail?.jd);
      const jobType = detail?.explicitRecruitmentType ?? raw.explicitRecruitmentType ?? (nativeIds?.has(originalJobId) ? 'intern' : undefined);
      if (!title || !company || !jd) { await Act('BrowserGoBack'); continue; }
      const entry: CollectedJob = {
        identity: `boss_zhipin:${originalJobId}`, platform: 'boss_zhipin', sourceId: 'boss_zhipin', originalJobId,
        sourceUrl: search.toString(), collectedAt: new Date().toISOString(),
        job: { id: `job-boss-${originalJobId}`, title, company, jd, favorite: false, channel: 'boss_zhipin',
          url: NormalizeUrl(detail?.url) ?? url, city: DecodeBossText(raw.city, 100),
          salary: DecodeBossText(detail?.salary || raw.salary, 100), experience: DecodeBossText(detail?.experience || raw.experience, 100),
          education: DecodeBossText(detail?.education || raw.education, 100), companySize: DecodeBossText(detail?.companySize || raw.companySize, 100),
          jobSeekingType: jobType === 'intern' || jobType === 'campus_recruitment' || jobType === 'social_recruitment' ? jobType : undefined,
        },
      };
      if (!await input.accept(entry)) return;
      // 返回真实列表历史，保留 SPA 当前页；不能假设站点支持 URL 的 page 参数。
      await Act('BrowserGoBack');
    }
    await AssertBossPage(browser, input.signal, input.deadline);
    const continuation = await Evaluate<{ infinite?: boolean; hasMore?: boolean; loading?: boolean; hasNext?: boolean }>(browser, BossListContinuationExpression, input.signal, input.deadline);
    if (continuation.infinite) {
      if (continuation.hasMore === false) return;
      if (continuation.hasMore !== true) throw new JobCollectionError('BOSS_PAGINATION_UNAVAILABLE', 'BOSS 滚动列表的加载状态未识别，不能认定岗位已耗尽。');
      // 通过正常键盘滚动触发页面自己的加载逻辑；Home 保证返回页底后仍产生滚动事件。
      if (!continuation.loading) { await Act('BrowserPressKey', { key: 'Home' }); await Act('BrowserPressKey', { key: 'End' }); }
      let loaded = false;
      for (let attempt = 0; attempt < 10; attempt++) {
        const filtered = internOnly ? await WaitBossNativeFilters(browser, input.signal, input.deadline, search) : undefined;
        const allowedIds = filtered ? new Set(filtered.jobIds) : undefined;
        const current = await ExtractBossList(browser, input.signal, input.deadline);
        if (current.some((item) => { const url = NormalizeUrl(item.url); return url && !seen.has(SourceJobId(url)) && (!allowedIds || allowedIds.has(SourceJobId(url))); })) { loaded = true; break; }
        const state = await Evaluate<{ hasMore?: boolean; loading?: boolean }>(browser, BossListContinuationExpression, input.signal, input.deadline);
        if (state.hasMore === false && !state.loading) return;
        await Delay(Math.min(500, Remaining(input.deadline)), undefined, { signal: input.signal });
      }
      if (!loaded) throw new JobCollectionError('BOSS_PAGINATION_STALLED', 'BOSS 滚动加载未返回新岗位，已停止采集；已入库岗位保留。');
      continue;
    }
    const snapshot = await Act('BrowserSnapshot') as { pageRevision: number; refs?: Record<string, { name?: string; role?: string; disabled?: boolean }> };
    const next = Object.entries(snapshot.refs ?? {}).find(([, ref]) => !ref.disabled
      && ['link', 'button'].includes(ref.role ?? '') && (ref.name === '下一页' || ref.name === String(page + 1)));
    if (!next) {
      // 快照中没有分页 ref 不等于来源耗尽：图标按钮或截断可能隐藏下一页入口。
      if (continuation.hasNext || (snapshot as { truncated?: boolean }).truncated) {
        throw new JobCollectionError('BOSS_PAGINATION_UNAVAILABLE', 'BOSS 页面可能仍有下一页，但快照未识别到可安全点击的分页入口，已停止；不能认定岗位已耗尽。');
      }
      return;
    }
    await Act('BrowserClick', { ref: next[0], pageRevision: snapshot.pageRevision });
    // SPA 分页不能依赖固定等待；确认岗位身份集合改变后才进入下一页。
    let changed = false;
    for (let attempt = 0; attempt < 10; attempt++) {
      const current = await ExtractBossList(browser, input.signal, input.deadline);
      if (current.map((item) => SourceJobId(NormalizeUrl(item.url) ?? '')).join('\n') !== fingerprint) { changed = true; break; }
      await Delay(500, undefined, { signal: input.signal });
    }
    if (!changed) throw new JobCollectionError('BOSS_PAGINATION_STALLED', 'BOSS 分页未更新，已停止采集；已入库岗位保留。');
  }
}

/** BOSS 浏览器采集与企业 ATS 公开采集共用会话候选缓存，ATS 事实独立存储。 */
export class JobCollectionService implements JobCollectionPort {
  private readonly browser: TrustedBrowser;
  private readonly loadViewModel: () => Promise<any>;
  private readonly saveJob: (input: Record<string, unknown>) => Promise<any>;
  private readonly now: () => number;
  private readonly atsRunner: AtsSourceRunner;
  private readonly atsMatcher: AtsCandidateMatcher;
  private readonly collectorRegistry = new Map<string, PlatformCollector>([[BossCollector.platform, BossCollector]]);
  private readonly collections = new Map<string, Map<string, CachedCollection>>();
  private readonly sweepTimer: ReturnType<typeof setInterval>;

  constructor(input: {
    browser: BrowserAutomationPort;
    loadViewModel: () => Promise<any> | any;
    saveJob: (input: Record<string, unknown>) => Promise<any> | any;
    now?: () => number;
    atsStorePath?: string;
    atsRunner?: AtsSourceRunner;
  }) {
    if (typeof input.browser.EvaluateTrustedPage !== 'function') {
      throw new Error('The browser runtime does not provide trusted page extraction.');
    }
    this.browser = input.browser as TrustedBrowser;
    this.loadViewModel = async () => await input.loadViewModel();
    this.saveJob = async (value) => await input.saveJob(value);
    this.now = input.now ?? Date.now;
    this.atsRunner = input.atsRunner ?? new AtsSourceRunner(undefined, new AtsFactStore(input.atsStorePath));
    this.atsMatcher = new AtsCandidateMatcher(input.atsStorePath ? `${input.atsStorePath}.matches.json` : undefined);
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
    if (input.platforms.length && input.platforms.every((platform) => platform === 'beisen' || platform === 'moka' || platform === 'hotjob' || platform === 'feishu')) return this.CollectAts(input);
    if (!input.queries.length || input.sources?.length) throw new JobCollectionError('INVALID_TOOL_ARGUMENTS', 'BOSS requires keyword/city queries and must not include ATS sources.');
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

  private async CollectAts(input: Parameters<JobCollectionPort['Collect']>[0]): ReturnType<JobCollectionPort['Collect']> {
    if (!input.sources?.length || input.sources.length > 10) throw new JobCollectionError('INVALID_TOOL_ARGUMENTS', 'ATS collection requires 1 to 10 public company recruitment sources.');
    const sources = input.sources.map((source) => CreateSource(source));
    const signal = AbortSignal.any([AbortSignal.timeout(Remaining(input.deadline)), ...(input.signal ? [input.signal] : [])]);
    const results = await this.atsRunner.RunBatch(sources, signal);
    AssertActive(input.signal, input.deadline);
    const candidates: CachedCandidate[] = [];
    const seen = new Set<string>();
    const warnings: string[] = [];
    let duplicates = 0;
    let filtered = 0;
    const ToCandidate = (job: NormalizedJob): CachedCandidate => ({
      candidateId: '', platform: job.ats, sourceJobId: job.id, title: job.title, company: job.company, city: job.locations.join('、'), salary: job.salary ?? '',
      experience: job.experience ?? '', education: job.education ?? '', jobType: job.jobType, jd: [job.description, job.requirements].filter(Boolean).join('\n\n'), url: job.applicationUrl,
      alreadySaved: false, contactStatus: 'not_contacted', companySize: '', industry: '', recruiter: '', collectedAt: job.lastSeenAt,
    });
    const matching = await this.atsMatcher.Process({ platforms: [...input.platforms].sort(), queries: input.queries, filters: input.filters ?? {} }, results, (job) => {
      AssertActive(input.signal, input.deadline);
      const candidate = ToCandidate(job);
      return (!input.queries.length || input.queries.some((query) => `${candidate.title}\n${candidate.jd}`.toLocaleLowerCase().includes(query.keyword.toLocaleLowerCase()) && (query.city === '全国' || candidate.city.includes(query.city))))
        && MatchesFilter(candidate, input.filters ?? {});
    }, signal).catch((error: unknown) => {
      signal.throwIfAborted();
      // 缓存读写故障不回滚已保存事实，不将未经筛选的岗位冒充匹配结果。
      return { jobs: [] as NormalizedJob[], processed: 0, reused: 0, errors: [{ sourceId: 'match-store', jobId: '', scope: '', at: new Date().toISOString(), message: error instanceof Error ? error.message : String(error) }] };
    });
    warnings.push(...matching.errors.map((error) => `${error.sourceId}: ATS_MATCH_FAILED: ${error.jobId}: ${error.message}`));
    const matched = new Set(matching.jobs.map((job) => `${job.sourceId}:${job.id}`));
    for (const result of results) {
      warnings.push(...result.errors.map((error) => `${result.sourceId}: ${error.code}: ${error.message}`));
      for (const job of result.jobs) {
        if (job.status !== 'open') { filtered += 1; continue; }
        if (!input.platforms.includes(job.ats)) { filtered += 1; continue; }
        if (seen.has(job.id)) { duplicates += 1; continue; }
        seen.add(job.id);
        const candidate = ToCandidate(job);
        if (!matched.has(`${job.sourceId}:${job.id}`)) { filtered += 1; continue; }
        candidates.push(candidate);
      }
    }
    const dates = new Map(results.flatMap((result) => result.jobs.map((job) => [job.id, job.updatedAt ?? job.publishedAt ?? ''] as const)));
    if (input.sort === 'newest') candidates.sort((a, b) => {
      return (dates.get(b.sourceJobId) ?? '').localeCompare(dates.get(a.sourceJobId) ?? '');
    });
    const selected = candidates.slice(0, Math.min(MaxResults, input.maxResults));
    const view = await this.loadViewModel();
    const jobs = Array.isArray(view?.jobs) ? view.jobs : [];
    const applications = Array.isArray(view?.applications) ? view.applications : [];
    for (const [index, candidate] of selected.entries()) {
      candidate.candidateId = `candidate-${index + 1}`;
      const existing = jobs.find((job: { id: string; url?: string }) => job.id === this.CandidateJobId(candidate) || job.url === candidate.url);
      candidate.alreadySaved = Boolean(existing);
      candidate.contactStatus = existing ? applications.find((application: { jobId: string; status: string }) => application.jobId === existing.id && application.status !== 'saved')?.status ?? 'not_contacted' : 'not_contacted';
    }
    AssertActive(input.signal, input.deadline);
    const collectionId = this.Store(input.sessionId, selected);
    return {
      status: selected.length >= input.maxResults ? 'completed' : 'completed_with_shortage', collectionId,
      candidates: selected.map(({ companySize: _s, industry: _i, recruiter: _r, collectedAt: _c, ...candidate }) => candidate),
      counts: { collected: selected.length, duplicates, filtered }, truncated: candidates.length > selected.length || results.some((result) => result.snapshotStatus !== 'complete'), warnings,
      sourceRuns: results.map((result) => ({ sourceId: result.sourceId, ats: result.ats, health: result.health, snapshotStatus: result.snapshotStatus, transport: result.transport, jobCount: result.jobs.length, nextPage: result.continuation?.nextPage, errors: result.errors })),
      matching: { processed: matching.processed, reused: matching.reused, failed: matching.errors.length },
    };
  }

  private CandidateJobId(candidate: CachedCandidate): string {
    return candidate.platform === 'boss_zhipin' ? `job-boss-${candidate.sourceJobId}` : `job-ats-${createHash('sha256').update(candidate.sourceJobId).digest('hex').slice(0, 32)}`;
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
    const jobId = this.CandidateJobId(candidate);
    const saved = await this.saveJob({
      jobId, company: candidate.company, title: candidate.title, city: candidate.city, salary: candidate.salary,
      experience: candidate.experience, ...(candidate.jobType ? { jobSeekingType: candidate.jobType } : {}), channel: candidate.platform === 'boss_zhipin' ? 'boss_zhipin' : 'company_website', favorite: false,
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
