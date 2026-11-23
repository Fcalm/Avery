import { createHash, randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { CompiledInstructions } from '@avery/agent-sdk';
import type {
  EvalCaseRun, EvalCaseRunDetail, EvalDatasetCase, EvalDatasetVersion, EvalDatasetImportPreview, EvalEvent, EvalProject, EvalProjectInput, EvalPromptCandidate,
  EvalRun, EvalRunDetail, EvalRunSummary,
} from '@avery/contracts';
import { ApplicationScenario, BuildApplicationPromptFragments, BuildDefaultPromptFragments, CompilePrompt, CreateDefaultModules, DefaultScenario } from '@avery/agent-modules-defaults';
import { EvalArtifactStore } from './eval-artifact-store';
import { PromptEvalRunner } from './prompt-eval-runner';
import { EvalScorer } from './eval-scorer';
import { BrowserEvalRunner } from './browser-eval-runner';
import { BrowserExtensionBridge } from '../browser-extension-bridge';
import { ScoreBrowserCase } from './browser-eval-scorer';
import { NormalizeEvalTrace } from './eval-trace';
import { BuildApplicationBenchmarkDataset, ApplicationBenchmarkVersion } from './career-portal-fixture';
import { DatasetEnvironment, DatasetTemplate, DiagnoseDataset } from './dataset-validation';
import { ResolveEvalDimensions } from './evaluation-rubric';
import { SummarizeEvalCases } from './eval-summary';
import { CompareEvalSamples } from './eval-comparison';
import { EvaluationToolPolicy } from './evaluation-tools';
import { FreezeEvaluationCredentials, ValidateEvaluationModels, type EvaluationCredentials } from './evaluation-models';

const Id = z.string().min(1).max(200).regex(/^[A-Za-z0-9._-]+$/);
const CandidateSchema = z.object({
  id: Id,
  name: z.string().trim().min(1).max(200),
  promptOverrides: z.record(z.string().min(1).max(200), z.string().max(100000)),
}).strict();
const ConfigSchema = z.object({
  executionProvider: z.enum(['DeepSeek', 'Z.AI', 'MIMO', '自定义']),
  executionModel: z.string().trim().min(1).max(200),
  judgeProvider: z.enum(['DeepSeek', 'Z.AI', 'MIMO', '自定义']).optional(),
  judgeModel: z.string().trim().min(1).max(200).optional(),
  candidates: z.array(CandidateSchema).min(1).max(20),
  toolNames: z.array(z.string().min(1).max(100)).max(50).optional(),
  userSimulator: z.enum(['approve_valid', 'reject_submit_once', 'scripted']),
  maxModelTurns: z.number().int().min(1).max(100),
  repeatCount: z.number().int().min(1).max(10),
  rubricDimensions: z.array(z.object({ id: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,99}$/), label: z.string().trim().min(1).max(100), weight: z.number().positive().max(100) }).strict()).min(1).max(20).optional(),
  fixtureBranch: z.enum(['clean', 'realistic-dom', 'career-portal']).optional(),
}).strict();
const ProjectInputSchema = z.object({
  id: Id.optional(),
  name: z.string().trim().min(1).max(200),
  runnerType: z.enum(['prompt', 'browser']),
  config: ConfigSchema,
  rubric: z.string().max(100000).optional(),
  judgePrompt: z.string().max(100000).optional(),
  judgeStrictJson: z.boolean().optional(),
}).strict();
const ScriptedResponseSchema = z.union([
  z.object({ kind: z.literal('confirmation'), accepted: z.boolean() }).strict(),
  z.object({ kind: z.literal('input'), content: z.string().max(10000) }).strict(),
  z.object({ kind: z.literal('input'), answers: z.record(z.string().min(1), z.string().max(10000)) }).strict(),
]);
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
  scriptedResponses: z.array(ScriptedResponseSchema).max(100).optional(),
  browser: z.object({
    benchmark: z.object({ scenarioId: z.string().min(1).max(100), goal: z.enum(['fill', 'preview', 'submit']) }).strict().optional(),
    fixtureVersion: z.string().max(100).optional(), seed: z.number().int().optional(),
    difficulty: z.enum(['basic', 'intermediate', 'advanced']).optional(),
    initialState: z.record(z.string(), z.unknown()).optional(),
    expectedTargets: z.array(z.string().max(200)).max(100).optional(),
    forbiddenTargets: z.array(z.string().max(200)).max(100).optional(),
    scriptedResponses: z.array(ScriptedResponseSchema).max(100).optional(),
    assertions: z.array(z.object({
      id: Id, type: z.enum(['state_equals', 'state_subset', 'state_absent', 'event_exists', 'event_absent', 'event_order', 'receipt_exists', 'metric_equals', 'metric_max']),
      path: z.string().max(500).optional(), expected: z.unknown().optional(), eventType: z.string().max(200).optional(), toolName: z.string().max(200).optional(),
      beforeToolName: z.string().max(200).optional(), afterToolName: z.string().max(200).optional(), weight: z.number().positive().max(1000),
      required: z.boolean().optional(), hardFailure: z.string().max(500).optional(),
    }).strict()).max(200).optional(),
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

/** 在固定上限内执行 CaseRun；任一基础设施异常后停止领取新任务，但等待已启动任务稳定退出。 */
export async function RunEvaluationTaskPool<T>(tasks: Array<() => Promise<T>>, maxConcurrency: number, signal: AbortSignal): Promise<T[]> {
  const requestedConcurrency = Number.isInteger(maxConcurrency) && maxConcurrency > 0 ? maxConcurrency : 1;
  const concurrency = Math.max(1, Math.min(requestedConcurrency, tasks.length || 1));
  const results = new Array<T>(tasks.length);
  let nextIndex = 0;
  let failure: unknown;
  let hasFailure = false;
  const workers = Array.from({ length: concurrency }, async () => {
    while (!hasFailure) {
      if (signal.aborted) {
        failure = signal.reason ?? Object.assign(new Error('Evaluation run was cancelled.'), { code: 'CANCELLED' });
        hasFailure = true;
        return;
      }
      const index = nextIndex;
      nextIndex += 1;
      if (index >= tasks.length) return;
      try { results[index] = await tasks[index](); } catch (error) {
        if (!hasFailure) { failure = error; hasFailure = true; }
        return;
      }
    }
  });
  await Promise.all(workers);
  if (hasFailure) throw failure;
  return results;
}

const StrictComparisonFields = [
  'runnerType', 'datasetVersion', 'toolsetHash', 'versions', 'config.executionProvider', 'config.executionModel', 'config.judgeProvider', 'config.judgeModel',
  'config.toolNames', 'config.fixtureBranch', 'config.maxModelTurns', 'config.userSimulator',
  'environment.repeatCount', 'environment.maxConcurrency', 'environment.browserEngine', 'environment.closeTaskTabs',
  'rubric', 'judgePrompt', 'judgeStrictJson', 'config.rubricDimensions', 'models', 'cases', 'toolDefinitions',
] as const;

function CanonicalEvalValue(value: unknown): string {
  const normalize = (item: unknown): unknown => Array.isArray(item) ? item.map(normalize) : item && typeof item === 'object' ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, normalize(child)])) : item;
  return JSON.stringify(normalize(value));
}

/** Prompt 候选差异是实验变量；这里只比较必须保持一致的运行控制变量。 */
export function FindEvalSnapshotDifferences(leftSnapshot: unknown, rightSnapshot: unknown): string[] {
  const read = (value: unknown, path: string) => path.split('.').reduce<unknown>((current, key) => (
    current && typeof current === 'object' ? (current as Record<string, unknown>)[key] : undefined
  ), value);
  return StrictComparisonFields.filter((field) => CanonicalEvalValue(read(leftSnapshot, field)) !== CanonicalEvalValue(read(rightSnapshot, field)));
}

function ValidateProjectConfig(config: z.infer<typeof ConfigSchema> & { toolNames: string[] }, runnerType: 'prompt' | 'browser'): void {
  ResolveEvalDimensions(config.rubricDimensions);
  if (runnerType === 'prompt' && (!config.judgeProvider || !config.judgeModel)) {
    throw Object.assign(new Error('Prompt evaluation requires a Judge provider and model.'), { code: 'VALIDATION_ERROR' });
  }
  const candidateIds = config.candidates.map((candidate) => candidate.id);
  if (new Set(candidateIds).size !== candidateIds.length) throw Object.assign(new Error('Evaluation candidate ids must be unique.'), { code: 'VALIDATION_ERROR' });
  if (new Set(config.toolNames).size !== config.toolNames.length) throw Object.assign(new Error('Evaluation tool names must be unique.'), { code: 'VALIDATION_ERROR' });
  const invalidTools = EvaluationToolPolicy(runnerType, config.toolNames).invalid;
  if (invalidTools.length) throw Object.assign(new Error(`当前测评场景不支持这些工具：${invalidTools.join('、')}。请修正工具配置。`), { code: 'VALIDATION_ERROR', details: { invalidTools } });
  const fragmentIds = new Set((runnerType === 'browser' ? BuildApplicationPromptFragments() : BuildDefaultPromptFragments()).map((fragment) => fragment.id));
  const unknownOverrides = config.candidates.flatMap((candidate) => Object.keys(candidate.promptOverrides).filter((id) => !fragmentIds.has(id)).map((id) => `${candidate.id}:${id}`));
  if (unknownOverrides.length) throw Object.assign(new Error(`Evaluation prompt overrides contain unknown fragment ids: ${unknownOverrides.join(', ')}.`), { code: 'VALIDATION_ERROR' });
}

interface EvalServiceOptions {
  userDataPath: string;
  providerFetch?: typeof fetch;
  store: any;
  credentialPort: any;
  getStoredSettings: () => Promise<Record<string, unknown>>;
  Emit(event: EvalEvent): void;
  promptRunner?: PromptEvalRunner;
  scorer?: EvalScorer;
  browserRunner?: BrowserEvalRunner;
  browserExtensionBridge?: BrowserExtensionBridge;
  externalBrowserPaths?: Partial<Record<'chrome' | 'edge' | 'ego', string>>;
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
  private datasetMutations = new Map<string, Promise<unknown>>();
  private credentialPort: any;
  private runCredentials = new Map<string, EvaluationCredentials>();
  private defaultBrowserEngine: 'chrome' | 'edge';

  constructor(options: EvalServiceOptions) {
    this.userDataPath = options.userDataPath;
    this.store = options.store;
    this.getStoredSettings = options.getStoredSettings;
    this.Emit = options.Emit;
    this.credentialPort = options.credentialPort;
    this.defaultBrowserEngine = options.externalBrowserPaths?.edge ? 'edge' : options.externalBrowserPaths?.chrome ? 'chrome' : 'edge';
    this.artifacts = new EvalArtifactStore(options.userDataPath);
    this.promptRunner = options.promptRunner ?? new PromptEvalRunner({ credentialPort: options.credentialPort, providerFetch: options.providerFetch });
    this.scorer = options.scorer ?? new EvalScorer({ credentialPort: options.credentialPort, providerFetch: options.providerFetch });
    this.browserRunner = options.browserRunner ?? new BrowserEvalRunner({
      credentialPort: options.credentialPort,
      providerFetch: options.providerFetch,
      browserExtensionBridge: options.browserExtensionBridge ?? new BrowserExtensionBridge({
        statePath: join(options.userDataPath, 'browser-extension', 'bridge.json'),
        browserPaths: options.externalBrowserPaths,
      }),
      externalBrowserPaths: options.externalBrowserPaths ?? {},
    });
  }

  async Initialize(): Promise<void> {
    await Promise.all([this.artifacts.Initialize(), this.store.RecoverInterruptedEvalRuns()]);
    const pending: Array<{ project_id: string }> = await this.store.ListEvalDatasetCleanupRecords();
    for (const id of new Set(pending.map(row => row.project_id))) await this.WithDatasetLock(id, () => this.CleanupDatasets(id));
  }

  /** 同项目文件落盘、登记、删除及重新导入按序完成，避免清理任务误删刚重导的同哈希文件。 */
  private async WithDatasetLock<T>(projectId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.datasetMutations.get(projectId) ?? Promise.resolve();
    const operation = previous.catch(() => undefined).then(work);
    this.datasetMutations.set(projectId, operation);
    try { return await operation; }
    finally { if (this.datasetMutations.get(projectId) === operation) this.datasetMutations.delete(projectId); }
  }

  /** 元数据先提交；文件清理失败保留持久任务，不能让已成功的删除看似失败并诱发重复提交。 */
  private async CleanupDatasets(projectId: string): Promise<void> {
    const pending: Array<{ version: string }> = await this.store.ListEvalDatasetCleanupRecords(projectId);
    const versions: Array<{ version: string }> = await this.store.ListEvalDatasetVersionRecords(projectId);
    for (const row of pending) {
      try {
        if (!versions.some(item => item.version === row.version)) await this.artifacts.DeleteDataset(projectId, row.version);
        await this.store.CompleteEvalDatasetCleanup(projectId, row.version);
      } catch {
        try { await this.store.RecordLog('WARN', 'evaluation.dataset_cleanup_pending', `project=${projectId}; version=${row.version}`); }
        catch { /* 清理任务已持久化，日志失败不能撤销元数据提交。 */ }
      }
    }
  }

  private InspectDataset(project: any, jsonl: string): EvalDatasetImportPreview {
    try { return DiagnoseDataset(project, ParseEvalDataset(jsonl), jsonl); }
    catch (error) {
      const environment = DatasetEnvironment(project);
      const details = (error as { details?: { line?: number; issues?: Array<{ path: unknown[]; message: string }> } })?.details;
      return {
        valid: false, caseCount: 0, environment,
        expectedFixtureVersion: environment === 'prompt' ? null : environment === 'career-portal' ? ApplicationBenchmarkVersion : '2',
        templateJsonl: DatasetTemplate(project),
        diagnostics: [{ line: details?.line ?? null, code: 'DATASET_SCHEMA_INVALID', declaredVersion: null, expectedVersion: null,
          message: error instanceof Error ? error.message : '测试集无法解析。',
          action: details?.issues?.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('；') || '请使用当前环境模板，每行填写一个 JSON 案例，ID 不重复，文件不超过 8 MiB。' }],
      };
    }
  }

  private RequireCompatibleDataset(project: any, jsonl: string): EvalDatasetCase[] {
    const preview = this.InspectDataset(project, jsonl);
    if (!preview.valid) throw Object.assign(new Error(preview.diagnostics.map(item => `第 ${item.line ?? '?'} 行${item.caseId ? `（${item.caseId}）` : ''}：${item.message}`).join('；')), { code: 'VALIDATION_ERROR', details: { preview } });
    return ParseEvalDataset(jsonl);
  }

  /** 不写文件或业务状态；导入时仍重新校验，以防预检后输入或项目配置变化。 */
  async PreviewDatasetImport(projectId: string, jsonl: string): Promise<EvalDatasetImportPreview> {
    await this.RequireDeveloperMode();
    const project = await this.store.ReadEvalProjectRecord(Id.parse(projectId));
    return this.InspectDataset(project, jsonl);
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
    const config = { ...parsed.config, toolNames: parsed.config.toolNames ?? EvaluationToolPolicy(parsed.runnerType).defaults };
    ValidateProjectConfig(config, parsed.runnerType);
    const now = Date.now();
    const created = await this.store.CreateEvalProjectRecord({ ...parsed, config, id: parsed.id ?? `eval-${randomUUID()}`, createdAt: now, updatedAt: now });
    if (parsed.runnerType === 'browser' && parsed.config.fixtureBranch === 'career-portal') {
      await this.ImportDataset(created.id, BuildApplicationBenchmarkDataset(), '', created.revision);
      return this.ReadProject(created.id);
    }
    return this.PublicProject(created);
  }

  async UpdateProject(id: string, input: EvalProjectInput, expectedRevision: number): Promise<EvalProject> {
    await this.RequireDeveloperMode();
    Id.parse(id);
    const parsed = ProjectInputSchema.parse(input);
    return this.WithDatasetLock(id, async () => {
      // 输入未携带 judgePrompt/judgeStrictJson 时沿用现值：旧调用方不传这些字段不应清空评判配置。
      const current = await this.store.ReadEvalProjectRecord(id);
      const config = { ...parsed.config, toolNames: parsed.config.toolNames ?? current.config.toolNames };
      ValidateProjectConfig(config, parsed.runnerType);
      const judgePrompt = parsed.judgePrompt ?? current.judgePrompt ?? '';
      const judgeStrictJson = parsed.judgeStrictJson ?? current.judgeStrictJson === true;
      return this.PublicProject(await this.store.UpdateEvalProjectRecord(id, { ...parsed, config, judgePrompt, judgeStrictJson, updatedAt: Date.now() }, expectedRevision));
    });
  }

  async ReadProject(id: string): Promise<EvalProject> { await this.RequireDeveloperMode(); return this.PublicProject(await this.store.ReadEvalProjectRecord(Id.parse(id))); }
  async ListProjects(): Promise<EvalProject[]> { await this.RequireDeveloperMode(); return (await this.store.ListEvalProjectRecords()).map((record: any) => this.PublicProject(record)); }
  async DeleteProject(id: string): Promise<{ deleted: boolean }> {
    await this.RequireDeveloperMode();
    const projectId = Id.parse(id);
    return this.WithDatasetLock(projectId, async () => {
      const result = await this.store.DeleteEvalProjectRecord(projectId);
      if (result.deleted) await this.artifacts.DeleteProjectDatasets(projectId);
      return result;
    });
  }

  async ImportDataset(projectId: string, jsonl: string, rubric: string, expectedRevision: number): Promise<any> {
    await this.RequireDeveloperMode();
    Id.parse(projectId);
    if (typeof rubric !== 'string' || rubric.length > 100000) throw Object.assign(new Error('Evaluation rubric is invalid.'), { code: 'VALIDATION_ERROR' });
    return this.WithDatasetLock(projectId, async () => {
      await this.CleanupDatasets(projectId);
      const projectToImport = await this.store.ReadEvalProjectRecord(projectId);
      const cases = this.RequireCompatibleDataset(projectToImport, jsonl);
      const normalized = cases.map((testCase) => JSON.stringify(testCase)).join('\n');
      const datasetVersion = createHash('sha256').update(normalized).digest('hex');
      // 先登记可能的孤立文件，覆盖落盘后、登记事务前应用退出的窗口；成功导入会在事务中撤销任务。
      await this.store.QueueEvalDatasetCleanupIfUnreferenced(projectId, datasetVersion);
      let datasetKey: string;
      try { datasetKey = await this.artifacts.WriteDataset(projectId, datasetVersion, normalized); }
      catch (error) {
        await this.store.QueueEvalDatasetCleanupIfUnreferenced(projectId, datasetVersion);
        throw error;
      }
      // 类别取首题的 category：版本库用它展示"评估类别"，与单题类别字段保持同源。
      let project: any;
      try { project = await this.store.ImportEvalDatasetRecord(projectId, datasetKey, rubric, datasetVersion, cases.length, cases[0]?.category ?? 'general', expectedRevision, Date.now()); }
      catch (error) {
        await this.store.QueueEvalDatasetCleanupIfUnreferenced(projectId, datasetVersion);
        await this.CleanupDatasets(projectId);
        throw error;
      }
      return { projectId, datasetVersion, caseCount: cases.length, revision: project.revision };
    });
  }

  /** 版本库读取：登记行 + 当前指针 + 引用计数一次给全，供评测集选择器直接渲染。 */
  async ListDatasetVersions(projectId: string): Promise<EvalDatasetVersion[]> {
    await this.RequireDeveloperMode();
    Id.parse(projectId);
    return this.WithDatasetLock(projectId, async () => {
      const project = await this.store.ReadEvalProjectRecord(projectId);
      const rows = await this.store.ListEvalDatasetVersionRecords(projectId);
      return rows.map((row: { version: string; case_count: number; category?: string; created_at: number; run_count: number }) => ({
        version: row.version,
        caseCount: row.case_count,
        category: row.category ?? 'general',
        importedAt: row.created_at,
        isCurrent: row.version === project.datasetVersion,
        runCount: Number(row.run_count),
      }));
    });
  }

  /** 项目指针切到历史版本；文件缺失说明登记与磁盘漂移，拒绝指向不可运行的数据集。 */
  async SelectDatasetVersion(projectId: string, version: string, expectedRevision: number): Promise<EvalProject> {
    await this.RequireDeveloperMode();
    Id.parse(projectId);
    if (!/^[A-Za-z0-9._-]{1,200}$/.test(version)) throw Object.assign(new Error('Evaluation dataset version is invalid.'), { code: 'VALIDATION_ERROR' });
    return this.WithDatasetLock(projectId, async () => {
      await this.CleanupDatasets(projectId);
      const row = (await this.store.ListEvalDatasetVersionRecords(projectId)).find((item: any) => item.version === version);
      if (!row) throw Object.assign(new Error('Evaluation dataset version was not found.'), { code: 'NOT_FOUND' });
      const project = await this.store.ReadEvalProjectRecord(projectId);
      this.RequireCompatibleDataset(project, await this.artifacts.ReadDataset(projectId, version));
      const datasetKey = `datasets/${projectId}/${version}.jsonl`;
      return this.PublicProject(await this.store.SelectEvalDatasetVersionRecord(projectId, datasetKey, version, row.case_count, expectedRevision, Date.now()));
    });
  }

  /** 删除登记与指针变更同事务；最后一版清空指针，文件清理任务可在失败后重试。 */
  async DeleteDatasetVersion(projectId: string, version: string, expectedRevision: number): Promise<EvalProject> {
    await this.RequireDeveloperMode();
    Id.parse(projectId);
    if (!/^[A-Za-z0-9._-]{1,200}$/.test(version)) throw Object.assign(new Error('Evaluation dataset version is invalid.'), { code: 'VALIDATION_ERROR' });
    return this.WithDatasetLock(projectId, async () => {
      const project = await this.store.DeleteEvalDatasetVersionRecord(projectId, version, expectedRevision, Date.now());
      await this.CleanupDatasets(projectId);
      return this.PublicProject(project);
    });
  }

  async ValidateProject(id: string): Promise<{ valid: boolean; errors: string[] }> {
    await this.RequireDeveloperMode();
    const record = await this.store.ReadEvalProjectRecord(Id.parse(id));
    const errors: string[] = [];
    if (!record.datasetVersion || !record.datasetJsonl) errors.push('请先导入至少一个测试案例。');
    if (record.runnerType === 'prompt' && !record.rubric.trim()) errors.push('请填写评分 Rubric。');
    if (!record.config.candidates.length) errors.push('至少需要一个 Prompt 候选。');
    const supportedTools = record.runnerType === 'browser' ? ApplicationScenario.toolNames : DefaultScenario.toolNames;
    if (!record.config.toolNames.every((name: string) => supportedTools.includes(name))) errors.push('测评包含当前场景不支持的工具。');
    try { await ValidateEvaluationModels(record.config, record.runnerType, await FreezeEvaluationCredentials(this.credentialPort)); }
    catch (error) { errors.push(error instanceof Error ? error.message : '模型配置无法读取。'); }
    if (record.runnerType === 'browser' && !record.config.toolNames.some((name: string) => name.startsWith('Browser'))) errors.push('浏览器测评至少需要一个 Browser 工具。');
    if (record.runnerType === 'browser' && !record.config.fixtureBranch) errors.push('浏览器测评必须选择 Fixture 分支。');
    if (record.datasetVersion) {
      try {
        this.RequireCompatibleDataset(record, await this.artifacts.ReadDataset(record.id, record.datasetVersion));
      } catch (error) {
        errors.push(error instanceof Error ? error.message : '测试集无法读取。');
      }
    }
    return { valid: errors.length === 0, errors };
  }

  private BuildSnapshot(project: any, cases: EvalDatasetCase[], runConfig = project.config): Record<string, unknown> {
    const scenarioId = project.runnerType === 'browser' ? 'application' : 'default';
    const productionFragments = project.runnerType === 'browser' ? BuildApplicationPromptFragments() : BuildDefaultPromptFragments();
    const definitions = CreateDefaultModules({
      getConfig: async () => null, saveConfig: async () => undefined, getStoredSettings: async () => ({}),
      file: {} as any, resumeRead: {} as any, resumeWrite: {} as any, observabilityStore: null,
    }).tools.GetToolDefinitions(scenarioId)
      .filter((tool) => project.config.toolNames.includes(tool.definition.function.name))
      .map((tool) => tool.definition);
    const toolsetHash = createHash('sha256').update(JSON.stringify(definitions)).digest('hex');
    const candidates = runConfig.candidates.map((candidate: EvalPromptCandidate) => {
      const fragments = productionFragments.map((fragment) => candidate.promptOverrides[fragment.id] === undefined
        ? fragment
        : { ...fragment, version: `${fragment.version}-eval`, content: candidate.promptOverrides[fragment.id], contentHash: '' });
      const compiled = CompilePrompt(fragments, scenarioId, toolsetHash, 'eval-1');
      return { ...candidate, compiledPrompt: compiled };
    });
    return {
      schemaVersion: 1, createdAt: Date.now(), projectId: project.id, projectRevision: project.revision,
      runnerType: project.runnerType, config: { ...runConfig, rubricDimensions: ResolveEvalDimensions(runConfig.rubricDimensions), candidates }, rubric: project.rubric, judgePrompt: project.judgePrompt ?? '', judgeStrictJson: project.judgeStrictJson === true,
      datasetVersion: project.datasetVersion, cases, toolDefinitions: definitions, toolsetHash,
      versions: { snapshot: 4, promptRunner: 4, browserRunner: 5, scorer: project.runnerType === 'browser' ? 'browser-deterministic-4' : 'prompt-judge-5', assertions: 2, trace: 2, rubric: 1, summary: 2, application: '0.1.0', ...(runConfig.fixtureBranch === 'career-portal' ? { benchmark: ApplicationBenchmarkVersion } : {}) },
      environment: { repeatCount: runConfig.repeatCount, maxConcurrency: project.runnerType === 'browser' ? 1 : 2 },
    };
  }

  async PreviewProject(id: string): Promise<any> {
    await this.RequireDeveloperMode();
    const project = await this.store.ReadEvalProjectRecord(Id.parse(id));
    const snapshot = this.BuildSnapshot(project, []) as any;
    const scenarioId = project.runnerType === 'browser' ? 'application' : 'default';
    const productionFragments = project.runnerType === 'browser' ? BuildApplicationPromptFragments() : BuildDefaultPromptFragments();
    const productionPrompt = CompilePrompt(productionFragments, scenarioId, snapshot.toolsetHash, 'eval-1').compiled;
    return {
      schemaVersion: 1,
      projectId: project.id,
      projectRevision: project.revision,
      generatedAt: Date.now(),
      toolsetHash: snapshot.toolsetHash,
      tools: EvaluationToolPolicy(project.runnerType, project.config.toolNames),
      productionPrompt,
      // Renderer 只获得可编辑的生产 Prompt 正文，不接触文件系统或编译实现。
      fragments: productionFragments.map((fragment) => ({
        id: fragment.id,
        content: fragment.content,
        trustLevel: fragment.trustLevel,
      })),
      candidates: snapshot.config.candidates.map((candidate: any) => ({
        id: candidate.id,
        name: candidate.name,
        compiledHash: candidate.compiledPrompt.manifest.compiledHash,
        compiledPrompt: candidate.compiledPrompt.compiled,
        overriddenFragmentIds: Object.keys(candidate.promptOverrides),
      })),
    };
  }

  async StartRun(projectId: string, candidateId?: string): Promise<EvalRun> {
    await this.RequireDeveloperMode();
    Id.parse(projectId);
    return this.WithDatasetLock(projectId, async () => {
      const validation = await this.ValidateProject(projectId);
      if (!validation.valid) throw Object.assign(new Error(validation.errors.join('；')), { code: 'VALIDATION_ERROR', details: { errors: validation.errors } });
      const project = await this.store.ReadEvalProjectRecord(projectId);
      const credentials = await FreezeEvaluationCredentials(this.credentialPort);
      const actualModels = await ValidateEvaluationModels(project.config, project.runnerType, credentials);
      const runConfig = project.config;
      let candidates = runConfig.candidates as Array<EvalPromptCandidate>;
      if (candidateId !== undefined) {
        // 单选候选语义：快照只冻结本次运行的候选，快照哈希因此随候选不同而不同。
        if (!candidates.some((candidate) => candidate.id === candidateId)) {
          throw Object.assign(new Error('指定的 Prompt 候选不存在。'), { code: 'VALIDATION_ERROR' });
        }
        candidates = candidates.filter((candidate) => candidate.id === candidateId);
      }
      const cases = this.RequireCompatibleDataset(project, await this.artifacts.ReadDataset(project.id, project.datasetVersion));
      const snapshot = this.BuildSnapshot(project, cases, { ...runConfig, candidates });
      snapshot.models = actualModels;
      if (project.runnerType === 'browser') {
        const settings = await this.getStoredSettings();
        const browserEngine = settings.browserEngine === 'chrome' || settings.browserEngine === 'edge' || settings.browserEngine === 'ego' ? settings.browserEngine : this.defaultBrowserEngine;
        (snapshot.environment as Record<string, unknown>).browserEngine = browserEngine;
        (snapshot.environment as Record<string, unknown>).closeTaskTabs = settings.closeTaskTabs !== false;
      }
      const snapshotHash = createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
      const id = `run-${randomUUID()}`;
      const record = await this.store.CreateEvalRunRecord({ id, projectId, projectName: project.name, runnerType: project.runnerType, status: 'queued', snapshotHash, snapshot, createdAt: Date.now() });
      await this.artifacts.WriteJson(id, 'snapshot.json', snapshot);
      this.runCredentials.set(id, credentials);
      this.queue.push(id);
      this.EmitEvent({ type: 'run_status', runId: id, message: '测评已进入队列' });
      void this.ProcessQueue();
      return this.PublicRun(record);
    });
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
      const plannedCaseIds = new Map<string, string>((await this.store.ListEvalCaseRunRecords(runId)).map((item: EvalCaseRun) => [`${item.caseId}\u0000${item.candidateId}\u0000${item.repeatIndex}`, item.id]));
      const caseTasks: Array<() => Promise<EvalCaseRun>> = [];
      for (const testCase of cases) {
        for (const candidate of projectConfig.candidates as Array<EvalPromptCandidate & { compiledPrompt: CompiledInstructions }>) {
          for (let repeatIndex = 0; repeatIndex < projectConfig.repeatCount; repeatIndex += 1) {
            caseTasks.push(async () => {
              this.ThrowIfCancelled(controller.signal);
              const caseRunId = plannedCaseIds.get(`${testCase.id}\u0000${candidate.id}\u0000${repeatIndex}`)!;
              const createdAt = (await this.store.ReadEvalCaseRunRecord(caseRunId)).createdAt;
              await this.store.UpsertEvalCaseRunRecord({ id: caseRunId, runId, candidateId: candidate.id, candidateName: candidate.name, caseId: testCase.id, repeatIndex, status: 'running', createdAt, metrics: {} });
              this.EmitEvent({ type: 'case_status', runId, caseRunId, message: `${candidate.name} · ${testCase.id} 正在执行` });
              try {
                const caseRoot = join(this.artifacts.dataRoot, 'runtime', runId, caseRunId);
                await mkdir(caseRoot, { recursive: true });
                const startedAt = Date.now();
                const commonInput = {
                  runId, caseRunId, candidate, testCase, provider: projectConfig.executionProvider, model: projectConfig.executionModel,
                  credentialPort: this.runCredentials.get(runId),
                  toolNames: projectConfig.toolNames, maxModelTurns: projectConfig.maxModelTurns,
                  userSimulator: projectConfig.userSimulator, caseRoot, signal: controller.signal,
                };
                const result = run.runnerType === 'browser'
                  ? await this.browserRunner.Execute({ ...commonInput, fixtureBranch: projectConfig.fixtureBranch, browserEngine: snapshot.environment.browserEngine === 'ego' ? 'ego' : snapshot.environment.browserEngine === 'chrome' ? 'chrome' : 'edge', closeTaskTabs: snapshot.environment.closeTaskTabs !== false })
                  : await this.promptRunner.Execute(commonInput);
                this.ThrowIfCancelled(controller.signal);
                await this.store.UpsertEvalCaseRunRecord({
                  id: caseRunId, runId, candidateId: candidate.id, candidateName: candidate.name, caseId: testCase.id, repeatIndex,
                  status: 'scoring', finalResponse: result.finalResponse, metrics: result.metrics, createdAt,
                });
                this.EmitEvent({ type: 'case_status', runId, caseRunId, message: `${candidate.name} · ${testCase.id} 正在评分` });
                for (const event of result.events) await this.artifacts.AppendCaseEvent(runId, caseRunId, 'messages.jsonl', event);
                const trace = NormalizeEvalTrace(result.events, result.finalState);
                await this.artifacts.WriteCaseJson(runId, caseRunId, 'trace.json', trace);
                const scoreResult = run.runnerType === 'browser'
                  ? ScoreBrowserCase({ testCase, events: result.events, finalState: result.finalState, metrics: result.metrics })
                  : await this.scorer.Score({
                    testCase, finalResponse: result.finalResponse, events: result.events, finalState: result.finalState, metrics: result.metrics,
                    rubric: snapshot.rubric, rubricDimensions: projectConfig.rubricDimensions, judgePrompt: snapshot.judgePrompt, strictJson: snapshot.judgeStrictJson === true, judgeProvider: projectConfig.judgeProvider, judgeModel: projectConfig.judgeModel!, credentialPort: this.runCredentials.get(runId), signal: controller.signal,
                  });
                this.ThrowIfCancelled(controller.signal);
                const judgeUsage = 'usage' in scoreResult ? scoreResult.usage : undefined;
                const metrics = {
                  ...result.metrics,
                  taskCompleted: scoreResult.score.scoreStatus === 'unscored' || typeof scoreResult.score.taskCompleted !== 'boolean' ? null : scoreResult.score.taskCompleted,
                  promptTokens: result.metrics.promptTokens == null && !judgeUsage ? null : Number(result.metrics.promptTokens ?? 0) + Number(judgeUsage?.promptTokens ?? 0),
                  completionTokens: result.metrics.completionTokens == null && !judgeUsage ? null : Number(result.metrics.completionTokens ?? 0) + Number(judgeUsage?.completionTokens ?? 0),
                  totalTokens: result.metrics.totalTokens == null && !judgeUsage ? null : Number(result.metrics.totalTokens ?? 0) + Number(judgeUsage?.totalTokens ?? 0),
                  durationMs: Date.now() - startedAt,
                };
                const record = await this.store.UpsertEvalCaseRunRecord({
                  id: caseRunId, runId, candidateId: candidate.id, candidateName: candidate.name, caseId: testCase.id, repeatIndex,
                  status: 'completed', finalResponse: result.finalResponse, score: scoreResult.score, metrics,
                  createdAt, completedAt: Date.now(),
                });
                await this.artifacts.WriteCaseJson(runId, caseRunId, 'result.json', { ...record, finalState: result.finalState, promptCompiledHash: candidate.compiledPrompt.manifest.compiledHash });
                await this.artifacts.WriteCaseJson(runId, caseRunId, 'score.json', scoreResult);
                this.EmitEvent({ type: 'score', runId, caseRunId, message: scoreResult.score.totalScore === null ? `${candidate.name} · ${testCase.id} 未计分` : `${candidate.name} · ${testCase.id} 得分 ${scoreResult.score.totalScore}`, data: { totalScore: scoreResult.score.totalScore } });
                return record;
              } catch (error) {
                const partialEvidence = (error as any)?.evalEvidence;
                if (partialEvidence?.events && Array.isArray(partialEvidence.events)) {
                  try {
                    for (const event of partialEvidence.events) await this.artifacts.AppendCaseEvent(runId, caseRunId, 'messages.jsonl', event);
                    await this.artifacts.WriteCaseJson(runId, caseRunId, 'trace.json', NormalizeEvalTrace(partialEvidence.events, partialEvidence.finalState));
                    await this.artifacts.WriteCaseJson(runId, caseRunId, 'result.json', { status: controller.signal.aborted ? 'cancelled' : 'failed', finalState: partialEvidence.finalState, promptCompiledHash: candidate.compiledPrompt.manifest.compiledHash });
                  } catch {
                    // Artifact 失败不能阻止 Case 写入稳定终态；主错误仍由 Case 记录保留。
                  }
                }
                const code = controller.signal.aborted ? 'CANCELLED' : String((error as any)?.code ?? 'EVAL_CASE_FAILED');
                const status = controller.signal.aborted ? 'cancelled' : 'failed';
                const record = await this.store.UpsertEvalCaseRunRecord({
                  id: caseRunId, runId, candidateId: candidate.id, candidateName: candidate.name, caseId: testCase.id, repeatIndex,
                  status, finalResponse: '', metrics: { environmentFailure: (error as { category?: unknown })?.category === 'environment', taskCompleted: controller.signal.aborted || (error as { category?: unknown })?.category === 'environment' ? null : false }, error: { code, message: error instanceof Error ? error.message : 'Evaluation case failed.' },
                  createdAt, completedAt: Date.now(),
                });
                if (controller.signal.aborted) throw error;
                return record;
              }
            });
          }
        }
      }
      const caseRuns = await RunEvaluationTaskPool(caseTasks, Number(snapshot.environment?.maxConcurrency ?? 1), controller.signal);
      this.ThrowIfCancelled(controller.signal);
      await this.store.UpdateEvalRunRecord(runId, { status: 'scoring' });
      this.EmitEvent({ type: 'run_status', runId, message: run.runnerType === 'browser' ? '正在汇总浏览器测评结果' : '正在汇总 Prompt 测评结果' });
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
      this.runCredentials.delete(runId);
    }
  }

  private Summarize(caseRuns: EvalCaseRun[], startedAt: number): EvalRunSummary {
    return SummarizeEvalCases(caseRuns, startedAt);
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
      this.runCredentials.delete(runId);
      const cases: EvalCaseRun[] = await this.store.ListEvalCaseRunRecords(runId);
      for (const item of cases) if (item.status === 'queued') await this.store.UpsertEvalCaseRunRecord({ ...item, status: 'not_run', completedAt: Date.now() });
      await this.store.UpdateEvalRunRecord(runId, { status: 'cancelled', summary: this.Summarize(await this.store.ListEvalCaseRunRecords(runId), Date.now()), error: { code: 'CANCELLED', message: 'Evaluation cancelled before execution.' }, completedAt: Date.now() });
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
  async ReadCaseResult(caseRunId: string): Promise<EvalCaseRunDetail> {
    await this.RequireDeveloperMode();
    const record = await this.store.ReadEvalCaseRunRecord(Id.parse(caseRunId));
    const [trace, scoreArtifact] = await Promise.all([
      this.artifacts.ReadCaseJson<any[]>(record.runId, record.id, 'trace.json'),
      this.artifacts.ReadCaseJson<any>(record.runId, record.id, 'score.json'),
    ]);
    return { ...record, trace: trace ?? [], ...(scoreArtifact?.details ? { scoreDetails: scoreArtifact.details } : {}) } as EvalCaseRunDetail;
  }

  async CompareRuns(leftRunId: string, rightRunId: string): Promise<any> {
    await this.RequireDeveloperMode();
    const [left, right] = await Promise.all([this.ReadRun(leftRunId), this.ReadRun(rightRunId)]);
    const differingSnapshotFields = FindEvalSnapshotDifferences(left.snapshot, right.snapshot);
    return { left, right, strictComparison: differingSnapshotFields.length === 0, differingSnapshotFields, samples: CompareEvalSamples(left, right) };
  }

  HasActiveRuns(): boolean { return Boolean(this.activeRunId || this.queue.length); }

  /** 应用退出时先中止活动执行并为排队 Run 写入稳定 cancelled 终态。 */
  async Close(): Promise<void> {
    for (const controller of this.controllers.values()) controller.abort(Object.assign(new Error('Application is shutting down.'), { code: 'CANCELLED' }));
    const queued = this.queue.splice(0);
    for (const runId of queued) this.runCredentials.delete(runId);
    for (const runId of queued) {
      const cases: EvalCaseRun[] = await this.store.ListEvalCaseRunRecords(runId);
      for (const item of cases) if (item.status === 'queued') await this.store.UpsertEvalCaseRunRecord({ ...item, status: 'not_run', completedAt: Date.now() });
      await this.store.UpdateEvalRunRecord(runId, { status: 'cancelled', summary: this.Summarize(await this.store.ListEvalCaseRunRecords(runId), Date.now()), error: { code: 'CANCELLED', message: 'Evaluation cancelled because the application stopped.' }, completedAt: Date.now() });
    }
    const deadline = Date.now() + 5000;
    while (this.activeRunId && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
    await this.artifactEventTail;
  }
}
