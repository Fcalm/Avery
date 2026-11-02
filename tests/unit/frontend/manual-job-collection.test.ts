import { describe, expect, it, vi } from 'vitest';
import { JobCollectionInputSchema, type JobCollectionInput, type JobCollectionTask, type RecruitmentSource } from '@avery/contracts';
import { StartManualJobCollection } from '../../../src/features/job/api/manualJobCollection';

function Fixture() {
  const events: string[] = [];
  const sources: RecruitmentSource[] = [
    { sourceId: 'active', companyId: 'a', company: '企业 A', url: 'https://example.com/a', platform: 'moka', category: 'mixed', enabled: true, origin: 'builtin' },
    { sourceId: 'disabled', companyId: 'b', company: '企业 B', url: 'https://example.com/b', platform: 'feishu', category: 'campus', enabled: false, origin: 'builtin' },
  ];
  const task: JobCollectionTask = { taskId: 'task', status: 'running', request: JobCollectionInputSchema.parse({ channel: 'company_website' }),
    createdAt: 1, updatedAt: 1, deadline: 1000, scanned: 0, collected: 0, inserted: 0, existing: 0, skippedDeleted: 0, failedWrites: 0, sources: [], warnings: [] };
  const port = {
    ListSources: vi.fn(async () => { events.push('list'); return sources; }),
    EnableSource: vi.fn(async (id: string) => { events.push(`enable:${id}`); }),
    Start: vi.fn(async (_input: JobCollectionInput) => { events.push('start'); return task; }),
  };
  return { port, events, task };
}

describe('手动岗位采集的默认配置', () => {
  it('先恢复旧版停用来源，再启动；缓存刷新和浏览器辅助默认开启，不沿用旧的来源子集', async () => {
    const { port, events, task } = Fixture();
    expect(await StartManualJobCollection({ channel: 'company_website', sourceIds: ['active'], refresh: false, browserFallback: false, keyword: '产品', educations: ['bachelor'] }, port)).toBe(task);
    expect(events).toEqual(['list', 'enable:disabled', 'start']);
    expect(port.Start).toHaveBeenCalledWith(expect.objectContaining({ refresh: true, browserFallback: true, keyword: '产品', educations: ['bachelor'] }));
    expect(port.Start.mock.calls[0]).toHaveLength(1);
    expect(port.Start.mock.calls[0][0]).not.toHaveProperty('sourceIds');
  });

  it('恢复来源失败时不启动采集，并保留原始错误', async () => {
    const { port } = Fixture();
    const failure = new Error('来源设置保存失败');
    port.EnableSource.mockRejectedValueOnce(failure);
    await expect(StartManualJobCollection({ channel: 'company_website' }, port)).rejects.toBe(failure);
    expect(port.Start).not.toHaveBeenCalled();
  });

  it('非法采集参数不会修改来源或启动任务', async () => {
    const { port } = Fixture();
    await expect(StartManualJobCollection({ channel: 'company_website', targetCount: 0 }, port)).rejects.toThrow();
    expect(port.ListSources).not.toHaveBeenCalled();
    expect(port.EnableSource).not.toHaveBeenCalled();
    expect(port.Start).not.toHaveBeenCalled();
  });

  it('校招汇总自动开启辅助选项，BOSS 保持专用采集路径，都不改企业来源配置', async () => {
    const { port } = Fixture();
    await StartManualJobCollection({ channel: 'campus_aggregator', company: '企业 A', graduationYear: 2027 }, port);
    expect(port.Start).toHaveBeenLastCalledWith(expect.objectContaining({ refresh: true, browserFallback: true, company: '企业 A', graduationYear: 2027 }));
    await StartManualJobCollection({ channel: 'boss_zhipin', keyword: '产品经理', city: '上海' }, port);
    expect(port.Start).toHaveBeenLastCalledWith(expect.objectContaining({ channel: 'boss_zhipin', refresh: false, browserFallback: false }));
    expect(port.ListSources).not.toHaveBeenCalled();
    expect(port.EnableSource).not.toHaveBeenCalled();
  });
});
