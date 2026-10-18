import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { ValidateRegistry, ClassifyOutcome, JobCoverage, CoverageSummary, RegistryEligibility } from '../../../scripts/ats-evaluation-report.mjs';

describe('ATS coverage evaluation', () => {
  const baseline = { schemaVersion: 1, sources: Array.from({ length: 50 }, (_, index) => ({ company: `基线${index}`, url: `https://baseline${index}.example/`, ats: index < 25 ? 'beisen' : 'moka' })) };
  const others = Array.from({ length: 50 }, (_, index) => ({ company: `新增${index}`, url: `https://other${index}.example/` }));
  it('固定100清单保留50基线；数量、重复和基线变化均拒绝', () => {
    const fixture = { schemaVersion: 1, registryKind: 'coverage-100', sources: [...baseline.sources, ...others] };
    expect(() => ValidateRegistry(fixture, baseline)).not.toThrow();
    expect(() => ValidateRegistry({ ...fixture, sources: fixture.sources.slice(1) }, baseline)).toThrow();
    expect(() => ValidateRegistry({ ...fixture, sources: [...baseline.sources, ...others.slice(1), others[1]] }, baseline)).toThrow();
    expect(() => ValidateRegistry({ ...fixture, sources: fixture.sources.map((source, index) => index ? source : { ...source, company: 'changed' }) }, baseline)).toThrow('changed');
  });
  it('未知平台、已识别但不支持及访问失败分别统计', () => {
    const run = (code: string, platform?: string) => ({ errors: [{ code }], jobs: [], snapshotStatus: 'unknown', detectedPlatform: platform });
    const runs = [run('SOURCE_UNKNOWN_PLATFORM'), run('SOURCE_ADAPTER_UNAVAILABLE', 'feishu'), run('SOURCE_ACCESS_DENIED', 'feishu')];
    expect(runs.map(ClassifyOutcome)).toEqual(['unknown_platform', 'unsupported_source', 'access_or_network_failure']);
    expect(ClassifyOutcome(run('SOURCE_405', 'feishu'))).toBe('access_or_network_failure');
    expect(CoverageSummary(runs)).toMatchObject({ recognizedPlatforms: 2, extractedSources: 0, outcomes: { unknown_platform: 1, unsupported_source: 1, access_or_network_failure: 1 }, adapterPriorities: [{ platform: 'feishu', sources: 1 }] });
  });
  it('公司名不能重复；平台资格不由采集门槛或已知域名代替', () => {
    const fixture = { schemaVersion: 1, registryKind: 'coverage-100', sources: [...baseline.sources, ...others] };
    expect(() => ValidateRegistry({ ...fixture, sources: fixture.sources.map((source, index) => index === 99 ? { ...source, company: others[0].company } : source) }, baseline)).toThrow('companies');
    const runs = [
      { url: others[0].url, ats: 'moka' },
      { url: others[1].url, detectedPlatform: 'feishu', errors: [{ code: 'SOURCE_ADAPTER_UNAVAILABLE' }] },
      { url: others[2].url, detectedPlatform: 'feishu', errors: [{ code: 'SOURCE_NETWORK_ERROR' }] },
    ];
    expect(RegistryEligibility(fixture, baseline, runs)).toMatchObject({ passed: false, verifiedOtherSources: 1, contradictedSources: 1, unverifiedSources: 48 });
    expect(RegistryEligibility(fixture, baseline, others.map((source) => ({ url: source.url, detectedPlatform: 'feishu', errors: [{ code: 'SOURCE_ADAPTER_UNAVAILABLE' }] })))).toMatchObject({ passed: true, verifiedOtherSources: 50 });
    expect(RegistryEligibility(baseline, baseline, [])).toBeUndefined();
  });
  it('v2只替换两家资格不符企业、纠正两家官方入口，其他失败样本及基线原样保留', () => {
    const read = (name: string) => readFileSync(new URL(`../../fixtures/${name}`, import.meta.url), 'utf8');
    const originalText = read('ats-sources-100.json');
    const original = JSON.parse(originalText);
    const revised = JSON.parse(read('ats-sources-100-v2.json'));
    const fixedBaseline = JSON.parse(read('ats-sources-50.json'));
    expect(revised.previousRegistrySha256).toBe(createHash('sha256').update(originalText).digest('hex'));
    expect(revised.registryVersion).toBe(2);
    expect(revised.changes).toHaveLength(4);
    for (const source of original.sources.filter((source: {company: string}) => !['智谱', '阶跃星辰', '理想汽车', '海尔'].includes(source.company))) {
      expect(revised.sources.find((item: {company: string}) => item.company === source.company)).toEqual(source);
    }
    expect(() => ValidateRegistry({ ...revised, sources: [...fixedBaseline.sources, ...revised.sources] }, fixedBaseline)).not.toThrow();
  });
  it('提取成功不等于岗位覆盖，公开总数不存在时明确未验证', () => {
    expect(JobCoverage({ jobs: [{}] })).toMatchObject({ status: 'unverified' });
    expect(JobCoverage({ jobs: [{}, {}], publicJobCount: 5 })).toMatchObject({ status: 'measured', rate: 0.4, denominator: 5 });
    expect(JobCoverage({ jobs: [], publicJobCount: 0 })).toMatchObject({ status: 'measured', rate: null });
  });
});
