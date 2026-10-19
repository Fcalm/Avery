import type { ChatMessageDto, ConversationDto } from '@avery/contracts';
import type { WorkspaceData } from './workspaceData';

/**
 * 会话消息是 append-only 事实流。后台刷新可能返回开始请求时的旧快照，不能因此删除
 * Renderer 已追加或正在流式生成的消息；同 ID 消息保留正文更完整的一份。
 */
export function MergeAppendOnlyMessages(local: ChatMessageDto[], remote: ChatMessageDto[]): ChatMessageDto[] {
  const merged = new Map<string, ChatMessageDto>();
  const order = new Map<string, number>();
  let nextOrder = 0;

  const add = (message: ChatMessageDto, preferRicher: boolean) => {
    if (!order.has(message.id)) order.set(message.id, nextOrder++);
    const existing = merged.get(message.id);
    if (!existing) { merged.set(message.id, message); return; }
    if (!preferRicher) { merged.set(message.id, message); return; }
    if (existing.presentation || message.presentation) {
      merged.set(message.id, (message.presentation?.sequence ?? -1) > (existing.presentation?.sequence ?? -1) ? message : existing);
      return;
    }
    const existingSize = existing.content.length + (existing.thinkingContent?.length ?? 0);
    const candidateSize = message.content.length + (message.thinkingContent?.length ?? 0);
    merged.set(message.id, candidateSize > existingSize ? message : existing);
  };

  local.forEach((message) => add(message, false));
  remote.forEach((message) => add(message, true));
  return [...merged.values()].sort((left, right) => {
    const leftTime = left.createdAt ?? Number.MAX_SAFE_INTEGER;
    const rightTime = right.createdAt ?? Number.MAX_SAFE_INTEGER;
    return leftTime === rightTime ? (order.get(left.id) ?? 0) - (order.get(right.id) ?? 0) : leftTime - rightTime;
  });
}

function IsSameMessage(left: ChatMessageDto, right: ChatMessageDto): boolean {
  return left.role === right.role
    && left.content === right.content
    && left.thinkingContent === right.thinkingContent
    && JSON.stringify(left.presentation) === JSON.stringify(right.presentation)
    && left.createdAt === right.createdAt
    && JSON.stringify(left.attachments ?? []) === JSON.stringify(right.attachments ?? []);
}

/**
 * 三方合并：remote 是刷新结果，baseline 是刷新开始时快照，local 是结果返回时的最新缓存。
 * 只把 baseline 之后的本地增删改覆盖到 remote，既保护确认续发，也不会永久保留已删除消息。
 */
export function MergeConversationSnapshot(
  baseline: ConversationDto | undefined,
  local: ConversationDto,
  remote: ConversationDto,
): ConversationDto {
  if (!baseline) return { ...remote, messages: MergeAppendOnlyMessages(remote.messages, local.messages) };
  const baselineMessages = new Map(baseline.messages.map((message) => [message.id, message]));
  const localMessages = new Map(local.messages.map((message) => [message.id, message]));
  const merged = new Map(remote.messages.map((message) => [message.id, message]));

  for (const baselineMessage of baseline.messages) {
    if (!localMessages.has(baselineMessage.id)) merged.delete(baselineMessage.id);
  }
  for (const localMessage of local.messages) {
    const previous = baselineMessages.get(localMessage.id);
    if (!previous || !IsSameMessage(previous, localMessage)) {
      const remoteMessage = merged.get(localMessage.id);
      if ((remoteMessage?.presentation?.sequence ?? -1) > (localMessage.presentation?.sequence ?? -1)) continue;
      merged.set(localMessage.id, localMessage);
    }
  }
  const order = new Map(local.messages.map((message, index) => [message.id, index]));
  return {
    ...remote,
    messages: [...merged.values()].sort((left, right) => {
      const leftTime = left.createdAt ?? Number.MAX_SAFE_INTEGER;
      const rightTime = right.createdAt ?? Number.MAX_SAFE_INTEGER;
      return leftTime === rightTime ? (order.get(left.id) ?? Number.MAX_SAFE_INTEGER) - (order.get(right.id) ?? Number.MAX_SAFE_INTEGER) : leftTime - rightTime;
    }),
  };
}

/** 后台事件刷新工作区时使用；新服务端实体照常出现，迟到响应不得回滚刷新期间的本地变化。 */
export function MergeWorkspaceSnapshot(
  baseline: WorkspaceData | undefined,
  local: WorkspaceData | undefined,
  remote: WorkspaceData,
): WorkspaceData {
  if (!local) return remote;
  const baselineConversations = new Map((baseline?.conversations ?? []).map((conversation) => [conversation.id, conversation]));
  const localConversations = new Map(local.conversations.map((conversation) => [conversation.id, conversation]));
  const remoteConversationIds = new Set(remote.conversations.map((conversation) => conversation.id));
  return {
    ...remote,
    conversations: [
      ...remote.conversations.flatMap((conversation) => {
        const localConversation = localConversations.get(conversation.id);
        if (!localConversation) return baselineConversations.has(conversation.id) ? [] : [conversation];
        return [MergeConversationSnapshot(baselineConversations.get(conversation.id), localConversation, conversation)];
      }),
      ...local.conversations.filter((conversation) => !remoteConversationIds.has(conversation.id) && !baselineConversations.has(conversation.id)),
    ],
  };
}

/** 消息写入成功后再次幂等合并，避免先前的旧快照已覆盖乐观更新。 */
export function AppendConversationMessages(data: WorkspaceData, conversationId: string, messages: ChatMessageDto[]): WorkspaceData {
  return {
    ...data,
    conversations: data.conversations.map((conversation) => conversation.id === conversationId
      ? { ...conversation, updatedAt: Date.now(), messages: MergeAppendOnlyMessages(conversation.messages, messages) }
      : conversation),
  };
}

/** 将最终回复写回缓存；数据库已确认成功后不再依赖流式事件是否完整到达。 */
export function CompleteConversationMessage(
  data: WorkspaceData,
  conversationId: string,
  messageId: string,
  content: string,
  thinkingContent?: string,
): WorkspaceData {
  return {
    ...data,
    conversations: data.conversations.map((conversation) => conversation.id === conversationId
      ? {
          ...conversation,
          updatedAt: Date.now(),
          messages: conversation.messages.map((message) => message.id === messageId
            ? { ...message, content, ...(thinkingContent !== undefined ? { thinkingContent } : {}) }
            : message),
        }
      : conversation),
  };
}
