import { afterEach, describe, expect, it, vi } from 'vitest';
import { BuildCollectPrompt, BuildJobLibraryQuery, DefaultJobConditions, JobConditionsStorageKey, LoadJobConditions, SaveJobConditions, ToggleJobCondition, type JobConditions } from '../../../src/features/job/api/jobConditions';

/** 应用内缓存以 localStorage 为唯一后端；用内存实现替换，避免测试依赖真实浏览器环境。 */
function StubStorage() {
  const entries = new Map<string, string>();
  vi.stubGlobal('window', {
    localStorage: {
      getItem: (key: string) => entries.get(key) ?? null,
      setItem: (key: string, value: string) => { entries.set(key, value); },
    },
  });
  return entries;
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('岗位采集条件的应用内缓存', () => {
  it('默认条件不限制岗位，具体条件映射到共享查询；四种视图仅改变状态条件', () => {
    expect(BuildJobLibraryQuery(DefaultJobConditions, 'all', 'score', 1)).toMatchObject({ channels: [], cities: [], keyword: '', page: 1, pageSize: 20 });
    for (const view of ['all', 'favorites', 'pending', 'applied'] as const) {
      expect(BuildJobLibraryQuery({ ...DefaultJobConditions, keyword: ' AGENT ', channel: 'boss_zhipin', salary: '25k', education: 'bachelor' }, view, 'created', 2))
        .toMatchObject({ keyword: 'AGENT', channels: ['boss_zhipin'], minMonthlySalary: 25000, educations: ['bachelor'], view, sort: 'created', page: 2 });
    }
  });
  it('没有缓存或缓存不可解析时回退默认条件', () => {
    const entries = StubStorage();
    expect(LoadJobConditions()).toEqual(DefaultJobConditions);

    entries.set(JobConditionsStorageKey, '{not json');
    expect(LoadJobConditions()).toEqual(DefaultJobConditions);

    entries.set(JobConditionsStorageKey, '["产品设计师"]');
    expect(LoadJobConditions()).toEqual(DefaultJobConditions);
  });

  it('保存后原样读回已选择的渠道与新增的学历要求、公司规模', () => {
    StubStorage();
    const conditions: JobConditions = {
      ...DefaultJobConditions, keyword: '产品设计师', city: '上海', education: 'bachelor', companySize: ['100-499', '500-999'],
    };

    SaveJobConditions(conditions);

    expect(LoadJobConditions()).toEqual(conditions);
  });

  it('丢弃已不在选项表中的旧值，避免控件落到非法状态', () => {
    const entries = StubStorage();
    entries.set(JobConditionsStorageKey, JSON.stringify({
      ...DefaultJobConditions, keyword: '后端工程师', channel: 'lagou', education: 'bachelor', companySize: 42,
    }));

    expect(LoadJobConditions()).toEqual({ ...DefaultJobConditions, keyword: '后端工程师', education: 'bachelor' });
  });

  it('采集指令带上明确选择的条件，全部不限时退化为“不限”', () => {
    expect(BuildCollectPrompt({ ...DefaultJobConditions, keyword: ' 产品设计师 ', city: '上海', education: 'bachelor', companySize: ['100-499'] }))
      .toBe('帮我按照条件：产品设计师、上海、本科、100 到 499 人，采集岗位');
    expect(BuildCollectPrompt(DefaultJobConditions)).toBe('帮我按照条件：不限，采集岗位');
  });

  it('迁移旧版公司规模单选缓存，过滤多选缓存中的未知值与重复值', () => {
    const entries = StubStorage();
    entries.set(JobConditionsStorageKey, JSON.stringify({ companySize: '100-499' }));
    expect(LoadJobConditions().companySize).toEqual(['100-499']);
    entries.set(JobConditionsStorageKey, JSON.stringify({ companySize: ['20-99', 'any', 'invalid', '20-99', 5, '500-999'] }));
    expect(LoadJobConditions().companySize).toEqual(['20-99', '500-999']);
    entries.set(JobConditionsStorageKey, JSON.stringify({ companySize: 'any' }));
    expect(LoadJobConditions().companySize).toEqual([]);
  });

  it('公司规模同组多选并可逐项取消，“不限”只清空当前组；单选再次点击恢复不限', () => {
    const first = ToggleJobCondition({ ...DefaultJobConditions, education: 'bachelor' }, 'companySize', '20-99');
    const second = ToggleJobCondition(first, 'companySize', '100-499');
    expect(second.companySize).toEqual(['20-99', '100-499']);
    expect(ToggleJobCondition(second, 'companySize', '20-99').companySize).toEqual(['100-499']);
    expect(ToggleJobCondition(second, 'companySize', 'any')).toMatchObject({ education: 'bachelor', companySize: [] });
    expect(ToggleJobCondition(second, 'education', 'bachelor').education).toBe('any');
    expect(first.companySize).toEqual(['20-99']);
    expect(DefaultJobConditions.companySize).toEqual([]);
  });

  it('多选公司规模、其他维度与排序方向完整传给后端查询', () => {
    const conditions = { ...DefaultJobConditions, companySize: ['20-99', '100-499'], education: 'master' };
    for (const sort of ['score', 'salary', 'created'] as const) {
      for (const sortDirection of ['asc', 'desc'] as const) {
        expect(BuildJobLibraryQuery(conditions, 'pending', sort, 3, sortDirection)).toMatchObject({
          companySizes: ['20-99', '100-499'], educations: ['master'], view: 'pending', sort, sortDirection, page: 3,
        });
      }
    }
    expect(BuildCollectPrompt(conditions)).toBe('帮我按照条件：硕士、20 到 99 人、100 到 499 人，采集岗位');
  });
});
