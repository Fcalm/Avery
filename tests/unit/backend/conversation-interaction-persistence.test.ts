import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentHost } from '../../../apps/backend/src/electron/backend/agent-host';
import { ApplyConversationActivity, CreateConversationPresentation, type ConversationPresentation } from '../../../packages/agent-sdk/src/conversation';
import type { AgentStreamEvent } from '../../../packages/agent-sdk/src/events';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function Root() { const root = await mkdtemp(join(tmpdir(), 'avery-interaction-')); roots.push(root); return root; }

describe('Host 会话交互恢复与结算', () => {
  it('过期定时确认退出等待状态，不创建任务且不重启复活', async () => {
    const root = await Root();
    let presentation = ApplyConversationActivity(CreateConversationPresentation('cron-expired'), { kind: 'tool', toolCallId: 'c1', name: 'CreateCronTask', toolStatus: 'waiting' }, 1, 1);
    presentation = ApplyConversationActivity(presentation, { kind: 'status', status: 'waiting' }, 2, 2);
    const business = {
      GetStoredSettings: async () => ({}), ResolveAttachmentUri: async () => null,
      CreateCronTask: vi.fn(),
      GetConversationPresentations: async () => [presentation],
      SaveConversationPresentation: async (_owner: string, snapshot: ConversationPresentation) => { presentation = snapshot; return { saved: true }; },
    };
    const host = new AgentHost({ userDataPath: root, workspacePath: root, Emit: () => undefined, business, observability: null });
    (host as any).requestSessions.set('cron-expired', 'owner');
    (host as any).pendingCronTasks.set('cron1', { requestId: 'cron-expired', input: {}, createdAt: 1 });
    await expect(host.ConfirmCronTask('cron1', true)).rejects.toThrow('expired');
    expect(business.CreateCronTask).not.toHaveBeenCalled();
    expect(presentation).toMatchObject({ status: 'failed', parts: [expect.objectContaining({ status: 'failed' })] });
    const restarted = new AgentHost({ userDataPath: root, workspacePath: root, Emit: () => undefined, business, observability: null });
    expect((await restarted.GetSessionAssistantState('owner')).pendingEvents).toEqual([]);
    await host.Close(); await restarted.Close();
  });

  it('删除重启恢复的会话时同步移除旧确认归属，不影响其他会话', async () => {
    const root = await Root();
    const business = { GetStoredSettings: async () => ({}), ResolveAttachmentUri: async () => null };
    const host = new AgentHost({ userDataPath: root, workspacePath: root, Emit: () => undefined, business, observability: null });
    const state = host as any;
    state.requestSessions.set('req1', 'deleted');
    state.requestSessions.set('req2', 'kept');
    state.pendingCronTasks.set('cron1', { requestId: 'req1', input: {}, createdAt: Date.now() });
    state.pendingCronTasks.set('cron2', { requestId: 'req2', input: {}, createdAt: Date.now() });
    state.SaveState();
    const restarted = new AgentHost({ userDataPath: root, workspacePath: root, Emit: () => undefined, business, observability: null });
    restarted.DeleteSessionResources('deleted');
    expect((restarted as any).requestSessions.has('req1')).toBe(false);
    expect((restarted as any).pendingCronTasks.has('cron1')).toBe(false);
    expect((await restarted.GetSessionAssistantState('kept')).pendingEvents).toMatchObject([{ confirmationId: 'cron2' }]);
    await host.Close(); await restarted.Close();
  });

  it('确认保存失败后仍消费一次性提案，重启不复活确认且原消息记录失败', async () => {
    const root = await Root();
    const resume = { id: 'r1', name: '简历', revision: 1, content: '原文', targetRoles: [], summary: '', updatedAt: '' };
    let presentation = ApplyConversationActivity(CreateConversationPresentation('req-failed'), { kind: 'tool', stepId: 's1', toolCallId: 'c1', name: 'UpdateResume', toolStatus: 'waiting' }, 1, 1);
    presentation = ApplyConversationActivity(presentation, { kind: 'status', status: 'waiting' }, 2, 2);
    const business = {
      GetStoredSettings: async () => ({}), ResolveAttachmentUri: async () => null,
      LoadViewModel: async () => ({ resumes: [resume] }),
      UpsertResume: vi.fn(async () => { throw new Error('disk write failed'); }),
      GetConversationPresentations: async () => [presentation],
      SaveConversationPresentation: async (_sessionId: string, snapshot: ConversationPresentation) => { presentation = snapshot; return { saved: true }; },
    };
    const host = new AgentHost({ userDataPath: root, workspacePath: root, Emit: () => undefined, business, observability: null });
    const state = host as any;
    state.requestSessions.set('req-failed', 'owner');
    state.pendingEdits.set('resume-confirmation-failed', { kind: 'edit', sessionId: 'owner', ownerId: 'agent-req-failed', resumeId: 'r1', resume, baseRevision: 1, content: '新文', reason: '优化', idempotencyKey: 'failed1', proposalHash: 'hash1' });
    state.SaveState();
    await expect(host.ConfirmResumeEdit('resume-confirmation-failed', true)).rejects.toThrow('disk write failed');
    const restarted = new AgentHost({ userDataPath: root, workspacePath: root, Emit: () => undefined, business, observability: null });
    expect((await restarted.GetSessionAssistantState('owner')).pendingEvents).toEqual([]);
    expect(presentation.status).toBe('failed');
    expect(presentation.parts[0]).toMatchObject({ status: 'failed' });
    await expect(restarted.ConfirmResumeEdit('resume-confirmation-failed', true)).rejects.toThrow();
    expect(business.UpsertResume).toHaveBeenCalledTimes(1);
    await host.Close(); await restarted.Close();
  });

  it('重启恢复确认、问题与 Todo，空会话不返回其他会话的数据', async () => {
    const root = await Root();
    const business = { GetStoredSettings: async () => ({}), ResolveAttachmentUri: async () => null };
    const host = new AgentHost({ userDataPath: root, workspacePath: root, Emit: () => undefined, business, observability: null });
    const state = host as any;
    state.requestSessions.set('req1', 'owner');
    state.pendingEdits.set('resume-confirmation-one', { sessionId: 'owner', ownerId: 'agent-req1', content: '待确认正文', reason: '优化', name: '简历' });
    state.pendingQuestions.set('owner', [{ id: 'q1', question: '城市？', options: ['广州', '深圳'] }]);
    state.tasks.set('owner', new Map([['todo1', { id: 'todo1', title: '准备简历', description: '', status: 'pending' }]]));
    state.SaveState();
    const restarted = new AgentHost({ userDataPath: root, workspacePath: root, Emit: () => undefined, business, observability: null });
    const restored = await restarted.GetSessionAssistantState('owner');
    expect(restored.tasks).toMatchObject([{ id: 'todo1', title: '准备简历' }]);
    expect(restored.pendingEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'resume_confirmation', requestId: 'req1', sessionId: 'owner', content: '待确认正文' }),
      expect.objectContaining({ type: 'question_requested', requestId: 'req1', sessionId: 'owner' }),
    ]));
    expect(await restarted.GetSessionAssistantState('other')).toMatchObject({ tasks: [], pendingEvents: [] });
    await host.Close(); await restarted.Close();
  });

  it('重启后确认简历：只执行一次写入，产物与工具结果落回原消息', async () => {
    const root = await Root(), events: AgentStreamEvent[] = [];
    let resume = { id: 'r1', name: '产品简历', revision: 1, content: '原文', targetRoles: [], summary: '', updatedAt: '' };
    let presentation = ApplyConversationActivity(CreateConversationPresentation('req1'), { kind: 'tool', stepId: 'step1', toolCallId: 'call1', name: 'UpdateResume', toolStatus: 'waiting' }, 1, 1);
    presentation = ApplyConversationActivity(presentation, { kind: 'status', status: 'waiting' }, 2, 2);
    const write = vi.fn(async (next: typeof resume) => { resume = { ...next, revision: 2 }; return { id: 'r1', revision: 2 }; });
    const business = {
      GetStoredSettings: async () => ({}), ResolveAttachmentUri: async () => null,
      LoadViewModel: async () => ({ resumes: [resume] }), UpsertResume: write,
      GetConversationPresentations: async (sessionId: string) => sessionId === 'owner' ? [presentation] : [],
      SaveConversationPresentation: async (sessionId: string, snapshot: ConversationPresentation) => { expect(sessionId).toBe('owner'); presentation = snapshot; return { saved: true }; },
    };
    const host = new AgentHost({ userDataPath: root, workspacePath: root, Emit: (event: AgentStreamEvent) => events.push(event), business, observability: null });
    const state = host as any;
    state.requestSessions.set('req1', 'owner');
    state.pendingEdits.set('resume-confirmation-one', { kind: 'edit', sessionId: 'owner', ownerId: 'agent-req1', resumeId: 'r1', resume, baseRevision: 1, content: '更新正文', reason: '优化', idempotencyKey: 'edit1', proposalHash: 'hash1' });
    state.SaveState();
    const restarted = new AgentHost({ userDataPath: root, workspacePath: root, Emit: (event: AgentStreamEvent) => events.push(event), business, observability: null });
    expect(await restarted.ConfirmResumeEdit('resume-confirmation-one', true)).toMatchObject({ applied: true });
    expect(write).toHaveBeenCalledTimes(1);
    expect(presentation.status).toBe('completed');
    expect(presentation.parts.find((part) => part.type === 'tool')).toMatchObject({ status: 'succeeded', toolCallId: 'call1' });
    expect(presentation.parts.find((part) => part.type === 'resource')).toMatchObject({ resource: { id: 'r1', revision: 2, produced: true } });
    expect(events.filter((event) => event.type === 'conversation_updated').every((event) => event.sessionId === 'owner' && event.requestId === 'req1')).toBe(true);
    await expect(restarted.ConfirmResumeEdit('resume-confirmation-one', true)).rejects.toThrow();
    expect(write).toHaveBeenCalledTimes(1);
    await host.Close(); await restarted.Close();
  });
});
