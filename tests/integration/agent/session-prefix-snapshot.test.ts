import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentHost } from '../../../apps/backend/src/electron/backend/agent-host';
import { ObservabilityStore } from '../../../apps/backend/src/observability-store';

const directories: string[] = [];

function CompletionResponse(content = '完成'): Response {
  const body = [
    `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`,
    'data: [DONE]\n\n',
  ].join('');
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('AgentHost 会话前缀快照', () => {
  it('新会话的空工具占位不应阻止首次绑定投递场景', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'offerget-application-session-'));
    directories.push(userDataPath);
    const observability = new ObservabilityStore(userDataPath);
    const storedSnapshots = new Map<string, any>([
      ['application-session', { sessionSnapshotJson: null, toolSnapshotJson: '[]' }],
    ]);
    const requestBodies: any[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      requestBodies.push(JSON.parse(String(init?.body)));
      return CompletionResponse('已进入投递场景');
    }));
    const host = new AgentHost({
      userDataPath,
      workspacePath: userDataPath,
      Emit: () => undefined,
      business: {
        GetStoredSettings: async () => ({}),
        GetProfiles: async () => ({ items: [] }),
        ResolveAttachmentUri: async () => null,
        GetConversationSnapshots: async (sessionId: string) => storedSnapshots.get(sessionId) ?? null,
        SetConversationSnapshots: async (sessionId: string, value: unknown) => { storedSnapshots.set(sessionId, value); },
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
      await expect(host.Send({
        requestId: 'application-request', sessionId: 'application-session', scenarioId: 'application',
        content: '帮我搜索合适的岗位', confirmationMode: 'always_confirm',
      })).resolves.toMatchObject({ accepted: true });

      const persisted = JSON.parse(storedSnapshots.get('application-session').toolSnapshotJson);
      expect(persisted.scenarioId).toBe('application');
      expect(persisted.tool.orderedToolNames).toContain('BrowserNavigate');
      expect(requestBodies[0].tools.map((tool: any) => tool.function.name)).toContain('BrowserNavigate');

      await expect(host.Send({
        requestId: 'invalid-scenario-switch', sessionId: 'application-session', scenarioId: 'default',
        content: '在原会话切回默认场景', confirmationMode: 'always_confirm',
      })).rejects.toThrow('A scenario is already bound to this conversation');
      expect(requestBodies).toHaveLength(1);
    } finally {
      await host.Close();
      observability.Close();
    }
  });

  it('跨 Run 复用完整快照并保留旧 runtime reminder，满 24 小时后才重建', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-22T02:08:00.000Z'));
    const userDataPath = mkdtempSync(join(tmpdir(), 'offerget-session-prefix-'));
    directories.push(userDataPath);
    const observability = new ObservabilityStore(userDataPath);
    const storedSnapshots = new Map<string, any>();
    const setSnapshots = vi.fn(async (sessionId: string, value: unknown) => { storedSnapshots.set(sessionId, value); });
    const requestBodies: any[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      requestBodies.push(JSON.parse(String(init?.body)));
      return CompletionResponse();
    }));
    const host = new AgentHost({
      userDataPath,
      workspacePath: userDataPath,
      Emit: () => undefined,
      business: {
        GetStoredSettings: async () => ({ customContext: 'stable context' }),
        GetProfiles: async () => ({ items: [] }),
        ResolveAttachmentUri: async () => null,
        GetConversationSnapshots: async (sessionId: string) => storedSnapshots.get(sessionId) ?? null,
        SetConversationSnapshots: setSnapshots,
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
      await host.Send({ requestId: 'request-1', sessionId: 'session-1', content: '第一轮', confirmationMode: 'always_confirm' });
      await host.Send({ requestId: 'request-2', sessionId: 'session-1', content: '第二轮', confirmationMode: 'always_confirm' });

      expect(setSnapshots).toHaveBeenCalledTimes(1);
      const persisted = storedSnapshots.get('session-1');
      const sessionSnapshot = JSON.parse(persisted.sessionSnapshotJson);
      expect(sessionSnapshot).toMatchObject({
        sessionRevision: 1,
        createdAt: '2026-08-22T02:08:00.000Z',
        expiresAt: '2026-08-23T02:08:00.000Z',
        refreshReason: 'session_created',
      });
      expect(sessionSnapshot.compiledPrefix).toContain('stable context');
      expect(requestBodies[0].messages[0]).toEqual(requestBodies[1].messages[0]);
      expect(requestBodies[0].tools).toEqual(requestBodies[1].tools);
      const reminders = requestBodies[1].messages.filter((message: { role: string; content: string }) => message.role === 'user' && message.content.includes('Used turns: 0 of 30.'));
      expect(reminders).toHaveLength(2);
      for (const message of reminders as Array<{ content: string; metadata?: unknown }>) {
        expect(message).not.toHaveProperty('metadata');
        expect(message.content).toMatch(/^<runtime-reminder>\n/);
        expect(message.content).toMatch(/\n<\/runtime-reminder>$/);
        expect(message.content).not.toMatch(/createdAt|scenario/i);
      }

      vi.setSystemTime(new Date('2026-08-23T02:08:00.001Z'));
      await host.Send({ requestId: 'request-3', sessionId: 'session-1', content: '第三轮', confirmationMode: 'always_confirm' });

      expect(setSnapshots).toHaveBeenCalledTimes(2);
      const refreshed = JSON.parse(storedSnapshots.get('session-1').sessionSnapshotJson);
      expect(refreshed).toMatchObject({ sessionRevision: 2, refreshReason: 'ttl_elapsed' });
    } finally {
      await host.Close();
      observability.Close();
    }
  });
});
