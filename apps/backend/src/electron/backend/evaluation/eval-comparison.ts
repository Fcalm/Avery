import type { EvalCaseRun, EvalComparison, EvalRunDetail } from '@avery/contracts';

function Statistics(values: number[]) {
  const mean = values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
  const stddev = values.length > 1 && mean !== null ? Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1)) : null;
  return { mean, stddev };
}

/** 单候选运行允许候选 ID 改名；多候选按 ID 配对，repeat 按序号取双方已评分交集，禁止取首分或混合不同候选。 */
export function CompareEvalSamples(left: EvalRunDetail, right: EvalRunDetail): NonNullable<EvalComparison['samples']> {
  const candidates = (run: EvalRunDetail) => {
    const frozen = (run.snapshot.config as { candidates?: Array<{ id: string; name: string }> } | undefined)?.candidates;
    return frozen ?? [...new Map(run.caseRuns.map(item => [item.candidateId, { id: item.candidateId, name: item.candidateName }])).values()];
  };
  const leftCandidates = candidates(left), rightCandidates = candidates(right);
  const pairs = leftCandidates.length === 1 && rightCandidates.length === 1
    ? [{ left: leftCandidates[0], right: rightCandidates[0] }]
    : [...leftCandidates.map(item => ({ left: item, right: rightCandidates.find(candidate => candidate.id === item.id) })), ...rightCandidates.filter(item => !leftCandidates.some(candidate => candidate.id === item.id)).map(item => ({ left: undefined, right: item }))];
  const caseIds = (run: EvalRunDetail) => new Set([...(run.snapshot.cases as Array<{ id: string }> ?? []).map(item => item.id), ...run.caseRuns.map(item => item.caseId)]);
  const leftIds = caseIds(left), rightIds = caseIds(right);
  const allLeft: number[] = [], allRight: number[] = [];
  const scored = (item: EvalCaseRun): boolean => item.status === 'completed' && typeof item.score?.totalScore === 'number';
  const rows = [...new Set([...leftIds, ...rightIds])].flatMap(caseId => pairs.map(pair => {
    const a = left.caseRuns.filter(item => item.caseId === caseId && item.candidateId === pair.left?.id);
    const b = right.caseRuns.filter(item => item.caseId === caseId && item.candidateId === pair.right?.id);
    const leftValues: number[] = [], rightValues: number[] = [];
    for (const sample of a) {
      const partner = b.find(item => item.repeatIndex === sample.repeatIndex);
      if (scored(sample) && partner && scored(partner)) { leftValues.push(sample.score!.totalScore!); rightValues.push(partner.score!.totalScore!); }
    }
    allLeft.push(...leftValues); allRight.push(...rightValues);
    return { caseId, leftCandidate: pair.left?.name ?? '缺少候选', rightCandidate: pair.right?.name ?? '缺少候选', leftTotal: a.length, rightTotal: b.length, leftScored: a.filter(scored).length, rightScored: b.filter(scored).length, pairedCount: leftValues.length, left: Statistics(leftValues), right: Statistics(rightValues) };
  }));
  return { commonCaseCount: [...leftIds].filter(id => rightIds.has(id)).length, leftOnlyCaseCount: [...leftIds].filter(id => !rightIds.has(id)).length, rightOnlyCaseCount: [...rightIds].filter(id => !leftIds.has(id)).length, pairedCount: allLeft.length, leftMean: Statistics(allLeft).mean, rightMean: Statistics(allRight).mean, rows };
}
