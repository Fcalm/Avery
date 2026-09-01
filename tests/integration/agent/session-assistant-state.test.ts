import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentHost } from '../../../apps/backend/src/electron/backend/agent-host';
import { ObservabilityStore } from '../../../apps/backend/src/observability-store';

const directories: string[] = [];

function CompletionResponse(): Response {
  return new Response([
    `data: ${JSON.stringify({ choices: [{ delta: { content: '已完成' } }] })}\n\n`,
    'data: [DONE]\n\n',
  ].join(''), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

function ModelsResponse(models: string[]): Response {
  return new Response(JSON.stringify({ data: models.map((id) => ({ id })) }), { status: 200 });
}

afterEach(() => {
  vi.unstubAllGlobals();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('AgentHost 会话助手状态', () => {
  it('将模型和确认权限写入业务会话快照，并在新宿主重载时校验失效模型后回退', async () => {
    const root = mkdtempSync(join(tmpdir(), 'offerget-session-assistant-state-'));
    directories.push(root);
    const snapshots = new Map<string, any>();
    const business = {
      GetStoredSettings: async () => ({}),
      GetProfiles: async () => ({ items: [] }),
      ResolveAttachmentUri: async () => null,
      GetConversationSnapshots: async (sessionId: string) => snapshots.get(sessionId) ?? null,
      SetConversationSnapshots: async (sessionId: string, value: unknown) => { snapshots.set(sessionId, structuredClone(value)); },
    };
    let availableModels = ['deepseek-v4-flash', 'deepseek-v4-pro'];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => String(url).endsWith('/models')
      ? ModelsResponse(availableModels)
      : CompletionResponse()));

    const firstObservability = new ObservabilityStore(join(root, 'first'));
    const first = new AgentHost({
      userDataPath: join(root, 'first'), workspacePath: root, Emit: () => undefined, business, observability: firstObservability,
      credentialPort: {
        Load: async () => ({ provider: 'DeepSeek', baseUrl: 'https://api.deepseek.com', model: 'deepseek-v4-flash', thinkingEnabled: false, contextLimit: 64_000, compressionThreshold: 80, apiKey: 'test-key' }),
        Save: async () => undefined,
      },
    });

    try {
      await first.Send({
        requestId: 'state-request-1', sessionId: 'state-session', content: '请开始',
        model: 'deepseek-v4-pro', reasoningEffort: 'xhigh', confirmationMode: 'allow_low_risk',
      });
      expect(JSON.parse(snapshots.get('state-session').toolSnapshotJson).assistantState).toEqual({
        model: 'deepseek-v4-pro', confirmationMode: 'allow_low_risk', reasoningEffort: 'xhigh',
      });
    } finally {
      await first.Close();
      firstObservability.Close();
    }

    availableModels = ['deepseek-v4-flash'];
    const restoredObservability = new ObservabilityStore(join(root, 'restored'));
    const restored = new AgentHost({
      userDataPath: join(root, 'restored'), workspacePath: root, Emit: () => undefined, business, observability: restoredObservability,
      credentialPort: {
        Load: async () => ({ provider: 'DeepSeek', baseUrl: 'https://api.deepseek.com', model: 'deepseek-v4-flash', thinkingEnabled: false, contextLimit: 64_000, compressionThreshold: 80, apiKey: 'test-key' }),
        Save: async () => undefined,
      },
    });

    try {
      await expect(restored.GetSessionAssistantState('state-session')).resolves.toMatchObject({
        model: 'deepseek-v4-flash', confirmationMode: 'allow_low_risk', reasoningEffort: 'xhigh',
      });
      await expect(restored.UpdateReasoningEffort('state-session', 'max')).resolves.toEqual({ updated: true, reasoningEffort: 'max' });
      await expect(restored.ReloadSession('state-session')).resolves.toMatchObject({ reloaded: true });
      expect(JSON.parse(snapshots.get('state-session').toolSnapshotJson).assistantState).toEqual({
        model: 'deepseek-v4-flash', confirmationMode: 'allow_low_risk', reasoningEffort: 'max',
      });
    } finally {
      await restored.Close();
      restoredObservability.Close();
    }
  });
});
