import { describe, expect, it } from 'vitest';
import { BuildTrends } from '../../../scripts/ats-trends-report.mjs';

describe('ATS historical trends', () => {
  const run = (index: number, extra = {}) => ({ sourceId: 's1', ats: 'moka', startedAt: `2026-09-${20 + index}T00:00:00Z`, finishedAt: `2026-09-${20 + index}T00:00:01Z`, snapshotStatus: 'complete', errors: [], durationMs: 100, normalizedCount: 10, ...extra });
  it('按平台来源时间筛选并使用历史质量，不以当前岗位回填旧历史', () => {
    const state = { sources: { s1: { company: '企业' } }, jobs: { irrelevant: { locations: [] } }, sourceRuns: [run(0), run(1, { fieldQuality: { present: { locations: 8 }, issues: { 'locations:source_empty': 2 } } }), run(2, { ats: 'beisen' })] };
    expect(BuildTrends(state, { platform: 'moka', since: '2026-09-21', sourceId: 's1' })).toMatchObject({ selectedRuns: 1, groups: [{ company: '企业', fieldCompleteness: { locations: 0.8 }, fieldIssues: { 'locations:source_empty': 2 }, unverifiedQualityRuns: 0 }] });
    expect(BuildTrends(state).groups[0]).toMatchObject({ fieldCompleteness: null, unverifiedQualityRuns: 1 });
    expect(() => BuildTrends(state, { since: 'invalid' })).toThrow();
  });
  it('连续异常和完整集合骤降可定位到来源，部分集合不参与骤降对照', () => {
    const runs = [run(0), run(1, { snapshotStatus: 'partial' }), run(2, { snapshotStatus: 'unknown', errors: [{ code: 'SOURCE_403' }] }), run(3, { snapshotStatus: 'partial' }), run(4, { normalizedCount: 4 })];
    expect(BuildTrends({ sources: {}, sourceRuns: runs }).alerts).toEqual([
      expect.objectContaining({ sourceId: 's1', reasons: ['schema_or_access_failure'] }),
      expect.objectContaining({ sourceId: 's1', reasons: ['three_consecutive_failed_or_stalled_runs'] }),
      expect.objectContaining({ sourceId: 's1', reasons: ['complete_job_count_drop_over_50_percent'] }),
    ]);
  });
  it('预算内分段持续前进不误告警；相同数量连续停滞才告警', () => {
    const runs = [10, 20, 30, 30, 30, 30].map((normalizedCount, index) => run(index, { snapshotStatus: 'partial', normalizedCount, errors: [{ code: 'SOURCE_REQUEST_LIMIT' }] }));
    const report = BuildTrends({ sources: {}, sourceRuns: runs });
    expect(report.alerts).toHaveLength(1);
    expect(report.alerts[0]).toMatchObject({ at: runs[5].finishedAt, reasons: ['three_consecutive_failed_or_stalled_runs'] });
  });
});
