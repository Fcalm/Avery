import { GetNow, CreateId, WriteAudit, AssertRevision } from './helpers';
import { ApplyConversationActivity, IsConversationPresentation, type ConversationPresentation } from '@avery/agent-sdk';
import { ChatMessageSkillSchema, type ChatMessageSkill } from '@avery/contracts';

/** 旧消息没有展示元数据；不把正文命令或历史技能选择推测为当时已选的技能。 */
function ReadMessageSkill(json: unknown): ChatMessageSkill | undefined {
  if (typeof json !== 'string') return undefined;
  try {
    const value = JSON.parse(json) as { skill?: unknown } | null;
    const parsed = ChatMessageSkillSchema.safeParse(value?.skill);
    return parsed.success ? parsed.data : undefined;
  } catch { return undefined; }
}

function ReadPresentation(json: unknown): ConversationPresentation | undefined {
  if (typeof json !== 'string') return undefined;
  try { const value: unknown = JSON.parse(json); return IsConversationPresentation(value) ? value : undefined; }
  catch { return undefined; }
}

/** 会话及其消息的独立事实源；消息按应用层生成 ID 幂等 upsert，删除会话时级联清理消息。 */
export class ConversationRepository {
  private db: any;
  private attachmentLifecycle: any;

  constructor({ db, attachmentLifecycle }: { db: any; attachmentLifecycle: any }) {
    this.db = db;
    this.attachmentLifecycle = attachmentLifecycle;
    // 只有数据库实例启动时恢复旧 running 状态；普通读取绝不改变正在运行的会话。
    const interrupted = this.db.prepare("SELECT id, presentation_json FROM conversation_messages WHERE presentation_json IS NOT NULL AND json_valid(presentation_json) AND json_extract(presentation_json, '$.status') = 'running'").all();
    const recover = this.db.prepare('UPDATE conversation_messages SET presentation_json = ? WHERE id = ?');
    for (const row of interrupted) {
      const presentation = ReadPresentation(row.presentation_json);
      if (presentation) recover.run(JSON.stringify(ApplyConversationActivity(presentation, { kind: 'status', status: 'interrupted', error: '上次运行因应用退出而中断，可继续发送消息。' }, presentation.sequence + 1, GetNow())), row.id);
    }
  }

  /** 读取全部会话与其消息，供页面启动时组装会话侧 ViewModel；时间为 UTC epoch 毫秒，revision 供外部冲突校验。
   * scenario_id 历史遗留默认值是 'resume-copilot'，读取时统一归一为 'default'，前端无需感知旧值。 */
  ListAll(): any[] {
    const conversations = this.db.prepare('SELECT id, title, revision, updated_at, pinned, archived, archived_at, auto_delete_at, scenario_id, environment_id, environment_name FROM conversations ORDER BY last_used_at DESC').all();
    return conversations.map((conversation: any) => ({
      id: conversation.id,
      title: conversation.title,
      revision: conversation.revision,
      updatedAt: conversation.updated_at,
      pinned: conversation.pinned === 1,
      archived: conversation.archived === 1,
      archivedAt: conversation.archived_at ?? null,
      autoDeleteAt: conversation.auto_delete_at ?? null,
      scenarioId: conversation.scenario_id === 'application' ? 'application' : 'default',
      projectId: conversation.environment_id ?? null,
      projectName: conversation.environment_name ?? null,
      messages: this.db.prepare('SELECT id, role, content, reasoning_content, presentation_json, metadata_json, created_at, updated_at FROM conversation_messages WHERE conversation_id = ? ORDER BY created_at, rowid').all(conversation.id).map((message: any) => ({
        id: message.id,
        role: message.role,
        content: message.content,
        thinkingContent: message.reasoning_content ?? undefined,
        presentation: ReadPresentation(message.presentation_json),
        skill: message.role === 'user' ? ReadMessageSkill(message.metadata_json) : undefined,
        createdAt: message.created_at,
        updatedAt: message.updated_at,
        attachments: this.db.prepare(`SELECT a.original_name AS name, 'attachment://' || a.id || '/' || a.original_name AS path
          FROM attachment_links l JOIN attachments a ON a.id = l.attachment_id
          WHERE l.owner_type = 'message' AND l.owner_id = ? AND a.deleted_at IS NULL ORDER BY l.created_at, a.id`).all(message.id),
      })),
    }));
  }

  /** 新建会话；调用方提供应用层生成的 ID，保证 Agent 会话与页面引用一致。
   * 场景与项目空间在创建时定格：Agent 快照一旦生成场景即被冻结，项目目录绑定后不可更换，
   * 侧栏的场景标注与项目分组因此以创建快照为准，避免读取运行态产生的竞态。 */
  Create({ id, title, scenarioId = 'default', projectId, projectName }: { id: string; title: string; scenarioId?: 'default' | 'application'; projectId?: string; projectName?: string }): any {
    if (typeof id !== 'string' || id.length === 0 || id.length > 200) throw new Error('Conversation id is invalid.');
    if (typeof title !== 'string' || title.length === 0 || title.length > 300) throw new Error('Conversation title is invalid.');
    if (scenarioId !== 'default' && scenarioId !== 'application') throw new Error('Conversation scenario is invalid.');
    if (projectId !== undefined && (typeof projectId !== 'string' || projectId.length === 0 || projectId.length > 200)) throw new Error('Conversation project id is invalid.');
    if (projectName !== undefined && (typeof projectName !== 'string' || projectName.length === 0 || projectName.length > 200)) throw new Error('Conversation project name is invalid.');
    // 项目分组以 projectId 为键，只有 half 配置（只有 id 或只有名称）无法稳定分组，直接拒绝。
    if (Boolean(projectId) !== Boolean(projectName)) throw new Error('Conversation project environment is invalid.');
    const now = GetNow();
    if (this.db.prepare('SELECT 1 FROM conversation_cleanup WHERE conversation_id = ?').get(id)) throw Object.assign(new Error('会话正在清理，请稍后重试。'), { code: 'RESOURCE_LOCKED' });
    this.db.prepare('INSERT INTO conversations(id, title, scenario_id, environment_id, environment_name, revision, created_at, updated_at, last_used_at) VALUES(?, ?, ?, ?, ?, 1, ?, ?, ?)')
      .run(id, title, scenarioId, projectId ?? null, projectName ?? null, now, now, now);
    WriteAudit(this.db, 'user', 'create', 'conversation', id, {});
    return { id, title, scenarioId, projectId: projectId ?? null, projectName: projectName ?? null, revision: 1, updatedAt: now, messages: [] };
  }

  /** 重命名会话；校验期望版本并刷新其最近使用时间。 */
  Rename(id: string, title: string, expectedRevision?: number): any {
    if (typeof id !== 'string' || id.length === 0 || id.length > 200) throw new Error('Conversation id is invalid.');
    if (typeof title !== 'string' || title.length === 0 || title.length > 300) throw new Error('Conversation title is invalid.');
    const existing = this.db.prepare('SELECT revision FROM conversations WHERE id = ?').get(id);
    if (!existing) throw new Error('Conversation was not found.');
    AssertRevision(existing, expectedRevision, 'conversation', id);
    const nextRevision = existing.revision + 1;
    const result = this.db.prepare('UPDATE conversations SET title = ?, revision = ?, updated_at = ?, last_used_at = ? WHERE id = ?').run(title, nextRevision, GetNow(), GetNow(), id);
    if (!result.changes) throw new Error('Conversation was not found.');
    WriteAudit(this.db, 'user', 'rename', 'conversation', id, {});
    return { id, title, revision: nextRevision };
  }

  /** 删除会话；保留定时任务运行历史并解除其对话关联，消息和附件链接随会话一并清理。 */
  Delete(id: string, actor: 'user' | 'system' = 'user'): any {
    if (typeof id !== 'string' || id.length === 0 || id.length > 200) throw new Error('Conversation id is invalid.');
    const run = this.db.transaction(() => {
      this.db.prepare('INSERT OR IGNORE INTO conversation_cleanup(conversation_id, created_at) VALUES(?, ?)').run(id, GetNow());
      this.attachmentLifecycle.RemoveConversationLinks(id);
      // cron_runs 需保留执行审计，但其 conversation_id 外键默认禁止删除；先断开关联再删会话。
      this.db.prepare('UPDATE cron_runs SET conversation_id = NULL WHERE conversation_id = ?').run(id);
      this.db.prepare('DELETE FROM conversations WHERE id = ?').run(id);
      WriteAudit(this.db, actor, 'delete', 'conversation', id, {});
    });
    run();
    return { id };
  }

  /** 刷新会话最近使用时间，供会话导航置顶使用。 */
  Touch(id: string): void {
    if (typeof id !== 'string' || id.length === 0 || id.length > 200) throw new Error('Conversation id is invalid.');
    this.db.prepare('UPDATE conversations SET updated_at = ?, last_used_at = ? WHERE id = ?').run(GetNow(), GetNow(), id);
  }

  /** 设置会话置顶标记；仅元数据变更，不刷新最近使用时间，避免置顶操作打乱"最近"排序。 */
  SetPinned(id: string, pinned: boolean, expectedRevision?: number): any {
    if (typeof id !== 'string' || id.length === 0 || id.length > 200) throw new Error('Conversation id is invalid.');
    if (typeof pinned !== 'boolean') throw new Error('Conversation pinned flag is invalid.');
    const existing = this.db.prepare('SELECT revision FROM conversations WHERE id = ?').get(id);
    if (!existing) throw new Error('Conversation was not found.');
    AssertRevision(existing, expectedRevision, 'conversation', id);
    const nextRevision = existing.revision + 1;
    const result = this.db.prepare('UPDATE conversations SET pinned = ?, revision = ? WHERE id = ?').run(pinned ? 1 : 0, nextRevision, id);
    if (!result.changes) throw new Error('Conversation was not found.');
    WriteAudit(this.db, 'user', 'set-pinned', 'conversation', id, { pinned });
    return { id, pinned, revision: nextRevision };
  }

  /** 设置会话归档标记；会话与消息保留在库中，归档仅使其从"最近"列表移出。 */
  SetArchived(id: string, archived: boolean, expectedRevision?: number): any {
    if (typeof id !== 'string' || id.length === 0 || id.length > 200) throw new Error('Conversation id is invalid.');
    if (typeof archived !== 'boolean') throw new Error('Conversation archived flag is invalid.');
    return this.db.transaction(() => {
      const existing = this.db.prepare('SELECT revision, archived, archived_at, auto_delete_at FROM conversations WHERE id = ?').get(id);
      if (!existing) throw new Error('Conversation was not found.');
      AssertRevision(existing, expectedRevision, 'conversation', id);
      // 重复归档不能延长保留期；恢复后再次归档才建立新期限。
      if ((existing.archived === 1) === archived) return { id, archived, revision: existing.revision, archivedAt: existing.archived_at ?? null, autoDeleteAt: existing.auto_delete_at ?? null };
      const nextRevision = existing.revision + 1;
      const archivedAt = archived ? GetNow() : null;
      const autoDeleteAt = archivedAt === null ? null : archivedAt + 30 * 86_400_000;
      this.db.prepare('UPDATE conversations SET archived = ?, archived_at = ?, auto_delete_at = ?, revision = ? WHERE id = ?').run(archived ? 1 : 0, archivedAt, autoDeleteAt, nextRevision, id);
      WriteAudit(this.db, 'user', 'set-archived', 'conversation', id, { archived });
      return { id, archived, revision: nextRevision, archivedAt, autoDeleteAt };
    })();
  }

  /** 在删除事务内重新检查归档和版本；自动清理还要重新核对期限。 */
  DeleteArchived(id: string, expectedRevision: number, dueBefore?: number): { id: string; deleted: boolean; reason?: 'not_found' | 'changed' } {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) throw new Error('Conversation revision is invalid.');
    return this.db.transaction(() => {
      const row = this.db.prepare('SELECT revision, archived, auto_delete_at FROM conversations WHERE id = ?').get(id);
      if (!row) return { id, deleted: false, reason: 'not_found' as const };
      if (row.archived !== 1 || row.revision !== expectedRevision || (dueBefore !== undefined && (row.auto_delete_at === null || row.auto_delete_at > dueBefore))) return { id, deleted: false, reason: 'changed' as const };
      this.Delete(id, dueBefore === undefined ? 'user' : 'system');
      return { id, deleted: true };
    })();
  }

  /** 仅返回有明确期限的到期快照；不读取消息正文，单批限制工作量。 */
  ListExpired(now: number): Array<{ id: string; expectedRevision: number }> {
    return this.db.prepare('SELECT id, revision AS expectedRevision FROM conversations WHERE archived = 1 AND auto_delete_at IS NOT NULL AND auto_delete_at <= ? ORDER BY auto_delete_at, id LIMIT 100').all(now);
  }

  ListPendingCleanup(): string[] {
    return this.db.prepare('SELECT conversation_id FROM conversation_cleanup ORDER BY created_at, conversation_id LIMIT 100').all().map((row: { conversation_id: string }) => row.conversation_id);
  }

  CompleteCleanup(id: string): void { this.db.prepare('DELETE FROM conversation_cleanup WHERE conversation_id = ?').run(id); }

  /** 正式宿主在运行准备阶段验证记录仍存在，防止删除后的迟到请求重建私有历史。 */
  AssertAvailable(id: string): void {
    if (!this.db.prepare('SELECT 1 FROM conversations WHERE id = ?').get(id)) throw Object.assign(new Error('对话不存在或已被删除。'), { code: 'NOT_FOUND' });
  }

  /** 向会话追加消息；按消息 ID upsert，重复投递不会产生重复记录。 */
  /** 仅由宿主调用；Renderer 不能提交或改写已执行工具的事实。 */
  SavePresentation(conversationId: string, presentation: ConversationPresentation): { saved: boolean } {
    if (!IsConversationPresentation(presentation)) throw new Error('Conversation presentation is invalid.');
    const id = 'reply-' + presentation.requestId;
    const existing = this.db.prepare('SELECT presentation_json FROM conversation_messages WHERE id = ? AND conversation_id = ?').get(id, conversationId);
    if (!existing) return { saved: false };
    const previous = ReadPresentation(existing.presentation_json);
    if (previous && previous.sequence >= presentation.sequence) return { saved: false };
    const content = presentation.parts.flatMap((part) => part.type === 'text' ? [part.text] : []).join('\n\n');
    const reasoning = presentation.parts.flatMap((part) => part.type === 'reasoning' ? [part.text] : []).join('\n\n');
    this.db.prepare('UPDATE conversation_messages SET presentation_json = ?, content = ?, reasoning_content = ?, updated_at = ? WHERE id = ? AND conversation_id = ?')
      .run(JSON.stringify(presentation), content, reasoning, GetNow(), id, conversationId);
    return { saved: true };
  }

  /** 宿主按会话恢复可见过程，用于确认回执和资源归属校验。 */
  GetPresentations(conversationId: string): ConversationPresentation[] {
    return this.db.prepare('SELECT presentation_json FROM conversation_messages WHERE conversation_id = ? AND presentation_json IS NOT NULL ORDER BY created_at, rowid')
      .all(conversationId).flatMap((row: { presentation_json: string }) => {
        const value = ReadPresentation(row.presentation_json); return value ? [value] : [];
      });
  }

  /** 后端重启时只结算遗留 running 投影；等待审批和已完成的事实保持原样，不恢复执行工具。 */
  RecoverInterrupted(): { recovered: number } {
    return this.db.transaction(() => {
      let recovered = 0;
      const rows = this.db.prepare('SELECT conversation_id,presentation_json FROM conversation_messages WHERE presentation_json IS NOT NULL').all() as Array<{ conversation_id: string; presentation_json: string }>;
      for (const row of rows) {
        const presentation = ReadPresentation(row.presentation_json);
        if (!presentation || presentation.status !== 'running') continue;
        const next = ApplyConversationActivity(presentation, { kind: 'status', status: 'failed', error: '上次运行已中断，已完成操作的记录已保留。请核对结果后继续，原操作不会自动重放。' }, presentation.sequence + 1, GetNow());
        if (this.SavePresentation(row.conversation_id, next).saved) recovered++;
      }
      return { recovered };
    })();
  }

  /** 向会话追加消息；按消息 ID upsert，重复投递不会产生重复记录。 */
  AppendMessages(conversationId: string, messages: any[]): any {
    if (typeof conversationId !== 'string' || conversationId.length === 0 || conversationId.length > 200) throw new Error('Conversation id is invalid.');
    if (!Array.isArray(messages) || messages.length === 0 || messages.length > 50) throw new Error('Conversation messages are invalid.');
    const existing = this.db.prepare('SELECT id FROM conversations WHERE id = ?').get(conversationId);
    if (!existing) throw new Error('Conversation was not found.');
    const insert = this.db.prepare('INSERT INTO conversation_messages(id, conversation_id, role, content, reasoning_content, status, created_at, updated_at, metadata_json) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET content = excluded.content, reasoning_content = excluded.reasoning_content, updated_at = excluded.updated_at, metadata_json = COALESCE(conversation_messages.metadata_json, excluded.metadata_json)');
    const now = GetNow();
    const run = this.db.transaction(() => {
      for (let index = 0; index < messages.length; index += 1) {
        const message = messages[index];
        if (!message || typeof message.id !== 'string' || message.id.length === 0 || message.id.length > 200) throw new Error('Conversation message id is invalid.');
        if (message.role !== 'user' && message.role !== 'assistant' && message.role !== 'system') throw new Error('Conversation message role is invalid.');
        if (typeof message.content !== 'string' || message.content.length > 100000) throw new Error('Conversation message content is invalid.');
        if (message.skill !== undefined && message.role !== 'user') throw new Error('Only user messages may include a skill label.');
        const metadata = message.skill === undefined ? null : JSON.stringify({ skill: ChatMessageSkillSchema.parse(message.skill) });
        const existingMessage = this.db.prepare('SELECT conversation_id FROM conversation_messages WHERE id = ?').get(message.id);
        if (existingMessage && existingMessage.conversation_id !== conversationId) throw new Error('Conversation message id belongs to another conversation.');
        insert.run(message.id, conversationId, message.role, message.content, message.thinkingContent ?? null, 'complete', now + index, now + index, metadata);
        this.attachmentLifecycle.ReplaceLinks('message', message.id, message.attachments ?? null);
      }
      this.Touch(conversationId);
    });
    run();
    return { conversationId, count: messages.length };
  }

  /** 写入流式占位消息的最终正文；Agent 正常结束、取消或失败时调用。 */
  CompleteMessage(conversationId: string, messageId: string, content: string, thinkingContent?: string): any {
    if (typeof conversationId !== 'string' || conversationId.length === 0 || conversationId.length > 200) throw new Error('Conversation id is invalid.');
    if (typeof messageId !== 'string' || messageId.length === 0 || messageId.length > 200) throw new Error('Conversation message id is invalid.');
    if (typeof content !== 'string' || content.length > 100000) throw new Error('Conversation message content is invalid.');
    const result = this.db.prepare('UPDATE conversation_messages SET content = ?, reasoning_content = ?, status = ?, updated_at = ? WHERE id = ? AND conversation_id = ?')
      .run(content, thinkingContent ?? null, 'complete', GetNow(), messageId, conversationId);
    if (!result.changes) throw new Error('Conversation message was not found.');
    this.Touch(conversationId);
    return { conversationId, messageId };
  }

  /** 移除一条本地消息，用于清理未完成请求的临时占位消息。 */
  RemoveMessage(conversationId: string, messageId: string): any {
    if (typeof conversationId !== 'string' || conversationId.length === 0 || conversationId.length > 200) throw new Error('Conversation id is invalid.');
    if (typeof messageId !== 'string' || messageId.length === 0 || messageId.length > 200) throw new Error('Conversation message id is invalid.');
    const run = this.db.transaction(() => {
      const message = this.db.prepare('SELECT id FROM conversation_messages WHERE id = ? AND conversation_id = ?').get(messageId, conversationId);
      if (message) this.attachmentLifecycle.RemoveLinks('message', messageId);
      this.db.prepare('DELETE FROM conversation_messages WHERE id = ? AND conversation_id = ?').run(messageId, conversationId);
      this.Touch(conversationId);
    });
    run();
    return { conversationId, messageId };
  }

  /** 在单次事务内同时写入会话上下文与 Tool Array 快照，保证 /reload-session 原子更新不产生部分快照。 */
  SetSnapshots(conversationId: string, { sessionSnapshotJson, toolSnapshotJson }: { sessionSnapshotJson?: string | null; toolSnapshotJson?: string | null }): any {
    const run = this.db.transaction(() => {
      if (sessionSnapshotJson != null) this.SetSessionSnapshot(conversationId, sessionSnapshotJson);
      if (toolSnapshotJson != null) this.SetToolSnapshot(conversationId, toolSnapshotJson);
    });
    run();
    return { conversationId };
  }

  /** 写入会话上下文快照的 JSON 序列化文本。 */
  SetSessionSnapshot(conversationId: string, json: string): void {
    if (typeof conversationId !== 'string' || conversationId.length === 0 || conversationId.length > 200) throw new Error('Conversation id is invalid.');
    if (typeof json !== 'string' || json.length > 500000) throw new Error('Session snapshot is invalid.');
    this.db.prepare('UPDATE conversations SET session_snapshot_json = ?, updated_at = ? WHERE id = ?').run(json, GetNow(), conversationId);
    this.attachmentLifecycle.ReplaceLinks('conversation', conversationId, json);
  }

  /** 读取会话上下文快照 JSON；未写入时返回 null。 */
  GetSessionSnapshot(conversationId: string): string | null {
    if (typeof conversationId !== 'string' || conversationId.length === 0 || conversationId.length > 200) throw new Error('Conversation id is invalid.');
    return this.db.prepare('SELECT session_snapshot_json FROM conversations WHERE id = ?').get(conversationId)?.session_snapshot_json ?? null;
  }

  /** 写入 Tool Array 快照的 JSON 序列化文本。 */
  SetToolSnapshot(conversationId: string, json: string): void {
    if (typeof conversationId !== 'string' || conversationId.length === 0 || conversationId.length > 200) throw new Error('Conversation id is invalid.');
    if (typeof json !== 'string' || json.length > 500000) throw new Error('Tool snapshot is invalid.');
    this.db.prepare('UPDATE conversations SET tool_array_snapshot_json = ?, updated_at = ? WHERE id = ?').run(json, GetNow(), conversationId);
  }

  /** 读取 Tool Array 快照 JSON；未写入时返回 null。 */
  GetToolSnapshot(conversationId: string): string | null {
    if (typeof conversationId !== 'string' || conversationId.length === 0 || conversationId.length > 200) throw new Error('Conversation id is invalid.');
    return this.db.prepare('SELECT tool_array_snapshot_json FROM conversations WHERE id = ?').get(conversationId)?.tool_array_snapshot_json ?? null;
  }
}
