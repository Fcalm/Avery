import { describe, expect, it } from 'vitest';
import { ResolveConfirmationContinuation } from '../../../src/features/assistant/confirmationContinuation';

describe('弹窗确认续发门禁', () => {
  it('同一 request 的确认答案立即获得发送权', () => {
    expect(ResolveConfirmationContinuation('request-old', 'request-old'))
      .toEqual({ allowed: true, releaseActiveRequest: true });
  });

  it('没有活动 Run 时直接发送确认答案', () => {
    expect(ResolveConfirmationContinuation(null, 'request-old'))
      .toEqual({ allowed: true, releaseActiveRequest: false });
  });

  it('其他 request 仍在运行时不能把确认答案串入错误 Run', () => {
    expect(ResolveConfirmationContinuation('request-new', 'request-old'))
      .toEqual({ allowed: false, releaseActiveRequest: false });
  });
});
