/** Agent 测评类型；第一版只开放 Prompt 与本地浏览器两类 Runner。 */
export type EvalRunnerType = 'prompt' | 'browser';
export type EvalRunStatus = 'queued' | 'preparing' | 'running' | 'scoring' | 'completed' | 'failed' | 'cancelled';
export type EvalCaseRunStatus = 'queued' | 'running' | 'scoring' | 'completed' | 'failed' | 'cancelled' | 'not_run';
export type EvalUserSimulatorStrategy = 'approve_valid' | 'reject_submit_once' | 'scripted';

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
  };
}

export interface EvalProjectConfig {
  executionProvider: 'DeepSeek';
  executionModel: string;
  judgeProvider: 'DeepSeek';
  judgeModel: string;
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

export interface EvalCaseScore {
  schemaVersion: 1;
  id: string;
  createdAt: number;
  deterministicScore: number;
  judgeScore: number | null;
  totalScore: number;
  dimensions: Record<string, number>;
  hardFailures: string[];
  reason: string;
  confidence: number | null;
}

export interface EvalPromptPreview {
  schemaVersion: 1;
  projectId: string;
  projectRevision: number;
  generatedAt: number;
  toolsetHash: string;
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
  ReadCaseResult: (caseRunId: string) => Promise<EvalCaseRun>;
  CompareRuns: (leftRunId: string, rightRunId: string) => Promise<EvalComparison>;
  OnEvent: (listener: (event: EvalEvent) => void) => () => void;
}
