import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentHost } from '../../../apps/backend/src/electron/backend/agent-host';
import { ObservabilityStore } from '../../../apps/backend/src/observability-store';

const directories: string[] = [];

function UsageResponse(): Response {
  const body = [
    `data: ${JSON.stringify({ choices: [{ delta: { content: '完成' } }], usage: null })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ delta: { content: '', role: null }, finish_reason: 'stop', index: 0 }], usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 } })}\n\n`,
    'data: [DONE]\n\n',
  ].join('');
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

afterEach(() => {
  vi.unstubAllGlobals();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('Agent Usage 三方对账', () => {
  it('同一 Provider usage 事实同步进入会话展示源、持久化状态与 Trace', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'offerget-usage-reconciliation-'));
    directories.push(userDataPath);
    const observability = new ObservabilityStore(userDataPath);
    vi.stubGlobal('fetch', vi.fn(async () => UsageResponse()));
    const snapshots = new Map<string, unknown>();
    const host = new AgentHost({
      userDataPath,
      workspacePath: userDataPath,
      Emit: () => undefined,
      business: {
        GetStoredSettings: async () => ({}),
        GetProfiles: async () => ({ items: [] }),
        ResolveAttachmentUri: async () => null,
        GetConversationSnapshots: async (sessionId: string) => snapshots.get(sessionId) ?? null,
        SetConversationSnapshots: async (sessionId: string, value: unknown) => { snapshots.set(sessionId, value); },
      },
      observability,
      credentialPort: {
        Load: async () => ({
          provider: 'DeepSeek', baseUrl: 'https://api.deepseek.com', model: 'deepseek-v4-flash', thinkingEnabled: false,
          contextLimit: 64_000, compressionThreshold: 80, apiKey: 'test-key',
        }),
        Save: async () => undefined,
      },
    });

    try {
      await host.Send({ requestId: 'request-usage-1', sessionId: 'session-usage-1', content: '回复完成' });

      const expected = {
        source: 'actual', promptTokens: 11, completionTokens: 7, totalTokens: 18,
        reportedRequestCount: 1, unreportedRequestCount: 0,
      };
      expect((await host.GetSessionAssistantState('session-usage-1')).usage).toMatchObject(expected);
      expect(observability.GetTraces()[0]?.usage).toEqual({
        source: 'provider', promptTokens: 11, completionTokens: 7, totalTokens: 18,
        reportedRequestCount: 1, unreportedRequestCount: 0,
      });
      const persisted = JSON.parse(readFileSync(join(userDataPath, 'agent-state.json'), 'utf8')) as { sessionUsage: Array<[string, unknown]> };
      expect(Object.fromEntries(persisted.sessionUsage)['session-usage-1']).toMatchObject(expected);
    } finally {
      await host.Close();
      observability.Close();
    }
  });
});
