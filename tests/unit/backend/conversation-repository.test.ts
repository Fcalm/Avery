import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import { ConversationRepository } from '../../../apps/backend/src/electron/repositories/conversation-repository';
import { AgentHost } from '../../../apps/backend/src/electron/backend/agent-host';
import { CreateDefaultModules } from '../../../packages/agent-modules-defaults/src/index';
import type { AgentStreamEvent, ModelCompletion } from '../../../packages/agent-sdk/src/index';
import { ApplyConversationActivity, CreateConversationPresentation } from '../../../packages/agent-sdk/src/conversation';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

function CreateRepository(file = ':memory:', initialize = true) {
  const db = new Database(file);
  db.pragma('foreign_keys = ON');
  if (initialize) db.exec(`
    CREATE TABLE conversations(id TEXT PRIMARY KEY, title TEXT NOT NULL, scenario_id TEXT NOT NULL DEFAULT 'resume-copilot', environment_id TEXT, environment_root_path TEXT, environment_real_path TEXT, environment_status TEXT NOT NULL DEFAULT 'none', environment_bound_at INTEGER, environment_name TEXT, session_snapshot_json TEXT, tool_array_snapshot_json TEXT NOT NULL DEFAULT '[]', revision INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, last_used_at INTEGER NOT NULL, pinned INTEGER NOT NULL DEFAULT 0, archived INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE conversation_messages(id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE, role TEXT NOT NULL, content TEXT NOT NULL, reasoning_content TEXT, presentation_json TEXT, status TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE cron_tasks(id TEXT PRIMARY KEY);
    CREATE TABLE attachments(id TEXT PRIMARY KEY, original_name TEXT, deleted_at INTEGER);
    CREATE TABLE attachment_links(attachment_id TEXT, owner_type TEXT, owner_id TEXT, created_at INTEGER);
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

describe('会话过程持久化', () => {
  it('真实消息链路落库后关闭并重开数据库，确认原提案再续跑，资源与 Todo 保持会话归属', async () => {
    const root = await mkdtemp(join(tmpdir(), 'avery-conversation-roundtrip-'));
    const file = join(root, 'conversation.db');
    let { db, repository } = CreateRepository(file);
    let host: AgentHost | undefined;
    let resume = { id: 'resume-roundtrip', name: '产品简历', content: '# 核心能力\n原型生产：旧内容\n# 教育经历\n南昌大学', updatedAt: '', revision: 10, targetRoles: [], summary: '' };
    const content = resume.content.replace('原型生产：旧内容', '原型生产：熟练使用 Figma 绘制产品原型');
    const events: AgentStreamEvent[] = [];
    const save = vi.fn(async (next: typeof resume, expectedRevision: number) => {
      expect(expectedRevision).toBe(10);
      resume = { ...next, revision: 11 };
      return { id: resume.id, revision: resume.revision };
    });
    const call = (index: number, name: string, args: Record<string, unknown>): ModelCompletion => ({ content: '', toolCalls: [{ id: `roundtrip-${index}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
    const completions = [
      call(0, 'ReadResume', { resumeId: resume.id }),
      call(1, 'CreateTodo', { todos: [{ title: '调整第一条核心能力', description: '保留其他内容' }] }),
      call(2, 'UpdateResume', { resumeId: resume.id, content, reason: '用户要求局部修改' }),
      { content: '第一条核心能力已保存，其他部分保持原样。', toolCalls: [] },
    ];
    const business = {
      GetStoredSettings: async () => ({}), GetProfiles: async () => ({ items: [] }), ResolveAttachmentUri: async () => null,
      LoadViewModel: async () => ({ resumes: [resume] }), UpsertResume: save,
      GetResumeRevisions: async () => [],
      SaveConversationPresentation: async (owner: string, presentation: Parameters<ConversationRepository['SavePresentation']>[1]) => repository.SavePresentation(owner, presentation),
      GetConversationPresentations: async (owner: string) => repository.GetPresentations(owner),
      GetConversationSnapshots: async (owner: string) => ({ sessionSnapshotJson: repository.GetSessionSnapshot(owner), toolSnapshotJson: repository.GetToolSnapshot(owner) }),
      SetConversationSnapshots: async (owner: string, snapshots: Parameters<ConversationRepository['SetSnapshots']>[1]) => repository.SetSnapshots(owner, snapshots),
    };
    const CreateHost = () => new AgentHost({ userDataPath: join(root, 'user'), workspacePath: root, business, Emit: (event) => events.push(event), observability: null,
      browserRuntime: { Close: async () => undefined, ResetPageReferences: () => undefined } as never,
      createDefaultModules: (ports) => {
        const modules = CreateDefaultModules(ports);
        return { ...modules, modelProvider: { ...modules.modelProvider,
          GetStatus: async () => ({ configured: true, provider: 'Test', model: 'roundtrip-model' }),
          ResolveRequestModel: () => 'roundtrip-model', BaseUrl: () => 'https://example.test',
          GetRuntimeLimits: () => ({ contextLimit: 128000, threshold: 70 }), EstimateTokens: () => 10,
          StreamCompletion: async ({ onDelta }) => { const next = completions.shift()!; if (next.content) onDelta({ content: next.content, reasoning: '' }); return next; },
        } };
      },
    });
    try {
      repository.Create({ id: 'owner', title: '局部修改', scenarioId: 'application' });
      repository.Create({ id: 'other', title: '另一个会话' });
      repository.AppendMessages('owner', [{ id: 'user-first', role: 'user', content: '只改第一条核心能力' }, { id: 'reply-roundtrip-first', role: 'assistant', content: '' }]);
      host = CreateHost();
      await host.Send({ requestId: 'roundtrip-first', sessionId: 'owner', scenarioId: 'application', confirmationMode: 'always_confirm', content: '只改第一条核心能力' });
      const confirmation = events.find((event) => event.type === 'resume_confirmation');
      expect(confirmation?.confirmationId).toBeTruthy();
      expect(repository.GetPresentations('owner')).toMatchObject([{ status: 'waiting' }]);
      expect(save).not.toHaveBeenCalled();
      const tasks = (await host.GetSessionAssistantState('owner')).tasks;
      expect(tasks).toMatchObject([{ title: '调整第一条核心能力' }]);
      await host.Close(); host = undefined; db.close();
      ({ db, repository } = CreateRepository(file, false));
      host = CreateHost();
      expect(repository.GetPresentations('owner')).toMatchObject([{ status: 'waiting' }]);
      expect(await host.GetSessionAssistantState('owner')).toMatchObject({ tasks, pendingEvents: [expect.objectContaining({ confirmationId: confirmation!.confirmationId, sessionId: 'owner' })] });
      expect(await host.GetSessionAssistantState('other')).toMatchObject({ tasks: [], pendingEvents: [] });
      await host.ConfirmResumeEdit(confirmation!.confirmationId!, true);
      expect(save).toHaveBeenCalledTimes(1);
      expect(repository.GetPresentations('owner')[0]).toMatchObject({ status: 'completed', parts: expect.arrayContaining([
        expect.objectContaining({ type: 'tool', name: 'UpdateResume', status: 'succeeded' }),
        expect.objectContaining({ type: 'resource', resource: expect.objectContaining({ kind: 'resume', id: resume.id, revision: 11, produced: true }) }),
      ]) });
      repository.AppendMessages('owner', [{ id: 'user-confirmed', role: 'user', content: '我已确认保存，继续' }, { id: 'reply-roundtrip-next', role: 'assistant', content: '' }]);
      await host.Send({ requestId: 'roundtrip-next', sessionId: 'owner', scenarioId: 'application', confirmationMode: 'always_confirm', content: '我已确认保存，继续' });
      expect(save).toHaveBeenCalledTimes(1);
      expect(resume.content).toBe(content);
      await host.Close(); host = undefined; db.close();
      ({ db, repository } = CreateRepository(file, false));
      const persisted = repository.ListAll();
      expect(persisted.find((item) => item.id === 'owner').messages).toMatchObject([
        { role: 'user' }, { presentation: { status: 'completed' } }, { role: 'user' }, { content: '第一条核心能力已保存，其他部分保持原样。', presentation: { status: 'completed' } },
      ]);
      expect(persisted.find((item) => item.id === 'other').messages).toEqual([]);
      host = CreateHost();
      const resource = { kind: 'resume' as const, id: resume.id, title: resume.name, revision: 11, produced: true };
      expect(await host.ReadConversationResource('owner', resource)).toMatchObject({ format: 'resume', document: { content, revision: 11 } });
      await expect(host.ReadConversationResource('other', resource)).rejects.toThrow('不属于当前会话');
      expect((await host.GetSessionAssistantState('owner')).pendingEvents).toEqual([]);
      await expect(host.ConfirmResumeEdit(confirmation!.confirmationId!, true)).rejects.toThrow();
      expect(save).toHaveBeenCalledTimes(1);
    } finally { await host?.Close(); if (db.open) db.close(); await rm(root, { recursive: true, force: true }); }
  });

  it('消息持久保存过程与资源，旧序号不能覆盖终态，删除后不能被流事件复活', () => {
    const { db, repository } = CreateRepository();
    repository.Create({ id: 'owner', title: '测试' });
    repository.AppendMessages('owner', [{ id: 'reply-req1', role: 'assistant', content: '' }]);
    const running = ApplyConversationActivity(CreateConversationPresentation('req1'), { kind: 'text', partId: 'text1', delta: '最终结果' }, 1, 1);
    const completed = ApplyConversationActivity(running, { kind: 'status', status: 'completed' }, 2, 2);
    expect(repository.SavePresentation('owner', completed)).toEqual({ saved: true });
    expect(repository.SavePresentation('owner', running)).toEqual({ saved: false });
    expect(repository.ListAll()[0].messages[0]).toMatchObject({ content: '最终结果', presentation: completed });
    expect(repository.SavePresentation('other', completed)).toEqual({ saved: false });
    repository.Delete('owner');
    expect(repository.SavePresentation('owner', completed)).toEqual({ saved: false });
    db.close();
  });

  it('重启时仅 running 变为中断，等待确认和已完成状态继续保留', () => {
    const { db, repository } = CreateRepository();
    repository.Create({ id: 'owner', title: '测试' });
    for (const [id, status] of [['run', 'running'], ['wait', 'waiting'], ['done', 'completed']] as const) {
      repository.AppendMessages('owner', [{ id: 'reply-' + id, role: 'assistant', content: '' }]);
      repository.SavePresentation('owner', { ...CreateConversationPresentation(id), sequence: 1, status });
    }
    const restarted = new ConversationRepository({ db, attachmentLifecycle: {} });
    expect(restarted.GetPresentations('owner').map((item) => item.status)).toEqual(['interrupted', 'waiting', 'completed']);
    expect(restarted.GetPresentations('owner')[0].error).toContain('退出而中断');
    db.close();
  });
});
