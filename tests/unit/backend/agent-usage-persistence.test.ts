import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentHost } from '../../../apps/backend/src/electron/backend/agent-host';

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('AgentHost 会话 usage 恢复', () => {
  it('重启后恢复同一会话的 Provider usage，不回退为估算值或其他会话数据', () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'offerget-agent-state-'));
    directories.push(userDataPath);
    const usage = {
      source: 'actual', inputTokens: 11, contextLimit: 64_000, compressionCount: 2, compressionThreshold: 80,
      promptTokens: 20, completionTokens: 8, totalTokens: 28, reportedRequestCount: 2, unreportedRequestCount: 1, updatedAt: Date.now(),
    };
    writeFileSync(join(userDataPath, 'agent-state.json'), JSON.stringify({
      histories: [], tasks: [], projectEnvironments: [], sessionUsage: [['session-restored', usage]], toolLedger: [], runSnapshots: [],
    }), 'utf8');
    const host = new AgentHost({
      userDataPath,
      workspacePath: userDataPath,
      Emit: () => undefined,
      business: { GetStoredSettings: async () => ({}), ResolveAttachmentUri: async () => null },
      observability: null,
      credentialPort: { Load: async () => null, Save: async () => undefined },
    });

    expect(host.GetSessionAssistantState('session-restored').usage).toMatchObject({
      source: 'actual', inputTokens: 11, contextLimit: 64_000, compressionCount: 2, compressionThreshold: 80,
      promptTokens: 20, completionTokens: 8, totalTokens: 28, reportedRequestCount: 2, unreportedRequestCount: 1,
    });
    expect(host.GetSessionAssistantState('another-session').usage).toMatchObject({ source: 'unavailable', promptTokens: 0, completionTokens: 0, totalTokens: 0 });
  });
});
