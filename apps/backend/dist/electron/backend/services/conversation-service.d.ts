/** 会话与消息的应用服务：封装会话 Repository，同时组合会话上下文与 Tool Array 快照的读写。 */
export declare class ConversationService {
    private repository;
    constructor({ repository }: {
        repository: any;
    });
    /** 读取全部会话与其消息，供工作空间聚合视图使用。 */
    ListAll(): any;
    /** 新建会话；调用方提供应用层生成的 ID。 */
    Create(conversation: any): any;
    /** 重命名会话；透传期望版本供冲突检测。 */
    Rename(id: string, title: string, expectedRevision?: number): any;
    /** 删除会话并级联清理其消息。 */
    Delete(id: string): any;
    /** 向会话追加消息，按消息 ID 幂等写入。 */
    AppendMessages(conversationId: string, messages: any[]): any;
    /** 写入流式占位消息的最终正文。 */
    CompleteMessage(conversationId: string, messageId: string, content: string, thinkingContent?: string): any;
    /** 移除未完成请求的临时占位消息。 */
    RemoveMessage(conversationId: string, messageId: string): any;
    /** 在单次事务内同时写入会话上下文与 Tool Array 两类快照，供 /reload-session 原子更新。 */
    SetSnapshots(conversationId: string, snapshots: {
        sessionSnapshotJson?: string | null;
        toolSnapshotJson?: string | null;
    }): any;
    /** 读取会话上下文与 Tool Array 快照，供重启后恢复与原子重载基线。 */
    GetSnapshots(conversationId: string): {
        sessionSnapshotJson: string | null;
        toolSnapshotJson: string | null;
    };
}
