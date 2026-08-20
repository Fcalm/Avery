/** 会话及其消息的独立事实源；消息按应用层生成 ID 幂等 upsert，删除会话时级联清理消息。 */
export declare class ConversationRepository {
    private db;
    private attachmentLifecycle;
    constructor({ db, attachmentLifecycle }: {
        db: any;
        attachmentLifecycle: any;
    });
    /** 读取全部会话与其消息，供页面启动时组装会话侧 ViewModel；时间为 UTC epoch 毫秒，revision 供外部冲突校验。 */
    ListAll(): any[];
    /** 新建会话；调用方提供应用层生成的 ID，保证 Agent 会话与页面引用一致。 */
    Create({ id, title }: {
        id: string;
        title: string;
    }): any;
    /** 重命名会话；校验期望版本并刷新其最近使用时间。 */
    Rename(id: string, title: string, expectedRevision?: number): any;
    /** 删除会话；外键级联移除其全部消息。 */
    Delete(id: string): any;
    /** 刷新会话最近使用时间，供会话导航置顶使用。 */
    Touch(id: string): void;
    /** 向会话追加消息；按消息 ID upsert，重复投递不会产生重复记录。 */
    AppendMessages(conversationId: string, messages: any[]): any;
    /** 写入流式占位消息的最终正文；Agent 正常结束、取消或失败时调用。 */
    CompleteMessage(conversationId: string, messageId: string, content: string, thinkingContent?: string): any;
    /** 移除一条本地消息，用于清理未完成请求的临时占位消息。 */
    RemoveMessage(conversationId: string, messageId: string): any;
    /** 在单次事务内同时写入会话上下文与 Tool Array 快照，保证 /reload-session 原子更新不产生部分快照。 */
    SetSnapshots(conversationId: string, { sessionSnapshotJson, toolSnapshotJson }: {
        sessionSnapshotJson?: string | null;
        toolSnapshotJson?: string | null;
    }): any;
    /** 写入会话上下文快照的 JSON 序列化文本。 */
    SetSessionSnapshot(conversationId: string, json: string): void;
    /** 读取会话上下文快照 JSON；未写入时返回 null。 */
    GetSessionSnapshot(conversationId: string): string | null;
    /** 写入 Tool Array 快照的 JSON 序列化文本。 */
    SetToolSnapshot(conversationId: string, json: string): void;
    /** 读取 Tool Array 快照 JSON；未写入时返回 null。 */
    GetToolSnapshot(conversationId: string): string | null;
}
