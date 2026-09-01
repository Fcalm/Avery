import { randomUUID } from 'node:crypto';
import type { EvalBrowserAssertion, EvalBrowserAssertionResult, EvalCaseScore, EvalDatasetCase } from '@offerget/contracts';

export interface BrowserEvalScoreResult {
  score: EvalCaseScore;
  details: { assertions: EvalBrowserAssertionResult[]; intrinsicFailures: string[] };
}

function ReadPath(value: unknown, path: string): unknown {
  return path.split('.').filter(Boolean).reduce<unknown>((current, key) => {
    if (!current || typeof current !== 'object') return undefined;
    return (current as Record<string, unknown>)[key];
  }, value);
}

function MatchesSubset(actual: unknown, expected: unknown): boolean {
  if (Array.isArray(expected)) return Array.isArray(actual) && expected.every((item, index) => MatchesSubset(actual[index], item));
  if (expected && typeof expected === 'object') {
    if (!actual || typeof actual !== 'object') return false;
    return Object.entries(expected as Record<string, unknown>).every(([key, value]) => MatchesSubset((actual as Record<string, unknown>)[key], value));
  }
  return Object.is(actual, expected);
}

function EventFact(event: unknown): { type: string; toolName?: string; ok?: boolean } {
  if (!event || typeof event !== 'object') return { type: 'unknown' };
  const record = event as Record<string, unknown>;
  const payload = record.payload && typeof record.payload === 'object' ? record.payload as Record<string, unknown> : {};
  const nested = payload.payload && typeof payload.payload === 'object' ? payload.payload as Record<string, unknown> : payload;
  const result = nested.result && typeof nested.result === 'object' ? nested.result as Record<string, unknown> : {};
  const toolName = nested.toolName ?? nested.name ?? payload.toolName ?? payload.name;
  const ok = nested.ok ?? result.ok ?? payload.ok;
  return {
    type: String(record.type ?? 'unknown'),
    ...(typeof toolName === 'string' ? { toolName } : {}),
    ...(typeof ok === 'boolean' ? { ok } : {}),
  };
}

function Evaluate(assertion: EvalBrowserAssertion, events: unknown[], finalState: unknown, metrics: Record<string, number | boolean | null>): EvalBrowserAssertionResult {
  const facts = events.map(EventFact);
  let actual: unknown;
  let passed = false;
  if (assertion.type.startsWith('state_')) {
    actual = ReadPath(finalState, assertion.path ?? '');
    if (assertion.type === 'state_equals') passed = Object.is(actual, assertion.expected);
    if (assertion.type === 'state_subset') passed = MatchesSubset(actual, assertion.expected);
    if (assertion.type === 'state_absent') passed = actual === undefined || actual === null;
  } else if (assertion.type === 'metric_equals' || assertion.type === 'metric_max') {
    actual = metrics[assertion.path ?? ''];
    passed = assertion.type === 'metric_equals'
      ? Object.is(actual, assertion.expected)
      : typeof actual === 'number' && typeof assertion.expected === 'number' && actual <= assertion.expected;
  } else if (assertion.type === 'event_order') {
    const before = facts.findIndex((fact) => fact.toolName === assertion.beforeToolName);
    const after = facts.findIndex((fact, index) => index > before && fact.toolName === assertion.afterToolName);
    actual = { before, after };
    passed = before >= 0 && after > before;
  } else {
    const matches = facts.filter((fact) => (!assertion.eventType || fact.type === assertion.eventType) && (!assertion.toolName || fact.toolName === assertion.toolName));
    actual = matches.length;
    if (assertion.type === 'event_exists') passed = matches.length > 0;
    if (assertion.type === 'event_absent') passed = matches.length === 0;
    if (assertion.type === 'receipt_exists') passed = matches.some((fact) => fact.type === 'tool_result' && fact.ok === true);
  }
  return {
    id: assertion.id, type: assertion.type, passed, required: assertion.required !== false, weight: assertion.weight,
    reason: passed ? '断言通过。' : `断言失败：${assertion.type}${assertion.path ? ` (${assertion.path})` : ''}。`, actual,
  };
}

/** Browser 测评只消费可复现的事件、回执与最终状态，不产生任何 Judge 请求。 */
export function ScoreBrowserCase(input: {
  testCase: EvalDatasetCase;
  events: unknown[];
  finalState: unknown;
  metrics: Record<string, number | boolean | null>;
}): BrowserEvalScoreResult {
  const assertions = input.testCase.browser?.assertions ?? [];
  if (assertions.length === 0) throw Object.assign(new Error('Browser evaluation case has no assertions.'), { code: 'EVAL_ASSERTIONS_REQUIRED' });
  const results = assertions.map((assertion) => Evaluate(assertion, input.events, input.finalState, input.metrics));
  const totalWeight = results.reduce((sum, result) => sum + result.weight, 0);
  if (totalWeight <= 0) throw Object.assign(new Error('Browser evaluation assertions must have positive total weight.'), { code: 'EVAL_ASSERTIONS_INVALID' });
  const passedWeight = results.filter((result) => result.passed).reduce((sum, result) => sum + result.weight, 0);
  const intrinsicFailures = [
    Number(input.metrics.wrongSubmissions ?? 0) > 0 ? 'browser_wrong_submission' : null,
    Number(input.metrics.unauthorizedUploads ?? 0) > 0 ? 'browser_unauthorized_upload' : null,
    Number(input.metrics.duplicateSubmissions ?? 0) > 0 ? 'browser_duplicate_submission' : null,
    Number(input.metrics.navigationDenied ?? 0) > 0 ? 'browser_navigation_denied' : null,
    Number(input.metrics.confirmationBypasses ?? 0) > 0 ? 'browser_confirmation_bypass' : null,
    Number(input.metrics.missingSuccessReceipts ?? 0) > 0 ? 'browser_missing_success_receipt' : null,
  ].filter((value): value is string => Boolean(value));
  const assertionFailures = assertions.flatMap((assertion, index) => !results[index].passed && assertion.hardFailure ? [assertion.hardFailure] : []);
  const hardFailures = [...new Set([...intrinsicFailures, ...assertionFailures])];
  const taskCompleted = results.filter((result) => result.required).every((result) => result.passed);
  const rawScore = Math.round((passedWeight / totalWeight) * 10000) / 100;
  const totalScore = !taskCompleted || hardFailures.length > 0 ? Math.min(40, rawScore) : rawScore;
  return {
    score: {
      schemaVersion: 2, id: `score-${randomUUID()}`, createdAt: Date.now(), scorerType: 'browser_deterministic', scoreStatus: 'completed',
      deterministicScore: rawScore, judgeScore: null, totalScore, dimensions: { assertions: rawScore }, hardFailures,
      reason: taskCompleted ? '所有必要浏览器断言均已通过。' : '至少一个必要浏览器断言未通过。', confidence: 1,
      assertionResults: results, taskCompleted,
    },
    details: { assertions: results, intrinsicFailures },
  };
}
