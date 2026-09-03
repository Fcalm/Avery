import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ObservabilityStore } from '../../../apps/backend/src/observability-store';
import { AssertEvaluationDeveloperModePreserved, EvalService, FindEvalSnapshotDifferences, ParseEvalDataset } from '../../../apps/backend/src/electron/backend/evaluation/eval-service';
import { EvalArtifactStore } from '../../../apps/backend/src/electron/backend/evaluation/eval-artifact-store';
import { CountEvalModelTurns } from '../../../apps/backend/src/electron/backend/evaluation/eval-runner-metrics';
import { BuildBrowserEvalPromptFragments } from '../../../apps/backend/src/electron/backend/evaluation/browser-eval-runner';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

const projectInput = {
  name: 'Prompt 回归', runnerType: 'prompt' as const, rubric: '按任务完成度评分。',
  config: {
    executionProvider: 'DeepSeek' as const, executionModel: 'deepseek-v4-flash',
    judgeProvider: 'DeepSeek' as const, judgeModel: 'deepseek-v4-pro',
    candidates: [{ id: 'a', name: 'A', promptOverrides: {} }, { id: 'b', name: 'B', promptOverrides: { 'output/style': 'Answer briefly.' } }],
    toolNames: ['ReadResume'], userSimulator: 'approve_valid' as const, maxModelTurns: 30, repeatCount: 1,
  },
};
const dataset = JSON.stringify({
  id: 'case-1', category: 'resume', input: { userMessage: '读取简历' }, fixtures: { resume: { id: 'eval-resume', content: 'React' } },
  expected: { requiredFacts: ['React'], requiredBehaviors: [], forbiddenClaims: [], forbiddenBehaviors: [], referenceAnswer: '' }, tags: [],
});
const scorer = {
  Score: vi.fn(async () => ({
    score: { deterministicScore: 60, judgeScore: 80, totalScore: 92, dimensions: { quality: 80 }, hardFailures: [], reason: 'ok', confidence: 0.9 },
    details: { deterministic: {}, judgeRaw: ['{}'] },
  })),
};

async function WaitForTerminal(service: EvalService, runId: string) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const run = await service.ReadRun(runId);
    if (['completed', 'failed', 'cancelled'].includes(run.status)) return run;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for evaluation run.');
}

describe('Agent evaluation service', () => {
  it('Browser Runner 的实际片段使用 application 场景并应用候选覆盖', () => {
    const fragments = BuildBrowserEvalPromptFragments({ id: 'browser-a', name: 'Browser A', promptOverrides: { 'scenario/application': 'APPLICATION OVERRIDE' } });
    expect(fragments.find((fragment) => fragment.id === 'scenario/application')?.content).toBe('APPLICATION OVERRIDE');
    expect(fragments.some((fragment) => fragment.id === 'scenario/default')).toBe(false);
  });
  it('模型轮数以 Kernel loop_turn 为事实源，不依赖不存在的 model_request 事件', () => {
    expect(CountEvalModelTurns([{ type: 'loop_turn' }, { type: 'tool_call' }, { type: 'loop_turn' }])).toBe(2);
  });
  it('活动测评期间设置整体替换不能通过省略 developerMode 绕过门禁', () => {
    expect(() => AssertEvaluationDeveloperModePreserved({}, true)).toThrow(/Cannot disable developer mode/);
    expect(() => AssertEvaluationDeveloperModePreserved({ developerMode: false }, true)).toThrow(/Cannot disable developer mode/);
    expect(() => AssertEvaluationDeveloperModePreserved({ developerMode: true }, true)).not.toThrow();
    expect(() => AssertEvaluationDeveloperModePreserved({}, false)).not.toThrow();
  });
  it('并发数不同的历史 Run 不能标记为严格可比', () => {
    const base = { runnerType: 'prompt', datasetVersion: 'v1', toolsetHash: 'tools', versions: { snapshot: 2 }, config: { executionModel: 'model', judgeModel: 'judge', toolNames: ['ReadResume'], maxModelTurns: 30, userSimulator: 'approve_valid' }, environment: { repeatCount: 1, maxConcurrency: 1 } };
    expect(FindEvalSnapshotDifferences(base, { ...base, environment: { ...base.environment, maxConcurrency: 2 } })).toContain('environment.maxConcurrency');
    expect(FindEvalSnapshotDifferences(base, structuredClone(base))).toEqual([]);
    expect(FindEvalSnapshotDifferences(base, { ...base, config: { ...base.config, executionProvider: 'Z.AI' } })).toContain('config.executionProvider');
  });

  it('切换 Provider 后 Run 快照与 Runner 使用当前唯一可用模型', async () => {
    const root = await mkdtemp(join(tmpdir(), 'avery-eval-provider-switch-')); roots.push(root);
    const store = new ObservabilityStore(root);
    const execute = vi.fn(async () => ({
      finalResponse: 'answer', events: [], finalState: {},
      metrics: { modelTurns: 1, toolCalls: 0, toolErrors: 0, promptTokens: 1, completionTokens: 1, totalTokens: 2, completed: true },
    }));
    const service = new EvalService({
      userDataPath: root, store,
      credentialPort: { Load: vi.fn(async () => ({ provider: 'Z.AI', model: 'glm-5.3-flash' })) },
      getStoredSettings: async () => ({ developerMode: true }), Emit: vi.fn(),
      promptRunner: { Execute: execute } as any, scorer: scorer as any,
    });
    await service.Initialize();
    let project = await service.CreateProject({ ...projectInput, config: { ...projectInput.config, candidates: [projectInput.config.candidates[0]] } });
    await service.ImportDataset(project.id, dataset, project.rubric, project.revision); project = await service.ReadProject(project.id);
    const run = await service.StartRun(project.id); const completed = await WaitForTerminal(service, run.id);
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ model: 'glm-5.3-flash' }));
    expect((completed.snapshot as any).config).toMatchObject({ executionProvider: 'Z.AI', executionModel: 'glm-5.3-flash', judgeProvider: 'Z.AI', judgeModel: 'glm-5.3-flash' });
    await service.Close(); store.Close();
  });
  it('JSONL 任一坏行或重复 ID 会整体拒绝并报告行号', () => {
    expect(() => ParseEvalDataset(`${dataset}\n{bad`)).toThrow(/line 2/);
    expect(() => ParseEvalDataset(`${dataset}\n${dataset}`)).toThrow(/line 2.*repeats case id/);
  });

  it('未知 Prompt Fragment 覆盖和重复工具名不能静默进入项目', async () => {
    const root = await mkdtemp(join(tmpdir(), 'avery-eval-config-')); roots.push(root);
    const store = new ObservabilityStore(root);
    const service = new EvalService({ userDataPath: root, store, credentialPort: {}, getStoredSettings: async () => ({ developerMode: true }), Emit: vi.fn() });
    await service.Initialize();
    await expect(service.CreateProject({ ...projectInput, config: { ...projectInput.config, candidates: [{ id: 'a', name: 'A', promptOverrides: { 'missing/fragment': 'x' } }] } })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(service.CreateProject({ ...projectInput, config: { ...projectInput.config, toolNames: ['ReadResume', 'ReadResume'] } })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await service.Close(); store.Close();
  });

  it('关闭开发者模式时 Backend 服务拒绝读写测评', async () => {
    const root = await mkdtemp(join(tmpdir(), 'avery-eval-gate-')); roots.push(root);
    const store = new ObservabilityStore(root);
    const service = new EvalService({ userDataPath: root, store, credentialPort: {}, getStoredSettings: async () => ({ developerMode: false }), Emit: vi.fn() });
    await service.Initialize();
    await expect(service.ListProjects()).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    await service.Close();
    store.Close();
  });

  it('冻结多候选快照并以最大并发 2 完成默认场景案例矩阵', async () => {
    const root = await mkdtemp(join(tmpdir(), 'avery-eval-run-')); roots.push(root);
    const store = new ObservabilityStore(root);
    let activeExecutions = 0; let peakExecutions = 0;
    const execute = vi.fn(async ({ candidate }: any) => {
      activeExecutions += 1; peakExecutions = Math.max(peakExecutions, activeExecutions);
      await new Promise((resolve) => setTimeout(resolve, 20));
      activeExecutions -= 1;
      return {
        finalResponse: `answer:${candidate.id}`, events: [{ type: 'completed', createdAt: Date.now(), payload: {} }],
        finalState: { profiles: [], resumes: [] }, metrics: { modelTurns: 1, toolCalls: 1, toolErrors: 0, promptTokens: 10, completionTokens: 5, totalTokens: 15, completed: true },
      };
    });
    const service = new EvalService({
      userDataPath: root, store, credentialPort: {}, getStoredSettings: async () => ({ developerMode: true }), Emit: vi.fn(),
      promptRunner: { Execute: execute } as any,
      scorer: scorer as any,
    });
    await service.Initialize();
    let project = await service.CreateProject(projectInput);
    await service.ImportDataset(project.id, dataset, project.rubric, project.revision);
    project = await service.ReadProject(project.id);
    const internalProject = await store.ReadEvalProjectRecord(project.id);
    expect(internalProject.datasetJsonl).toMatch(/^datasets\//);
    expect(internalProject.datasetJsonl).not.toContain('case-1');
    const run = await service.StartRun(project.id);
    const completed = await WaitForTerminal(service, run.id);
    expect(completed.status).toBe('completed');
    expect(completed.caseRuns).toHaveLength(2);
    expect(completed.caseRuns.map((item) => item.finalResponse)).toEqual(['answer:a', 'answer:b']);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(peakExecutions).toBe(2);
    expect(completed.snapshot).toMatchObject({ projectRevision: project.revision, datasetVersion: project.datasetVersion });
    const snapshotText = await readFile(join(root, 'evaluation-data', 'runs', run.id, 'snapshot.json'), 'utf8');
    expect(snapshotText).toContain('compiledPrompt');
    expect(snapshotText).not.toContain(root);
    const frozen = completed.snapshot as any;
    expect(frozen.environment.maxConcurrency).toBe(2);
    expect(frozen.versions.scorer).toBe('prompt-judge-3');
    expect(frozen.toolDefinitions.map((definition: any) => definition.function.name)).toEqual(['ReadResume']);
    expect(frozen.config.candidates[0].compiledPrompt.manifest.toolPolicyHash).toBe(frozen.toolsetHash);
    const preview = await service.PreviewProject(project.id);
    expect(preview.candidates).toHaveLength(2);
    expect(preview.fragments.map((fragment: any) => fragment.id)).toContain('scenario/default');
    expect(preview.candidates[0].compiledPrompt).toContain('Avery');
    const caseDetail = await service.ReadCaseResult(completed.caseRuns[0].id);
    expect(caseDetail.trace.at(-1)).toMatchObject({ kind: 'fixture_state' });
    expect(caseDetail.scoreDetails).toBeTruthy();
    const resultArtifact = JSON.parse(await readFile(join(root, 'evaluation-data', 'runs', run.id, 'cases', completed.caseRuns[0].id, 'result.json'), 'utf8'));
    expect(resultArtifact.promptCompiledHash).toBe(frozen.config.candidates[0].compiledPrompt.manifest.compiledHash);
    await service.UpdateProject(project.id, { ...projectInput, name: '源项目已变化' }, project.revision);
    const historical = await service.ReadRun(run.id);
    expect(historical.snapshot).toEqual(completed.snapshot);
    await service.DeleteProject(project.id);
    await expect(stat(join(root, 'evaluation-data', 'datasets', project.id))).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await service.ReadRun(run.id)).snapshot).toEqual(completed.snapshot);
    await service.Close();
    store.Close();
  });

  it('Runner 中途失败仍保存已形成的 Trace 证据', async () => {
    const root = await mkdtemp(join(tmpdir(), 'avery-eval-partial-trace-')); roots.push(root);
    const store = new ObservabilityStore(root);
    const execute = vi.fn(async () => {
      throw Object.assign(new Error('fixture failed'), { code: 'FIXTURE_FAILED', evalEvidence: { events: [{ type: 'tool_call', createdAt: 1, payload: { name: 'ReadResume' } }], finalState: { partial: true } } });
    });
    const service = new EvalService({
      userDataPath: root, store, credentialPort: {}, getStoredSettings: async () => ({ developerMode: true }), Emit: vi.fn(),
      promptRunner: { Execute: execute } as any, scorer: scorer as any,
    });
    await service.Initialize();
    let project = await service.CreateProject({ ...projectInput, config: { ...projectInput.config, candidates: [projectInput.config.candidates[0]] } });
    await service.ImportDataset(project.id, dataset, project.rubric, project.revision); project = await service.ReadProject(project.id);
    const run = await service.StartRun(project.id); const completed = await WaitForTerminal(service, run.id);
    const caseRun = completed.caseRuns[0];
    expect(caseRun.status).toBe('failed');
    const detail = await service.ReadCaseResult(caseRun.id);
    expect(detail.trace.map((node) => node.kind)).toEqual(['tool_call', 'fixture_state']);
    await service.Close(); store.Close();
  });

  it('取消后忽略 AbortSignal 的迟到 Runner 结果不能写成完成', async () => {
    const root = await mkdtemp(join(tmpdir(), 'avery-eval-cancel-')); roots.push(root);
    const store = new ObservabilityStore(root);
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    const execute = vi.fn(async () => {
      await waiting;
      return {
        finalResponse: 'late completion', events: [], finalState: {},
        metrics: { modelTurns: 1, toolCalls: 0, toolErrors: 0, promptTokens: 1, completionTokens: 1, totalTokens: 2, completed: true },
      };
    });
    const service = new EvalService({
      userDataPath: root, store, credentialPort: {}, getStoredSettings: async () => ({ developerMode: true }), Emit: vi.fn(),
      promptRunner: { Execute: execute } as any,
      scorer: scorer as any,
    });
    await service.Initialize();
    let project = await service.CreateProject({ ...projectInput, config: { ...projectInput.config, candidates: [projectInput.config.candidates[0]] } });
    const secondCase = JSON.stringify({ ...JSON.parse(dataset), id: 'case-2' });
    const thirdCase = JSON.stringify({ ...JSON.parse(dataset), id: 'case-3' });
    await service.ImportDataset(project.id, `${dataset}\n${secondCase}\n${thirdCase}`, project.rubric, project.revision);
    project = await service.ReadProject(project.id);
    const run = await service.StartRun(project.id);
    const deadline = Date.now() + 1000;
    while (execute.mock.calls.length < 2 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
    expect(execute).toHaveBeenCalledTimes(2);
    await expect(service.CancelRun(run.id)).resolves.toEqual({ cancelled: true });
    release();
    const cancelled = await WaitForTerminal(service, run.id);
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.caseRuns).toHaveLength(3);
    expect(cancelled.caseRuns.map((item) => item.status).sort()).toEqual(['cancelled', 'cancelled', 'not_run']);
    expect(cancelled.caseRuns.find((item) => item.status === 'cancelled')).toMatchObject({ status: 'cancelled', finalResponse: '' });
    expect(cancelled.summary).toMatchObject({ totalCaseRuns: 3, cancelledCaseRuns: 2 });
    await service.Close();
    store.Close();
  });

  it('Artifact 事件完整保留长证据，同时脱敏密钥和绝对路径', async () => {
    const root = await mkdtemp(join(tmpdir(), 'avery-eval-artifact-')); roots.push(root);
    const artifacts = new EvalArtifactStore(root);
    const longText = 'x'.repeat(25_000);
    await artifacts.AppendEvent('run-safe', { longText, authorization: 'Bearer sk-secret123', cookie: 'session=private', path: 'C:\\Users\\tester\\secret.txt' });
    const contents = await readFile(join(root, 'evaluation-data', 'runs', 'run-safe', 'events.jsonl'), 'utf8');
    expect(contents).toContain(longText);
    expect(contents).not.toContain('sk-secret123');
    expect(contents).not.toContain('session=private');
    expect(contents).not.toContain('C:\\Users\\tester');
    expect(contents).toContain('[REDACTED_PATH]');
  });

  it('全局只执行一个 Run，第二个保持 queued 且可独立取消', async () => {
    const root = await mkdtemp(join(tmpdir(), 'avery-eval-queue-')); roots.push(root);
    const store = new ObservabilityStore(root);
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    const execute = vi.fn(async () => {
      await waiting;
      return { finalResponse: 'done', events: [], finalState: {}, metrics: { modelTurns: 1, toolCalls: 0, toolErrors: 0, promptTokens: 1, completionTokens: 1, totalTokens: 2, completed: true } };
    });
    const service = new EvalService({
      userDataPath: root, store, credentialPort: {}, getStoredSettings: async () => ({ developerMode: true }), Emit: vi.fn(),
      promptRunner: { Execute: execute } as any, scorer: scorer as any,
    });
    await service.Initialize();
    let project = await service.CreateProject({ ...projectInput, config: { ...projectInput.config, candidates: [projectInput.config.candidates[0]] } });
    await service.ImportDataset(project.id, dataset, project.rubric, project.revision); project = await service.ReadProject(project.id);
    const first = await service.StartRun(project.id); const second = await service.StartRun(project.id);
    const deadline = Date.now() + 1000;
    while (execute.mock.calls.length === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
    expect((await service.ReadRun(first.id)).status).toBe('running');
    expect((await service.ReadRun(second.id)).status).toBe('queued');
    await expect(service.CancelRun(second.id)).resolves.toEqual({ cancelled: true });
    expect((await service.ReadRun(second.id)).status).toBe('cancelled');
    release(); await WaitForTerminal(service, first.id);
    expect(execute).toHaveBeenCalledTimes(1);
    await service.Close();
    const queuedEvents = await readFile(join(root, 'evaluation-data', 'runs', second.id, 'events.jsonl'), 'utf8');
    expect(queuedEvents).toContain('排队中的测评已取消');
    store.Close();
  });

  it('browser 项目分派给 BrowserEvalRunner 并使用 Fixture 状态判分', async () => {
    const root = await mkdtemp(join(tmpdir(), 'avery-eval-browser-dispatch-')); roots.push(root);
    const store = new ObservabilityStore(root);
    const browserExecute = vi.fn(async () => ({
      finalResponse: 'receipt', events: [], finalState: { fixture: { submissionCount: 1 } },
      metrics: { taskCompleted: true, modelTurns: 2, toolCalls: 3, toolErrors: 0, promptTokens: 2, completionTokens: 2, totalTokens: 4 },
    }));
    const service = new EvalService({
      userDataPath: root, store, credentialPort: {}, getStoredSettings: async () => ({ developerMode: true }), Emit: vi.fn(),
      browserRunner: { Execute: browserExecute } as any, scorer: scorer as any,
    });
    await service.Initialize();
    scorer.Score.mockClear();
    const browserInput = {
      ...projectInput, runnerType: 'browser' as const,
      rubric: '',
      config: { executionProvider: 'DeepSeek' as const, executionModel: 'deepseek-v4-flash', candidates: [{ ...projectInput.config.candidates[0], promptOverrides: { 'scenario/application': 'Browser evaluation scenario.' } }], toolNames: ['BrowserNavigate', 'BrowserSnapshot'], fixtureBranch: 'realistic-dom' as const, maxModelTurns: 100, repeatCount: 1, userSimulator: 'approve_valid' as const },
    };
    let project = await service.CreateProject(browserInput);
    const preview = await service.PreviewProject(project.id);
    expect(preview.fragments.map((fragment: any) => fragment.id)).toContain('scenario/application');
    expect(preview.fragments.map((fragment: any) => fragment.id)).not.toContain('scenario/default');
    const browserDataset = JSON.stringify({ ...JSON.parse(dataset), browser: { fixtureVersion: '1', seed: 1, assertions: [{ id: 'submitted', type: 'state_equals', path: 'fixture.submissionCount', expected: 1, weight: 100, required: true }] }, expected: { ...JSON.parse(dataset).expected, expectedState: { submissionCount: 1 } } });
    await service.ImportDataset(project.id, browserDataset, project.rubric, project.revision); project = await service.ReadProject(project.id);
    const run = await service.StartRun(project.id); const completed = await WaitForTerminal(service, run.id);
    expect(completed.status).toBe('completed'); expect(browserExecute).toHaveBeenCalledTimes(1);
    expect((completed.snapshot as any).environment.maxConcurrency).toBe(1);
    expect(completed.summary?.taskCompletionRate).toBe(1);
    expect(scorer.Score).not.toHaveBeenCalled();
    await service.Close();
    store.Close();
  });
});
