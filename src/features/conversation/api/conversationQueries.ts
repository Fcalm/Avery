import { useCallback } from 'react';
import type { ChatMessageInput, ConversationDto } from '@avery/contracts';
import { platformClient, Unwrap } from '../../../shared/platform/platformClient';
import type { ChatMessage, Conversation } from '../../../types/domain';
import { useWorkspaceData } from '../../workspace/api/useWorkspaceData';
import { usePatchWorkspace, useWorkspaceMutation, type WorkspaceMutationHandlers } from '../../workspace/api/mutationHelper';
import { CreateEntityId } from '../../workspace/api/workspaceData';
import { AppendConversationMessages, CompleteConversationMessage } from '../../workspace/api/workspaceMerge';

/** 会话业务集合；来自工作空间聚合缓存。 */
export function useConversations() {
  const { data } = useWorkspaceData();
  return data?.conversations ?? [];
}

/** 新建会话；返回应用层 ID 供页面立即设为当前会话，写回后端确认的记录。
 * environment 携带创建时选择的场景与项目空间（此后不可变），落库后供侧栏场景标注与项目分组使用。 */
export function useCreateConversation(handlers?: WorkspaceMutationHandlers) {
  const mutation = useWorkspaceMutation<{ id: string; title: string; scenarioId?: 'default' | 'application'; projectId?: string; projectName?: string }, ConversationDto>({
    mutationFn: ({ id, title, scenarioId, projectId, projectName }, options) => Unwrap(platformClient.workspace.CreateConversation({ id, title, scenarioId, projectId, projectName }, options)),
    applyServer: (data, _vars, result) => ({ ...data, conversations: [result, ...data.conversations] }),
    ...handlers,
  });
  return useCallback(async (title: string, environment?: { scenarioId: 'default' | 'application'; projectId?: string; projectName?: string }) => {
    const id = CreateEntityId('conversation');
    await mutation.mutateAsync({ id, title, scenarioId: environment?.scenarioId, projectId: environment?.projectId, projectName: environment?.projectName });
    return id;
  }, [mutation]);
}

/** 重命名会话；成功后写回服务器确认的 revision，冲突时刷新并触发恢复回调。 */
export function useRenameConversation(handlers?: WorkspaceMutationHandlers) {
  return useWorkspaceMutation<{ id: string; title: string; expectedRevision?: number }, { id: string; title: string; revision: number }>({
    mutationFn: ({ id, title, expectedRevision }, options) => Unwrap(platformClient.workspace.RenameConversation(id, title, expectedRevision, options)),
    applyServer: (data, vars, result) => ({
      ...data,
      conversations: data.conversations.map((item) => (item.id === vars.id ? { ...item, title: vars.title, updatedAt: Date.now(), revision: result.revision } : item)),
    }),
    conflictCode: 'REVISION_CONFLICT',
    ...handlers,
  });
}

/** 删除会话；成功后从缓存移除。 */
export function useDeleteConversation(handlers?: WorkspaceMutationHandlers) {
  return useWorkspaceMutation<{ id: string }, { id: string }>({
    mutationFn: ({ id }, options) => Unwrap(platformClient.workspace.DeleteConversation(id, options)),
    applyServer: (data, vars) => ({ ...data, conversations: data.conversations.filter((item) => item.id !== vars.id) }),
    ...handlers,
  });
}

/** 设置会话置顶标记；成功后写回服务器确认的 pinned 状态与 revision。 */
export function useSetConversationPinned(handlers?: WorkspaceMutationHandlers) {
  return useWorkspaceMutation<{ id: string; pinned: boolean; expectedRevision?: number }, { id: string; pinned: boolean; revision: number }>({
    mutationFn: ({ id, pinned, expectedRevision }, options) => Unwrap(platformClient.workspace.SetConversationPinned(id, pinned, expectedRevision, options)),
    applyServer: (data, vars, result) => ({
      ...data,
      conversations: data.conversations.map((item) => (item.id === vars.id ? { ...item, pinned: result.pinned, revision: result.revision } : item)),
    }),
    conflictCode: 'REVISION_CONFLICT',
    ...handlers,
  });
}

/** 设置会话归档标记；归档仅使其从"最近"列表移出，记录与消息保留。 */
export function useSetConversationArchived(handlers?: WorkspaceMutationHandlers) {
  return useWorkspaceMutation<{ id: string; archived: boolean; expectedRevision?: number }, { id: string; archived: boolean; revision: number }>({
    mutationFn: ({ id, archived, expectedRevision }, options) => Unwrap(platformClient.workspace.SetConversationArchived(id, archived, expectedRevision, options)),
    applyServer: (data, vars, result) => ({
      ...data,
      conversations: data.conversations.map((item) => (item.id === vars.id ? { ...item, archived: result.archived, revision: result.revision } : item)),
    }),
    conflictCode: 'REVISION_CONFLICT',
    ...handlers,
  });
}

/** 追加消息并持久化；消息已由流式流程在本地缓存写入，这里只做后端落库。 */
export function useAppendConversationMessages(handlers?: WorkspaceMutationHandlers) {
  return useWorkspaceMutation<{ conversationId: string; messages: ChatMessage[] }, { conversationId: string; count: number }>({
    mutationFn: ({ conversationId, messages }, options) => Unwrap(platformClient.workspace.AppendConversationMessages(conversationId, messages as ChatMessageInput[], options)),
    applyServer: (data, variables) => AppendConversationMessages(data, variables.conversationId, variables.messages),
    ...handlers,
  });
}

/** 写入流式占位消息的最终正文；本地缓存已含最新内容，无需额外写回。 */
export function useCompleteConversationMessage(handlers?: WorkspaceMutationHandlers) {
  return useWorkspaceMutation<{ conversationId: string; messageId: string; content: string; thinkingContent?: string }, { conversationId: string; messageId: string }>({
    mutationFn: ({ conversationId, messageId, content, thinkingContent }, options) => Unwrap(platformClient.workspace.CompleteConversationMessage(conversationId, messageId, content, thinkingContent, options)),
    applyServer: (data, variables) => CompleteConversationMessage(data, variables.conversationId, variables.messageId, variables.content, variables.thinkingContent),
    ...handlers,
  });
}

/** 移除未完成请求的临时占位消息；成功后从缓存删除占位。 */
export function useRemoveConversationMessage(handlers?: WorkspaceMutationHandlers) {
  return useWorkspaceMutation<{ conversationId: string; messageId: string }, { conversationId: string; messageId: string }>({
    mutationFn: ({ conversationId, messageId }, options) => Unwrap(platformClient.workspace.RemoveConversationMessage(conversationId, messageId, options)),
    applyServer: (data, vars) => ({
      ...data,
      conversations: data.conversations.map((item) => (item.id === vars.conversationId ? { ...item, messages: item.messages.filter((message) => message.id !== vars.messageId) } : item)),
    }),
    ...handlers,
  });
}

/** 直接对会话消息做局部缓存更新；用于 Agent 流式增量等高频场景。 */
export function usePatchConversations() {
  const patch = usePatchWorkspace();
  return useCallback((updater: (conversations: Conversation[]) => Conversation[]) => {
    patch((data) => ({ ...data, conversations: updater(data.conversations) }));
  }, [patch]);
}
