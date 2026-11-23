const PrivateKey = /^(?:api[_-]?key|token|access[_-]?token|refresh[_-]?token|secret|client[_-]?secret|password|captcha|cookie|set-cookie|authorization|reasoning|reasoning_content|thinking|thinkingContent|chain_of_thought)$/i;

/** 仅给 Judge 业务证据，不发送凭据、思考正文或供应商请求快照；字符串中的令牌也脱敏。 */
export function SanitizeJudgeEvidence(value: unknown): unknown {
  if (typeof value === 'string') return value.replace(/Bearer\s+[^\s"'<>]+/gi, 'Bearer [REDACTED]').replace(/\bsk-[A-Za-z0-9_-]+\b/g, '[REDACTED_API_KEY]');
  if (Array.isArray(value)) return value.map(SanitizeJudgeEvidence);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([key]) => !PrivateKey.test(key)).map(([key, item]) => {
    if (key === 'arguments' && typeof item === 'string') {
      try { return [key, SanitizeJudgeEvidence(JSON.parse(item))]; } catch { /* 不是 JSON 的工具参数按普通文本脱敏。 */ }
    }
    return [key, SanitizeJudgeEvidence(item)];
  }));
  return value;
}

/** 事件保持输入顺序和原序号，引用不会因过滤思考或日志而指向别的动作。 */
export function ObservableJudgeEvents(events: unknown[]): unknown[] {
  return events.flatMap((event, index) => {
    if (!event || typeof event !== 'object') return [];
    const type = String((event as { type?: unknown }).type ?? '');
    return /^(?:tool_call|tool_result|question_requested|resume_confirmation|browser_confirmation|browser_action_completed|simulator_confirmation|simulator_stopped|user_input|interaction_result|interaction_resolved)$/.test(type)
      ? [{ ...SanitizeJudgeEvidence(event) as Record<string, unknown>, id: `event-${index + 1}` }] : [];
  });
}

export interface ExpectedStateCheck { path: string; passed: boolean; expected: unknown; actual: unknown; }

/** expectedState 为对象子集、数组完整结构；没有要求的对象字段不裁决，数组增删必须被发现。 */
export function CheckExpectedState(actual: unknown, expected: unknown, path = 'finalState'): ExpectedStateCheck[] {
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || actual.length !== expected.length) return [{ path, passed: false, expected, actual }];
    return expected.flatMap((item, index) => CheckExpectedState(actual[index], item, `${path}[${index}]`));
  }
  if (expected && typeof expected === 'object') {
    if (!actual || typeof actual !== 'object' || Array.isArray(actual)) return [{ path, passed: false, expected, actual }];
    return Object.entries(expected).flatMap(([key, value]) => CheckExpectedState((actual as Record<string, unknown>)[key], value, `${path}.${key}`));
  }
  return [{ path, passed: Object.is(actual, expected), expected, actual }];
}
