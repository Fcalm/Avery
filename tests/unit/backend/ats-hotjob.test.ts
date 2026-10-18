import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { AtsError, type PublicTransport } from '../../../apps/backend/src/electron/backend/ats/types';
import { AtsFactStore, AtsSourceRunner, CreateSource } from '../../../apps/backend/src/electron/backend/ats/source-runner';
import { JobCollectionService } from '../../../apps/backend/src/electron/backend/job-collection-service';
import type { BrowserAutomationPort } from '../../../packages/agent-sdk/src/tools';

const url = 'https://tenant.hotjob.cn/SU64d47c466202cc36e27a52d4/pb/social.html';
const source = CreateSource({ url, company: '企业' });
function Transport(count = 1, failAt = Infinity): PublicTransport {
  let calls = 0;
  return { Request: vi.fn(async (url, input) => {
    if (++calls === failAt) throw new AtsError('SOURCE_REQUEST_LIMIT', 'budget');
    const body = input.body as Record<string, unknown>;
    let data: unknown;
    if (url.includes('listPositionDetail')) data = { postId: body.postId, postName: `岗位${body.postId}`, workContent: '职责', serviceCondition: '要求', workPlaceList: [{ name: '上海' }], showDeliverButton: 1, longTermRelease: 1 };
    else if (url.includes('getSLD')) data = { linkData: { link: 'https://tenant.hotjob.cn/SU64d47c466202cc36e27a52d4/pb/custom.html' } };
    else {
      const page = Number(body.currentPage);
      data = { pageForm: { currentPage: page, pageSize: 12, dataCount: count, pageData: Array.from({ length: Math.min(12, count - (page - 1) * 12) }, (_, index) => ({ postId: String((page - 1) * 12 + index), postName: '岗位', publishDate: '2026-09-20' })) } };
    }
    return { url, status: 200, body: JSON.stringify({ state: '200', data }) };
  }) };
}
describe('Hotjob public category collection', () => {
  it('表单编码、详情真实字段、源站身份和正确申请路由', async () => {
    const transport = Transport();
    const result = await new AtsSourceRunner(transport).Run(source);
    expect(result).toMatchObject({ ats: 'hotjob', snapshotStatus: 'complete', publicJobCount: 1, jobs: [{ status: 'open', locations: ['上海'], description: '职责', requirements: '要求', fieldIssues: { updatedAt: 'source_missing' } }] });
    expect(result.jobs[0].applicationUrl).toBe('https://tenant.hotjob.cn/SU64d47c466202cc36e27a52d4/pb/posDetail.html?postId=0&postType=society');
    expect(transport.Request).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ bodyEncoding: 'form', body: expect.objectContaining({ recruitType: 2 }) }));
  });
  it('详情页中途失败持久化游标，重启后完整合并且不重复岗位', async () => {
    const file = join(await mkdtemp(join(tmpdir(), 'avery-hotjob-')), 'facts.json');
    const first = await new AtsSourceRunner(Transport(15, 5), new AtsFactStore(file)).Run(source);
    expect(first).toMatchObject({ snapshotStatus: 'partial', continuation: { nextPage: 2, pendingRows: expect.any(Array) } });
    expect(first.jobs).toHaveLength(3);
    const next = await new AtsSourceRunner(Transport(15), new AtsFactStore(file)).Run(source);
    expect(next.snapshotStatus).toBe('complete');
    expect(new Set(next.jobs.map((job) => job.id)).size).toBe(15);
    const saved = JSON.parse(await readFile(file, 'utf8'));
    expect(saved.continuations[source.id]).toBeUndefined();
    expect(saved.jobs[`${source.id}:${first.jobs[0].id}`].firstSeenAt).toBe(first.finishedAt);
  });
  it('招聘门户不猜类别，旧模板及异常协议明确拒绝', async () => {
    const result = await new AtsSourceRunner(Transport()).Run(CreateSource({ url: 'https://tenant.hotjob.cn/', company: '企业' }));
    expect(result.errors[0].code).toBe('SOURCE_MULTIPLE_PORTALS');
    const old = await new AtsSourceRunner(Transport()).Run(CreateSource({ url: 'https://tenant.hotjob.cn/wt/old/index', company: '企业' }));
    expect(old.errors[0].code).toBe('SOURCE_UNSUPPORTED');
    const bad: PublicTransport = { Request: vi.fn(async (url) => ({ url, status: 200, body: JSON.stringify({ state: '200', data: { pageForm: { pageData: [], currentPage: 1, pageSize: 50, dataCount: 50 } } }) })) };
    expect((await new AtsSourceRunner(bad).Run(source)).errors[0].code).toBe('SOURCE_SCHEMA_CHANGED');
  });
  it('详情要求登录不绕过；缺少状态证据不能作为可投递岗位', async () => {
    const transport = Transport();
    const original = transport.Request;
    transport.Request = vi.fn(async (url, input) => url.includes('listPositionDetail') ? { url, status: 200, body: '{"state":"401","msg":"请登录"}' } : original(url, input));
    expect((await new AtsSourceRunner(transport).Run(source)).errors[0].code).toBe('SOURCE_LOGIN_REQUIRED');
    const missing = Transport();
    const request = missing.Request;
    missing.Request = vi.fn(async (url, input) => {
      const result = await request(url, input);
      if (url.includes('listPositionDetail')) { const json = JSON.parse(result.body); delete json.data.showDeliverButton; result.body = JSON.stringify(json); }
      return result;
    });
    expect((await new AtsSourceRunner(missing).Run(source)).jobs[0].status).toBe('unknown');
  });
  it('公开总数变化后不拼接旧检查点，重新遍历新集合', async () => {
    const file = join(await mkdtemp(join(tmpdir(), 'avery-hotjob-change-')), 'facts.json');
    const first = await new AtsSourceRunner(Transport(15, 5), new AtsFactStore(file)).Run(source);
    expect(first.continuation).toBeDefined();
    const next = await new AtsSourceRunner(Transport(2), new AtsFactStore(file)).Run(source);
    expect(next).toMatchObject({ snapshotStatus: 'complete', publicJobCount: 2 });
    expect(next.jobs).toHaveLength(2);
    expect(next.changes).toContainEqual(expect.objectContaining({ id: first.jobs[2].id, event: 'CLOSED' }));
  });
  it('Host候选筛选不启动浏览器，只有显式SaveCandidate才写入官网岗位', async () => {
    const browser = { EvaluateTrustedPage: vi.fn(), Prepare: vi.fn(), Execute: vi.fn() } as unknown as BrowserAutomationPort;
    const saveJob = vi.fn(async (job) => ({ jobId: job.jobId, jobRevision: 1 }));
    const service = new JobCollectionService({ browser, atsRunner: new AtsSourceRunner(Transport()), loadViewModel: () => ({ jobs: [], applications: [] }), saveJob });
    try {
      const result = await service.Collect({ sessionId: 'hotjob', platforms: ['hotjob'], sources: [{ company: source.company, url }], queries: [], sort: 'relevance', maxResults: 10 });
      expect(result.candidates).toHaveLength(1);
      expect(result.candidates[0].platform).toBe('hotjob');
      expect(browser.Prepare).not.toHaveBeenCalled();
      expect(saveJob).not.toHaveBeenCalled();
      await service.SaveCandidate({ sessionId: 'hotjob', collectionId: result.collectionId, candidateId: result.candidates[0].candidateId });
      expect(saveJob).toHaveBeenCalledWith(expect.objectContaining({ channel: 'company_website' }));
      service.DeleteSession('hotjob');
      await expect(service.SaveCandidate({ sessionId: 'hotjob', collectionId: result.collectionId, candidateId: result.candidates[0].candidateId })).rejects.toMatchObject({ code: 'JOB_COLLECTION_EXPIRED' });
    } finally { service.Close(); }
  });
});
