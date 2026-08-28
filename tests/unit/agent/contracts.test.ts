import { describe, expect, expectTypeOf, it } from 'vitest';
import type { AgentSessionAssistantState, AgentStreamEvent } from '../../../packages/contracts/src/bridge';
import { ErrorCode } from '../../../packages/contracts/src/error-codes';
import { CreateResultFailure, RequestEnvelopeSchema, WriteCommandEnvelopeSchema } from '../../../packages/contracts/src/envelope';
import { ResumeUpsertSchema } from '../../../packages/contracts/src/write-schemas';

describe('contracts Agent 相关契约', () => {
  it('Agent 事件类型包含内容、互斥终态和可恢复等待态', () => {
    const eventTypes = [
      'thinking_delta', 'content_delta', 'completed', 'cancelled', 'error',
      'waiting_user_input', 'waiting_confirmation', 'paused',
      'browser_confirmation', 'browser_action_completed', 'browser_user_action',
    ] satisfies AgentStreamEvent['type'][];

    expect(eventTypes).toContain('completed');
    expect(eventTypes).toContain('waiting_confirmation');
  });

  it('会话状态显式冻结默认或投递场景', () => {
    expectTypeOf<AgentSessionAssistantState['scenarioId']>().toEqualTypeOf<'default' | 'application'>();
  });

  it('Usage 来源显式支持 unavailable，不能把估算伪装成真实值', () => {
    expectTypeOf<AgentSessionAssistantState['usage']['source']>()
      .toEqualTypeOf<'actual' | 'unavailable' | 'legacy_estimate'>();
    const unavailable: AgentSessionAssistantState['usage'] = {
      inputTokens: 0,
      contextLimit: 64_000,
      compressionCount: 0,
      compressionThreshold: 70,
      source: 'unavailable',
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      reportedRequestCount: 0,
      unreportedRequestCount: 1,
    };
    expect(unavailable.source).toBe('unavailable');
  });

  it('稳定错误码拒绝未知错误码向外泄漏', () => {
    expect(ErrorCode.RESUME_REVISION_CONFLICT).toBe('RESUME_REVISION_CONFLICT');
    expect(ErrorCode.RESOURCE_NOT_AUTHORIZED).toBe('RESOURCE_NOT_AUTHORIZED');
    expect(CreateResultFailure('UNKNOWN_INTERNAL_CODE', 'safe message')).toEqual({
      ok: false,
      error: { code: 'INTERNAL_ERROR', message: 'safe message', retryable: false },
    });
  });

  it('写入信封要求稳定幂等键并限制 revision', () => {
    expect(WriteCommandEnvelopeSchema.safeParse({ payload: [] }).success).toBe(false);
    expect(WriteCommandEnvelopeSchema.safeParse({ idempotencyKey: 'intent-1', payload: [] }).success).toBe(true);
    expect(RequestEnvelopeSchema.safeParse({ requestId: 'request-1', expectedRevision: -1, payload: {} }).success).toBe(false);
    expect(RequestEnvelopeSchema.safeParse({ requestId: 'request-1', idempotencyKey: 'intent-1', expectedRevision: 3, payload: {} }).success).toBe(true);
  });

  it('简历写 Schema 拦截空 ID 与超长正文', () => {
    expect(ResumeUpsertSchema.safeParse({ id: '', content: 'resume' }).success).toBe(false);
    expect(ResumeUpsertSchema.safeParse({ id: 'resume-1', content: 'x'.repeat(200_001) }).success).toBe(false);
    expect(ResumeUpsertSchema.safeParse({ id: 'resume-1', content: '正常简历' }).success).toBe(true);
  });
});
