import { describe, expect, it } from 'vitest';
import { CreateConversationPresentation } from '../../../packages/agent-sdk/src/conversation';
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
  it('保存资料触发刷新时，较新的本地回复不能携带乐观时间排到用户消息之前', () => {
    const user = { id: 'user', role: 'user' as const, content: '修改简历', createdAt: 100 };
    const reply = { id: 'reply', role: 'assistant' as const, content: '', createdAt: 100, presentation: { ...CreateConversationPresentation('req1'), sequence: 1 } };
    const baseline = workspace([user, reply]);
    const completed = { ...reply, content: '修改已保存', presentation: { ...reply.presentation, sequence: 3, status: 'completed' as const, parts: [
      { id: 'artifact', stepId: 'step1', type: 'resource' as const, resource: { kind: 'resume' as const, id: 'r1', title: '简历', revision: 12, produced: true, lineChanges: { added: 1, removed: 0 } } },
    ] } };
    const local = workspace([user, completed]);
    // 后端追加消息时重新分配创建时间；刷新返回期间，本地回复已经收到更高序号的终态。
    const remote = workspace([{ ...user, createdAt: 200 }, { ...reply, createdAt: 201 }]);
    const messages = MergeWorkspaceSnapshot(baseline, local, remote).conversations[0].messages;
    expect(messages.map((message) => message.id)).toEqual(['user', 'reply']);
    expect(messages[1]).toMatchObject({ createdAt: 201, content: '修改已保存', presentation: completed.presentation });
  });

  it('没有刷新基线时，采用本地新正文也保留服务端的消息创建时间', () => {
    const user = { id: 'user', role: 'user' as const, content: '修改档案', createdAt: 100 };
    const reply = { id: 'reply', role: 'assistant' as const, content: '', createdAt: 100 };
    const local = workspace([user, { ...reply, content: '更新后的完整回答' }]);
    const remote = workspace([{ ...user, createdAt: 200 }, { ...reply, createdAt: 201 }]);
    const messages = MergeWorkspaceSnapshot(undefined, local, remote).conversations[0].messages;
    expect(messages.map((message) => message.id)).toEqual(['user', 'reply']);
    expect(messages[1]).toMatchObject({ createdAt: 201, content: '更新后的完整回答' });
  });

  it('迟到的追加成功回执不能把已校准的创建时间改回乐观值', () => {
    const persisted = workspace([
      { id: 'user', role: 'user', content: '修改简历', createdAt: 200 },
      { id: 'reply', role: 'assistant', content: '', createdAt: 201 },
    ]);
    const incoming = [
      { id: 'user', role: 'user' as const, content: '修改简历', createdAt: 100 },
      { id: 'reply', role: 'assistant' as const, content: '本地正在生成的回答', createdAt: 100 },
    ];
    const messages = AppendConversationMessages(persisted, 'conversation-1', incoming).conversations[0].messages;
    expect(messages.map((message) => [message.id, message.createdAt])).toEqual([['user', 200], ['reply', 201]]);
    expect(messages[1].content).toBe('本地正在生成的回答');
  });

  it('校准旧一轮时间时保留刷新期间追加的下一轮，同一快照重复合并不再改变顺序', () => {
    const user = { id: 'user1', role: 'user' as const, content: '修改简历', createdAt: 100 };
    const reply = { id: 'reply1', role: 'assistant' as const, content: '', createdAt: 100 };
    const baseline = workspace([user, reply]);
    const local = workspace([user, { ...reply, content: '已完成' },
      { id: 'user2', role: 'user', content: '再改一处', createdAt: 300 },
      { id: 'reply2', role: 'assistant', content: '', createdAt: 300 },
    ]);
    const remote = workspace([{ ...user, createdAt: 200 }, { ...reply, createdAt: 201 }]);
    const merged = MergeWorkspaceSnapshot(baseline, local, remote);
    const repeated = MergeWorkspaceSnapshot(baseline, merged, remote);
    expect(merged.conversations[0].messages.map((message) => message.id)).toEqual(['user1', 'reply1', 'user2', 'reply2']);
    expect(repeated.conversations[0].messages).toEqual(merged.conversations[0].messages);
  });

  it('迟到工作区快照不能把新投影回滚为旧序号，服务端更新终态也能覆盖本地长文本', () => {
    const message = { id: 'reply', role: 'assistant' as const, content: '本地长文本', presentation: { ...CreateConversationPresentation('req1'), sequence: 2 } };
    const baseline = workspace([{ ...message, presentation: { ...message.presentation, sequence: 1 } }]);
    const local = workspace([message]);
    const stale = workspace([{ ...message, content: '', presentation: { ...message.presentation, sequence: 1 } }]);
    expect(MergeWorkspaceSnapshot(baseline, local, stale).conversations[0].messages[0].presentation?.sequence).toBe(2);
    const completed = workspace([{ ...message, content: '结果', presentation: { ...message.presentation, sequence: 3, status: 'completed' } }]);
    expect(MergeWorkspaceSnapshot(baseline, local, completed).conversations[0].messages[0]).toMatchObject({ content: '结果', presentation: { sequence: 3, status: 'completed' } });
  });
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
