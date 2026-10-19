/** 会话与消息的应用服务：封装会话 Repository，同时组合会话上下文与 Tool Array 快照的读写。 */
export class ConversationService {
  private repository: any;

  constructor({ repository }: { repository: any }) {
    this.repository = repository;
  }

  /** 读取全部会话与其消息，供工作空间聚合视图使用。 */
  ListAll(): any {
    return this.repository.ListAll();
  }

  /** 新建会话；调用方提供应用层生成的 ID。 */
  Create(conversation: any): any {
    return this.repository.Create(conversation);
  }

  /** 重命名会话；透传期望版本供冲突检测。 */
  Rename(id: string, title: string, expectedRevision?: number): any {
    return this.repository.Rename(id, title, expectedRevision);
  }

  /** 删除会话并级联清理其消息。 */
  Delete(id: string): any {
    return this.repository.Delete(id);
  }

  /** 设置会话置顶标记；透传期望版本供冲突检测。 */
  SetPinned(id: string, pinned: boolean, expectedRevision?: number): any {
    return this.repository.SetPinned(id, pinned, expectedRevision);
  }

  /** 设置会话归档标记；透传期望版本供冲突检测。 */
  SetArchived(id: string, archived: boolean, expectedRevision?: number): any {
    return this.repository.SetArchived(id, archived, expectedRevision);
  }

  /** 向会话追加消息，按消息 ID 幂等写入。 */
  AppendMessages(conversationId: string, messages: any[]): any {
    return this.repository.AppendMessages(conversationId, messages);
  }

  /** 写入流式占位消息的最终正文。 */
  SavePresentation(conversationId: string, presentation: import('@avery/agent-sdk').ConversationPresentation): { saved: boolean } {
    return this.repository.SavePresentation(conversationId, presentation);
  }

  /** 写入流式占位消息的最终正文。 */
  CompleteMessage(conversationId: string, messageId: string, content: string, thinkingContent?: string): any {
    return this.repository.CompleteMessage(conversationId, messageId, content, thinkingContent);
  }

  /** 移除未完成请求的临时占位消息。 */
  RemoveMessage(conversationId: string, messageId: string): any {
    return this.repository.RemoveMessage(conversationId, messageId);
  }

  /** 在单次事务内同时写入会话上下文与 Tool Array 两类快照，供 /reload-session 原子更新。 */
  SetSnapshots(conversationId: string, snapshots: { sessionSnapshotJson?: string | null; toolSnapshotJson?: string | null }): any {
    return this.repository.SetSnapshots(conversationId, snapshots);
  }

  /** 读取会话上下文与 Tool Array 快照，供重启后恢复与原子重载基线。 */
  GetSnapshots(conversationId: string): { sessionSnapshotJson: string | null; toolSnapshotJson: string | null } {
    return {
      sessionSnapshotJson: this.repository.GetSessionSnapshot(conversationId),
      toolSnapshotJson: this.repository.GetToolSnapshot(conversationId),
    };
  }
}
