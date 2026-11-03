const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, readFile, readdir, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { CreateBusinessStoreClient } = require('../dist/infra/business-store-client.js');
const { CreateBackend } = require('../dist/router.js');
const { CreateEmptyResumeData, ResumeDataToText } = require('../../../packages/contracts/dist/index.js');
const { CreateToolsModule } = require('../../../packages/agent-modules-defaults/dist/tools.js');
const { CreateInteractionModule } = require('../../../packages/agent-modules-defaults/dist/interaction.js');
const { AgentResumePort } = require('../dist/electron/backend/agent-resume-port.js');

// 通过生产 IPC 校验和业务 Worker 操作隔离工作空间，不打开用户数据库。
test('结构化简历经 IPC 保存并写入独立 JSON，重启后切换模板保持数据和版本', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'avery-resume-worker-'));
  let business = CreateBusinessStoreClient({ workspacePath: directory });
  try {
    await business.ready;
    const data = CreateEmptyResumeData();
    data.personal = { name: '隔离测试', email: 'fixture@example.com', phone: '13800000000', github: '' };
    data.projects = [{ name: '示例项目', role: '负责人', start: '2026-01', end: '至今', descriptions: ['验证独立 JSON 持久化'] }];
    const resume = { id: 'isolated-resume', name: '测试简历', content: ResumeDataToText(data), data, templateId: 'classic', targetRoles: [], summary: '' };
    const backend = CreateBackend({ container: { resumes: { UpsertResume: (input, revision) => business.UpsertResume(input, revision) } } });
    const saved = await backend.HandleCommand('workspace:resumes-upsert', 'save', 'resume-save', resume);
    assert.equal(saved.ok, true);
    const files = await readdir(join(directory, 'resumes'));
    assert.equal(files.length, 1);
    const filePath = join(directory, 'resumes', files[0]);
    assert.deepEqual(JSON.parse(await readFile(filePath, 'utf8')).resume.data, data);
    await business.call('Close'); business.close();
    business = CreateBusinessStoreClient({ workspacePath: directory });
    await business.ready;
    const loaded = (await business.LoadViewModel()).resumes[0];
    assert.deepEqual(loaded.data, data);
    await business.UpsertResume({ ...loaded, templateId: 'compact' }, loaded.revision);
    const switched = JSON.parse(await readFile(filePath, 'utf8')).resume;
    assert.deepEqual(switched.data, data);
    assert.equal(switched.templateId, 'compact');
    assert.equal(switched.revision, 2);
    const revisions = await business.GetResumeRevisions(resume.id);
    await business.RestoreResumeRevision(resume.id, revisions.find((row) => row.revision === 1).id, 2);
    assert.equal(JSON.parse(await readFile(filePath, 'utf8')).resume.templateId, 'classic');
    await business.DeleteResume(resume.id);
    assert.deepEqual(await readdir(join(directory, 'resumes')), []);
  } finally {
    await business.call('Close'); business.close();
    await rm(directory, { recursive: true, force: true });
  }
});

for (const confirmationMode of ['fully_trusted', 'always_confirm']) {
  test(`Agent ${confirmationMode} 创建和编辑经真实 Worker 保存新版 JSON，确认过程不丢结构`, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'avery-agent-resume-worker-'));
    const business = CreateBusinessStoreClient({ workspacePath: directory });
    try {
      await business.ready;
      const port = new AgentResumePort({ business });
      const ledger = new Map();
      const context = {
        requestId: 'test-request', runId: 'test-run', sessionId: 'test-session', scenarioId: 'application', confirmationMode,
        resumeEditing: false, boundResume: null, projectRoot: null, attachments: [], profileSnapshot: [],
        tasks: new Map(), pendingQuestions: new Map(), pendingEdits: new Map(),
        ports: { resumeRead: port, resumeWrite: port }, emit() {}, persistSessionState() {},
        bindResume(resume) { context.boundResume = resume; },
        ledger: {
          async Start(entry) { ledger.set(entry.ledgerId, { ...entry }); },
          async Finish(id, status, extra) { ledger.set(id, { ...ledger.get(id), status, ...extra }); },
          async FindByIdempotencyKey(key) { return [...ledger.values()].find((entry) => entry.idempotencyKey === key && entry.status !== 'started'); },
        },
      };
      const tools = CreateToolsModule({ getConfig: async () => null, saveConfig: async () => undefined, getStoredSettings: async () => ({}) });
      async function Call(name, input) {
        const result = await tools.ExecuteToolCall({ id: `call-${name}`, type: 'function', function: { name, arguments: JSON.stringify(input) } }, context);
        const payload = JSON.parse(result.content);
        if (result.disposition === 'wait_confirmation') {
          assert.equal((await business.LoadViewModel()).resumes.length, name === 'CreateResume' ? 0 : 1);
          // 模拟提案随应用状态落盘、恢复，再走生产确认回调。
          context.pendingEdits = new Map(JSON.parse(JSON.stringify([...context.pendingEdits])));
          assert.equal((await CreateInteractionModule().ConfirmResumeEdit(payload.confirmationId, true, context)).applied, true);
        } else assert.equal(payload.ok, true, result.content);
      }
      const data = { personal: { name: 'Agent 测试', email: 'agent@example.com', phone: '13800000000', github: '' },
        education: [], work: [], projects: [{ name: '示例项目', role: '负责人', start: '2026-01', end: '至今', descriptions: ['原始描述'] }], sections: [] };
      await Call('CreateResume', { name: 'Agent 简历', data, reason: '用户要求新建' });
      const created = (await business.LoadViewModel()).resumes[0];
      assert.equal(created.data.mode, 'structured');
      assert.deepEqual(created.data.projects, data.projects);
      assert.equal(created.data.legacyContent, undefined);
      await business.UpsertResume({ ...created, templateId: 'compact' }, created.revision);
      await Call('ReadResume', { resumeId: created.id });
      data.projects[0].descriptions[0] = '修改后的描述';
      await Call('UpdateResume', { resumeId: created.id, data, reason: '只修改一条描述' });
      const edited = (await business.LoadViewModel()).resumes[0];
      assert.equal(edited.data.mode, 'structured'); assert.equal(edited.templateId, 'compact');
      assert.equal(edited.data.projects[0].descriptions[0], '修改后的描述');
      const files = await readdir(join(directory, 'resumes'));
      const persisted = JSON.parse(await readFile(join(directory, 'resumes', files[0]), 'utf8')).resume;
      assert.deepEqual(persisted.data, edited.data); assert.equal(persisted.templateId, 'compact');
    } finally {
      await business.call('Close'); business.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
}
