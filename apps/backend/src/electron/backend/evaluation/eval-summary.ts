import type { EvalCaseRun, EvalRunSummary } from '@avery/contracts';

/** 完成率只统计已得到明确业务判定的案例；未计分、环境失败、取消和未执行均不冒充失败或成功。 */
export function SummarizeEvalCases(caseRuns: EvalCaseRun[], startedAt: number, now = Date.now()): EvalRunSummary {
  const completed = caseRuns.filter(item => item.status === 'completed');
  const scores = completed.map(item => item.score?.totalScore).filter((value): value is number => typeof value === 'number');
  const evaluated = caseRuns.filter(item => ['completed', 'failed'].includes(item.status) && item.metrics.environmentFailure !== true && typeof item.metrics.taskCompleted === 'boolean');
  const taskCompleted = evaluated.filter(item => item.metrics.taskCompleted === true).length;
  const numberMetric = (key: string) => caseRuns.reduce((sum, item) => sum + (typeof item.metrics[key] === 'number' ? item.metrics[key] as number : 0), 0);
  const promptTokens = numberMetric('promptTokens'), completionTokens = numberMetric('completionTokens');
  return {
    totalCaseRuns: caseRuns.length, completedCaseRuns: completed.length,
    unscoredCaseRuns: completed.filter(item => typeof item.score?.totalScore !== 'number').length,
    failedCaseRuns: caseRuns.filter(item => item.status === 'failed').length,
    cancelledCaseRuns: caseRuns.filter(item => item.status === 'cancelled').length,
    notRunCaseRuns: caseRuns.filter(item => item.status === 'not_run').length,
    taskEvaluatedCaseRuns: evaluated.length, taskCompletedCaseRuns: taskCompleted,
    averageScore: scores.length ? scores.reduce((sum, value) => sum + value, 0) / scores.length : null,
    taskCompletionRate: evaluated.length ? taskCompleted / evaluated.length : null,
    toolErrorCount: numberMetric('toolErrors'), modelTurns: numberMetric('modelTurns'), durationMs: Math.max(0, now - startedAt),
    usage: { source: promptTokens + completionTokens > 0 ? 'provider' : 'unavailable', promptTokens, completionTokens, totalTokens: promptTokens + completionTokens },
  };
}
