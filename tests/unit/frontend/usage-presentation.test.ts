import { describe, expect, it } from 'vitest';
import { CreateSessionUsagePresentation } from '../../../src/features/assistant/usagePresentation';

describe('会话真实 Usage 展示', () => {
  it('只以最近一次 Provider prompt_tokens 计算进度，并且详情不暴露具体 token 数', () => {
    expect(CreateSessionUsagePresentation({
      source: 'actual', inputTokens: 12_800, contextLimit: 64_000, compressionThreshold: 80,
      reportedRequestCount: 3, unreportedRequestCount: 0,
    })).toEqual({
      progress: 20, title: '上下文进度 20%；压缩阈值 80%',
    });
  });

  it('Provider 未返回 Usage 时显示未知，而不是估算百分比', () => {
    expect(CreateSessionUsagePresentation({
      source: 'unavailable', inputTokens: 0, contextLimit: 64_000, compressionThreshold: 80,
      reportedRequestCount: 0, unreportedRequestCount: 1,
    }).progress).toBe(0);
  });

  it('新会话在没有成功请求时显示破折号', () => {
    expect(CreateSessionUsagePresentation({
      source: 'unavailable', inputTokens: 0, contextLimit: 64_000, compressionThreshold: 80,
      reportedRequestCount: 0, unreportedRequestCount: 0,
    }).progress).toBe(0);
  });

  it('历史估算值不能作为真实 Usage 展示', () => {
    expect(CreateSessionUsagePresentation({
      source: 'legacy_estimate', inputTokens: 44_000, contextLimit: 64_000, compressionThreshold: 80,
      reportedRequestCount: 5, unreportedRequestCount: 0,
    }).progress).toBe(0);
  });
});
