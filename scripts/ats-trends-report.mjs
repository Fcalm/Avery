/** 历史趋势按平台、来源和 UTC 日分组；字段质量仅使用采集当时的计数。 */
export function BuildTrends(state, { platform, sourceId, since } = {}) {
  if (since && !Number.isFinite(Date.parse(since))) throw new Error('Invalid --since date.');
  const selected = state.sourceRuns.filter((run) => (!platform || (run.ats ?? run.detectedPlatform ?? 'unknown') === platform)
    && (!sourceId || run.sourceId === sourceId) && (!since || Date.parse(run.startedAt) >= Date.parse(since)));
  const groups = new Map();
  const alerts = [];
  const recent = new Map();
  for (const run of [...selected].sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt))) {
    const ats = run.ats ?? run.detectedPlatform ?? 'unknown';
    const day = new Date(run.startedAt).toISOString().slice(0, 10);
    const key = `${ats}:${run.sourceId}:${day}`;
    const group = groups.get(key) ?? { platform: ats, sourceId: run.sourceId, company: state.sources[run.sourceId]?.company ?? run.sourceId, day,
      runs: 0, success: 0, partial: 0, failed: 0, jobs: 0, durations: [], errors: {}, fieldPresent: {}, fieldIssues: {}, measuredJobs: 0, unverifiedQualityRuns: 0 };
    group.runs += 1;
    const success = run.snapshotStatus === 'complete' && run.errors.every((error) => error.code === 'SOURCE_EMPTY');
    const partial = run.snapshotStatus === 'partial';
    group[success ? 'success' : partial ? 'partial' : 'failed'] += 1;
    group.jobs += run.normalizedCount;
    group.durations.push(run.durationMs);
    for (const error of run.errors) group.errors[error.code] = (group.errors[error.code] ?? 0) + 1;
    if (run.fieldQuality) {
      group.measuredJobs += run.normalizedCount;
      for (const [field, count] of Object.entries(run.fieldQuality.present)) group.fieldPresent[field] = (group.fieldPresent[field] ?? 0) + count;
      for (const [issue, count] of Object.entries(run.fieldQuality.issues)) group.fieldIssues[issue] = (group.fieldIssues[issue] ?? 0) + count;
    } else group.unverifiedQualityRuns += 1;
    const previous = recent.get(run.sourceId);
    // 正常分段仍在增加岗位时不计为连续失败；停滞或真正失败才进入连续异常计数。
    const progressing = partial && run.normalizedCount > (previous?.lastRun.normalizedCount ?? 0)
      && run.errors.every((error) => ['SOURCE_PAGE_LIMIT', 'SOURCE_REQUEST_LIMIT', 'SOURCE_TIMEOUT'].includes(error.code));
    const failureStreak = success || progressing ? 0 : (previous?.failureStreak ?? 0) + 1;
    const reasons = [];
    if (failureStreak === 3) reasons.push('three_consecutive_failed_or_stalled_runs');
    if (run.errors.some((error) => ['SOURCE_SCHEMA_CHANGED', 'SOURCE_401', 'SOURCE_403', 'SOURCE_CAPTCHA', 'SOURCE_LOGIN_REQUIRED', 'SOURCE_ACCESS_DENIED'].includes(error.code))) reasons.push('schema_or_access_failure');
    if (success && previous?.lastComplete && run.normalizedCount < previous.lastComplete.normalizedCount * 0.5) reasons.push('complete_job_count_drop_over_50_percent');
    if (reasons.length) alerts.push({ sourceId: run.sourceId, platform: ats, at: run.finishedAt, reasons, errors: run.errors });
    recent.set(run.sourceId, { failureStreak, lastRun: run, lastComplete: success ? run : previous?.lastComplete });
    groups.set(key, group);
  }
  return { schemaVersion: 1, historyRuns: state.sourceRuns.length, selectedRuns: selected.length,
    historyLimit: 1000, timeZone: 'UTC', alerts,
    groups: [...groups.values()].map(({ durations, fieldPresent, measuredJobs, ...group }) => {
      durations.sort((a, b) => a - b);
      return { ...group, successRate: group.success / group.runs, latencyP50Ms: durations[Math.floor((durations.length - 1) * 0.5)], latencyP95Ms: durations[Math.floor((durations.length - 1) * 0.95)],
        qualitySampleJobs: measuredJobs, fieldCompleteness: measuredJobs ? Object.fromEntries(Object.entries(fieldPresent).map(([field, count]) => [field, count / measuredJobs])) : null };
    }) };
}
