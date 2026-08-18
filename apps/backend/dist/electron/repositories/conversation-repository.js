"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
// @ts-nocheck
const { GetNow, CreateId, WriteAudit, AssertRevision } = require('./helpers.js');
/** 会话及其消息的独立事实源；消息按应用层生成 ID 幂等 upsert，删除会话时级联清理消息。 */
class ConversationRepository {
    constructor({ db, attachmentLifecycle }) {
        this.db = db;
        this.attachmentLifecycle = attachmentLifecycle;
    }
    /** 读取全部会话与其消息，供页面启动时组装会话侧 ViewModel；时间为 UTC epoch 毫秒，revision 供外部冲突校验。 */
    ListAll() {
        const conversations = this.db.prepare('SELECT id, title, revision, updated_at FROM conversations ORDER BY last_used_at DESC').all();
        return conversations.map((conversation) => ({
            id: conversation.id,
            title: conversation.title,
            revision: conversation.revision,
            updatedAt: conversation.updated_at,
            messages: this.db.prepare('SELECT id, role, content, reasoning_content, created_at FROM conversation_messages WHERE conversation_id = ? ORDER BY created_at').all(conversation.id).map((message) => ({
                id: message.id,
                role: message.role,
                content: message.content,
                thinkingContent: message.reasoning_content ?? undefined,
                createdAt: message.created_at,
                attachments: this.db.prepare(`SELECT a.original_name AS name, 'attachment://' || a.id || '/' || a.original_name AS path
          FROM attachment_links l JOIN attachments a ON a.id = l.attachment_id
          WHERE l.owner_type = 'message' AND l.owner_id = ? AND a.deleted_at IS NULL ORDER BY l.created_at, a.id`).all(message.id),
            })),
        }));
    }
    /** 新建会话；调用方提供应用层生成的 ID，保证 Agent 会话与页面引用一致。 */
    Create({ id, title }) {
        if (typeof id !== 'string' || id.length === 0 || id.length > 200)
            throw new Error('Conversation id is invalid.');
        if (typeof title !== 'string' || title.length === 0 || title.length > 300)
            throw new Error('Conversation title is invalid.');
        const now = GetNow();
        this.db.prepare('INSERT INTO conversations(id, title, revision, created_at, updated_at, last_used_at) VALUES(?, ?, 1, ?, ?, ?)')
            .run(id, title, now, now, now);
        WriteAudit(this.db, 'user', 'create', 'conversation', id, {});
        return { id, title, revision: 1, updatedAt: now, messages: [] };
    }
    /** 重命名会话；校验期望版本并刷新其最近使用时间。 */
    Rename(id, title, expectedRevision) {
        if (typeof id !== 'string' || id.length === 0 || id.length > 200)
            throw new Error('Conversation id is invalid.');
        if (typeof title !== 'string' || title.length === 0 || title.length > 300)
            throw new Error('Conversation title is invalid.');
        const existing = this.db.prepare('SELECT revision FROM conversations WHERE id = ?').get(id);
        if (!existing)
            throw new Error('Conversation was not found.');
        AssertRevision(existing, expectedRevision, 'conversation', id);
        const nextRevision = existing.revision + 1;
        const result = this.db.prepare('UPDATE conversations SET title = ?, revision = ?, updated_at = ?, last_used_at = ? WHERE id = ?').run(title, nextRevision, GetNow(), GetNow(), id);
        if (!result.changes)
            throw new Error('Conversation was not found.');
        WriteAudit(this.db, 'user', 'rename', 'conversation', id, {});
        return { id, title, revision: nextRevision };
    }
    /** 删除会话；外键级联移除其全部消息。 */
    Delete(id) {
        if (typeof id !== 'string' || id.length === 0 || id.length > 200)
            throw new Error('Conversation id is invalid.');
        const run = this.db.transaction(() => {
            this.attachmentLifecycle.RemoveConversationLinks(id);
            this.db.prepare('DELETE FROM conversations WHERE id = ?').run(id);
            WriteAudit(this.db, 'user', 'delete', 'conversation', id, {});
        });
        run();
        return { id };
    }
    /** 刷新会话最近使用时间，供会话导航置顶使用。 */
    Touch(id) {
        if (typeof id !== 'string' || id.length === 0 || id.length > 200)
            throw new Error('Conversation id is invalid.');
        this.db.prepare('UPDATE conversations SET updated_at = ?, last_used_at = ? WHERE id = ?').run(GetNow(), GetNow(), id);
    }
    /** 向会话追加消息；按消息 ID upsert，重复投递不会产生重复记录。 */
    AppendMessages(conversationId, messages) {
        if (typeof conversationId !== 'string' || conversationId.length === 0 || conversationId.length > 200)
            throw new Error('Conversation id is invalid.');
        if (!Array.isArray(messages) || messages.length === 0 || messages.length > 50)
            throw new Error('Conversation messages are invalid.');
        const existing = this.db.prepare('SELECT id FROM conversations WHERE id = ?').get(conversationId);
        if (!existing)
            throw new Error('Conversation was not found.');
        const insert = this.db.prepare('INSERT INTO conversation_messages(id, conversation_id, role, content, reasoning_content, status, created_at, updated_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET content = excluded.content, reasoning_content = excluded.reasoning_content, updated_at = excluded.updated_at');
        const now = GetNow();
        const run = this.db.transaction(() => {
            for (let index = 0; index < messages.length; index += 1) {
                const message = messages[index];
                if (!message || typeof message.id !== 'string' || message.id.length === 0 || message.id.length > 200)
                    throw new Error('Conversation message id is invalid.');
                if (message.role !== 'user' && message.role !== 'assistant' && message.role !== 'system')
                    throw new Error('Conversation message role is invalid.');
                if (typeof message.content !== 'string' || message.content.length > 100000)
                    throw new Error('Conversation message content is invalid.');
                const existingMessage = this.db.prepare('SELECT conversation_id FROM conversation_messages WHERE id = ?').get(message.id);
                if (existingMessage && existingMessage.conversation_id !== conversationId)
                    throw new Error('Conversation message id belongs to another conversation.');
                insert.run(message.id, conversationId, message.role, message.content, message.thinkingContent ?? null, 'complete', now + index, now + index);
                this.attachmentLifecycle.ReplaceLinks('message', message.id, message.attachments ?? null);
            }
            this.Touch(conversationId);
        });
        run();
        return { conversationId, count: messages.length };
    }
    /** 写入流式占位消息的最终正文；Agent 正常结束、取消或失败时调用。 */
    CompleteMessage(conversationId, messageId, content, thinkingContent) {
        if (typeof conversationId !== 'string' || conversationId.length === 0 || conversationId.length > 200)
            throw new Error('Conversation id is invalid.');
        if (typeof messageId !== 'string' || messageId.length === 0 || messageId.length > 200)
            throw new Error('Conversation message id is invalid.');
        if (typeof content !== 'string' || content.length > 100000)
            throw new Error('Conversation message content is invalid.');
        const result = this.db.prepare('UPDATE conversation_messages SET content = ?, reasoning_content = ?, status = ?, updated_at = ? WHERE id = ? AND conversation_id = ?')
            .run(content, thinkingContent ?? null, 'complete', GetNow(), messageId, conversationId);
        if (!result.changes)
            throw new Error('Conversation message was not found.');
        this.Touch(conversationId);
        return { conversationId, messageId };
    }
    /** 移除一条本地消息，用于清理未完成请求的临时占位消息。 */
    RemoveMessage(conversationId, messageId) {
        if (typeof conversationId !== 'string' || conversationId.length === 0 || conversationId.length > 200)
            throw new Error('Conversation id is invalid.');
        if (typeof messageId !== 'string' || messageId.length === 0 || messageId.length > 200)
            throw new Error('Conversation message id is invalid.');
        const run = this.db.transaction(() => {
            const message = this.db.prepare('SELECT id FROM conversation_messages WHERE id = ? AND conversation_id = ?').get(messageId, conversationId);
            if (message)
                this.attachmentLifecycle.RemoveLinks('message', messageId);
            this.db.prepare('DELETE FROM conversation_messages WHERE id = ? AND conversation_id = ?').run(messageId, conversationId);
            this.Touch(conversationId);
        });
        run();
        return { conversationId, messageId };
    }
    /** 在单次事务内同时写入会话上下文与 Tool Array 快照，保证 /reload-session 原子更新不产生部分快照。 */
    SetSnapshots(conversationId, { sessionSnapshotJson, toolSnapshotJson }) {
        const run = this.db.transaction(() => {
            if (sessionSnapshotJson != null)
                this.SetSessionSnapshot(conversationId, sessionSnapshotJson);
            if (toolSnapshotJson != null)
                this.SetToolSnapshot(conversationId, toolSnapshotJson);
        });
        run();
        return { conversationId };
    }
    /** 写入会话上下文快照的 JSON 序列化文本。 */
    SetSessionSnapshot(conversationId, json) {
        if (typeof conversationId !== 'string' || conversationId.length === 0 || conversationId.length > 200)
            throw new Error('Conversation id is invalid.');
        if (typeof json !== 'string' || json.length > 500000)
            throw new Error('Session snapshot is invalid.');
        this.db.prepare('UPDATE conversations SET session_snapshot_json = ?, updated_at = ? WHERE id = ?').run(json, GetNow(), conversationId);
        this.attachmentLifecycle.ReplaceLinks('conversation', conversationId, json);
    }
    /** 读取会话上下文快照 JSON；未写入时返回 null。 */
    GetSessionSnapshot(conversationId) {
        if (typeof conversationId !== 'string' || conversationId.length === 0 || conversationId.length > 200)
            throw new Error('Conversation id is invalid.');
        return this.db.prepare('SELECT session_snapshot_json FROM conversations WHERE id = ?').get(conversationId)?.session_snapshot_json ?? null;
    }
    /** 写入 Tool Array 快照的 JSON 序列化文本。 */
    SetToolSnapshot(conversationId, json) {
        if (typeof conversationId !== 'string' || conversationId.length === 0 || conversationId.length > 200)
            throw new Error('Conversation id is invalid.');
        if (typeof json !== 'string' || json.length > 500000)
            throw new Error('Tool snapshot is invalid.');
        this.db.prepare('UPDATE conversations SET tool_array_snapshot_json = ?, updated_at = ? WHERE id = ?').run(json, GetNow(), conversationId);
    }
    /** 读取 Tool Array 快照 JSON；未写入时返回 null。 */
    GetToolSnapshot(conversationId) {
        if (typeof conversationId !== 'string' || conversationId.length === 0 || conversationId.length > 200)
            throw new Error('Conversation id is invalid.');
        return this.db.prepare('SELECT tool_array_snapshot_json FROM conversations WHERE id = ?').get(conversationId)?.tool_array_snapshot_json ?? null;
    }
}
module.exports = { ConversationRepository };
