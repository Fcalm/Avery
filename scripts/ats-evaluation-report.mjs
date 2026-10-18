/** 固定评估清单在采集前校验；100 家清单须原样保留既有 50 家，不能按结果替换。 */
export function ValidateRegistry(fixture, baseline) {
  if (fixture.schemaVersion !== 1 || !Array.isArray(fixture.sources)) throw new Error('Unsupported registry format.');
  const expected = fixture.registryKind === 'coverage-100' ? 100 : 50;
  if (fixture.sources.length !== expected || new Set(fixture.sources.map((source) => source.url)).size !== expected) throw new Error(`Registry must contain ${expected} unique source URLs.`);
  if (new Set(fixture.sources.map((source) => source.company)).size !== expected) throw new Error('Registry companies must be unique.');
  if (expected === 50 && ['beisen', 'moka'].some((ats) => fixture.sources.filter((source) => source.ats === ats).length !== 25)) throw new Error('Regression registry requires 25 Beisen and 25 Moka sources.');
  if (expected === 100) {
    for (const source of baseline.sources) {
      const retained = fixture.sources.find((item) => item.url === source.url);
      if (!retained || retained.company !== source.company || retained.ats !== source.ats) throw new Error(`Original regression source changed: ${source.company}`);
    }
    const baselineUrls = new Set(baseline.sources.map((source) => source.url));
    const added = fixture.sources.filter((source) => !baselineUrls.has(source.url));
    if (added.length !== 50 || added.some((source) => source.ats === 'beisen' || source.ats === 'moka')) throw new Error('Coverage registry must add 50 other sources without declaring them Beisen/Moka.');
  }
}

/** 样本资格单独验收；采集门槛通过不能证明未知来源属于其他平台。 */
export function RegistryEligibility(fixture, baseline, runs) {
  if (fixture.registryKind !== 'coverage-100') return undefined;
  const baselineUrls = new Set(baseline.sources.map((source) => source.url));
  const sources = fixture.sources.filter((source) => !baselineUrls.has(source.url));
  const details = sources.map((source) => {
    const run = runs.find((item) => item.url === source.url);
    const platform = run?.ats ?? run?.detectedPlatform;
    const publicEvidence = (run?.jobs?.length ?? 0) > 0 || run?.health === 'empty'
      || run?.errors?.some((error) => ['SOURCE_ADAPTER_UNAVAILABLE', 'SOURCE_MULTIPLE_PORTALS'].includes(error.code));
    const status = platform === 'moka' || platform === 'beisen' ? 'contradicted'
      : platform && publicEvidence ? 'verified_other' : 'unverified';
    return { company: source.company, url: source.url, platform, status };
  });
  return { requiredOtherSources: 50, verifiedOtherSources: details.filter((item) => item.status === 'verified_other').length,
    contradictedSources: details.filter((item) => item.status === 'contradicted').length,
    unverifiedSources: details.filter((item) => item.status === 'unverified').length,
    passed: details.length === 50 && details.every((item) => item.status === 'verified_other'), details };
}

export function ClassifyOutcome(run) {
  const codes = run.errors.map((error) => error.code);
  if (codes.includes('SOURCE_UNKNOWN_PLATFORM')) return 'unknown_platform';
  if (codes.some((code) => ['SOURCE_ADAPTER_UNAVAILABLE', 'SOURCE_UNSUPPORTED', 'SOURCE_PRIVATE_API', 'SOURCE_MULTIPLE_PORTALS'].includes(code))) return 'unsupported_source';
  if (codes.some((code) => /^SOURCE_[45]\d\d$/.test(code) || ['SOURCE_NETWORK_ERROR', 'SOURCE_TIMEOUT', 'SOURCE_CAPTCHA', 'SOURCE_LOGIN_REQUIRED', 'SOURCE_ACCESS_DENIED'].includes(code))) return 'access_or_network_failure';
  if (run.snapshotStatus === 'complete') return run.jobs.length ? 'complete' : 'empty';
  if (run.snapshotStatus === 'partial') return 'partial';
  return 'schema_failure';
}

/** 公开 Count/total 为明确对照口径；不存在公开总数时不输出伪造的岗位覆盖率。 */
export function JobCoverage(run) {
  if (!Number.isFinite(run.publicJobCount) || run.publicJobCount < 0) return { status: 'unverified', reason: 'No public job-count denominator is available.' };
  return { status: 'measured', method: 'public_api_count', extracted: run.jobs.length, denominator: run.publicJobCount,
    rate: run.publicJobCount ? run.jobs.length / run.publicJobCount : null };
}

export function CoverageSummary(runs) {
  const outcomes = {};
  const priorities = {};
  for (const run of runs) {
    const outcome = ClassifyOutcome(run);
    outcomes[outcome] = (outcomes[outcome] ?? 0) + 1;
    if (run.detectedPlatform && outcome === 'unsupported_source') priorities[run.detectedPlatform] = (priorities[run.detectedPlatform] ?? 0) + 1;
  }
  return { sources: runs.length, recognizedPlatforms: runs.filter((run) => run.ats || run.detectedPlatform).length,
    extractedSources: runs.filter((run) => run.jobs.length).length, completeSources: runs.filter((run) => run.snapshotStatus === 'complete').length,
    outcomes, adapterPriorities: Object.entries(priorities).sort((a, b) => b[1] - a[1]).map(([platform, sources]) => ({ platform, sources })) };
}
