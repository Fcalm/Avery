import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentHost } from '../../../apps/backend/src/electron/backend/agent-host';
import { ObservabilityStore } from '../../../apps/backend/src/observability-store';

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('AgentHost 会话删除清理', () => {
  it('删除会话时清除其运行状态并保留其他会话和审计账本', async () => {
    const root = mkdtempSync(join(tmpdir(), 'avery-session-delete-'));
    directories.push(root);
    const hostPath = join(root, 'host');
    const observability = new ObservabilityStore(join(root, 'observability'));
    const host = new AgentHost({
      userDataPath: hostPath,
      workspacePath: root,
      Emit: () => undefined,
      observability,
      business: {
        GetStoredSettings: async () => ({}),
        GetProfiles: async () => ({ items: [] }),
        ResolveAttachmentUri: async () => null,
      },
    });
    const state = host as any;
    const deletedSessionId = 'conversation-deleted';
    const keptSessionId = 'conversation-kept';
    const deletedRequestId = 'request-deleted';
    const keptRequestId = 'request-kept';
    const deletedController = new AbortController();

    try {
      for (const key of ['histories', 'tasks', 'projectEnvironments', 'sessionSnapshots', 'sessionUsage', 'sessionScenarios', 'sessionAssistantStates', 'sessionResumeBindings', 'loadedSkills', 'loadedSkillResources']) {
        state[key].set(deletedSessionId, key === 'tasks' || key === 'loadedSkills' ? new Map() : key === 'loadedSkillResources' ? new Set() : { sessionId: deletedSessionId });
        state[key].set(keptSessionId, key === 'tasks' || key === 'loadedSkills' ? new Map() : key === 'loadedSkillResources' ? new Set() : { sessionId: keptSessionId });
      }
      state.pendingQuestions.set(deletedSessionId, [{ id: 'question-deleted' }]);
      state.pendingQuestions.set(keptSessionId, [{ id: 'question-kept' }]);
      state.pendingEdits.set('edit-deleted', { sessionId: deletedSessionId });
      state.pendingEdits.set('edit-kept', { sessionId: keptSessionId });
      state.runSnapshots.set(deletedRequestId, { sessionId: deletedSessionId });
      state.runSnapshots.set(keptRequestId, { sessionId: keptSessionId });
      state.pendingBrowserActions.set('browser-deleted', { requestId: deletedRequestId });
      state.pendingBrowserActions.set('browser-kept', { requestId: keptRequestId });
      state.pendingCronTasks.set('cron-deleted', { requestId: deletedRequestId });
      state.pendingCronTasks.set('cron-kept', { requestId: keptRequestId });
      state.runtimeControls.set(deletedRequestId, { sessionId: deletedSessionId, confirmationMode: 'always_confirm', toolContext: {} });
      state.controllers.set(deletedRequestId, deletedController);
      state.toolLedger.set('audit-kept', { ledgerId: 'audit-kept', runId: deletedRequestId });

      host.DeleteSessionResources(deletedSessionId);

      expect(deletedController.signal.aborted).toBe(true);
      for (const key of ['histories', 'tasks', 'pendingQuestions', 'projectEnvironments', 'sessionSnapshots', 'sessionUsage', 'sessionScenarios', 'sessionAssistantStates', 'sessionResumeBindings', 'loadedSkills', 'loadedSkillResources']) {
        expect(state[key].has(deletedSessionId), key).toBe(false);
        expect(state[key].has(keptSessionId), key).toBe(true);
      }
      expect(state.pendingEdits.has('edit-deleted')).toBe(false);
      expect(state.pendingBrowserActions.has('browser-deleted')).toBe(false);
      expect(state.pendingCronTasks.has('cron-deleted')).toBe(false);
      expect(state.runSnapshots.has(deletedRequestId)).toBe(false);
      expect(state.pendingEdits.has('edit-kept')).toBe(true);
      expect(state.pendingBrowserActions.has('browser-kept')).toBe(true);
      expect(state.pendingCronTasks.has('cron-kept')).toBe(true);
      expect(state.runSnapshots.has(keptRequestId)).toBe(true);
      expect(state.toolLedger.has('audit-kept')).toBe(true);

      const persisted = JSON.parse(readFileSync(join(hostPath, 'agent-state.json'), 'utf8'));
      expect(persisted.histories).toEqual([[keptSessionId, { sessionId: keptSessionId }]]);
      expect(persisted.runSnapshots).toEqual([[keptRequestId, { sessionId: keptSessionId }]]);
    } finally {
      await host.Close();
      observability.Close();
    }
  });
});
