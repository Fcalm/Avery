import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { BeisenCareerAdapter, DetectAts, MokaPublicAdapter } from '../../../apps/backend/src/electron/backend/ats/adapters';
import { ApplySnapshot, AtsFactStore, AtsSourceRunner, CreateSource } from '../../../apps/backend/src/electron/backend/ats/source-runner';
import { AtsCandidateMatcher } from '../../../apps/backend/src/electron/backend/ats/candidate-matcher';
import { ParseLegacyList, ParseLegacyDetail } from '../../../apps/backend/src/electron/backend/ats/beisen-legacy';
import { DiscoverMokaRecruitment, ParseMokaRecruitmentUrl } from '../../../apps/backend/src/electron/backend/ats/moka-discovery';
import type { AtsSource, PublicTransport, SourceResult } from '../../../apps/backend/src/electron/backend/ats/types';
import { JobCollectionService } from '../../../apps/backend/src/electron/backend/job-collection-service';
import type { BrowserAutomationPort } from '../../../packages/agent-sdk/src';

const source = CreateSource({ url: 'https://example.zhiye.com/', company: '甲企业', maxPages: 5 });
const signal = () => new AbortController().signal;
function BeisenRow(id: number) { return { JobAdId: id, Id: `uuid-${id}`, JobAdName: `工程师${id}`, Status: 1, Duty: '开发工作', Require: '专业要求', LocNames: ['上海'], ChangeDate: '2026-09-20T12:00:00', PostDate: '0001-01-01T00:00:00' }; }
function Transport(pages: unknown[] = [{ Code: 200, Data: [BeisenRow(1)], Count: 1 }], portal = '<script>var BSGlobal={"PortalId":"portal-1"};</script>'): PublicTransport {
  let index = 0;
  return { Request: vi.fn(async (url, input) => ({ status: 200, url, body: input.method === 'POST' ? JSON.stringify(pages[index++]) : portal })) };
}
async function Run(transport: PublicTransport, item: AtsSource = source) { return new AtsSourceRunner(transport).Run(item); }

describe('ATS public source adapters', () => {
  it('Moka 官网唯一入口及自定义路径特征识别，来源与申请链接分别保留', async () => {
    const item = CreateSource({ company: '乙企业', url: 'https://careers.example.com/' });
    const transport: PublicTransport = { Request: vi.fn(async (url) => ({ url, status: 200, body: url.includes('api.mokahr.com') ? JSON.stringify({ jobs: [{ id: '1', title: '研发', status: 'open', locations: [], description: '研发系统' }], total: 1 }) : '<a href="https://app.mokahr.com/social-recruitment/company/100#/jobs">加入我们</a>' })) };
    const run = await Run(transport, item);
    expect(run).toMatchObject({ ats: 'moka', health: 'healthy', jobs: [{ sourceUrl: item.url, applicationUrl: 'https://app.mokahr.com/social-recruitment/company/100#/job/1', fieldIssues: { locations: 'source_empty', requirements: 'source_missing', updatedAt: 'source_missing' } }] });
    expect(DiscoverMokaRecruitment('<script src="https://static.mokahr.com/app.js"></script>', 'https://careers.example.com/campus-recruitment/c/100')).toMatchObject({ orgId: 'c', siteId: '100', mode: 'campus' });
  });
  it('多个 Moka 入口不能猜选，品牌文字及伪域名不作为平台依据', async () => {
    const html = '<a href="https://app.mokahr.com/campus-recruitment/c/1">校招</a><iframe src="https://app.mokahr.com/social-recruitment/c/2"></iframe>';
    expect(() => DiscoverMokaRecruitment(html, 'https://careers.example.com/')).toThrow('multiple Moka');
    expect(DiscoverMokaRecruitment('Moka', 'https://careers.example.com/')).toBeUndefined();
    for (const url of ['https://app.mokahr.com.evil.com/apply/c/1', 'https://app.mokahr.com/apply/%ZZ/1', 'https://user:secret@app.mokahr.com/apply/c/1']) expect(ParseMokaRecruitmentUrl(url)).toBeUndefined();
  });
  it('Moka 源站未提供与无法映射的字段分开，IP 白名单响应不能作为网络重试成功', async () => {
    const item = CreateSource({ company: '乙企业', url: 'https://app.mokahr.com/social-recruitment/c/1' });
    const transport: PublicTransport = { Request: vi.fn(async (url) => ({ url, status: 200, body: JSON.stringify({ jobs: [{ id: '1', title: '研发', status: 'open', locations: [{ code: 1 }], description: { content: 'unrecognized' }, updatedAt: 'bad-date' }], total: 1 }) })) };
    expect((await Run(transport, item)).jobs[0].fieldIssues).toEqual({ locations: 'unmapped_value', description: 'unmapped_value', requirements: 'source_missing', updatedAt: 'source_invalid' });
    const denied: PublicTransport = { Request: vi.fn(async (url) => ({ url, status: 500, body: '{"msg":"IP not allowed."}' })) };
    expect(await Run(denied, item)).toMatchObject({ health: 'access_controlled', errors: [{ code: 'SOURCE_ACCESS_DENIED', message: expect.any(String) }] });
  });
  const legacyList = (rows: string, pagination = '') => `<div class="positionlist"><table class="jobsTable"><tr class="title"><td>职位名称</td><td>职位类型</td><td>工作地点</td><td>发布时间</td></tr>${rows}</table>${pagination}</div>`;
  const legacyRow = (id: number) => `<tr><td><a href="/zpdetail/${id}">算法工程师${id}</a></td><td>研发</td><td>广东省-佛山市</td><td>2026-09-20</td></tr>`;
  const legacyDetail = '<ul><li class="ntitle td-HasRecruitCategories">招聘类别：</li><li class="nvalue">社会招聘</li></ul><div class="xiangqingtext"><p class="title">工作职责：</p><p>研发系统<br>维护系统</p><p class="title">任职资格：</p><p>本科及以上</p></div><a id="apply">现在申请</a>';
  it('旧 CMS 列表和详情解析，保留真实地点、职责、类别与详情 URL', async () => {
    const list = legacyList(legacyRow(1));
    const transport: PublicTransport = { Request: vi.fn(async (url) => ({ url, status: 200, body: url.includes('registerSystemInfo') ? '<title>Not Found</title>' : url.includes('zpdetail') ? legacyDetail : list })) };
    const run = await Run(transport);
    expect(run).toMatchObject({ health: 'healthy', snapshotStatus: 'complete' });
    expect(run.jobs[0]).toMatchObject({ id: 'beisen:example.zhiye.com:1', applicationUrl: 'https://example.zhiye.com/zpdetail/1', locations: ['广东省-佛山市'], description: '研发系统\n维护系统', requirements: '本科及以上', jobType: 'social_recruitment', publishedAt: '2026-09-20' });
    expect(run.jobs[0].updatedAt).toBeUndefined();
    expect(transport.Request).toHaveBeenCalledTimes(3);
  });
  it('旧 CMS 空列表不误关闭；定制热招页面不冒充全量', async () => {
    const transport: PublicTransport = { Request: vi.fn(async (url) => ({ url, status: 200, body: url.includes('registerSystemInfo') ? '<title>Not Found</title>' : legacyList('<tr><td colspan="4">无任何在招职位</td></tr>') })) };
    expect(await Run(transport)).toMatchObject({ health: 'empty', jobs: [], errors: [{ code: 'SOURCE_EMPTY', message: expect.any(String) }] });
    expect(() => ParseLegacyList('<div><a href="/zpdetail/1">热招</a></div>', source.url)).toThrow('unsupported custom layout');
  });
  it('旧 CMS 详情请求达到分段预算后自动续跑，不重读已完成详情或漏掉待处理项', async () => {
    const list = legacyList(Array.from({ length: 45 }, (_, index) => legacyRow(index + 1)).join(''));
    const details: number[] = [];
    const transport: PublicTransport = { Request: vi.fn(async (url) => {
      const id = url.match(/zpdetail\/(\d+)/)?.[1]; if (id) details.push(Number(id));
      return { url, status: 200, body: url.includes('registerSystemInfo') ? '<title>Not Found</title>' : id ? legacyDetail : list };
    }) };
    const store = new AtsFactStore(); const runner = new AtsSourceRunner(transport, store);
    const first = await runner.Run(source);
    expect(first.snapshotStatus).toBe('partial'); expect(first.continuation?.pendingRows?.length).toBeGreaterThan(0);
    expect(first.requestCount).toBe(30);
    const final = await runner.Run(source);
    expect(final.snapshotStatus).toBe('complete'); expect(final.jobs).toHaveLength(45);
    expect(new Set(details).size).toBe(45); expect(details).toHaveLength(45);
  });
  it('旧 CMS 下一页读取失败保留 partial，已读取详情不丢失', async () => {
    const list = legacyList(legacyRow(1), '<a href="/alljob/?PageIndex=2">2</a>');
    const transport: PublicTransport = { Request: vi.fn(async (url) => ({ url, status: url.includes('PageIndex') ? 403 : 200, body: url.includes('registerSystemInfo') ? '<title>Not Found</title>' : url.includes('zpdetail') ? legacyDetail : list })) };
    expect(await Run(transport)).toMatchObject({ health: 'partial', snapshotStatus: 'partial', jobs: [{ atsJobId: '1' }], errors: [{ code: 'SOURCE_403', message: expect.any(String) }] });
  });
  it('旧 CMS 单条详情变更隔离而不阻断其余岗位，快照不能视为完整', async () => {
    const list = legacyList(legacyRow(1) + legacyRow(2));
    const transport: PublicTransport = { Request: vi.fn(async (url) => ({ url, status: 200, body: url.includes('registerSystemInfo') ? '<title>Not Found</title>' : url.endsWith('/1') ? '<title>changed</title>' : url.includes('zpdetail') ? legacyDetail : list })) };
    expect(await Run(transport)).toMatchObject({ health: 'partial', snapshotStatus: 'partial', jobs: [{ atsJobId: '2' }], quarantine: [{ atsJobId: '1' }], receivedCount: 2 });
  });
  it('旧 CMS 表格布局详情及恶意跨域链接校验', () => {
    const item = ParseLegacyList(legacyList(legacyRow(1)), 'https://example.zhiye.com/alljob/').items[0];
    const detail = '<table><tr><td class="ntitle td-HasCities"><span>工作地点：</span></td><td class="nvalue"><span>上海市,北京市</span></td></tr></table><div class="detail"><h4>工作职责：</h4><span>算法研发</span></div><div class="detail"><h4>任职资格：</h4><span>三年经验</span></div><a id="apply">申请</a>';
    expect(ParseLegacyDetail(detail, item)).toMatchObject({ LocNames: ['上海市', '北京市'], Duty: '算法研发', Require: '三年经验' });
    expect(() => ParseLegacyList(legacyList(legacyRow(1).replace('/zpdetail/1', 'https://evil.example/zpdetail/1')), source.url)).toThrow('must stay');
    expect(() => ParseLegacyDetail('<title>Not Found</title>', item)).toThrow('expected application');
  });
  it('旧 CMS newdefault 表头映射，不固定地点列的位置', () => {
    const html = '<div class="positionlist-newdefault"><table><thead><tr><th class="jnameT">职位名称</th><th>招聘类别</th><th>招聘人数</th><th>工作地点</th><th>发布时间</th></tr></thead><tr><td><a href="/zpdetail/1">研发</a></td><td>校园招聘</td><td>3</td><td>北京,上海</td><td>2026-09-20</td></tr></table></div>';
    expect(ParseLegacyList(html, source.url).items[0].raw).toMatchObject({ Category: '校园招聘', LocNames: ['北京', '上海'], PostDate: '2026-09-20' });
  });
  it('单来源30请求预算包含重试观察，停止后保留 partial', async () => {
    const transport: PublicTransport = { Request: vi.fn(async (url, input) => {
      input.onRequest?.();
      input.onRequest?.();
      return { url, status: 200, body: url.includes('registerSystemInfo') ? '{"PortalId":"p"}' : JSON.stringify({ Data: Array.from({ length: 50 }, (_, index) => BeisenRow(Number((input.body as { PageIndex: number }).PageIndex) * 50 + index)), Count: 1000 }) };
    }) };
    const run = await Run(transport, { ...source, maxPages: 20 });
    expect(run).toMatchObject({ snapshotStatus: 'partial', requestCount: 30, errors: [{ code: 'SOURCE_REQUEST_LIMIT', message: expect.any(String) }] });
    expect(run.jobs.length).toBeGreaterThan(0);
  });
  it('JSON 全量分段重启续跑，最终完整集合才关闭缺失岗位', async () => {
    const file = join(await mkdtemp(join(tmpdir(), 'avery-ats-resume-')), 'facts.json');
    const store = new AtsFactStore(file);
    const old = await Run(Transport([{ Data: [BeisenRow(999)], Count: 1 }]));
    await store.Record(source, old);
    const calls: number[] = [];
    const transport: PublicTransport = { Request: vi.fn(async (url, input) => {
      if (!input.body) return { url, status: 200, body: '{"PortalId":"portal-1"}' };
      const index = Number((input.body as { PageIndex: number }).PageIndex);
      calls.push(index);
      return { url, status: 200, body: JSON.stringify({ Data: Array.from({ length: Math.min(50, 301 - index * 50) }, (_, ordinal) => BeisenRow(index * 50 + ordinal)), Count: 301 }) };
    }) };
    const first = await new AtsSourceRunner(transport, store).Run(source);
    expect(first).toMatchObject({ snapshotStatus: 'partial', continuation: { nextPage: 6, receivedCount: 250 } });
    expect(first.changes.some((change) => change.event === 'CLOSED')).toBe(false);
    calls.length = 0;
    const final = await new AtsSourceRunner(transport, new AtsFactStore(file)).Run(source);
    expect(final).toMatchObject({ snapshotStatus: 'complete', receivedCount: 301 });
    expect(final.jobs).toHaveLength(301);
    expect(calls).toEqual([0, 5, 6]);
    expect(final.changes.find((change) => change.id.endsWith(':999'))?.event).toBe('CLOSED');
    expect(await new AtsFactStore(file).GetContinuation(source.id)).toBeUndefined();
  });
  it('续跑验证发现第一页或总数改变，丢弃旧阶段并从第一页重新遍历', async () => {
    const store = new AtsFactStore();
    const first = await new AtsSourceRunner(Transport(Array.from({ length: 5 }, (_, index) => ({ Data: Array.from({ length: 50 }, (_, ordinal) => BeisenRow(index * 50 + ordinal)), Count: 301 }))), store).Run(source);
    expect(first.continuation).toBeDefined();
    const changed = await new AtsSourceRunner(Transport([{ Data: [BeisenRow(777)], Count: 1 }]), store).Run(source);
    expect(changed).toMatchObject({ snapshotStatus: 'complete', receivedCount: 1, jobs: [{ atsJobId: '777' }] });
    expect(await store.GetContinuation(source.id)).toBeUndefined();
  });
  it('从 BSGlobal 提取 PortalId，并保留缺失字段及正确申请链接', async () => {
    const transport = Transport();
    const result = await Run(transport);
    expect(result.health).toBe('healthy');
    expect(result.snapshotStatus).toBe('complete');
    expect(result.jobs[0]).toMatchObject({ id: 'beisen:example.zhiye.com:1', title: '工程师1', description: '开发工作', requirements: '专业要求', locations: ['上海'], applicationUrl: 'https://example.zhiye.com/jobdetail?jobAdId=uuid-1' });
    expect(result.jobs[0].publishedAt).toBeUndefined();
    expect(result.jobs[0].salary).toBeUndefined();
    expect(transport.Request).toHaveBeenCalledWith(expect.stringContaining('GetJobAdPageList'), expect.objectContaining({ body: expect.objectContaining({ PortalId: 'portal-1', PageIndex: 0, PageSize: 50, DisplayFields: expect.arrayContaining(['LocId', 'Salary', 'PostDate']) }) }));
  });
  it('缺少 PortalId 标记结构变化，不调用列表', async () => {
    const transport = Transport([], '<html>changed</html>');
    expect(await Run(transport)).toMatchObject({ health: 'schema_changed', snapshotStatus: 'unknown', jobs: [], errors: [{ code: 'SOURCE_SCHEMA_CHANGED', message: expect.any(String) }] });
    expect(transport.Request).toHaveBeenCalledTimes(1);
  });
  it('多页并满足 Count 时完整；ID 去重', async () => {
    const result = await Run(Transport([
      { Code: 200, Data: Array.from({ length: 50 }, (_, i) => BeisenRow(i)), Count: 51 },
      { Code: 200, Data: [BeisenRow(50)], Count: 51 },
    ]));
    expect(result.jobs).toHaveLength(51);
    expect(result.snapshotStatus).toBe('complete');
    expect(result.requestCount).toBe(3);
  });
  it('上限仍有剩余时标记 partial', async () => {
    const result = await Run(Transport(Array.from({ length: 5 }, (_, page) => ({ Data: Array.from({ length: 50 }, (_, i) => BeisenRow(page * 50 + i)), Count: 999 }))));
    expect(result.jobs).toHaveLength(250);
    expect(result.snapshotStatus).toBe('partial');
    expect(result.errors[0].code).toBe('SOURCE_PAGE_LIMIT');
  });
  it('不一致的短页、重复页、坏记录均不能证明完整', async () => {
    expect((await Run(Transport([{ Data: [BeisenRow(1)], Count: 100 }]))).snapshotStatus).toBe('partial');
    const rows = Array.from({ length: 50 }, (_, i) => BeisenRow(i));
    expect((await Run(Transport([{ Data: rows, Count: 100 }, { Data: rows, Count: 100 }]))).snapshotStatus).toBe('partial');
    const invalid = await Run(Transport([{ Data: [BeisenRow(1), { JobAdId: 2 }], Count: 2 }]));
    expect(invalid.quarantine).toHaveLength(1);
    expect(invalid.snapshotStatus).toBe('partial');
  });
  it('空列表不是关闭证据；结构变化显式报错', async () => {
    expect(await Run(Transport([{ Data: [], Count: 0 }]))).toMatchObject({ health: 'empty', jobs: [] });
    expect(await Run(Transport([{ Data: {} }]))).toMatchObject({ health: 'schema_changed', jobs: [] });
  });
  it('自定义域名通过页面特征识别北森', async () => {
    for (const url of ['file://app.mokahr.com/social-recruitment/c/1', 'https://user:secret@app.mokahr.com/social-recruitment/c/1', 'https://app.mokahr.com:444/social-recruitment/c/1']) {
      expect(() => CreateSource({ company: '乙', url })).toThrow('public HTTPS');
    }
    const custom = CreateSource({ url: 'https://careers.example.com/', company: '甲' });
    expect(await DetectAts(custom, Transport(), signal())).toBe('beisen');
    await expect(DetectAts(custom, Transport([], '<html>other</html>'), signal())).rejects.toMatchObject({ code: 'SOURCE_UNKNOWN_PLATFORM' });
  });
  it('已知但未适配平台须验证可访问性，网络失败保留平台线索', async () => {
    const item = CreateSource({ company: '乙', url: 'https://tenant.jobs.feishu.cn/' });
    await expect(DetectAts(item, Transport([], '<html>公开招聘</html>'), signal())).rejects.toMatchObject({ code: 'SOURCE_ADAPTER_UNAVAILABLE', detectedPlatform: 'feishu' });
    const denied: PublicTransport = { Request: vi.fn(async (url) => ({ url, status: 403, body: 'denied' })) };
    await expect(DetectAts(item, denied, signal())).rejects.toMatchObject({ code: 'SOURCE_403', detectedPlatform: 'feishu' });
    const failed: PublicTransport = { Request: vi.fn(async () => { throw new Error('ENOTFOUND'); }) };
    await expect(DetectAts(item, failed, signal())).rejects.toMatchObject({ code: 'SOURCE_NETWORK_ERROR', detectedPlatform: 'feishu' });
  });
  it('飞书自定义招聘入口须有站点元数据及招聘静态资源，普通集成字段不误判', async () => {
    const custom = CreateSource({ company: '乙', url: 'https://careers.example.com/' });
    const html = '<script>window.config={"website_info":{"id":"1"},"BeisenExamAccount":true};</script><img src="https://lf3-atsx-tob.feishucdn.com/obj/static-atsx-online-ee-tob/saas_career/banner.png">';
    await expect(DetectAts(custom, Transport([], html), signal())).rejects.toMatchObject({ code: 'SOURCE_ADAPTER_UNAVAILABLE', detectedPlatform: 'feishu' });
    for (const body of ['<script>window.config={"website_info":{},"BeisenExamAccount":true}</script>', '<img src="https://lf3-atsx-tob.feishucdn.com/obj/static-atsx-online-ee-tob/banner.png">', '<script>beisenInternalCode="abc"</script>']) {
      await expect(DetectAts(custom, Transport([], body), signal())).rejects.toMatchObject({ code: 'SOURCE_UNKNOWN_PLATFORM' });
    }
  });
  it('HTTP 401/403 不绕过，验证码 SDK 本身不误判', async () => {
    for (const status of [401, 403]) {
      expect(await Run({ Request: vi.fn(async (url) => ({ url, status, body: 'blocked' })) })).toMatchObject({ health: 'access_controlled' });
    }
    expect((await Run(Transport(undefined, '<script src="captcha.js"></script><script>BSGlobal={"PortalId":"a"}</script>'))).health).toBe('healthy');
    expect((await Run(Transport(undefined, '<title>人机验证</title>'))).errors[0].code).toBe('SOURCE_CAPTCHA');
  });
  it('页请求失败保留之前的部分快照', async () => {
    const transport = Transport([{ Data: Array.from({ length: 50 }, (_, i) => BeisenRow(i)), Count: 100 }, { unexpected: true }]);
    const result = await Run(transport);
    expect(result.jobs).toHaveLength(50);
    expect(result.health).toBe('partial');
    expect(result.snapshotStatus).toBe('partial');
  });
  it.each(['campus', 'social'] as const)('Moka %s 解析租户、分页，缺失要求不推测', async (mode) => {
    const moka = CreateSource({ url: `https://app.mokahr.com/${mode}-recruitment/company/123`, company: '乙' });
    const transport: PublicTransport = { Request: vi.fn(async (url) => ({ url, status: 200, body: url.includes('api-platform') ? JSON.stringify({ jobs: [{ id: 7, title: '研发', status: 'open', description: '岗位描述', locations: [{ name: '北京' }] }], total: 1 }) : '<html></html>' })) };
    const result = await Run(transport, moka);
    expect(result.health).toBe('healthy');
    expect(result.jobs[0].requirements).toBeUndefined();
    expect(result.jobs[0].jobType).toBe(`${mode}_recruitment`);
    expect(transport.Request).toHaveBeenCalledWith(expect.stringContaining(`mode=${mode}&limit=50&offset=0`), expect.anything());
  });
  it('Moka 空岗位、结构变化、私有接口与自定义域名分别处理', async () => {
    const moka = CreateSource({ url: 'https://app.mokahr.com/social-recruitment/company/123', company: '乙' });
    for (const [body, health] of [['{"jobs":[]}', 'empty'], ['{}', 'schema_changed'], ['{"encrypted":true}', 'unsupported']] as const) {
      const result = await Run({ Request: vi.fn(async (url) => ({ url, status: 200, body })) }, moka);
      expect(result.health).toBe(health);
      if (health === 'unsupported') expect(result.transport).toBe('unsupported_private_api');
    }
    await expect(new MokaPublicAdapter().probe(CreateSource({ url: 'https://custom.example.com/social-recruitment/c/1', company: '乙' }), Transport(), signal())).rejects.toMatchObject({ code: 'SOURCE_UNSUPPORTED' });
  });
  it('单来源失败不终止批次，外部取消不写假成功', async () => {
    const transport: PublicTransport = { Request: vi.fn(async (url) => ({ url, status: new URL(url).hostname.startsWith('bad.') ? 403 : 200, body: url.includes('registerSystemInfo') ? '{"PortalId":"p"}' : JSON.stringify({ Data: [BeisenRow(1)], Count: 1 }) })) };
    const runner = new AtsSourceRunner(transport);
    const results = await runner.RunBatch([source, CreateSource({ url: 'https://bad.zhiye.com/', company: '坏' })]);
    expect(results.map((r) => r.health)).toEqual(['healthy', 'access_controlled']);
    const controller = new AbortController(); controller.abort(new Error('cancelled'));
    await expect(runner.RunBatch([source], controller.signal)).rejects.toThrow('cancelled');
  });

  it.each(['beisen', 'moka'] as const)('%s 来源总预算30秒，超时不接收迟到成功', async (ats) => {
    const expired = AbortSignal.abort(new DOMException('Source timeout', 'TimeoutError'));
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(expired);
    try {
      const item = ats === 'beisen' ? source : CreateSource({ company: '乙', url: 'https://app.mokahr.com/social-recruitment/test/1' });
      const transport = ats === 'beisen' ? Transport() : { Request: vi.fn(async (url: string) => ({ url, status: 200, body: JSON.stringify({ jobs: [{ id: 1, title: '研发' }], total: 1 }) })) };
      const result = await Run(transport, item);
      expect(timeout).toHaveBeenCalledWith(30_000);
      expect(result).toMatchObject({ health: 'timeout', snapshotStatus: 'unknown', jobs: [], errors: [{ code: 'SOURCE_TIMEOUT', message: expect.any(String) }] });
    } finally { timeout.mockRestore(); }
  });
});

describe('ATS fact diff and tool integration', () => {
  it('变化驱动匹配：新增与关键变化执行，未变复用，重复事件不重复候选', async () => {
    const run = await Run(Transport());
    const matcher = new AtsCandidateMatcher();
    const match = vi.fn(() => true);
    expect(await matcher.Process({}, [run, run], match)).toMatchObject({ processed: 1, jobs: [run.jobs[0]] });
    expect(await matcher.Process({}, [{ ...run, changes: [{ id: run.jobs[0].id, event: 'UNCHANGED', rematch: false }] }], match)).toMatchObject({ processed: 0, reused: 1 });
    expect(await matcher.Process({}, [{ ...run, jobs: [{ ...run.jobs[0], rawHash: 'changed' }], changes: [{ id: run.jobs[0].id, event: 'UPDATED', rematch: true }] }], match)).toMatchObject({ processed: 1 });
    expect(match).toHaveBeenCalledTimes(2);
  });
  it('匹配结果重启复用，新条件单独匹配；失败单独保存并可重试', async () => {
    const file = join(await mkdtemp(join(tmpdir(), 'avery-ats-matching-')), 'matches.json');
    const run = await Run(Transport());
    await new AtsCandidateMatcher(file).Process({ city: '上海' }, [run], () => true);
    const match = vi.fn(() => true);
    expect(await new AtsCandidateMatcher(file).Process({ city: '上海' }, [run], match)).toMatchObject({ processed: 0, reused: 1 });
    expect(match).not.toHaveBeenCalled();
    const failed = await new AtsCandidateMatcher(file).Process({ city: '北京' }, [run], () => { throw new Error('match unavailable'); });
    expect(failed).toMatchObject({ jobs: [], errors: [{ jobId: run.jobs[0].id, message: 'match unavailable' }] });
    expect(JSON.parse(await readFile(file, 'utf8')).errors).toHaveLength(1);
    expect(await new AtsCandidateMatcher(file).Process({ city: '北京' }, [run], match)).toMatchObject({ processed: 1, jobs: [run.jobs[0]] });
  });
  it('关闭、unknown、stale 不推荐；重新开放进入匹配', async () => {
    const run = await Run(Transport());
    for (const status of ['closed', 'unknown', 'stale'] as const) {
      const matcher = new AtsCandidateMatcher();
      await matcher.Process({}, [run], () => true);
      const match = vi.fn(() => true);
      expect(await matcher.Process({}, [{ ...run, jobs: [{ ...run.jobs[0], status }] }], match)).toMatchObject({ jobs: [], processed: 0 });
      expect(match).not.toHaveBeenCalled();
      expect(await matcher.Process({}, [run], match)).toMatchObject({ processed: 1 });
    }
  });
  it('完整缺失关闭及 stale 事件清理其他条件缓存，数据源隔离', async () => {
    const run = await Run(Transport());
    const matcher = new AtsCandidateMatcher();
    await matcher.Process({ city: '上海' }, [run], () => true);
    await matcher.Process({ city: '北京' }, [run], () => true);
    await matcher.Process({}, [{ ...run, jobs: [], changes: [{ id: run.jobs[0].id, event: 'CLOSED', rematch: false }] }], () => true);
    expect(await matcher.Process({ city: '上海' }, [run], () => true)).toMatchObject({ processed: 1 });
    const other = { ...run, sourceId: 'other', jobs: run.jobs.map((job) => ({ ...job, sourceId: 'other' })) };
    expect(await matcher.Process({ city: '上海' }, [other], () => true)).toMatchObject({ processed: 1 });
  });
  it('筛选字段变化也重算，拒绝匹配结果同样缓存', async () => {
    const run = await Run(Transport());
    const matcher = new AtsCandidateMatcher();
    const match = vi.fn(() => false);
    expect(await matcher.Process({}, [run], match)).toMatchObject({ processed: 1, jobs: [] });
    expect(await matcher.Process({}, [run], match)).toMatchObject({ processed: 0, reused: 1, jobs: [] });
    expect(await matcher.Process({}, [{ ...run, jobs: [{ ...run.jobs[0], salary: '30K' }] }], match)).toMatchObject({ processed: 1 });
  });
  it('匹配取消不继续执行；条件分区数量受限且保留当前分区', async () => {
    const file = join(await mkdtemp(join(tmpdir(), 'avery-ats-match-limit-')), 'matches.json');
    const run = await Run(Transport());
    const matcher = new AtsCandidateMatcher(file);
    const match = vi.fn(() => true);
    await expect(matcher.Process({}, [run], match, AbortSignal.abort(new Error('cancelled')))).rejects.toThrow('cancelled');
    expect(match).not.toHaveBeenCalled();
    for (let index = 0; index < 33; index += 1) await matcher.Process({ index }, [run], match);
    const state = JSON.parse(await readFile(file, 'utf8'));
    expect(Object.keys(state.scopes)).toHaveLength(32);
    expect(await new AtsCandidateMatcher(file).Process({ index: 32 }, [run], match)).toMatchObject({ processed: 0, reused: 1 });
  });
  it('匹配缓存损坏仍保留采集事实，工具返回明确警告', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'avery-ats-match-error-'));
    const file = join(directory, 'facts.json');
    const { writeFile } = await import('node:fs/promises');
    await writeFile(`${file}.matches.json`, 'invalid-json');
    const browser = { EvaluateTrustedPage: vi.fn() } as unknown as BrowserAutomationPort;
    const runner = new AtsSourceRunner(Transport(), new AtsFactStore(file));
    const service = new JobCollectionService({ browser, atsRunner: runner, atsStorePath: file, loadViewModel: () => ({ jobs: [], applications: [] }), saveJob: vi.fn() });
    try {
      const result = await service.Collect({ sessionId: 's', platforms: ['beisen'], sources: [{ url: source.url, company: source.company }], queries: [], maxResults: 10, sort: 'relevance' });
      expect(result.candidates).toEqual([]);
      expect(result.warnings.some((warning) => warning.includes('ATS_MATCH_FAILED'))).toBe(true);
      expect(result.matching?.failed).toBe(1);
      expect(Object.keys(JSON.parse(await readFile(file, 'utf8')).jobs)).toHaveLength(1);
    } finally { service.Close(); }
  });
  it('NEW、UNCHANGED、UPDATED、CLOSED；部分/未知/失败/空不关闭，30天 stale', async () => {
    const result = await Run(Transport([{ Data: [BeisenRow(1), BeisenRow(2)], Count: 2 }]));
    expect(ApplySnapshot([], result, result.finishedAt).changes.map((c) => c.event)).toEqual(['NEW', 'NEW']);
    expect(ApplySnapshot(result.jobs, result, result.finishedAt).changes.map((c) => c.event)).toEqual(['UNCHANGED', 'UNCHANGED']);
    const updated = { ...result, jobs: [{ ...result.jobs[0], rawHash: 'changed' }] };
    expect(ApplySnapshot(result.jobs, updated, result.finishedAt).changes.map((c) => c.event)).toEqual(['UPDATED', 'CLOSED']);
    const explicitlyClosed = ApplySnapshot(result.jobs, { ...result, jobs: [{ ...result.jobs[0], status: 'closed' }, result.jobs[1]] }, result.finishedAt);
    expect(explicitlyClosed.changes[0]).toMatchObject({ event: 'CLOSED', rematch: false });
    for (const variant of [{ ...updated, snapshotStatus: 'partial' }, { ...updated, snapshotStatus: 'unknown' }, { ...updated, health: 'timeout' }, { ...result, jobs: [] }] as SourceResult[]) {
      expect(ApplySnapshot(result.jobs, variant, result.finishedAt).changes.some((c) => c.event === 'CLOSED')).toBe(false);
    }
    const at = new Date(Date.parse(result.finishedAt) + 31 * 86400_000).toISOString();
    expect(ApplySnapshot(result.jobs, { ...result, jobs: [], health: 'empty' }, at).jobs.every((job) => job.status === 'stale')).toBe(true);
  });
  it('事实存储持久化并隔离同租户不同来源，重启保留 firstSeenAt', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'avery-ats-test-'));
    const file = join(directory, 'facts.json');
    const store = new AtsFactStore(file);
    const first = await Run(Transport());
    await store.Record(source, first);
    const other = { ...source, id: 'other', url: 'https://example.zhiye.com/campus' };
    await store.Record(other, { ...first, sourceId: other.id, jobs: first.jobs.map((job) => ({ ...job, sourceId: other.id })) });
    const restarted = new AtsFactStore(file);
    const later = { ...first, finishedAt: new Date(Date.parse(first.finishedAt) + 1000).toISOString() };
    expect((await restarted.Record(source, later)).changes[0].event).toBe('UNCHANGED');
    const data = JSON.parse(await readFile(file, 'utf8'));
    expect(Object.keys(data.jobs)).toHaveLength(2);
    expect(data.sourceRuns[0].fieldQuality).toEqual({ present: { locations: 1, description: 1, requirements: 1, updatedAt: 1 }, issues: {} });
    expect(data.sourceRuns[0].jobs).toBeUndefined();
    expect(Object.values(data.jobs).map((job: unknown) => (job as { firstSeenAt: string }).firstSeenAt)).toEqual([first.finishedAt, first.finishedAt]);
    await restarted.Record(source, { ...later, jobs: [], health: 'partial', snapshotStatus: 'unknown', errors: [{ code: 'SOURCE_NETWORK_ERROR', message: 'connection failed' }], finishedAt: new Date(Date.parse(later.finishedAt) + 1000).toISOString() });
    const failed = JSON.parse(await readFile(file, 'utf8'));
    expect(failed.sources[source.id].lastSuccessAt).toBe(later.finishedAt);
  });
  it('ATS 不操作浏览器，不自动保存，最多10个；保存走官网渠道并支持缓存删除', async () => {
    const browser = { EvaluateTrustedPage: vi.fn(), Prepare: vi.fn(), Execute: vi.fn() } as unknown as BrowserAutomationPort;
    const saveJob = vi.fn(async (job) => ({ jobId: job.jobId, jobRevision: 1 }));
    const runner = new AtsSourceRunner(Transport([{ Data: Array.from({ length: 12 }, (_, i) => BeisenRow(i)), Count: 12 }]));
    const service = new JobCollectionService({ browser, atsRunner: runner, loadViewModel: () => ({ jobs: [], applications: [] }), saveJob });
    try {
      const result = await service.Collect({ sessionId: 's', platforms: ['beisen'], sources: [{ url: source.url, company: source.company }], queries: [], maxResults: 10, sort: 'relevance' });
      expect(result.candidates).toHaveLength(10);
      expect(result.truncated).toBe(true);
      expect(saveJob).not.toHaveBeenCalled();
      expect(browser.Prepare).not.toHaveBeenCalled();
      await service.SaveCandidate({ sessionId: 's', collectionId: result.collectionId, candidateId: result.candidates[0].candidateId });
      expect(saveJob).toHaveBeenCalledWith(expect.objectContaining({ channel: 'company_website', sourceJobId: 'beisen:example.zhiye.com:0' }));
      service.DeleteSession('s');
      await expect(service.SaveCandidate({ sessionId: 's', collectionId: result.collectionId, candidateId: result.candidates[1].candidateId })).rejects.toMatchObject({ code: 'JOB_COLLECTION_EXPIRED' });
    } finally { service.Close(); }
  });
  it('跨周期从磁盘恢复：非完整结果保留既有岗位，完整缺失才关闭', async () => {
    const file = join(await mkdtemp(join(tmpdir(), 'avery-ats-cycles-')), 'facts.json');
    const initial = await Run(Transport([{ Data: [BeisenRow(1), BeisenRow(2)], Count: 2 }]));
    await new AtsFactStore(file).Record(source, initial);
    let time = Date.parse(initial.finishedAt);
    const variants: SourceResult[] = [
      { ...initial, snapshotStatus: 'partial', health: 'partial', jobs: [initial.jobs[0]] },
      { ...initial, snapshotStatus: 'unknown', health: 'schema_changed', jobs: [], errors: [{ code: 'SOURCE_SCHEMA_CHANGED', message: 'changed' }] },
      { ...initial, snapshotStatus: 'unknown', health: 'timeout', jobs: [], errors: [{ code: 'SOURCE_TIMEOUT', message: 'timeout' }] },
      { ...initial, health: 'empty', jobs: [] },
    ];
    for (const variant of variants) {
      const result = await new AtsFactStore(file).Record(source, { ...variant, finishedAt: new Date(time += 1000).toISOString() });
      expect(result.changes.some((change) => change.event === 'CLOSED')).toBe(false);
      const stored = JSON.parse(await readFile(file, 'utf8'));
      expect((Object.values(stored.jobs) as Array<{ status: string; firstSeenAt: string }>).map((job) => [job.status, job.firstSeenAt])).toEqual([
        ['open', initial.finishedAt], ['open', initial.finishedAt],
      ]);
    }
    const changed = await new AtsFactStore(file).Record(source, {
      ...initial, jobs: [{ ...initial.jobs[0], title: '高级工程师', rawHash: 'updated' }], finishedAt: new Date(time += 1000).toISOString(),
    });
    expect(changed.changes.map((change) => [change.event, change.rematch])).toEqual([['UPDATED', true], ['CLOSED', false]]);
    const stored = JSON.parse(await readFile(file, 'utf8'));
    expect((Object.values(stored.jobs) as Array<{ firstSeenAt: string }>).map((job) => job.firstSeenAt)).toEqual([initial.finishedAt, initial.finishedAt]);
  });
});
