import { describe, expect, it, vi } from 'vitest';
import { AtsFactStore, AtsSourceRunner, CreateSource } from '../../../apps/backend/src/electron/backend/ats/source-runner';
import type { PublicTransport } from '../../../apps/backend/src/electron/backend/ats/types';

const Html = `<script id="js-websiteInfo" type="text/json">${JSON.stringify({ website_info: { path: 'campus' }, tenant_info: { tenant_name: '官网企业' } })}</script>`;
const Row = (id = '1') => ({ id, title: '产品经理', description: '职责\\n产品设计', requirement: '本科', city_list: [{ name: '上海' }], recruit_type: { name: '正式', parent: { name: '校招' } }, channel_online_status: 1 });
const Source = (direct = false) => CreateSource({ company: '第三方简称', url: `https://test.jobs.feishu.cn/campus/${direct ? 'position/1/detail' : ''}` });
const Signal = () => new AbortController().signal;
function Transport(rows = [Row()], count = rows.length) {
  return { Request: vi.fn<PublicTransport['Request']>(async (url) => ({ url, status: 200, body: url.includes('/api/') ? JSON.stringify({ code: 0, data: url.includes('/search/') ? { job_post_list: rows, count } : { job_post_detail: rows[0] } }) : Html })) };
}
describe('飞书公开岗位适配器', () => {
  it('列表使用官网企业名和结构化类型，地点、换行正确，不猜测学历', async () => {
    const transport = Transport(); const result = await new AtsSourceRunner(transport).Run(Source(), Signal());
    expect(result).toMatchObject({ health: 'healthy', snapshotStatus: 'complete', jobs: [{ company: '官网企业', atsJobId: '1', jobType: 'campus_recruitment', locations: ['上海'], education: undefined, description: '职责\n产品设计', status: 'open', applicationUrl: 'https://test.jobs.feishu.cn/campus/position/1/detail' }] });
    const call = transport.Request.mock.calls.find(([url]) => url.includes('/search/'))!;
    expect(call[1]).toMatchObject({ method: 'POST', feishuPath: 'campus', body: { offset: 0, portal_type: 6 } });
    expect(JSON.stringify(call)).not.toMatch(/signature|cookie|csrf/i);
  });
  it('单岗位公开详情不声明企业完整；身份错误和受限列表不能当空岗位', async () => {
    const direct = await new AtsSourceRunner(Transport()).Run(Source(true), Signal());
    expect(direct).toMatchObject({ scope: 'single_job', snapshotStatus: 'partial', jobs: [{ atsJobId: '1' }] });
    const wrong = await new AtsSourceRunner(Transport([Row('2')])).Run(Source(true), Signal());
    expect(wrong.health).toBe('schema_changed'); expect(wrong.jobs).toHaveLength(0);
    const transport = Transport(); transport.Request.mockImplementation(async (url) => ({ url, status: url.includes('/api/') ? 405 : 200, body: Html }));
    expect(await new AtsSourceRunner(transport).Run(Source(), Signal())).toMatchObject({ health: 'unsupported', jobs: [], errors: [{ code: 'SOURCE_BROWSER_REQUIRED', message: expect.any(String) }] });
  });
  it('重复列表页不能声明完整或关闭旧岗位，401/403不绕过', async () => {
    const rows = Array.from({ length: 50 }, (_, i) => Row(String(i)));
    const result = await new AtsSourceRunner(Transport(rows, 100)).Run(Source(), Signal());
    expect(result.snapshotStatus).toBe('partial'); expect(result.errors[0].code).toBe('SOURCE_SCHEMA_CHANGED');
    for (const status of [401, 403]) {
      const transport = { Request: vi.fn(async (url: string) => ({ url, status, body: '' })) };
      expect((await new AtsSourceRunner(transport).Run(Source(), Signal())).health).toBe('access_controlled');
      expect(transport.Request).toHaveBeenCalledTimes(1);
    }
  });
  it('生产使用有效事实缓存，刷新重新联网，默认测试/诊断仍执行真实探测', async () => {
    const transport = Transport(); const store = new AtsFactStore(); const runner = new AtsSourceRunner(transport, store);
    await runner.Run(Source(), Signal(), { useCache: true });
    const requests = transport.Request.mock.calls.length;
    expect((await runner.Run(Source(), Signal(), { useCache: true })).cacheHit).toBe(true);
    expect(transport.Request).toHaveBeenCalledTimes(requests);
    await runner.Run(Source(), Signal(), { useCache: true, refresh: true });
    expect(transport.Request).toHaveBeenCalledTimes(requests * 2);
  });
  it('部分缓存保持partial，数量不足时可继续检查点，不反复返回同一缓存', async () => {
    const source = { ...Source(), maxPages: 5 as const };
    const transport = Transport();
    transport.Request.mockImplementation(async (url, input) => {
      const offset = Number((input.body as { offset?: number })?.offset ?? 0);
      return { url, status: 200, body: url.includes('/api/') ? JSON.stringify({ code: 0, data: { job_post_list: Array.from({ length: 50 }, (_, index) => Row(String(offset + index))), count: 300 } }) : Html };
    });
    const runner = new AtsSourceRunner(transport);
    expect(await runner.Run(source, Signal())).toMatchObject({ snapshotStatus: 'partial', jobs: expect.any(Array) });
    const requests = transport.Request.mock.calls.length;
    expect(await runner.Run(source, Signal(), { useCache: true, reusePartial: true })).toMatchObject({ snapshotStatus: 'partial', cacheHit: true, continuation: { nextPage: 6 } });
    expect(transport.Request).toHaveBeenCalledTimes(requests);
    const complete = await runner.Run(source, Signal(), { useCache: false });
    expect(complete.snapshotStatus).toBe('complete'); expect(complete.jobs).toHaveLength(300);
  });
});
