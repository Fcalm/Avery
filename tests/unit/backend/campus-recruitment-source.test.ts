import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { JobCollectionInputSchema } from '@avery/contracts';
import { CampusRecruitmentSource, CampusRecruitmentUrl, IsExpiredCampusRecruitment, ParseCampusManifest } from '../../../apps/backend/src/electron/backend/campus-recruitment-source';
import type { PublicTransport } from '../../../apps/backend/src/electron/backend/ats/types';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const Row = (extra = {}) => ({ company: '测试企业', batch: '27届秋招', location: '上海、北京', positions: '产品经理', appLink: 'https://test.zhiye.com/jobs?channel=ad', deadline: '1900-01-01', ...extra });
const Html = (files = ['p1.v1'], comm: unknown[] = []) => `const META = ${JSON.stringify({ ver: files[0], files, total: 2, comm })};\nconst COMM_DATA = META.comm || [];`;
async function Fixture() {
  const root = await mkdtemp(join(tmpdir(), 'avery-campus-')); roots.push(root);
  const request = vi.fn<PublicTransport['Request']>(async (url) => ({ url, status: 200, body: url === CampusRecruitmentUrl ? Html() : JSON.stringify([Row(), Row({ appLink: 'https://mp.weixin.qq.com/s/x' })]), etag: '"v1"' }));
  return { path: join(root, 'cache.json'), request, transport: { Request: request } };
}
const Input = (extra = {}) => JobCollectionInputSchema.parse({ channel: 'campus_aggregator', ...extra });
const Signal = () => new AbortController().signal;

describe('校招公告发现与缓存', () => {
  it.each(['2026届及以后', '26届起', '2026届及以上', '2026-2027届', '２６／２７届', '26、27届', '2026年9月至2027年8月毕业', '不限届别（26届也可）'])('保留不能确定已失效的范围：%s', (batch) => {
    expect(IsExpiredCampusRecruitment(batch)).toBe(false);
  });
  it('汇总入口默认只接受官网校招/实习分类；既有企业渠道默认不限', () => {
    expect(Input().jobSeekingTypes).toEqual(['campus_recruitment', 'intern']);
    expect(JobCollectionInputSchema.parse({ channel: 'company_website' }).jobSeekingTypes).toEqual([]);
    expect(Input({ jobSeekingTypes: ['social_recruitment'] }).jobSeekingTypes).toEqual(['social_recruitment']);
  });
  it('同版本跨查询/重启复用分片，只输出ATS入口，不复制截止日期或摘要', async () => {
    const f = await Fixture();
    const first = await new CampusRecruitmentSource(f.path, f.transport).Discover(Input({ graduationYear: 2027, city: '上海', keyword: '产品' }), Signal());
    expect(first.discovery).toMatchObject({ total: 2, matched: 2, sources: 1, skipped: 1, cacheHit: false, reasons: { 仅微信公众号: 1 } });
    expect(first.sources[0].url).toBe('https://test.zhiye.com/jobs');
    expect(JSON.stringify(first.sources)).not.toContain('1900'); expect(JSON.stringify(first.sources)).not.toContain('产品经理');
    expect((await new CampusRecruitmentSource(f.path, f.transport).Discover(Input({ company: '不存在' }), Signal())).discovery).toMatchObject({ matched: 0, cacheHit: true });
    expect(f.request).toHaveBeenCalledTimes(2);
  });
  it('先清除明确过期公告及缓存，保留跨届、未知届别和当年发布的新届别招聘', async () => {
    const f = await Fixture();
    const batches = ['26届补招', '26春招', '26春招补录', '2025届校招', '2026届秋招',
      '27届秋招', '2027届实习', '26/27届秋招', '2026至2028届', '2026届、2027届', '日常实习', '2026年秋招（2027届）', '2026年秋招'];
    const rows = batches.map((batch, i) => Row({ batch, appLink: `https://t${i}.zhiye.com/jobs` }));
    f.request.mockImplementation(async (url) => ({ url, status: 200, body: url === CampusRecruitmentUrl ? Html(['p1.v1'], [Row({ batch: '26届补招' })]) : JSON.stringify(rows), etag: '"v1"' }));
    const service = new CampusRecruitmentSource(f.path, f.transport);
    const first = await service.Discover(Input(), Signal());
    expect(first.discovery).toMatchObject({ total: 14, matched: 8, sources: 8, skipped: 6, reasons: { '过期届别或批次（2026及以前）': 6 } });
    const cached = JSON.parse(await readFile(f.path, 'utf8'));
    expect(cached.manifest.comm).toEqual([]);
    expect(cached.files['p1.v1'].rows.map((row: { batch: string }) => row.batch)).toEqual(batches.slice(5));
    const second = await new CampusRecruitmentSource(f.path, f.transport).Discover(Input({ graduationYear: 2026 }), Signal());
    expect(second.discovery).toMatchObject({ total: 14, skipped: 6, cacheHit: true });
    expect(second.sources.map((source) => source.url)).not.toContain('https://t4.zhiye.com/jobs');
    expect(f.request).toHaveBeenCalledTimes(2);
    f.request.mockImplementation(async (url) => ({ url, status: 304, body: '' }));
    expect((await service.Discover(Input({ refresh: true }), Signal())).discovery).toMatchObject({ total: 14, matched: 8, skipped: 6 });
    // 源站重新返回原始旧数据时仍要清理，不能把已清理数量重复累加。
    f.request.mockImplementation(async (url) => ({ url, status: 200, body: url === CampusRecruitmentUrl ? Html(['p1.v2'], [Row({ batch: '26届补招' })]) : JSON.stringify(rows) }));
    expect((await service.Discover(Input({ refresh: true }), Signal())).discovery).toMatchObject({ total: 14, matched: 8, skipped: 6 });
    expect(Object.keys(JSON.parse(await readFile(f.path, 'utf8')).files)).toEqual(['p1.v2']);
  });
  it('旧版热缓存无需重新下载即可清理，清理计数不随重启重复增加', async () => {
    const f = await Fixture();
    await writeFile(f.path, JSON.stringify({ schemaVersion: 1, checkedAt: Date.now(), manifest: { ver: 'v1', files: ['p1.v1'], total: 2, comm: [] },
      files: { 'p1.v1': { rows: [Row({ batch: '26春招' }), Row()] } } }));
    for (let i = 0; i < 2; i++) {
      const result = await new CampusRecruitmentSource(f.path, f.transport).Discover(Input(), Signal());
      expect(result.discovery).toMatchObject({ total: 2, matched: 1, skipped: 1, cacheHit: true });
      expect(JSON.parse(await readFile(f.path, 'utf8')).files['p1.v1'].rows).toHaveLength(1);
    }
    expect(f.request).not.toHaveBeenCalled();
  });
  it('刷新使用条件请求，304复用；新版本只读取新分片', async () => {
    const f = await Fixture(); const service = new CampusRecruitmentSource(f.path, f.transport);
    await service.Discover(Input(), Signal());
    f.request.mockImplementation(async (url) => ({ url, status: 304, body: '' }));
    expect((await service.Discover(Input({ refresh: true }), Signal())).sources).toHaveLength(1);
    expect(f.request.mock.calls[2][1].ifNoneMatch).toBe('"v1"'); expect(f.request.mock.calls[3][1].ifNoneMatch).toBe('"v1"');
    f.request.mockImplementation(async (url) => ({ url, status: 200, body: url === CampusRecruitmentUrl ? Html(['p1.v1', 'p2.v2']) : JSON.stringify([Row({ company: '新企业', appLink: 'https://new.jobs.feishu.cn/campus/' })]) }));
    // 超出TTL后只校验入口并获取新增文件，已有版本分片不重新读取。
    const now = Date.now(); vi.spyOn(Date, 'now').mockReturnValue(now + 16 * 60_000);
    try { expect((await service.Discover(Input(), Signal())).sources).toHaveLength(2); }
    finally { vi.restoreAllMocks(); }
    expect(f.request.mock.calls.slice(4).map(([url]) => url)).toEqual([CampusRecruitmentUrl, 'https://campus.sma-wiki.cn/campus/data/p2.v2.json']);
  });
  it('准确筛选届别/批次，城市全国作为候选，未知入口不成为岗位', async () => {
    const f = await Fixture();
    f.request.mockImplementation(async (url) => ({ url, status: 200, body: url === CampusRecruitmentUrl ? Html() : JSON.stringify([
      Row({ batch: '26届秋招' }), Row({ location: '杭州' }), Row({ batch: '27届实习' }),
      Row({ location: '全国', appLink: 'https://app.mokahr.com/campus-recruitment/a/1' }),
      Row({ appLink: 'https://test.zhiye.com.evil.example/' }), Row({ appLink: 'http://test.zhiye.com/' }),
    ]) }));
    const result = await new CampusRecruitmentSource(f.path, f.transport).Discover(Input({ graduationYear: 2027, batch: '秋招', city: '上海' }), Signal());
    expect(result.discovery).toMatchObject({ matched: 3, sources: 1, skipped: 3, reasons: { '过期届别或批次（2026及以前）': 1 } }); expect(result.sources[0].platform).toBe('moka');
  });
  it('分页下载中断保存已下载分片，失败不伪装为空结果，后续续拉', async () => {
    const f = await Fixture(); let failed = true;
    f.request.mockImplementation(async (url) => {
      if (url.includes('p2') && failed) throw new Error('network');
      return { url, status: 200, body: url === CampusRecruitmentUrl ? Html(['p1.v1', 'p2.v1']) : JSON.stringify([Row()]) };
    });
    const service = new CampusRecruitmentSource(f.path, f.transport);
    await expect(service.Discover(Input(), Signal())).rejects.toThrow('network'); failed = false;
    expect((await service.Discover(Input(), Signal())).sources).toHaveLength(1);
    expect(f.request.mock.calls.filter(([url]) => url.includes('p1.v1'))).toHaveLength(1);
  });
  it('只解析JSON、不执行代码，异常清单和登录失败显式报错', async () => {
    expect(() => ParseCampusManifest('const META = process.exit(); const COMM_DATA = [];')).toThrow('invalid');
    expect(() => ParseCampusManifest(Html(['../secret']))).toThrow('invalid');
    const f = await Fixture(); f.request.mockResolvedValue({ url: CampusRecruitmentUrl, status: 403, body: '' });
    await expect(new CampusRecruitmentSource(f.path, f.transport).Discover(Input(), Signal())).rejects.toMatchObject({ code: 'SOURCE_403' });
  });
});
