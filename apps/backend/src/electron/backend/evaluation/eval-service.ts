import { createHash, randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type {
  EvalCaseRun, EvalDatasetCase, EvalEvent, EvalProject, EvalProjectInput, EvalPromptCandidate,
  EvalRun, EvalRunDetail, EvalRunSummary,
} from '@offerget/contracts';
import { ApplicationScenario, BuildDefaultPromptFragments, CompilePrompt, CreateDefaultModules, DefaultScenario } from '@offerget/agent-modules-defaults';
import { EvalArtifactStore } from './eval-artifact-store';
import { PromptEvalRunner } from './prompt-eval-runner';
import { EvalScorer } from './eval-scorer';
import { BrowserEvalRunner } from './browser-eval-runner';

const Id = z.string().min(1).max(200).regex(/^[A-Za-z0-9._-]+$/);
const CandidateSchema = z.object({
  id: Id,
  name: z.string().trim().min(1).max(200),
  promptOverrides: z.record(z.string().min(1).max(200), z.string().max(100000)),
}).strict();
const ConfigSchema = z.object({
  executionProvider: z.literal('DeepSeek'),
  executionModel: z.string().trim().min(1).max(200),
  judgeProvider: z.literal('DeepSeek'),
  judgeModel: z.string().trim().min(1).max(200),
  candidates: z.array(CandidateSchema).min(1).max(20),
  toolNames: z.array(z.string().min(1).max(100)).max(50),
  userSimulator: z.enum(['approve_valid', 'reject_submit_once', 'scripted']),
  maxModelTurns: z.number().int().min(1).max(100),
  repeatCount: z.number().int().min(1).max(10),
  fixtureBranch: z.enum(['clean', 'realistic-dom']).optional(),
}).strict();
const ProjectInputSchema = z.object({
  id: Id.optional(),
  name: z.string().trim().min(1).max(200),
  runnerType: z.enum(['prompt', 'browser']),
  config: ConfigSchema,
  rubric: z.string().max(100000).optional(),
}).strict();
const DatasetCaseSchema = z.object({
  id: Id,
  category: z.string().max(100).default('general'),
  input: z.object({ userMessage: z.string().min(1).max(200000) }).strict(),
  fixtures: z.object({
    resume: z.record(z.string(), z.unknown()).optional(),
    profile: z.array(z.unknown()).max(500).optional(),
    files: z.array(z.object({ name: z.string().min(1).max(200), content: z.string().max(500000) }).strict()).max(20).optional(),
  }).strict().default({}),
  expected: z.object({
    requiredFacts: z.array(z.string().max(10000)).max(100).default([]),
    requiredBehaviors: z.array(z.string().max(10000)).max(100).default([]),
    forbiddenClaims: z.array(z.string().max(10000)).max(100).default([]),
    forbiddenBehaviors: z.array(z.string().max(10000)).max(100).default([]),
    referenceAnswer: z.string().max(200000).default(''),
    expectedState: z.record(z.string(), z.unknown()).optional(),
    forbiddenActions: z.array(z.string().max(200)).max(100).optional(),
  }).strict(),
  tags: z.array(z.string().max(100)).max(100).default([]),
  browser: z.object({
    fixtureVersion: z.string().max(100).optional(), seed: z.number().int().optional(),
    difficulty: z.enum(['basic', 'intermediate', 'advanced']).optional(),
    initialState: z.record(z.string(), z.unknown()).optional(),
    expectedTargets: z.array(z.string().max(200)).max(100).optional(),
    forbiddenTargets: z.array(z.string().max(200)).max(100).optional(),
    scriptedResponses: z.array(z.object({ kind: z.enum(['confirmation', 'input']), accepted: z.boolean().optional(), content: z.string().max(10000).optional() }).strict()).max(100).optional(),
  }).strict().optional(),
}).strict();

/** 按行严格解析 JSONL；任一坏行中止整个导入，避免不完整数据集进入历史基线。 */
export function ParseEvalDataset(jsonl: string): EvalDatasetCase[] {
  if (typeof jsonl !== 'string' || Buffer.byteLength(jsonl, 'utf8') > 8 * 1024 * 1024) {
    throw Object.assign(new Error('Evaluation dataset must be UTF-8 text no larger than 8 MiB.'), { code: 'VALIDATION_ERROR' });
  }
  const cases: EvalDatasetCase[] = [];
  const ids = new Set<string>();
  for (const [index, rawLine] of jsonl.split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (!line) continue;
    let parsed: unknown;
    try { parsed = JSON.parse(line); } catch {
      throw Object.assign(new Error(`Evaluation dataset line ${index + 1} is not valid JSON.`), { code: 'VALIDATION_ERROR', details: { line: index + 1 } });
    }
    const result = DatasetCaseSchema.safeParse(parsed);
    if (!result.success) {
      throw Object.assign(new Error(`Evaluation dataset line ${index + 1} does not match the case schema.`), { code: 'VALIDATION_ERROR', details: { line: index + 1, issues: result.error.issues } });
    }
    if (ids.has(result.data.id)) throw Object.assign(new Error(`Evaluation dataset line ${index + 1} repeats case id ${result.data.id}.`), { code: 'VALIDATION_ERROR', details: { line: index + 1 } });
    ids.add(result.data.id);
    cases.push(result.data as EvalDatasetCase);
  }
  if (cases.length === 0) throw Object.assign(new Error('Evaluation dataset contains no cases.'), { code: 'VALIDATION_ERROR' });
  if (cases.length > 1000) throw Object.assign(new Error('Evaluation dataset contains more than 1000 cases.'), { code: 'VALIDATION_ERROR' });
  return cases;
}

function ValidateProjectConfig(config: z.infer<typeof ConfigSchema>): void {
  const candidateIds = config.candidates.map((candidate) => candidate.id);
  if (new Set(candidateIds).size !== candidateIds.length) throw Object.assign(new Error('Evaluation candidate ids must be unique.'), { code: 'VALIDATION_ERROR' });
  if (new Set(config.toolNames).size !== config.toolNames.length) throw Object.assign(new Error('Evaluation tool names must be unique.'), { code: 'VALIDATION_ERROR' });
  const fragmentIds = new Set(BuildDefaultPromptFragments().map((fragment) => fragment.id));
  const unknownOverrides = config.candidates.flatMap((candidate) => Object.keys(candidate.promptOverrides).filter((id) => !fragmentIds.has(id)).map((id) => `${candidate.id}:${id}`));
  if (unknownOverrides.length) throw Object.assign(new Error(`Evaluation prompt overrides contain unknown fragment ids: ${unknownOverrides.join(', ')}.`), { code: 'VALIDATION_ERROR' });
}

interface EvalServiceOptions {
  userDataPath: string;
  store: any;
  credentialPort: any;
  getStoredSettings: () => Promise<Record<string, unknown>>;
  Emit(event: EvalEvent): void;
  promptRunner?: PromptEvalRunner;
  scorer?: EvalScorer;
  browserRunner?: BrowserEvalRunner;
  agentBrowserExecutablePath?: string;
  browserCompanionExecutablePath?: string;
  browserCompanionAppPath?: string;
}

/** 设置采用整体替换语义；运行中省略 developerMode 与显式 false 同样会关闭门禁。 */
export function AssertEvaluationDeveloperModePreserved(nextSettings: unknown, hasActiveRuns: boolean): void {
  if (hasActiveRuns && (!nextSettings || typeof nextSettings !== 'object' || (nextSettings as any).developerMode !== true)) {
    throw Object.assign(new Error('Cannot disable developer mode while an evaluation run is active.'), { code: 'RESOURCE_LOCKED' });
  }
}

/** 测评应用服务：开发者门禁、快照、单队列执行、持久化和事件均在 Backend 内完成。 */
export class EvalService {
  private store: any;
  private getStoredSettings: () => Promise<Record<string, unknown>>;
  private Emit: (event: EvalEvent) => void;
  private artifacts: EvalArtifactStore;
  private promptRunner: PromptEvalRunner;
  private scorer: EvalScorer;
  private browserRunner: BrowserEvalRunner;
  private queue: string[] = [];
  private activeRunId: string | null = null;
  private controllers = new Map<string, AbortController>();
  private committingRuns = new Set<string>();
  private userDataPath: string;
  private artifactEventTail: Promise<void> = Promise.resolve();

  constructor(options: EvalServiceOptions) {
    this.userDataPath = options.userDataPath;
    this.store = options.store;
    this.getStoredSettings = options.getStoredSettings;
    this.Emit = options.Emit;
    this.artifacts = new EvalArtifactStore(options.userDataPath);
    this.promptRunner = options.promptRunner ?? new PromptEvalRunner({ credentialPort: options.credentialPort });
    this.scorer = options.scorer ?? new EvalScorer({ credentialPort: options.credentialPort });
    this.browserRunner = options.browserRunner ?? new BrowserEvalRunner({
      credentialPort: options.credentialPort,
      executablePath: options.agentBrowserExecutablePath ?? join(options.userDataPath, 'agent-browser', 'runtime-unavailable'),
      companionExecutablePath: options.browserCompanionExecutablePath ?? join(options.userDataPath, 'agent-browser', 'companion-unavailable'),
      companionAppPath: options.browserCompanionAppPath,
    });
  }

  async Initialize(): Promise<void> {
    await Promise.all([this.artifacts.Initialize(), this.store.RecoverInterruptedEvalRuns()]);
  }

  private async RequireDeveloperMode(): Promise<void> {
    const settings = await this.getStoredSettings();
    if (settings?.developerMode !== true) throw Object.assign(new Error('Agent evaluation requires developer mode.'), { code: 'PERMISSION_DENIED' });
  }

  private PublicProject(record: any): EvalProject {
    const { datasetJsonl: _datasetJsonl, ...project } = record;
    return project as EvalProject;
  }

  async CreateProject(input: EvalProjectInput): Promise<EvalProject> {
    await this.RequireDeveloperMode();
    const parsed = ProjectInputSchema.parse(input);
    ValidateProjectConfig(parsed.config);
    const now = Date.now();
    return this.PublicProject(await this.store.CreateEvalProjectRecord({ ...parsed, id: parsed.id ?? `eval-${randomUUID()}`, createdAt: now, updatedAt: now }));
  }

  async UpdateProject(id: string, input: EvalProjectInput, expectedRevision: number): Promise<EvalProject> {
    await this.RequireDeveloperMode();
    Id.parse(id);
    const parsed = ProjectInputSchema.parse(input);
    ValidateProjectConfig(parsed.config);
    return this.PublicProject(await this.store.UpdateEvalProjectRecord(id, { ...parsed, updatedAt: Date.now() }, expectedRevision));
  }

  async ReadProject(id: string): Promise<EvalProject> { await this.RequireDeveloperMode(); return this.PublicProject(await this.store.ReadEvalProjectRecord(Id.parse(id))); }
  async ListProjects(): Promise<EvalProject[]> { await this.RequireDeveloperMode(); return (await this.store.ListEvalProjectRecords()).map((record: any) => this.PublicProject(record)); }
  async DeleteProject(id: string): Promise<{ deleted: boolean }> {
    await this.RequireDeveloperMode();
    const projectId = Id.parse(id);
    const result = await this.store.DeleteEvalProjectRecord(projectId);
    if (result.deleted) await this.artifacts.DeleteProjectDatasets(projectId);
    return result;
  }

  async ImportDataset(projectId: string, jsonl: string, rubric: string, expectedRevision: number): Promise<any> {
    await this.RequireDeveloperMode();
    Id.parse(projectId);
    if (typeof rubric !== 'string' || rubric.length > 100000) throw Object.assign(new Error('Evaluation rubric is invalid.'), { code: 'VALIDATION_ERROR' });
    const cases = ParseEvalDataset(jsonl);
    const normalized = cases.map((testCase) => JSON.stringify(testCase)).join('\n');
    const datasetVersion = createHash('sha256').update(normalized).digest('hex');
    const datasetKey = await this.artifacts.WriteDataset(projectId, datasetVersion, normalized);
    const project = await this.store.ImportEvalDatasetRecord(projectId, datasetKey, rubric, datasetVersion, cases.length, expectedRevision, Date.now());
    return { projectId, datasetVersion, caseCount: cases.length, revision: project.revision };
  }

  async ValidateProject(id: string): Promise<{ valid: boolean; errors: string[] }> {
    await this.RequireDeveloperMode();
    const record = await this.store.ReadEvalProjectRecord(Id.parse(id));
    const errors: string[] = [];
    if (!record.datasetVersion || !record.datasetJsonl) errors.push('请先导入至少一个测试案例。');
    if (!record.rubric.trim()) errors.push('请填写评分 Rubric。');
    if (!record.config.candidates.length) errors.push('至少需要一个 Prompt 候选。');
    const supportedTools = record.runnerType === 'browser' ? ApplicationScenario.toolNames : DefaultScenario.toolNames;
    if (!record.config.toolNames.every((name: string) => supportedTools.includes(name))) errors.push('测评包含当前场景不支持的工具。');
    if (record.runnerType === 'browser' && !record.config.toolNames.some((name: string) => name.startsWith('Browser'))) errors.push('浏览器测评至少需要一个 Browser 工具。');
    if (record.runnerType === 'browser' && !record.config.fixtureBranch) errors.push('浏览器测评必须选择 Fixture 分支。');
    return { valid: errors.length === 0, errors };
  }

  private BuildSnapshot(project: any, cases: EvalDatasetCase[]): Record<string, unknown> {
    const scenarioId = project.runnerType === 'browser' ? 'application' : 'default';
    const definitions = CreateDefaultModules({
      getConfig: async () => null, saveConfig: async () => undefined, getStoredSettings: async () => ({}),
      file: {} as any, resumeRead: {} as any, resumeWrite: {} as any, observabilityStore: null,
    }).tools.GetToolDefinitions(scenarioId)
      .filter((tool) => project.config.toolNames.includes(tool.definition.function.name))
      .map((tool) => tool.definition);
    const toolsetHash = createHash('sha256').update(JSON.stringify(definitions)).digest('hex');
    const candidates = project.config.candidates.map((candidate: EvalPromptCandidate) => {
      const fragments = BuildDefaultPromptFragments().map((fragment) => candidate.promptOverrides[fragment.id] === undefined
        ? fragment
        : { ...fragment, version: `${fragment.version}-eval`, content: candidate.promptOverrides[fragment.id], contentHash: '' });
      const compiled = CompilePrompt(fragments, scenarioId, toolsetHash, 'eval-1');
      return { ...candidate, compiledPrompt: compiled };
    });
    return {
      schemaVersion: 1, createdAt: Date.now(), projectId: project.id, projectRevision: project.revision,
      runnerType: project.runnerType, config: { ...project.config, candidates }, rubric: project.rubric,
      datasetVersion: project.datasetVersion, cases, toolDefinitions: definitions, toolsetHash,
      versions: { snapshot: 1, promptRunner: 1, browserRunner: 1, scorer: 1, application: '0.1.0' },
      environment: { repeatCount: project.config.repeatCount, maxConcurrency: 1 },
    };
  }

  async PreviewProject(id: string): Promise<any> {
    await this.RequireDeveloperMode();
    const project = await this.store.ReadEvalProjectRecord(Id.parse(id));
    const snapshot = this.BuildSnapshot(project, []) as any;
    return {
      schemaVersion: 1,
      projectId: project.id,
      projectRevision: project.revision,
      generatedAt: Date.now(),
      toolsetHash: snapshot.toolsetHash,
      candidates: snapshot.config.candidates.map((candidate: any) => ({
        id: candidate.id,
        name: candidate.name,
        compiledHash: candidate.compiledPrompt.manifest.compiledHash,
        compiledPrompt: candidate.compiledPrompt.compiled,
        overriddenFragmentIds: Object.keys(candidate.promptOverrides),
      })),
    };
  }

  async StartRun(projectId: string): Promise<EvalRun> {
    await this.RequireDeveloperMode();
    const validation = await this.ValidateProject(projectId);
    if (!validation.valid) throw Object.assign(new Error(validation.errors.join('；')), { code: 'VALIDATION_ERROR', details: { errors: validation.errors } });
    const project = await this.store.ReadEvalProjectRecord(projectId);
    const cases = ParseEvalDataset(await this.artifacts.ReadDataset(project.id, project.datasetVersion));
    const snapshot = this.BuildSnapshot(project, cases);
    const snapshotHash = createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
    const id = `run-${randomUUID()}`;
    const record = await this.store.CreateEvalRunRecord({ id, projectId, projectName: project.name, runnerType: project.runnerType, status: 'queued', snapshotHash, snapshot, createdAt: Date.now() });
    await this.artifacts.WriteJson(id, 'snapshot.json', snapshot);
    this.queue.push(id);
    this.EmitEvent({ type: 'run_status', runId: id, message: '测评已进入队列' });
    void this.ProcessQueue();
    return this.PublicRun(record);
  }

  private PublicRun(record: any): EvalRun {
    const { snapshot: _snapshot, ...run } = record;
    return run as EvalRun;
  }

  private EmitEvent(event: Omit<EvalEvent, 'createdAt'>): void {
    const complete = { ...event, createdAt: Date.now() } as EvalEvent;
    this.Emit(complete);
    // 同一追加链保证事件文件顺序稳定；失败不阻断后续事件，但 Close 会等待已排入的写入。
    this.artifactEventTail = this.artifactEventTail.then(() => this.artifacts.AppendEvent(event.runId, complete)).catch(() => undefined);
  }

  /** Provider/Runner 可能忽略 AbortSignal 并迟到返回；所有结果提交点都必须再次检查。 */
  private ThrowIfCancelled(signal: AbortSignal): void {
    if (signal.aborted) {
      throw Object.assign(new Error('Evaluation run was cancelled.'), { code: 'CANCELLED' });
    }
  }

  private async ProcessQueue(): Promise<void> {
    if (this.activeRunId) return;
    const runId = this.queue.shift();
    if (!runId) return;
    this.activeRunId = runId;
    try { await this.ExecuteRun(runId); } finally { this.activeRunId = null; void this.ProcessQueue(); }
  }

  private async ExecuteRun(runId: string): Promise<void> {
    const controller = new AbortController();
    this.controllers.set(runId, controller);
    const run = await this.store.UpdateEvalRunRecord(runId, { status: 'preparing', startedAt: Date.now(), error: null });
    this.EmitEvent({ type: 'run_status', runId, message: '正在准备不可变快照' });
    try {
      await this.store.UpdateEvalRunRecord(runId, { status: 'running' });
      this.EmitEvent({ type: 'run_status', runId, message: run.runnerType === 'browser' ? '浏览器测评开始执行' : 'Prompt 测评开始执行' });
      const snapshot = run.snapshot as any;
      const projectConfig = snapshot.config;
      const cases = snapshot.cases as EvalDatasetCase[];
      const caseRuns: EvalCaseRun[] = [];
      const plannedCaseIds = new Map<string, string>();
      for (const testCase of cases) {
        for (const candidate of projectConfig.candidates as Array<EvalPromptCandidate & { compiledPrompt: unknown }>) {
          for (let repeatIndex = 0; repeatIndex < projectConfig.repeatCount; repeatIndex += 1) {
            this.ThrowIfCancelled(controller.signal);
            const caseRunId = `case-${randomUUID()}`;
            plannedCaseIds.set(`${testCase.id}\u0000${candidate.id}\u0000${repeatIndex}`, caseRunId);
            await this.store.UpsertEvalCaseRunRecord({
              id: caseRunId, runId, candidateId: candidate.id, candidateName: candidate.name, caseId: testCase.id,
              repeatIndex, status: 'queued', createdAt: Date.now(), metrics: {},
            });
          }
        }
      }
      for (const testCase of cases) {
        for (const candidate of projectConfig.candidates as Array<EvalPromptCandidate & { compiledPrompt: unknown }>) {
          for (let repeatIndex = 0; repeatIndex < projectConfig.repeatCount; repeatIndex += 1) {
            this.ThrowIfCancelled(controller.signal);
            const caseRunId = plannedCaseIds.get(`${testCase.id}\u0000${candidate.id}\u0000${repeatIndex}`)!;
            const createdAt = (await this.store.ReadEvalCaseRunRecord(caseRunId)).createdAt;
            await this.store.UpsertEvalCaseRunRecord({ id: caseRunId, runId, candidateId: candidate.id, candidateName: candidate.name, caseId: testCase.id, repeatIndex, status: 'running', createdAt, metrics: {} });
            this.EmitEvent({ type: 'case_status', runId, caseRunId, message: `${candidate.name} · ${testCase.id} 正在执行` });
            try {
              const caseRoot = join(this.userDataPath, 'evaluation-data', 'runtime', runId, caseRunId);
              await mkdir(caseRoot, { recursive: true });
              const startedAt = Date.now();
              const commonInput = {
                runId, caseRunId, candidate, testCase, model: projectConfig.executionModel,
                toolNames: projectConfig.toolNames, maxModelTurns: projectConfig.maxModelTurns,
                userSimulator: projectConfig.userSimulator, caseRoot, signal: controller.signal,
              };
              const result = run.runnerType === 'browser'
                ? await this.browserRunner.Execute({ ...commonInput, fixtureBranch: projectConfig.fixtureBranch })
                : await this.promptRunner.Execute(commonInput);
              this.ThrowIfCancelled(controller.signal);
              await this.store.UpsertEvalCaseRunRecord({
                id: caseRunId, runId, candidateId: candidate.id, candidateName: candidate.name, caseId: testCase.id, repeatIndex,
                status: 'scoring', finalResponse: result.finalResponse, metrics: result.metrics, createdAt,
              });
              this.EmitEvent({ type: 'case_status', runId, caseRunId, message: `${candidate.name} · ${testCase.id} 正在评分` });
              for (const event of result.events) await this.artifacts.AppendCaseEvent(runId, caseRunId, 'messages.jsonl', event);
              const scoreResult = await this.scorer.Score({
                testCase, finalResponse: result.finalResponse, events: result.events, finalState: result.finalState, metrics: result.metrics,
                rubric: snapshot.rubric, judgeModel: projectConfig.judgeModel, signal: controller.signal,
              });
              this.ThrowIfCancelled(controller.signal);
              const judgeUsage = scoreResult.usage;
              const metrics = {
                ...result.metrics,
                taskCompleted: typeof result.metrics.taskCompleted === 'boolean'
                  ? result.metrics.taskCompleted
                  : Boolean(result.finalResponse) && scoreResult.score.deterministicScore >= 45 && scoreResult.score.hardFailures.length === 0,
                promptTokens: Number(result.metrics.promptTokens ?? 0) + Number(judgeUsage?.promptTokens ?? 0),
                completionTokens: Number(result.metrics.completionTokens ?? 0) + Number(judgeUsage?.completionTokens ?? 0),
                totalTokens: Number(result.metrics.totalTokens ?? 0) + Number(judgeUsage?.totalTokens ?? 0),
                durationMs: Date.now() - startedAt,
              };
              const record = await this.store.UpsertEvalCaseRunRecord({
                id: caseRunId, runId, candidateId: candidate.id, candidateName: candidate.name, caseId: testCase.id, repeatIndex,
                status: 'completed', finalResponse: result.finalResponse, score: scoreResult.score, metrics,
                createdAt, completedAt: Date.now(),
              });
              caseRuns.push(record);
              await this.artifacts.WriteCaseJson(runId, caseRunId, 'result.json', { ...record, finalState: result.finalState });
              await this.artifacts.WriteCaseJson(runId, caseRunId, 'score.json', scoreResult);
              this.EmitEvent({ type: 'score', runId, caseRunId, message: `${candidate.name} · ${testCase.id} 得分 ${scoreResult.score.totalScore}`, data: { totalScore: scoreResult.score.totalScore } });
            } catch (error) {
              const code = controller.signal.aborted ? 'CANCELLED' : String((error as any)?.code ?? 'EVAL_CASE_FAILED');
              const status = controller.signal.aborted ? 'cancelled' : 'failed';
              const record = await this.store.UpsertEvalCaseRunRecord({
                id: caseRunId, runId, candidateId: candidate.id, candidateName: candidate.name, caseId: testCase.id, repeatIndex,
                status, finalResponse: '', metrics: {}, error: { code, message: error instanceof Error ? error.message : 'Evaluation case failed.' },
                createdAt, completedAt: Date.now(),
              });
              caseRuns.push(record);
              if (controller.signal.aborted) throw error;
            }
          }
        }
      }
      this.ThrowIfCancelled(controller.signal);
      await this.store.UpdateEvalRunRecord(runId, { status: 'scoring' });
      this.EmitEvent({ type: 'run_status', runId, message: '正在汇总 Prompt 测评结果' });
      const summary = this.Summarize(caseRuns, run.startedAt ?? Date.now());
      await this.artifacts.WriteJson(runId, 'summary.json', summary);
      this.ThrowIfCancelled(controller.signal);
      this.committingRuns.add(runId);
      await this.store.UpdateEvalRunRecord(runId, { status: 'completed', summary, completedAt: Date.now() });
      this.EmitEvent({ type: 'run_status', runId, message: '测评完成' });
    } catch (error) {
      const cancelled = controller.signal.aborted || (error as any)?.code === 'CANCELLED';
      const existingCaseRuns = await this.store.ListEvalCaseRunRecords(runId);
      for (const caseRun of existingCaseRuns.filter((item: EvalCaseRun) => item.status === 'queued')) {
        await this.store.UpsertEvalCaseRunRecord({ ...caseRun, status: 'not_run', completedAt: Date.now() });
      }
      const terminalCaseRuns = await this.store.ListEvalCaseRunRecords(runId);
      await this.store.UpdateEvalRunRecord(runId, {
        status: cancelled ? 'cancelled' : 'failed',
        summary: this.Summarize(terminalCaseRuns, run.startedAt ?? Date.now()),
        error: { code: cancelled ? 'CANCELLED' : String((error as any)?.code ?? 'EVAL_RUN_FAILED'), message: error instanceof Error ? error.message : 'Evaluation run failed.' },
        completedAt: Date.now(),
      });
      this.EmitEvent({ type: cancelled ? 'run_status' : 'error', runId, message: cancelled ? '测评已取消' : (error instanceof Error ? error.message : '测评失败') });
    } finally {
      this.committingRuns.delete(runId);
      this.controllers.delete(runId);
    }
  }

  private Summarize(caseRuns: EvalCaseRun[], startedAt: number): EvalRunSummary {
    const completed = caseRuns.filter((item) => item.status === 'completed');
    const scores = completed.map((item) => item.score?.totalScore).filter((value): value is number => typeof value === 'number');
    const attempted = caseRuns.filter((item) => item.status === 'completed' || item.status === 'failed');
    const numberMetric = (key: string) => caseRuns.reduce((sum, item) => sum + (typeof item.metrics[key] === 'number' ? item.metrics[key] as number : 0), 0);
    const promptTokens = numberMetric('promptTokens'); const completionTokens = numberMetric('completionTokens');
    return {
      totalCaseRuns: caseRuns.length, completedCaseRuns: completed.length,
      failedCaseRuns: caseRuns.filter((item) => item.status === 'failed').length,
      cancelledCaseRuns: caseRuns.filter((item) => item.status === 'cancelled').length,
      averageScore: scores.length ? scores.reduce((sum, value) => sum + value, 0) / scores.length : null,
      taskCompletionRate: attempted.length ? attempted.filter((item) => item.metrics.taskCompleted === true).length / attempted.length : null,
      toolErrorCount: numberMetric('toolErrors'), modelTurns: numberMetric('modelTurns'), durationMs: Date.now() - startedAt,
      usage: { source: promptTokens + completionTokens > 0 ? 'provider' : 'unavailable', promptTokens, completionTokens, totalTokens: promptTokens + completionTokens },
    };
  }

  async CancelRun(runId: string): Promise<{ cancelled: boolean }> {
    await this.RequireDeveloperMode();
    Id.parse(runId);
    if (this.committingRuns.has(runId)) return { cancelled: false };
    const controller = this.controllers.get(runId);
    if (controller) { controller.abort(Object.assign(new Error('Evaluation cancelled by developer.'), { code: 'CANCELLED' })); return { cancelled: true }; }
    const queuedIndex = this.queue.indexOf(runId);
    if (queuedIndex >= 0) {
      this.queue.splice(queuedIndex, 1);
      await this.store.UpdateEvalRunRecord(runId, { status: 'cancelled', error: { code: 'CANCELLED', message: 'Evaluation cancelled before execution.' }, completedAt: Date.now() });
      this.EmitEvent({ type: 'run_status', runId, message: '排队中的测评已取消' });
      return { cancelled: true };
    }
    return { cancelled: false };
  }

  async ReadRun(runId: string): Promise<EvalRunDetail> {
    await this.RequireDeveloperMode();
    const run = await this.store.ReadEvalRunRecord(Id.parse(runId));
    return { ...run, caseRuns: await this.store.ListEvalCaseRunRecords(runId) } as EvalRunDetail;
  }
  async ListRuns(projectId?: string): Promise<EvalRun[]> { await this.RequireDeveloperMode(); return (await this.store.ListEvalRunRecords(projectId ? Id.parse(projectId) : undefined)).map((record: any) => this.PublicRun(record)); }
  async ReadCaseResult(caseRunId: string): Promise<EvalCaseRun> { await this.RequireDeveloperMode(); return this.store.ReadEvalCaseRunRecord(Id.parse(caseRunId)); }

  async CompareRuns(leftRunId: string, rightRunId: string): Promise<any> {
    await this.RequireDeveloperMode();
    const [left, right] = await Promise.all([this.ReadRun(leftRunId), this.ReadRun(rightRunId)]);
    const fields = ['runnerType', 'datasetVersion', 'toolsetHash', 'versions', 'config.executionModel', 'config.judgeModel', 'config.toolNames', 'config.fixtureBranch'];
    const read = (value: any, path: string) => path.split('.').reduce((current, key) => current?.[key], value);
    const differingSnapshotFields = fields.filter((field) => JSON.stringify(read(left.snapshot, field)) !== JSON.stringify(read(right.snapshot, field)));
    return { left, right, strictComparison: differingSnapshotFields.length === 0, differingSnapshotFields };
  }

  HasActiveRuns(): boolean { return Boolean(this.activeRunId || this.queue.length); }

  /** 应用退出时先中止活动执行并为排队 Run 写入稳定 cancelled 终态。 */
  async Close(): Promise<void> {
    for (const controller of this.controllers.values()) controller.abort(Object.assign(new Error('Application is shutting down.'), { code: 'CANCELLED' }));
    const queued = this.queue.splice(0);
    await Promise.all(queued.map((runId) => this.store.UpdateEvalRunRecord(runId, {
      status: 'cancelled', error: { code: 'CANCELLED', message: 'Evaluation cancelled because the application stopped.' }, completedAt: Date.now(),
    }).catch(() => undefined)));
    const deadline = Date.now() + 5000;
    while (this.activeRunId && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
    await this.artifactEventTail;
  }
}
