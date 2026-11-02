import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { JobRepository } from '../../../apps/backend/src/electron/repositories/job-repository';
import { JobLibraryCollectionService } from '../../../apps/backend/src/electron/backend/job-library-collection-service';
import { CreateAgentJobLibrary } from '../../../apps/backend/src/electron/backend/agent-job-library';
import { BuiltinRecruitmentSources } from '../../../apps/backend/src/electron/backend/recruitment-sources';
import type { NormalizedJob, SourceResult } from '../../../apps/backend/src/electron/backend/ats/types';
import { CreateToolsModule } from '../../../packages/agent-modules-defaults/src/tools';
import { CreateToolContext } from '../agent/test-helpers';

function CreatePorts() { return { getConfig: async () => null, saveConfig: async () => undefined, getStoredSettings: async () => ({}) }; }

const Database = createRequire(import.meta.url)('better-sqlite3');
const close: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const cleanup of close.splice(0).reverse()) await cleanup(); });
const source = BuiltinRecruitmentSources[0];
function Jobs(count: number): NormalizedJob[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `beisen:tenant:${index}`, ats: 'beisen', tenant: 'tenant', atsJobId: String(index), sourceId: source.sourceId,
    title: `产品经理 ${index}`, company: '测试企业', sourceUrl: source.url, applicationUrl: `https://test.zhiye.com/job/${index}`,
    locations: ['广州'], description: '负责产品设计。'.repeat(4000), requirements: '本科', education: '本科', jobType: 'intern',
    rawHash: String(index), firstSeenAt: '2026-10-18T00:00:00Z', lastSeenAt: '2026-10-18T00:00:00Z', status: 'open',
  }));
}
function Result(count = 12): SourceResult {
  return { sourceId: source.sourceId, ats: 'beisen', health: 'healthy', snapshotStatus: 'complete', transport: 'public_api',
    jobs: Jobs(count), quarantine: [], errors: [], startedAt: '2026-10-18T00:00:00Z', finishedAt: '2026-10-18T00:00:01Z', durationMs: 1000, requestCount: 1, receivedCount: count };
}
async function Fixture(overrides: Partial<ConstructorParameters<typeof JobLibraryCollectionService>[0]> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'avery-agent-job-library-'));
  close.push(() => rm(root, { recursive: true, force: true }));
  const db = new Database(':memory:'); close.push(() => db.close());
  db.exec(`CREATE TABLE jobs(id TEXT PRIMARY KEY, payload_json TEXT NOT NULL, is_favorite INTEGER NOT NULL, channel TEXT NOT NULL, match_score REAL, deadline INTEGER, revision INTEGER, created_at INTEGER, updated_at INTEGER, deleted_at INTEGER);
    CREATE TABLE applications(id TEXT PRIMARY KEY, job_id TEXT, status TEXT);
    CREATE TABLE audit_events(id TEXT PRIMARY KEY, actor_type TEXT, action TEXT, entity_type TEXT, entity_id TEXT, metadata_json TEXT, created_at INTEGER);`);
  const repo = new JobRepository({ db });
  const run = vi.fn(async () => Result());
  const pageBrowser = vi.fn(async () => { throw new Error('不能重置Agent为页面采集浏览器'); });
  const service = new JobLibraryCollectionService({ workspacePath: root, sources: [source], runner: { Run: run },
    importJobs: async (batch) => repo.ImportCollectedJobs(batch), collectBoss: pageBrowser, ...overrides });
  close.push(() => service.Close());
  const boss = vi.fn(async () => undefined);
  const port = CreateAgentJobLibrary({ collection: service, collectBoss: boss, query: async (query) => repo.QueryForAgent(query) });
  return { service, repo, db, port, run, boss, pageBrowser, root };
}

describe('Agent持久岗位库端口', () => {
  it('真实工具链采集12个直接入SQLite，摘要与页面统计一致；读取分页和详情不返回整库正文', async () => {
    const { service, repo, port, db } = await Fixture();
    const context = CreateToolContext({ scenarioId: 'application', boundResume: null, ports: { ...CreateToolContext().ports, jobLibrary: port } });
    const tools = CreateToolsModule(CreatePorts());
    const call = { id: 'collect-12', type: 'function' as const, function: { name: 'CollectJobs', arguments: '{"channel":"company_website","keyword":"产品","targetCount":12,"educations":["bachelor"]}' } };
    const collected = JSON.parse((await tools.ExecuteToolCall(call, context)).content);
    expect(collected).toMatchObject({ ok: true, requestedCount: 12, collected: 12, inserted: 12, existing: 0 });
    expect(collected).not.toHaveProperty('candidates');
    expect((await service.GetJobCollectionTask(collected.taskId))?.collected).toBe(repo.Query({}).total);
    const args = { channel: 'company_website' as const, keyword: '产品', maxResults: 5, detailLevel: 'summary' as const };
    const first = await port.Read(args) as any;
    const second = await port.Read({ ...args, cursor: first.nextCursor }) as any;
    const third = await port.Read({ ...args, cursor: second.nextCursor }) as any;
    expect(first.total).toBe(12); expect(third.hasMore).toBe(false);
    const ids = [...first.items, ...second.items, ...third.items].map((job: any) => job.jobId);
    expect(new Set(ids).size).toBe(12);
    expect(first.items[0].jd.length).toBe(300); expect(first.truncated).toBe(true);
    expect(first.items[0].truncatedFields).toContain('jd');
    db.prepare('INSERT INTO applications VALUES (?, ?, ?)').run('application-1', ids[0], '已投递');
    const detail = await port.Read({ jobId: ids[0] }) as any;
    expect(detail.items).toHaveLength(1); expect(detail.items[0].applicationStatuses).toEqual(['applied']);
    expect(detail.items[0].jd.length).toBe(8000); expect(detail.items[0].truncatedFields).toContain('jd');
    let text = detail.items[0].jd, cursor = detail.nextCursor;
    while (cursor) {
      const part = await port.Read({ jobId: ids[0], cursor }) as any;
      expect(part.items[0].jdOffset).toBe(text.length);
      expect(JSON.stringify(part).length).toBeLessThanOrEqual(12000);
      text += part.items[0].jd; cursor = part.nextCursor;
    }
    expect(text).toBe(repo.FindById(ids[0]).jd);
    // 新模块实例模拟确认续跑/进程重放，持久账本阻止再次执行成功的工具调用。
    const replayed = await CreateToolsModule(CreatePorts()).ExecuteToolCall(call, context);
    expect(JSON.parse(replayed.content).replayed).toBe(true); expect(repo.Query({}).total).toBe(12);
  });

  it('默认简表不带JD或URL；计数不返回岗位，字符预算续页不丢记录', async () => {
    const { port, repo } = await Fixture({ runner: { Run: async () => Result(100) } });
    await port.Collect({ request: { channel: 'company_website', targetCount: 100 }, idempotencyKey: 'budget' });
    expect(await port.Read({ detailLevel: 'count' })).toMatchObject({ total: 100, mode: 'count', items: [], nextCursor: null });
    const first = await port.Read({}) as any;
    expect(first.items).toHaveLength(20); expect(first.detailLevel).toBe('brief');
    expect(first.items[0]).not.toHaveProperty('jd'); expect(first.items[0]).not.toHaveProperty('url');
    const seen = new Set<string>(); let cursor: string | undefined;
    do {
      const result = await port.Read({ detailLevel: 'summary', maxResults: 100, cursor }) as any;
      expect(JSON.stringify(result).length).toBeLessThanOrEqual(12000);
      expect(result.items.length).toBeGreaterThan(0);
      for (const job of result.items) { expect(seen.has(job.jobId)).toBe(false); seen.add(job.jobId); }
      cursor = result.nextCursor;
    } while (cursor);
    expect(seen.size).toBe(repo.Query({}).total);
    await expect(port.Read({ detailLevel: 'summary', cursor: first.nextCursor })).rejects.toThrow('cursor');
    await expect(port.Read({ detailLevel: 'detail' })).rejects.toThrow('jobId');
  });

  it('详情转义膨胀仍受预算限制；正文变化后旧游标拒绝拼接', async () => {
    const { port, repo } = await Fixture();
    repo.Upsert({ id: 'escaped', title: '产品', company: '测试', city: '上海', channel: 'company_website', url: '\u0000'.repeat(5000), jd: '\u0001"\\\n😀'.repeat(9000) });
    const first = await port.Read({ jobId: 'escaped' }) as any;
    expect(first.items).toHaveLength(1); expect(JSON.stringify(first).length).toBeLessThanOrEqual(12000);
    expect(first.hasMore).toBe(true);
    let reconstructed = first.items[0].jd, cursor = first.nextCursor;
    while (cursor) {
      const part = await port.Read({ jobId: 'escaped', cursor }) as any;
      expect(JSON.stringify(part).length).toBeLessThanOrEqual(12000);
      expect(part.items[0].jdOffset).toBe(reconstructed.length);
      expect(part.items[0].jd).not.toMatch(/[\ud800-\udbff]$/);
      reconstructed += part.items[0].jd; cursor = part.nextCursor;
    }
    expect(reconstructed).toBe(repo.FindById('escaped').jd);
    const job = repo.FindById('escaped'); repo.Upsert({ ...job, jd: '已变化' }, job.revision);
    await expect(port.Read({ jobId: 'escaped', cursor: first.nextCursor })).rejects.toThrow('changed');
  });

  it('游标绑定原筛选和数量；坏游标、混合详情参数拒绝，删除和到期岗位不可读', async () => {
    const { port, repo } = await Fixture();
    await port.Collect({ request: { channel: 'company_website', targetCount: 12 }, idempotencyKey: 'collect-cursor' });
    const first = await port.Read({ maxResults: 5 }) as any;
    expect((await port.Read({ maxResults: 100 }) as any).items).toHaveLength(12);
    await expect(port.Read({ maxResults: 101 })).rejects.toThrow('maxResults');
    await expect(port.Read({ channel: 'boss_zhipin', maxResults: 5, cursor: first.nextCursor })).rejects.toThrow('cursor');
    await expect(port.Read({ maxResults: 6, cursor: first.nextCursor })).rejects.toThrow('cursor');
    await expect(port.Read({ cursor: 'not-json' })).rejects.toThrow('cursor');
    const id = first.items[0].jobId;
    await expect(port.Read({ jobId: id, keyword: '产品' })).rejects.toThrow('separately');
    repo.Delete(id); expect(await port.Read({ jobId: id })).toMatchObject({ total: 0, items: [] });
    const expired = repo.FindById(first.items[1].jobId);
    repo.Upsert({ ...expired, deadline: Date.now() - 1000 });
    expect(await port.Read({ jobId: expired.id })).toMatchObject({ total: 0, items: [] });
  });

  it('取消等待在途批次落盘后才返回，保留实际数量，重复幂等键不重新运行来源', async () => {
    const controller = new AbortController();
    let started!: () => void, finish!: () => void;
    const ready = new Promise<void>((resolve) => { started = resolve; });
    const gate = new Promise<void>((resolve) => { finish = resolve; });
    let repo!: JobRepository;
    const writes = vi.fn(async (batch) => { started(); await gate; return repo.ImportCollectedJobs(batch); });
    const fixture = await Fixture({ runner: { Run: async () => Result(50) }, importJobs: writes }); repo = fixture.repo;
    let returned = false;
    const request = { channel: 'company_website' as const, targetCount: 50 };
    const work = fixture.port.Collect({ request, idempotencyKey: 'cancel-write', signal: controller.signal }).then((result) => { returned = true; return result; });
    await ready; controller.abort(); await Promise.resolve(); expect(returned).toBe(false);
    finish(); const result = await work;
    expect(result).toMatchObject({ status: 'cancelled', collected: 25, inserted: 25 });
    expect(repo.Query({}).total).toBe(25); expect(writes).toHaveBeenCalledTimes(1);
    expect(fixture.service.HasActiveTask()).toBe(false);
    expect(await fixture.port.Collect({ request, idempotencyKey: 'cancel-write' })).toMatchObject({ taskId: result.taskId, status: 'cancelled', collected: 25 });
    expect(writes).toHaveBeenCalledTimes(1);
  });

  it('BOSS复用Agent调用的浏览器执行器，不调用页面独占浏览器启动入口', async () => {
    const { port, boss, pageBrowser } = await Fixture();
    boss.mockImplementationOnce(async (input: any) => { await input.accept({ identity: 'boss_zhipin:one', platform: 'boss_zhipin', sourceId: 'boss_zhipin', originalJobId: 'one', sourceUrl: 'https://www.zhipin.com/', collectedAt: '2026-10-18T00:00:00Z', job: { id: 'job-boss-one', title: '产品经理', company: '测试企业', companySize: '20-99人', channel: 'boss_zhipin', favorite: false, city: '广州', experience: '', jd: '产品设计' } }); });
    expect(await port.Collect({ request: { channel: 'boss_zhipin', keyword: '产品', city: '广州', targetCount: 1 }, idempotencyKey: 'boss-1' })).toMatchObject({ collected: 1 });
    expect(boss).toHaveBeenCalledTimes(1); expect(pageBrowser).not.toHaveBeenCalled();
    expect(await port.Read({ jobId: 'job-boss-one' })).toMatchObject({ items: [{ companySize: '20-99人' }] });
  });

  it.each(['请先登录BOSS直聘', '个人浏览器未连接'])('BOSS不可用时保留具体失败原因：%s', async (message) => {
    const fixture = await Fixture();
    fixture.boss.mockRejectedValueOnce(new Error(message));
    const result = await fixture.port.Collect({ request: { channel: 'boss_zhipin', keyword: '产品', city: '广州', targetCount: 1 }, idempotencyKey: `unavailable-${message}` });
    expect(result.status).toBe('failed'); expect(result.collected).toBe(0); expect(result.sources[0].error).toBe(message);
    expect(result.warnings).toContain(message); expect(fixture.repo.Query({}).total).toBe(0);
  });

  it('超时返回timed_out而不是成功；来源未启用或不存在时不写入', async () => {
    const fixture = await Fixture({ taskTimeoutMs: () => 15, runner: { Run: async (_source, signal) => {
      await new Promise((_resolve, reject) => { if (signal.aborted) reject(signal.reason); else signal.addEventListener('abort', () => reject(signal.reason), { once: true }); });
      return Result();
    } } });
    const result = await fixture.port.Collect({ request: { channel: 'company_website' }, idempotencyKey: 'timeout' });
    expect(result).toMatchObject({ status: 'timed_out', collected: 0 }); expect(fixture.service.HasActiveTask()).toBe(false);
    await expect(fixture.port.Collect({ request: { channel: 'company_website', sourceIds: ['nonexistent'] }, idempotencyKey: 'invalid-source' })).rejects.toThrow('来源');
    expect(fixture.repo.Query({}).total).toBe(0);
  });

  it('服务重启保留已入库岗位和幂等任务；缺少原任务时只对账，不自动重采', async () => {
    const fixture = await Fixture();
    const request = { channel: 'company_website' as const, targetCount: 12 };
    const original = await fixture.port.Collect({ request, idempotencyKey: 'persisted' });
    await fixture.service.Close();
    const path = join(fixture.root, 'job-collection', 'state.json');
    const stored = JSON.parse(await readFile(path, 'utf8')) as { tasks: Array<{ request: Record<string, unknown> }> };
    for (const task of stored.tasks) { delete task.request.refresh; delete task.request.browserFallback; delete task.request.keywordScope; }
    await writeFile(path, JSON.stringify(stored), 'utf8');
    const run = vi.fn(async () => Result());
    const restarted = new JobLibraryCollectionService({ workspacePath: fixture.root, sources: [source], runner: { Run: run },
      importJobs: async (batch) => fixture.repo.ImportCollectedJobs(batch), collectBoss: fixture.pageBrowser });
    close.push(() => restarted.Close());
    expect(await restarted.CollectAndWait(request, { idempotencyKey: 'persisted', reconcileOnly: true })).toMatchObject({ taskId: original.taskId, collected: 12 });
    expect(fixture.repo.Query({}).total).toBe(12); expect(run).not.toHaveBeenCalled();
    await expect(restarted.CollectAndWait(request, { idempotencyKey: 'missing', reconcileOnly: true })).rejects.toMatchObject({ code: 'JOB_COLLECTION_TASK_MISSING' });
    expect(run).not.toHaveBeenCalled();
  });

  it('大量来源只返回前20个摘要并明确截断，不把全部来源正文交给模型', async () => {
    const fixture = await Fixture({ sources: Array.from({ length: 30 }, (_, index) => ({ ...source, sourceId: `source-${index}` })), runner: { Run: async () => Result(0) } });
    const result = await fixture.port.Collect({ request: { channel: 'company_website', targetCount: 1 }, idempotencyKey: 'many-sources' });
    expect(result.sources).toHaveLength(20); expect(result.sourceCount).toBe(30); expect(result.truncated).toBe(true);
  });
});
