import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import type { CollectedJob } from '@avery/contracts';
import { CollectBossJobsToLibrary } from '../../../apps/backend/src/electron/backend/job-collection-service';

// Node 的 Promise 定时器不受 Vitest 虚拟时钟控制；仅在虚拟时钟用例中改走可推进的全局定时器。
vi.mock('node:timers/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:timers/promises')>();
  return { ...actual, setTimeout: (delay: number, value?: unknown, options?: { signal?: AbortSignal; ref?: boolean }) =>
    vi.isFakeTimers() ? new Promise((resolve) => setTimeout(() => resolve(value), delay)) : actual.setTimeout(delay, value, options) };
});

/** 执行生产的固定详情提取表达式，而非直接伪造已识别的招聘类型。 */
function Browser({ title = 'AI产品经理实习生', listTitle = title, tags = ['广州', '在校/应届', '本科'], listTags = ['在校生', '本科'],
  jd = '负责AI产品设计', body = '', hasNext = false, modernDetail = false, infinite = false, batchSize = 1, batches = 1,
  unknownFirstBatch = false, loadingStateKnown = true, stalled = false,
  nativeFilter = 'available', nativeInternCode = '1902', recommended = false, dropFilterAfterBack = false, nativeIdsMismatch = false,
  jdInnerText = undefined as string | undefined, companyTags = [] as string[], listCompanyTags = [] as string[], unrelatedCompanyTags = [] as string[] } = {}) {
  let url = 'https://www.zhipin.com/web/geek/job';
  let loadedBatches = 1;
  let filterLost = false;
  const history: string[] = [];
  const browser = {
    Prepare: vi.fn(async (input) => ({ toolName: input.toolName, canonicalArguments: input.arguments })),
    Execute: vi.fn(async ({ proposal }) => {
      if (proposal.toolName === 'BrowserNavigate') { history.push(url); url = proposal.canonicalArguments.url; }
      if (proposal.toolName === 'BrowserGoBack') { url = history.pop() ?? url; filterLost = dropFilterAfterBack; }
      if (proposal.toolName === 'BrowserPressKey' && proposal.canonicalArguments.key === 'End' && !stalled) loadedBatches = Math.min(batches, loadedBatches + 1);
      return { status: 'succeeded', data: proposal.toolName === 'BrowserSnapshot' ? { refs: {}, pageRevision: 1 } : {} };
    }),
    EvaluateTrustedPage: vi.fn(async ({ expression }) => {
      if (expression.includes("risk: 'verification'")) return { risk: null };
      if (expression.includes('.options-pages') && !infinite) return { hasNext };
      const currentId = Number(url.match(/id(\d+)\.html/)?.[1] ?? 1);
      const currentTitle = unknownFirstBatch && currentId <= batchSize ? 'AI产品经理' : title;
      const list = infinite ? { __vue__: loadingStateKnown ? { $options: { name: 'PageJobs' }, hasMore: loadedBatches < batches, moreLoading: false } : null, parentElement: null } : null;
      const query = new URL(url).searchParams;
      const jobType = nativeFilter === 'ignored' || filterLost ? '' : query.get('jobType') ?? '';
      const filter = nativeFilter === 'missing' ? null : { __vue__: {
        jobTypeList: [{ code: 0, name: '不限' }, { code: 1901, name: '全职' }, { code: 1903, name: '兼职' },
          ...(nativeFilter === 'unsupported' ? [] : [{ code: nativeInternCode, name: '实习' }])],
        formData: { jobType }, $parent: {
          $options: { name: 'PageJobs' }, loading: nativeFilter === 'loading', moreLoading: false, isSearch: true,
          formData: { query: nativeFilter === 'wrongQuery' ? '其他关键词' : query.get('query'), city: query.get('city'), jobType },
          jobList: Array.from({ length: loadedBatches * batchSize - (recommended ? 1 : 0) }, (_, index) => ({ encryptJobId: `${nativeIdsMismatch ? 'other' : 'id'}${index + 1}` })),
        },
      } };
      return runInNewContext(expression, {
        location: { href: url },
        document: {
          title: `${currentTitle}_测试企业招聘-BOSS直聘`, body: { innerText: body },
          querySelectorAll: (selector: string) => selector === '.job-card-wrap' ? Array.from({ length: loadedBatches * batchSize }, (_, index) => ({
            getAttribute: () => '',
            querySelectorAll: (selector: string) => (selector.includes('.company-tag-list') ? listCompanyTags : listTags).map((textContent) => ({ textContent })),
            querySelector: (selector: string) => selector === '.job-name' ? {
              textContent: unknownFirstBatch && index < batchSize ? 'AI产品经理' : listTitle,
              closest: () => ({ getAttribute: () => `/job_detail/id${index + 1}.html` }),
            } : selector === '.company-name' ? { textContent: '测试企业' } : null,
          })) : selector.split(',').some((part) => part.trim() === '.sider-company p') ? companyTags.map((textContent) => ({ textContent }))
            : selector.split(',').some((part) => part.trim() === '.company-info-item') ? unrelatedCompanyTags.map((textContent) => ({ textContent }))
              : selector.includes('.tag-list') ? tags.map((textContent) => ({ textContent })) : [],
          querySelector: (selector: string) => selector === '.c-filter-condition' ? filter
            : selector === '.job-list-container .rec-job-list' ? list
            : (!modernDetail && selector.includes('.name h1') || modernDetail && selector === '.job-detail-header .job-name') ? { textContent: currentTitle }
              : (!modernDetail && selector === '.job-sec-text' || modernDetail && selector === '.job-detail-body .desc') ? { textContent: jd, innerText: jdInnerText } : null,
        },
      });
    }),
  };
  return browser;
}

describe('BOSS采集条件与真实提取逻辑', () => {
  it.each([false, true])('JD使用可见正文保留段落和列表换行，不保存被隐藏文本（新版详情=%s）', async (modernDetail) => {
    const browser = Browser({ modernDetail, jd: '工作职责设计产品跟进研发隐藏推荐文字', jdInnerText: '工作职责\r\n1. 设计产品  \r\n2. 跟进研发\r\n\r\n任职要求\r\n本科在读' });
    const entries: CollectedJob[] = [];
    await CollectBossJobsToLibrary(browser as never, { keyword: '产品', city: '广州', signal: new AbortController().signal,
      deadline: Date.now() + 10000, accept: async (entry) => { entries.push(entry); return false; } });
    expect(entries[0].job.jd).toBe('工作职责\n1. 设计产品\n2. 跟进研发\n\n任职要求\n本科在读');
  });

  it.each(['20-99人', '1000-9999人', '10000人以上', '少于20人', '20人以下'])('从详情右侧公司信息采集人数规模：%s', async (companySize) => {
    const browser = Browser({ companyTags: ['人工智能', companySize] });
    const entries: CollectedJob[] = [];
    await CollectBossJobsToLibrary(browser as never, { keyword: '产品', city: '广州', signal: new AbortController().signal,
      deadline: Date.now() + 10000, accept: async (entry) => { entries.push(entry); return false; } });
    expect(entries[0].job.companySize).toBe(companySize);
  });

  it('公司规模缺失时不把行业、招聘人数、JD或其他推荐企业当成规模', async () => {
    const browser = Browser({ companyTags: ['人工智能', '招聘20人'], unrelatedCompanyTags: ['1000-9999人'], jd: '负责为100-499人的企业设计产品。' });
    const entries: CollectedJob[] = [];
    await CollectBossJobsToLibrary(browser as never, { keyword: '产品', city: '广州', signal: new AbortController().signal,
      deadline: Date.now() + 10000, accept: async (entry) => { entries.push(entry); return false; } });
    expect(entries[0].job.companySize).toBe('');
  });

  it('右侧规模缺失时回退到当前列表卡片标签；详情有规模时优先详情', async () => {
    for (const companyTags of [[], ['公司规模：100-499人']]) {
      const browser = Browser({ companyTags, listCompanyTags: ['未融资', '20-99人', '人工智能'] });
      const entries: CollectedJob[] = [];
      await CollectBossJobsToLibrary(browser as never, { keyword: '产品', city: '广州', signal: new AbortController().signal,
        deadline: Date.now() + 10000, accept: async (entry) => { entries.push(entry); return false; } });
      expect(entries[0].job.companySize).toBe(companyTags.length ? '100-499人' : '20-99人');
    }
  });

  it.each([
    ['AI产品经理实习生', 'intern'], ['AI Product Intern', 'intern'], ['AI产品经理（校招）', 'campus_recruitment'], ['AI产品经理（社招）', 'social_recruitment'],
  ])('主标签不含类型时仍识别当前岗位标题：%s', async (title, type) => {
    const browser = Browser({ title });
    const entries: CollectedJob[] = [];
    await CollectBossJobsToLibrary(browser as never, { keyword: 'ai产品经理', city: '广州', jobSeekingTypes: ['intern'], educations: ['bachelor'],
      signal: new AbortController().signal, deadline: Date.now() + 10000, accept: async (entry) => { entries.push(entry); return false; } });
    expect(entries[0].job).toMatchObject({ title, jobSeekingType: type, education: '本科' });
    const search = new URL(browser.Prepare.mock.calls[0][0].arguments.url);
    expect(search.searchParams.has('jobType')).toBe(false);
    expect(search.searchParams.get('query')).toBe('ai产品经理');
    expect(search.searchParams.get('degree')).toBe('203');
    expect(search.searchParams.get('city')).toBe('101280100');
    expect(new URL(entries[0].sourceUrl).searchParams.get('jobType')).toBe('1902');
  });

  it('不从JD或推荐岗位的实习字样推测当前岗位类型，缺少详情学历时保留列表事实', async () => {
    const browser = Browser({ title: 'AI产品经理', tags: ['广州', '1-3年'], body: 'JD含实习经历说明；相关推荐：产品实习生' });
    const entries: CollectedJob[] = [];
    await CollectBossJobsToLibrary(browser as never, { keyword: 'ai产品经理', city: '广州', signal: new AbortController().signal,
      deadline: Date.now() + 10000, accept: async (entry) => { entries.push(entry); return false; } });
    expect(entries[0].job.jobSeekingType).toBeUndefined();
    expect(entries[0].job.education).toBe('本科');
  });

  it('包含未映射的校招多选时不只向站点提交实习子集，防止丢失OR结果', async () => {
    const browser = Browser();
    await CollectBossJobsToLibrary(browser as never, { keyword: '产品', city: '广州', jobSeekingTypes: ['intern', 'campus_recruitment'],
      signal: new AbortController().signal, deadline: Date.now() + 10000, accept: async () => false });
    const search = new URL(browser.Prepare.mock.calls[0][0].arguments.url);
    expect(search.searchParams.has('jobType')).toBe(false);
    expect(search.searchParams.get('query')).toBe('产品');
  });

  it('仍有下一页却没有快照引用时明确失败，不冒充来源已经耗尽', async () => {
    const browser = Browser({ hasNext: true });
    await expect(CollectBossJobsToLibrary(browser as never, { keyword: '产品', city: '广州', signal: new AbortController().signal,
      deadline: Date.now() + 10000, accept: async () => true })).rejects.toMatchObject({ code: 'BOSS_PAGINATION_UNAVAILABLE' });
    expect(browser.Prepare.mock.calls.some(([input]) => input.toolName === 'BrowserClick')).toBe(false);
  });

  it('已验证的原生实习列表可以补充缺失类型，不改动用户原有关键词', async () => {
    const browser = Browser({ title: 'AI产品经理', listTitle: 'AI产品经理' });
    const entries: CollectedJob[] = [];
    await CollectBossJobsToLibrary(browser as never, { keyword: 'AI产品经理 实习', city: '广州', jobSeekingTypes: ['intern'],
      signal: new AbortController().signal, deadline: Date.now() + 10000, accept: async (entry) => { entries.push(entry); return false; } });
    expect(new URL(browser.Prepare.mock.calls[0][0].arguments.url).searchParams.get('query')).toBe('AI产品经理 实习');
    expect(entries[0].job.jobSeekingType).toBe('intern');
  });

  it.each(['本岗位为实习岗位，参与产品设计。', '招聘AI产品实习生，参与设计。', '实习时长不少于3个月，每周到岗4天。'])('当前JD明确说明实习安排时识别：%s', async (jd) => {
    const browser = Browser({ title: 'AI产品经理', jd });
    const entries: CollectedJob[] = [];
    await CollectBossJobsToLibrary(browser as never, { keyword: '产品', city: '广州', signal: new AbortController().signal,
      deadline: Date.now() + 10000, accept: async (entry) => { entries.push(entry); return false; } });
    expect(entries[0].job.jobSeekingType).toBe('intern');
  });

  it('相关实习经历/管理实习生不能让普通岗位变成实习岗位', async () => {
    const browser = Browser({ title: 'AI产品经理', jd: '3年以上工作经验，有产品实习经历优先，负责招聘AI产品实习生、指导和管理实习生。' });
    const entries: CollectedJob[] = [];
    await CollectBossJobsToLibrary(browser as never, { keyword: '产品', city: '广州', signal: new AbortController().signal,
      deadline: Date.now() + 10000, accept: async (entry) => { entries.push(entry); return false; } });
    expect(entries[0].job.jobSeekingType).toBeUndefined();
  });

  it('详情类型缺失时保留列表标题证据；列表学历标签不依赖固定位置', async () => {
    const browser = Browser({ title: 'AI产品经理', listTitle: 'AI产品经理实习生', tags: ['广州'], listTags: ['本科', '在校生'] });
    const entries: CollectedJob[] = [];
    await CollectBossJobsToLibrary(browser as never, { keyword: '产品', city: '广州', signal: new AbortController().signal,
      deadline: Date.now() + 10000, accept: async (entry) => { entries.push(entry); return false; } });
    expect(entries[0].job).toMatchObject({ jobSeekingType: 'intern', education: '本科' });
  });

  it('新详情结构只读取当前标题、主标签、职位描述', async () => {
    const browser = Browser({ title: 'AI产品经理', modernDetail: true, jd: '实习周期：3个月，负责AI产品设计', body: '推荐岗位：正式产品经理' });
    const entries: CollectedJob[] = [];
    await CollectBossJobsToLibrary(browser as never, { keyword: '产品', city: '广州', signal: new AbortController().signal,
      deadline: Date.now() + 10000, accept: async (entry) => { entries.push(entry); return false; } });
    expect(entries[0].job).toMatchObject({ title: 'AI产品经理', jobSeekingType: 'intern', education: '本科', jd: '实习周期：3个月，负责AI产品设计' });
  });

  it('滚动列表首批15条全部类型未知时继续加载，筛出第二批5个实习本科岗位，不重复读取累计项', async () => {
    const browser = Browser({ infinite: true, batches: 2, batchSize: 15, unknownFirstBatch: true });
    const inspected: CollectedJob[] = [], accepted: CollectedJob[] = [];
    await CollectBossJobsToLibrary(browser as never, { keyword: 'ai产品经理', city: '广州', jobSeekingTypes: ['intern', 'campus_recruitment'], educations: ['bachelor'],
      signal: new AbortController().signal, deadline: Date.now() + 10000, accept: async (entry) => {
        inspected.push(entry);
        if (entry.job.jobSeekingType === 'intern' && entry.job.education === '本科') accepted.push(entry);
        return accepted.length < 5;
      } });
    expect(inspected).toHaveLength(20);
    expect(new Set(inspected.map((entry) => entry.identity)).size).toBe(20);
    expect(accepted).toHaveLength(5);
    const keys = browser.Prepare.mock.calls.filter(([input]) => input.toolName === 'BrowserPressKey').map(([input]) => input.arguments.key);
    expect(keys).toEqual(['Home', 'End']);
    expect(browser.Prepare.mock.calls.every(([input]) => ['BrowserNavigate', 'BrowserGoBack', 'BrowserPressKey'].includes(input.toolName))).toBe(true);
  });

  it('滚动列表明确没有更多岗位后才结束，不发送消息或使用伪造分页URL', async () => {
    const browser = Browser({ infinite: true, batchSize: 2 });
    const entries: CollectedJob[] = [];
    await CollectBossJobsToLibrary(browser as never, { keyword: '产品', city: '广州', signal: new AbortController().signal,
      deadline: Date.now() + 10000, accept: async (entry) => { entries.push(entry); return true; } });
    expect(entries).toHaveLength(2);
    expect(browser.Prepare.mock.calls.some(([input]) => input.toolName === 'BrowserPressKey' || input.toolName === 'BrowserClick')).toBe(false);
  });

  it('滚动加载状态未知时明确失败，不把首批15条误报为来源耗尽', async () => {
    const browser = Browser({ infinite: true, loadingStateKnown: false });
    await expect(CollectBossJobsToLibrary(browser as never, { keyword: '产品', city: '广州', signal: new AbortController().signal,
      deadline: Date.now() + 10000, accept: async () => true })).rejects.toMatchObject({ code: 'BOSS_PAGINATION_UNAVAILABLE' });
  });

  it('从当前页面动态取得实习编码；原关键词和学历保持不变', async () => {
    const browser = Browser({ title: 'AI产品经理', nativeInternCode: '2902' });
    const entries: CollectedJob[] = [];
    await CollectBossJobsToLibrary(browser as never, { keyword: 'AI产品经理', city: '广州', jobSeekingTypes: ['intern'], educations: ['bachelor'],
      signal: new AbortController().signal, deadline: Date.now() + 10000, accept: async (entry) => { entries.push(entry); return false; } });
    const searches = browser.Prepare.mock.calls.filter(([input]) => input.toolName === 'BrowserNavigate').slice(0, 2)
      .map(([input]) => new URL(input.arguments.url));
    expect(searches.map((url) => url.searchParams.get('query'))).toEqual(['AI产品经理', 'AI产品经理']);
    expect(searches[1].searchParams.get('jobType')).toBe('2902');
    expect(searches[1].searchParams.get('degree')).toBe('203');
    expect(entries[0].job.jobSeekingType).toBe('intern');
  });

  it('筛选结果之外的推荐卡片不会补造类型或进入采集结果', async () => {
    const browser = Browser({ title: '产品经理', infinite: true, batchSize: 2, recommended: true });
    const entries: CollectedJob[] = [];
    await CollectBossJobsToLibrary(browser as never, { keyword: '产品', city: '广州', jobSeekingTypes: ['intern'],
      signal: new AbortController().signal, deadline: Date.now() + 10000, accept: async (entry) => { entries.push(entry); return true; } });
    expect(entries.map((entry) => entry.originalJobId)).toEqual(['id1']);
    expect(entries[0].job.jobSeekingType).toBe('intern');
  });

  it('原生实习筛选跨批次持续核验，累计列表按岗位ID去重', async () => {
    const browser = Browser({ title: '产品经理', infinite: true, batchSize: 2, batches: 2 });
    const entries: CollectedJob[] = [];
    await CollectBossJobsToLibrary(browser as never, { keyword: '产品', city: '广州', jobSeekingTypes: ['intern'],
      signal: new AbortController().signal, deadline: Date.now() + 10000, accept: async (entry) => { entries.push(entry); return entries.length < 3; } });
    expect(entries.map((entry) => entry.originalJobId)).toEqual(['id1', 'id2', 'id3']);
    expect(entries.every((entry) => entry.job.jobSeekingType === 'intern')).toBe(true);
  });

  it('只有全职/兼职时不冒充实习，也不开始读取岗位详情', async () => {
    const browser = Browser({ nativeFilter: 'unsupported' });
    await expect(CollectBossJobsToLibrary(browser as never, { keyword: '产品', city: '广州', jobSeekingTypes: ['intern'],
      signal: new AbortController().signal, deadline: Date.now() + 10000, accept: async () => false }))
      .rejects.toMatchObject({ code: 'BOSS_FILTER_UNAVAILABLE' });
    expect(browser.Prepare.mock.calls.filter(([input]) => input.toolName === 'BrowserNavigate')).toHaveLength(1);
  });

  it.each(['missing', 'ignored', 'loading', 'wrongQuery'])('原生筛选%s时不依据URL伪造成功结果', async (nativeFilter) => {
    vi.useFakeTimers();
    try {
      const browser = Browser({ nativeFilter });
      const accept = vi.fn(async () => false);
      const pending = expect(CollectBossJobsToLibrary(browser as never, { keyword: '产品', city: '广州', jobSeekingTypes: ['intern'],
        signal: new AbortController().signal, deadline: Date.now() + 10000, accept }))
        .rejects.toMatchObject({ code: 'BOSS_FILTER_UNVERIFIED' });
      await vi.runAllTimersAsync(); await pending;
      expect(accept).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });

  it('筛选后的岗位身份无法与DOM对应时明确失败，而非返回成功的空列表', async () => {
    const browser = Browser({ nativeIdsMismatch: true });
    const accept = vi.fn(async () => false);
    await expect(CollectBossJobsToLibrary(browser as never, { keyword: '产品', city: '广州', jobSeekingTypes: ['intern'],
      signal: new AbortController().signal, deadline: Date.now() + 10000, accept }))
      .rejects.toMatchObject({ code: 'BOSS_FILTER_RESULTS_UNVERIFIED' });
    expect(accept).not.toHaveBeenCalled();
  });

  it('返回列表后筛选失效则停止，不给后续岗位错误标注实习', async () => {
    vi.useFakeTimers();
    try {
      const browser = Browser({ title: '产品经理', infinite: true, batches: 2, dropFilterAfterBack: true });
      const entries: CollectedJob[] = [];
      const pending = expect(CollectBossJobsToLibrary(browser as never, { keyword: '产品', city: '广州', jobSeekingTypes: ['intern'],
        signal: new AbortController().signal, deadline: Date.now() + 10000, accept: async (entry) => { entries.push(entry); return true; } }))
        .rejects.toMatchObject({ code: 'BOSS_FILTER_UNVERIFIED' });
      await vi.runAllTimersAsync(); await pending;
      expect(entries).toHaveLength(1);
    } finally { vi.useRealTimers(); }
  });
});
