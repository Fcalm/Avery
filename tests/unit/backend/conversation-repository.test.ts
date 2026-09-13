import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { ConversationRepository } from '../../../apps/backend/src/electron/repositories/conversation-repository';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

function CreateRepository() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE conversations(id TEXT PRIMARY KEY, title TEXT NOT NULL, scenario_id TEXT NOT NULL DEFAULT 'resume-copilot', environment_id TEXT, environment_root_path TEXT, environment_real_path TEXT, environment_status TEXT NOT NULL DEFAULT 'none', environment_bound_at INTEGER, environment_name TEXT, session_snapshot_json TEXT, tool_array_snapshot_json TEXT NOT NULL DEFAULT '[]', revision INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, last_used_at INTEGER NOT NULL, pinned INTEGER NOT NULL DEFAULT 0, archived INTEGER NOT NULL DEFAULT 0);
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

describe('ConversationRepository 创建', () => {
  it('创建会话时定格场景与项目空间，列表读取返回同一快照', () => {
    const { db, repository } = CreateRepository();
    repository.Create({ id: 'conversation-1', title: '投递会话', scenarioId: 'application', projectId: 'project-1', projectName: 'resume-html-pdf' });
    repository.Create({ id: 'conversation-2', title: '普通聊天' });

    const conversations = repository.ListAll();
    expect(conversations.find((item: any) => item.id === 'conversation-1')).toMatchObject({ scenarioId: 'application', projectId: 'project-1', projectName: 'resume-html-pdf' });
    expect(conversations.find((item: any) => item.id === 'conversation-2')).toMatchObject({ scenarioId: 'default', projectId: null, projectName: null });
    db.close();
  });

  it('项目空间只传 id 或只传名称时拒绝创建，场景值非法时拒绝创建', () => {
    const { db, repository } = CreateRepository();
    expect(() => repository.Create({ id: 'conversation-3', title: '半配置', projectId: 'project-1' })).toThrow('project environment is invalid');
    expect(() => repository.Create({ id: 'conversation-4', title: '坏场景', scenarioId: 'resume-copilot' as unknown as 'default' })).toThrow('scenario is invalid');
    db.close();
  });

  it('功能上线前的旧会话缺元数据时仍可读取，遗留场景标识归一为默认场景', () => {
    const { db, repository } = CreateRepository();
    db.prepare("INSERT INTO conversations(id, title, scenario_id, revision, created_at, updated_at, last_used_at) VALUES('legacy-1', '旧会话', 'resume-copilot', 1, 1, 1, 1)").run();

    expect(repository.ListAll().find((item: any) => item.id === 'legacy-1')).toMatchObject({ scenarioId: 'default', projectId: null, projectName: null });
    db.close();
  });
});

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
