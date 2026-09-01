/** Agent 测评类型；第一版只开放 Prompt 与本地浏览器两类 Runner。 */
export type EvalRunnerType = 'prompt' | 'browser';
export type EvalRunStatus = 'queued' | 'preparing' | 'running' | 'scoring' | 'completed' | 'failed' | 'cancelled';
export type EvalCaseRunStatus = 'queued' | 'running' | 'scoring' | 'completed' | 'failed' | 'cancelled' | 'not_run';
export type EvalUserSimulatorStrategy = 'approve_valid' | 'reject_submit_once' | 'scripted';
export type EvalBrowserAssertionType = 'state_equals' | 'state_subset' | 'state_absent' | 'event_exists' | 'event_absent' | 'event_order' | 'receipt_exists' | 'metric_equals' | 'metric_max';

export interface EvalBrowserAssertion {
  id: string;
  type: EvalBrowserAssertionType;
  /** state_* 使用 finalState 路径，metric_* 使用 metrics 键。 */
  path?: string;
  expected?: unknown;
  /** event_* 与 receipt_exists 可按事件类型和工具名筛选。 */
  eventType?: string;
  toolName?: string;
  beforeToolName?: string;
  afterToolName?: string;
  weight: number;
  required?: boolean;
  /** 断言失败时产生的稳定机器码；存在该字段即视为硬失败。 */
  hardFailure?: string;
}

export interface EvalPromptCandidate {
  id: string;
  name: string;
  /** Prompt Fragment id → 正文覆盖；空对象表示使用当前生产 Fragment。 */
  promptOverrides: Record<string, string>;
}

export interface EvalExpectedResult {
  requiredFacts: string[];
  requiredBehaviors: string[];
  forbiddenClaims: string[];
  forbiddenBehaviors: string[];
  referenceAnswer: string;
  expectedState?: Record<string, unknown>;
  forbiddenActions?: string[];
}

export interface EvalDatasetCase {
  id: string;
  category: string;
  input: { userMessage: string };
  fixtures: { resume?: Record<string, unknown>; profile?: unknown[]; files?: Array<{ name: string; content: string }> };
  expected: EvalExpectedResult;
  tags: string[];
  browser?: {
    fixtureVersion?: string;
    seed?: number;
    difficulty?: 'basic' | 'intermediate' | 'advanced';
    initialState?: Record<string, unknown>;
    expectedTargets?: string[];
    forbiddenTargets?: string[];
    scriptedResponses?: Array<{ kind: 'confirmation' | 'input'; accepted?: boolean; content?: string }>;
    assertions?: EvalBrowserAssertion[];
  };
}

export interface EvalProjectConfig {
  executionProvider: 'DeepSeek';
  executionModel: string;
  /** 只有 Prompt Runner 需要 Judge；Browser Runner 不应配置或调用 Judge。 */
  judgeProvider?: 'DeepSeek';
  judgeModel?: string;
  candidates: EvalPromptCandidate[];
  toolNames: string[];
  userSimulator: EvalUserSimulatorStrategy;
  maxModelTurns: number;
  repeatCount: number;
  fixtureBranch?: 'clean' | 'realistic-dom';
}

export interface EvalProject {
  schemaVersion: 1;
  id: string;
  name: string;
  runnerType: EvalRunnerType;
  config: EvalProjectConfig;
  datasetVersion: string | null;
  datasetCaseCount: number;
  rubric: string;
  revision: number;
  createdAt: number;
  updatedAt: number;
}

export interface EvalProjectInput {
  id?: string;
  name: string;
  runnerType: EvalRunnerType;
  config: EvalProjectConfig;
  rubric?: string;
}

export interface EvalDatasetImportResult {
  projectId: string;
  datasetVersion: string;
  caseCount: number;
  revision: number;
}

export interface EvalRunSummary {
  totalCaseRuns: number;
  completedCaseRuns: number;
  unscoredCaseRuns?: number;
  failedCaseRuns: number;
  cancelledCaseRuns: number;
  averageScore: number | null;
  taskCompletionRate: number | null;
  toolErrorCount: number;
  modelTurns: number;
  durationMs: number;
  usage: { source: 'provider' | 'unavailable'; promptTokens: number; completionTokens: number; totalTokens: number };
}

export interface EvalRun {
  schemaVersion: 1;
  id: string;
  projectId: string;
  projectName: string;
  runnerType: EvalRunnerType;
  status: EvalRunStatus;
  snapshotHash: string;
  summary: EvalRunSummary | null;
  error?: { code: string; message: string };
  createdAt: number;
  startedAt: number | null;
  completedAt: number | null;
}

export interface EvalRequirementResult {
  requirement: string;
  passed: boolean;
  reason: string;
}

export interface EvalBrowserAssertionResult {
  id: string;
  type: EvalBrowserAssertionType;
  passed: boolean;
  required: boolean;
  weight: number;
  reason: string;
  actual?: unknown;
}

export interface EvalCaseScore {
  schemaVersion: 1 | 2;
  id: string;
  createdAt: number;
  scorerType?: 'legacy' | 'prompt_judge' | 'browser_deterministic';
  scoreStatus?: 'completed' | 'unscored';
  deterministicScore: number | null;
  judgeScore: number | null;
  totalScore: number | null;
  dimensions: Record<string, number>;
  hardFailures: string[];
  reason: string;
  confidence: number | null;
  requirementResults?: EvalRequirementResult[];
  assertionResults?: EvalBrowserAssertionResult[];
  judgeStatus?: 'completed' | 'corrected' | 'failed';
  judgeCorrectionCount?: number;
  taskCompleted?: boolean;
}

export type EvalTraceNodeType = 'user' | 'model' | 'tool_call' | 'tool_result' | 'confirmation' | 'page_state' | 'fixture_state' | 'error' | 'event';

export interface EvalTraceNode {
  id: string;
  ordinal: number;
  kind: EvalTraceNodeType;
  title: string;
  createdAt: number;
  durationMs?: number;
  modelTurn?: number;
  status?: 'pending' | 'ok' | 'error' | 'rejected';
  toolName?: string;
  summary: string;
  details?: Record<string, unknown>;
  artifactIds?: string[];
}

export interface EvalPromptPreview {
  schemaVersion: 1;
  projectId: string;
  projectRevision: number;
  generatedAt: number;
  toolsetHash: string;
  /** 未应用候选替换的生产 Prompt 编译结果，供界面标识候选版本的行级差异。 */
  productionPrompt: string;
  /** 当前生产 Prompt 的可替换片段；界面用它构造结构化编辑器，不要求用户编写 JSON。 */
  fragments: Array<{
    id: string;
    content: string;
    trustLevel: 'runtime' | 'product' | 'scenario' | 'user-preference';
  }>;
  candidates: Array<{
    id: string;
    name: string;
    compiledHash: string;
    compiledPrompt: string;
    overriddenFragmentIds: string[];
  }>;
}

export interface EvalCaseRun {
  schemaVersion: 1;
  id: string;
  runId: string;
  candidateId: string;
  candidateName: string;
  caseId: string;
  repeatIndex: number;
  status: EvalCaseRunStatus;
  finalResponse: string;
  score: EvalCaseScore | null;
  metrics: Record<string, number | boolean | null>;
  error?: { code: string; message: string };
  createdAt: number;
  completedAt: number | null;
}

export interface EvalRunDetail extends EvalRun {
  snapshot: Record<string, unknown>;
  caseRuns: EvalCaseRun[];
}

export interface EvalCaseRunDetail extends EvalCaseRun {
  trace: EvalTraceNode[];
  scoreDetails?: {
    objective?: Record<string, unknown>;
    judgeRaw?: string[];
    judgeError?: { code: string; message: string };
  };
}

export interface EvalComparison {
  left: EvalRunDetail;
  right: EvalRunDetail;
  strictComparison: boolean;
  differingSnapshotFields: string[];
}

export interface EvalEvent {
  type: 'run_status' | 'case_status' | 'model' | 'tool' | 'confirmation' | 'score' | 'error';
  runId: string;
  caseRunId?: string;
  message: string;
  createdAt: number;
  data?: Record<string, unknown>;
}

/** 测评 Bridge 与 Agent Tool 完全分离；只有开发者模式下的应用页面可调用。 */
export interface DesktopEvaluationBridge {
  CreateProject: (input: EvalProjectInput) => Promise<EvalProject>;
  UpdateProject: (id: string, input: EvalProjectInput, expectedRevision: number) => Promise<EvalProject>;
  ReadProject: (id: string) => Promise<EvalProject>;
  ListProjects: () => Promise<EvalProject[]>;
  DeleteProject: (id: string) => Promise<{ deleted: boolean }>;
  ImportDataset: (projectId: string, jsonl: string, rubric: string, expectedRevision: number) => Promise<EvalDatasetImportResult>;
  ValidateProject: (id: string) => Promise<{ valid: boolean; errors: string[] }>;
  PreviewProject: (id: string) => Promise<EvalPromptPreview>;
  StartRun: (projectId: string) => Promise<EvalRun>;
  CancelRun: (runId: string) => Promise<{ cancelled: boolean }>;
  ReadRun: (runId: string) => Promise<EvalRunDetail>;
  ListRuns: (projectId?: string) => Promise<EvalRun[]>;
  ReadCaseResult: (caseRunId: string) => Promise<EvalCaseRunDetail>;
  CompareRuns: (leftRunId: string, rightRunId: string) => Promise<EvalComparison>;
  OnEvent: (listener: (event: EvalEvent) => void) => () => void;
}
