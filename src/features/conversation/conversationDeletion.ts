/** 删除当前会话后进入真正的空白草稿；删除其他会话不改变当前选择。 */
export function ResolveActiveConversationAfterDeletion(activeConversationId: string | null, deletedConversationId: string): string | null {
  return activeConversationId === deletedConversationId ? null : activeConversationId;
}
