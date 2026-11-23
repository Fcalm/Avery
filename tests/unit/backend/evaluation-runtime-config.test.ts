import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EvalService } from '../../../apps/backend/src/electron/backend/evaluation/eval-service';
import { ObservabilityStore } from '../../../apps/backend/src/observability-store';
import { DefaultScenario } from '../../../packages/agent-modules-defaults/src/prompts';
import { EvaluationTestCredentials } from '../../fixtures/evaluation-credentials';

const closers: Array<() => Promise<void>> = [];
afterEach(async () => { vi.restoreAllMocks(); for (const close of closers.splice(0).reverse()) await close(); });
const config = { executionProvider: 'DeepSeek' as const, executionModel: 'deepseek-v4-flash', judgeProvider: 'DeepSeek' as const, judgeModel: 'deepseek-v4-pro', candidates: [{ id: 'a', name: 'A', promptOverrides: {} }], userSimulator: 'approve_valid' as const, maxModelTurns: 4, repeatCount: 1 };
const dataset = JSON.stringify({ id: 'resume-one', category: '简历', input: { userMessage: '请回答测试问题' }, fixtures: { profile: [{ content: '已有事实' }] }, expected: { requiredFacts: [], requiredBehaviors: [], forbiddenClaims: [], forbiddenBehaviors: [], referenceAnswer: '' }, tags: [] });
const result = { finalResponse: '回答', events: [], finalState: { profiles: [], resumes: [] }, metrics: { totalTokens: 2, promptTokens: 1, completionTokens: 1 } };
const score = { score: { totalScore: 80, hardFailures: [], dimensions: {} }, details: { objective: {}, judgeRaw: [] } };

async function Fixture(credentials = EvaluationTestCredentials(), execute = vi.fn(async (_input: any) => result)) {
  const root = await mkdtemp(join(tmpdir(), 'avery-eval-config-'));
  const store = new ObservabilityStore(root);
  const judge = vi.fn(async (_input: any) => score);
  const service = new EvalService({ userDataPath: root, store, credentialPort: credentials, getStoredSettings: async () => ({ developerMode: true }), Emit() {}, promptRunner: { Execute: execute } as any, scorer: { Score: judge } as any });
  closers.push(async () => { await service.Close(); store.Close(); await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); });
  await service.Initialize();
  return { root, store, service, execute, judge };
}

async function Terminal(service: EvalService, id: string) {
  for (let attempt = 0; attempt < 300; attempt++) {
    const run = await service.ReadRun(id);
    if (['completed', 'failed', 'cancelled'].includes(run.status)) return run;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('run did not terminate');
}

describe('测评工具与模型配置', () => {
  it('省略工具的新项目从正式只读场景生成，合法题库可以运行', async () => {
    const { service } = await Fixture();
    let project = await service.CreateProject({ name: '默认 Prompt', runnerType: 'prompt', rubric: '依据事实', config });
    expect(project.config.toolNames).toEqual(DefaultScenario.toolNames);
    expect(project.config.toolNames).not.toContain('WriteTodo');
    await service.ImportDataset(project.id, dataset, project.rubric, project.revision);
    project = await service.ReadProject(project.id);
    expect(await service.ValidateProject(project.id)).toMatchObject({ valid: true });
    expect((await Terminal(service, (await service.StartRun(project.id)).id)).status).toBe('completed');
    await expect(service.CreateProject({ name: '错误工具', runnerType: 'prompt', rubric: '', config: { ...config, toolNames: ['WriteTodo'] } })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('旧工具显式修正；聊天场景不把旧写工具映射成新的写权限，历史快照不变', async () => {
    const { service, store } = await Fixture();
    let project = await service.CreateProject({ name: '旧项目', runnerType: 'prompt', rubric: '依据事实', config });
    await service.ImportDataset(project.id, dataset, project.rubric, project.revision);
    project = await service.ReadProject(project.id);
    store.UpdateEvalProjectRecord(project.id, { ...project, config: { ...project.config, toolNames: ['ReadResume', 'CreateTodo', 'UpdateTodo', 'WriteTodo', 'RetiredTool'] }, updatedAt: Date.now() }, project.revision);
    project = await service.ReadProject(project.id);
    const snapshot = { config: structuredClone(project.config) };
    store.CreateEvalRunRecord({ id: 'old-run', projectId: project.id, projectName: project.name, runnerType: 'prompt', status: 'completed', snapshotHash: 'old', snapshot, createdAt: Date.now() });
    const preview = await service.PreviewProject(project.id);
    expect(preview.tools.invalid).toEqual(['CreateTodo', 'UpdateTodo', 'WriteTodo', 'RetiredTool']);
    expect(preview.tools.suggested).toEqual(['ReadResume']);
    expect((await service.ReadProject(project.id)).config).toEqual(project.config);
    project = await service.UpdateProject(project.id, { name: project.name, runnerType: 'prompt', rubric: project.rubric, config: { ...project.config, toolNames: preview.tools.suggested } }, project.revision);
    expect(await service.ValidateProject(project.id)).toMatchObject({ valid: true });
    expect((await service.ReadRun('old-run')).snapshot).toEqual(snapshot);
    await expect(service.UpdateProject(project.id, { name: project.name, runnerType: 'prompt', config: { ...project.config, toolNames: ['UnknownTool'] } }, project.revision)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('执行与 Judge 独立选供应商，跨供应商同名模型也不会混淆', async () => {
    const source = await EvaluationTestCredentials().Load();
    source.provider = 'MIMO';
    source.model = 'mimo-v2.6-flash';
    source.providerConfigs['自定义'].model = 'deepseek-v4-flash';
    const { service, execute, judge } = await Fixture({ Load: async () => structuredClone(source) });
    let project = await service.CreateProject({ name: '同名模型', runnerType: 'prompt', rubric: '依据事实', config: { ...config, judgeProvider: '自定义', judgeModel: 'deepseek-v4-flash' } });
    await service.ImportDataset(project.id, dataset, project.rubric, project.revision);
    const run = await Terminal(service, (await service.StartRun(project.id)).id);
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ provider: 'DeepSeek', model: 'deepseek-v4-flash' }));
    expect(judge).toHaveBeenCalledWith(expect.objectContaining({ judgeProvider: '自定义', judgeModel: 'deepseek-v4-flash' }));
    expect((run.snapshot.config as any).executionProvider).toBe('DeepSeek');
    expect((run.snapshot.config as any).judgeProvider).toBe('自定义');
    expect(run.snapshot.models).toMatchObject({ execution: { provider: 'DeepSeek', baseUrl: 'https://api.deepseek.com' }, judge: { provider: '自定义', baseUrl: 'https://fixture.invalid/v1' } });
    expect(JSON.stringify(run)).not.toContain('synthetic-');
  });

  it.each(['credentials', 'execution-model', 'judge-model'])('%s 不可用时启动前拒绝，无 Run 或模型请求', async failure => {
    const source = await EvaluationTestCredentials().Load();
    if (failure === 'credentials') source.providerConfigs.DeepSeek.apiKey = '';
    const { service, execute, judge } = await Fixture({ Load: async () => structuredClone(source) });
    const project = await service.CreateProject({ name: '不可用', runnerType: 'prompt', rubric: '依据事实', config: { ...config, ...(failure === 'execution-model' ? { executionModel: 'retired-model' } : {}), ...(failure === 'judge-model' ? { judgeModel: 'retired-judge' } : {}) } });
    await service.ImportDataset(project.id, dataset, project.rubric, project.revision);
    await expect(service.StartRun(project.id)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(await service.ListRuns(project.id)).toEqual([]);
    expect(execute).not.toHaveBeenCalled(); expect(judge).not.toHaveBeenCalled();
  });

  it('排队时冻结凭据和配置，后续切换全局设置不会改写正在排队的执行或 Judge', async () => {
    const source = await EvaluationTestCredentials().Load();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const received: string[] = [];
    const execute = vi.fn(async (input: any) => {
      if (!received.length) await gate;
      received.push((await input.credentialPort.Load()).providerConfigs.DeepSeek.apiKey);
      return result;
    });
    const { root, service, judge } = await Fixture({ Load: async () => structuredClone(source) }, execute);
    const project = await service.CreateProject({ name: '冻结', runnerType: 'prompt', rubric: '依据事实', config });
    await service.ImportDataset(project.id, dataset, project.rubric, project.revision);
    const first = await service.StartRun(project.id);
    const second = await service.StartRun(project.id);
    source.provider = 'MIMO'; source.model = 'mimo-v2.6-flash'; source.providerConfigs.DeepSeek.apiKey = 'changed-after-queue';
    release();
    await Terminal(service, first.id);
    const completed = await Terminal(service, second.id);
    expect(received).toEqual(['synthetic-DeepSeek-credential', 'synthetic-DeepSeek-credential']);
    const passedCredentials = await judge.mock.calls[1][0].credentialPort.Load();
    expect(passedCredentials.providerConfigs.DeepSeek.apiKey).toBe('synthetic-DeepSeek-credential');
    expect((completed.snapshot.config as any).executionProvider).toBe('DeepSeek');
    expect((completed.snapshot.config as any).judgeModel).toBe('deepseek-v4-pro');
    expect(await readFile(join(root, 'evaluation-data', 'runs', second.id, 'snapshot.json'), 'utf8')).not.toContain('synthetic-');
    expect(await readFile(join(root, 'evaluation-data', 'runs', second.id, 'cases', completed.caseRuns[0].id, 'score.json'), 'utf8')).not.toContain('synthetic-');
  });
});
