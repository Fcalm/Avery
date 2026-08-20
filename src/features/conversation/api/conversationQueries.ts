import { useCallback } from 'react';
import type { ChatMessageInput, ConversationDto } from '@offerget/contracts';
import { platformClient, Unwrap } from '../../../shared/platform/platformClient';
import type { ChatMessage, Conversation } from '../../../types/domain';
import { useWorkspaceData } from '../../workspace/api/useWorkspaceData';
import { usePatchWorkspace, useWorkspaceMutation, type WorkspaceMutationHandlers } from '../../workspace/api/mutationHelper';
import { CreateEntityId } from '../../workspace/api/workspaceData';

/** 会话业务集合；来自工作空间聚合缓存。 */
export function useConversations() {
  const { data } = useWorkspaceData();
  return data?.conversations ?? [];
}

/** 新建会话；返回应用层 ID 供页面立即设为当前会话，写回后端确认的记录。 */
export function useCreateConversation(handlers?: WorkspaceMutationHandlers) {
  const mutation = useWorkspaceMutation<{ id: string; title: string }, ConversationDto>({
    mutationFn: ({ id, title }, options) => Unwrap(platformClient.workspace.CreateConversation({ id, title }, options)),
    applyServer: (data, _vars, result) => ({ ...data, conversations: [result, ...data.conversations] }),
    ...handlers,
  });
  return useCallback(async (title: string) => {
    const id = CreateEntityId('conversation');
    await mutation.mutateAsync({ id, title });
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

/** 追加消息并持久化；消息已由流式流程在本地缓存写入，这里只做后端落库。 */
export function useAppendConversationMessages(handlers?: WorkspaceMutationHandlers) {
  return useWorkspaceMutation<{ conversationId: string; messages: ChatMessage[] }, { conversationId: string; count: number }>({
    mutationFn: ({ conversationId, messages }, options) => Unwrap(platformClient.workspace.AppendConversationMessages(conversationId, messages as ChatMessageInput[], options)),
    applyServer: (data) => data,
    ...handlers,
  });
}

/** 写入流式占位消息的最终正文；本地缓存已含最新内容，无需额外写回。 */
export function useCompleteConversationMessage(handlers?: WorkspaceMutationHandlers) {
  return useWorkspaceMutation<{ conversationId: string; messageId: string; content: string; thinkingContent?: string }, { conversationId: string; messageId: string }>({
    mutationFn: ({ conversationId, messageId, content, thinkingContent }, options) => Unwrap(platformClient.workspace.CompleteConversationMessage(conversationId, messageId, content, thinkingContent, options)),
    applyServer: (data) => data,
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
