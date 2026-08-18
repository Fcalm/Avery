"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
// @ts-nocheck
/** 会话与消息的应用服务：封装会话 Repository，同时组合会话上下文与 Tool Array 快照的读写。 */
class ConversationService {
    constructor({ repository }) {
        this.repository = repository;
    }
    /** 读取全部会话与其消息，供工作空间聚合视图使用。 */
    ListAll() {
        return this.repository.ListAll();
    }
    /** 新建会话；调用方提供应用层生成的 ID。 */
    Create(conversation) {
        return this.repository.Create(conversation);
    }
    /** 重命名会话；透传期望版本供冲突检测。 */
    Rename(id, title, expectedRevision) {
        return this.repository.Rename(id, title, expectedRevision);
    }
    /** 删除会话并级联清理其消息。 */
    Delete(id) {
        return this.repository.Delete(id);
    }
    /** 向会话追加消息，按消息 ID 幂等写入。 */
    AppendMessages(conversationId, messages) {
        return this.repository.AppendMessages(conversationId, messages);
    }
    /** 写入流式占位消息的最终正文。 */
    CompleteMessage(conversationId, messageId, content, thinkingContent) {
        return this.repository.CompleteMessage(conversationId, messageId, content, thinkingContent);
    }
    /** 移除未完成请求的临时占位消息。 */
    RemoveMessage(conversationId, messageId) {
        return this.repository.RemoveMessage(conversationId, messageId);
    }
    /** 在单次事务内同时写入会话上下文与 Tool Array 两类快照，供 /reload-session 原子更新。 */
    SetSnapshots(conversationId, { sessionSnapshotJson, toolSnapshotJson }) {
        return this.repository.SetSnapshots(conversationId, { sessionSnapshotJson, toolSnapshotJson });
    }
    /** 读取会话上下文与 Tool Array 快照，供重启后恢复与原子重载基线。 */
    GetSnapshots(conversationId) {
        return {
            sessionSnapshotJson: this.repository.GetSessionSnapshot(conversationId),
            toolSnapshotJson: this.repository.GetToolSnapshot(conversationId),
        };
    }
}
module.exports = { ConversationService };
