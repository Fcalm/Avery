import { describe, expect, it } from 'vitest';
import type { WorkspaceData } from '../../../src/features/workspace/api/workspaceData';
import {
  AppendConversationMessages, CompleteConversationMessage, MergeAppendOnlyMessages, MergeWorkspaceSnapshot,
} from '../../../src/features/workspace/api/workspaceMerge';

function workspace(messages: WorkspaceData['conversations'][number]['messages']): WorkspaceData {
  return {
    conversations: [{ id: 'conversation-1', title: 'test', messages }],
    resumes: [], jobs: [], applications: [], profiles: [],
    settings: {} as WorkspaceData['settings'],
  };
}

describe('append-only 会话缓存合并', () => {
  it('迟到的旧工作区快照不能删除确认后的 user 和 assistant 消息', () => {
    const local = workspace([
      { id: 'initial', role: 'user', content: '创建定时任务', createdAt: 1 },
      { id: 'confirmed', role: 'user', content: '我已确认创建上述定时任务', createdAt: 2 },
      { id: 'reply', role: 'assistant', content: '定时任务已确认创建成功', createdAt: 3 },
    ]);
    const staleRemote = workspace([{ id: 'initial', role: 'user', content: '创建定时任务', createdAt: 1 }]);

    const baseline = workspace([{ id: 'initial', role: 'user', content: '创建定时任务', createdAt: 1 }]);
    expect(MergeWorkspaceSnapshot(baseline, local, staleRemote).conversations[0].messages.map((message) => message.id))
      .toEqual(['initial', 'confirmed', 'reply']);
  });

  it('同 ID 流式消息保留正文更完整的一份', () => {
    expect(MergeAppendOnlyMessages(
      [{ id: 'reply', role: 'assistant', content: '已经生成的较长正文', createdAt: 1 }],
      [{ id: 'reply', role: 'assistant', content: '', createdAt: 1 }],
    )[0].content).toBe('已经生成的较长正文');
    expect(MergeAppendOnlyMessages(
      [{ id: 'reply', role: 'assistant', content: '', createdAt: 1 }],
      [{ id: 'reply', role: 'assistant', content: '服务端最终正文', createdAt: 1 }],
    )[0].content).toBe('服务端最终正文');
  });

  it('消息写入成功后幂等补回缓存，最终回复也由服务端确认结果写回', () => {
    const initial = workspace([]);
    const appended = AppendConversationMessages(initial, 'conversation-1', [
      { id: 'confirmed', role: 'user', content: '确认结果', createdAt: 2 },
      { id: 'reply', role: 'assistant', content: '', createdAt: 3 },
    ]);
    const duplicated = AppendConversationMessages(appended, 'conversation-1', appended.conversations[0].messages);
    const completed = CompleteConversationMessage(duplicated, 'conversation-1', 'reply', 'Agent 已继续');

    expect(completed.conversations[0].messages).toHaveLength(2);
    expect(completed.conversations[0].messages.find((message) => message.id === 'reply')?.content).toBe('Agent 已继续');
  });

  it('保护当前消息的同时仍接收定时任务新建的会话', () => {
    const baseline = workspace([]);
    const local = workspace([{ id: 'confirmed', role: 'user', content: '确认结果', createdAt: 1 }]);
    const remote = workspace([]);
    remote.conversations.push({ id: 'cron-conversation', title: '定时任务', messages: [] });

    const merged = MergeWorkspaceSnapshot(baseline, local, remote);
    expect(merged.conversations.map((conversation) => conversation.id)).toEqual(['conversation-1', 'cron-conversation']);
    expect(merged.conversations[0].messages[0].id).toBe('confirmed');
  });

  it('刷新期间本地删除的占位消息不会被旧服务端快照重新带回', () => {
    const placeholder = { id: 'reply', role: 'assistant' as const, content: '', createdAt: 2 };
    const baseline = workspace([{ id: 'user', role: 'user', content: '问题', createdAt: 1 }, placeholder]);
    const local = workspace([{ id: 'user', role: 'user', content: '问题', createdAt: 1 }]);
    const staleRemote = workspace([{ id: 'user', role: 'user', content: '问题', createdAt: 1 }, placeholder]);

    expect(MergeWorkspaceSnapshot(baseline, local, staleRemote).conversations[0].messages.map((message) => message.id))
      .toEqual(['user']);
  });
});
