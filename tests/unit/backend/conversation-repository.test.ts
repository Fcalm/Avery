import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { ConversationRepository } from '../../../apps/backend/src/electron/repositories/conversation-repository';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

function CreateRepository() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE conversations(id TEXT PRIMARY KEY, title TEXT NOT NULL, revision INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, last_used_at INTEGER NOT NULL);
    CREATE TABLE conversation_messages(id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE, role TEXT NOT NULL, content TEXT NOT NULL, reasoning_content TEXT, status TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE cron_tasks(id TEXT PRIMARY KEY);
    CREATE TABLE cron_runs(id TEXT PRIMARY KEY, cron_task_id TEXT NOT NULL REFERENCES cron_tasks(id), conversation_id TEXT REFERENCES conversations(id));
    CREATE TABLE audit_events(id TEXT PRIMARY KEY, actor_type TEXT, action TEXT, entity_type TEXT, entity_id TEXT, metadata_json TEXT, created_at INTEGER);
  `);
  return {
    db,
    repository: new ConversationRepository({ db, attachmentLifecycle: { RemoveConversationLinks: () => undefined, ReplaceLinks: () => undefined, RemoveLinks: () => undefined } }),
  };
}

describe('ConversationRepository 删除', () => {
  it('删除定时任务创建的对话时保留运行历史并清空关联', () => {
    const { db, repository } = CreateRepository();
    repository.Create({ id: 'cron-conversation-1', title: '定时投递' });
    db.prepare('INSERT INTO cron_tasks(id) VALUES(?)').run('cron-1');
    db.prepare('INSERT INTO cron_runs(id, cron_task_id, conversation_id) VALUES(?, ?, ?)').run('run-1', 'cron-1', 'cron-conversation-1');

    expect(repository.Delete('cron-conversation-1')).toEqual({ id: 'cron-conversation-1' });
    expect(db.prepare('SELECT id FROM conversations WHERE id = ?').get('cron-conversation-1')).toBeUndefined();
    expect(db.prepare('SELECT conversation_id FROM cron_runs WHERE id = ?').get('run-1')).toEqual({ conversation_id: null });
    db.close();
  });
});
