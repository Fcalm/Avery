import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ObservabilityStore } from '../../../apps/backend/src/observability-store';

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('ObservabilityStore Provider usage 对账', () => {
  it('以 Provider usage 事实聚合 Trace，不使用估算 token_count', () => {
    const directory = mkdtempSync(join(tmpdir(), 'avery-observability-'));
    directories.push(directory);
    const store = new ObservabilityStore(directory);
    store.StartTrace('request-1', 'session-1', 'model-1');
    store.AppendTraceEvent('request-1', 'assistant_message', { content: 'response' }, 9_999);
    store.RecordTraceUsage('request-1', { source: 'provider', promptTokens: 11, completionTokens: 7, totalTokens: 18 });
    store.RecordTraceUsage('request-1', { source: 'provider', promptTokens: 3, completionTokens: 2, totalTokens: 5 });
    store.RecordTraceUsage('request-1', { source: 'unavailable', promptTokens: 0, completionTokens: 0, totalTokens: 0 });

    expect(store.GetTraces()).toEqual([expect.objectContaining({
      requestId: 'request-1',
      usage: { source: 'provider', promptTokens: 14, completionTokens: 9, totalTokens: 23, reportedRequestCount: 2, unreportedRequestCount: 1 },
    })]);
    expect(store.GetTraceEvents('request-1').filter((event) => event.eventType === 'provider_usage').map((event) => event.payload)).toEqual([
      { source: 'provider', promptTokens: 11, completionTokens: 7, totalTokens: 18 },
      { source: 'provider', promptTokens: 3, completionTokens: 2, totalTokens: 5 },
      { source: 'unavailable', promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    ]);
    store.Close();
  });

  it('Provider 未返回 usage 时显式保留 unavailable，不伪造估算值', () => {
    const directory = mkdtempSync(join(tmpdir(), 'avery-observability-'));
    directories.push(directory);
    const store = new ObservabilityStore(directory);
    store.StartTrace('request-2', 'session-1', 'model-1');
    store.RecordTraceUsage('request-2', { source: 'unavailable', promptTokens: 0, completionTokens: 0, totalTokens: 0 });

    expect(store.GetTraces()[0]?.usage).toEqual({ source: 'unavailable', promptTokens: 0, completionTokens: 0, totalTokens: 0, reportedRequestCount: 0, unreportedRequestCount: 1 });
    store.Close();
  });

  it('拒绝总数矛盾或携带非零值的 unavailable usage', () => {
    const directory = mkdtempSync(join(tmpdir(), 'avery-observability-'));
    directories.push(directory);
    const store = new ObservabilityStore(directory);
    store.StartTrace('request-invalid', 'session-1', 'model-1');

    expect(() => store.RecordTraceUsage('request-invalid', { source: 'provider', promptTokens: 11, completionTokens: 7, totalTokens: 19 })).toThrow(/usage is invalid/i);
    expect(() => store.RecordTraceUsage('request-invalid', { source: 'unavailable', promptTokens: 1, completionTokens: 0, totalTokens: 1 })).toThrow(/usage is invalid/i);
    expect(store.GetTraces()[0]?.usage).toEqual({ source: 'unavailable', promptTokens: 0, completionTokens: 0, totalTokens: 0, reportedRequestCount: 0, unreportedRequestCount: 0 });
    store.Close();
  });
});
