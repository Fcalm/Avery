export type Goal = 'fill' | 'preview' | 'submit';
export type Profile = 'feishu' | 'beisen' | 'moka';
export interface Entry { id: string; current?: boolean; _committed?: Record<string, string>; [key: string]: string | boolean | Record<string, string> | undefined; }
export interface FileEvidence { name: string; size: number; sha256: string; type?: string; exists?: boolean; }
export interface ApplicationState {
  version: string; atsProfile?: Profile; intention: Record<string, string>; personal: Record<string, string>;
  additional: Record<string, string | string[]> & { skills: string[] };
  education: Entry[]; work: Entry[]; projects: Entry[]; noWork: boolean; truth: boolean; privacy: boolean;
  files: Record<string, FileEvidence>; status: 'draft' | 'submitted'; nextId: number;
  events: EventRecord[]; submission: Receipt | null;
}
export interface ParserConfig { enabled?: boolean; stages: Array<{ delayMs: number; mode: 'overwrite' | 'fill-empty' | 'untouched-only'; values: Record<string, string | string[] | boolean> }>; }
export interface AgentMetrics { tokens?: { input?: number; output?: number; cached?: number }; retries?: number; agent?: string; model?: string; }
export interface Failure { code: string; message: string; }
export interface EventRecord { type: string; sequence?: number; at?: string; actor?: 'server' | 'client'; hash?: string; path?: string; [key: string]: unknown; }
export interface Receipt { id: string; runId: string; previewId: string; digest: string; fileHashes: Record<string, string>; at: string; }
export interface Manifest {
  benchmarkVersion: string; scorerVersion: string;
  runId: string; scenarioId: string; scenarioVersion: string; scenarioHash: string; inputHash: string; attachmentHash: string;
  seed: number; goal: Goal; referenceDate: string; profileId: Profile; createdAt: string; endedAt: string | null;
  environment: { node: string; platform: string; browser: { userAgent: string; width: number; height: number; dpr: number } | null };
  parser: { enabled: boolean; stages: Array<{ delayMs: number; mode: string }> };
}
export interface CreatedRun { id: string; url: string; accessToken: string; manifest: Manifest; input: string; attachmentPath: string; attachmentName: string; attachmentUrl: string; }
export interface RunView { manifest: Manifest; revision: number; state: ApplicationState; profile: Record<string, string | number>; parserPending: boolean; preview: { id: string; digest: string; revision: number; at: string } | null; receipt: Receipt | null; }
export interface EvaluationReport {
  scorerVersion?: string;
  verified: boolean; passed: boolean; score: number | null;
  outcome: 'passed' | 'expected_blocked' | 'failed' | 'needs_review' | 'agent_failure' | 'environment_failure' | 'unverified' | 'invalid_record';
  correct?: number; total?: number; goal?: Goal; issues: Array<{ path: string; code: string; [key: string]: unknown }>;
  completion?: { filled: boolean; formValid: boolean; previewed: boolean; submitted: boolean; expectedBlocked: boolean };
  metrics?: { elapsedMs: number | null; tokens: AgentMetrics['tokens'] | null; retries: number | null; retryEvents: number; blurDiscards: number; fieldErrors: number };
}
export interface SignedResult { format: 'career-portal-result-v2'; keyId: string; signature: string; payload: { manifest: Manifest; scenario: unknown; evidence: unknown; report: EvaluationReport }; }
export interface CreateOptions { scenarioId?: string; goal?: Goal; seed?: number; parser?: ParserConfig; }
export interface ScenarioDefinition {
  id: string; version: string; title: string; profileId: Profile; expected: ApplicationState; initial?: ApplicationState;
  input?: string; expectedMissing?: string[]; preserve?: string[]; acceptedTexts?: Record<string, string[]>;
  attachment: { name: string; base64: string }; parser?: ParserConfig;
}
export interface BenchClient {
  listScenarios(): Promise<{ scenarios: Array<{ id: string; title: string; profile: Profile; version: string }> }>;
  registerScenario(scenario: ScenarioDefinition): Promise<{ scenarioId: string; version: string; registered: true }>;
  createRun(options?: CreateOptions): Promise<CreatedRun>;
  getState(id: string): Promise<RunView>;
  getEvents(id: string, after?: number): Promise<{ events: EventRecord[]; cursor: number }>;
  addMetrics(id: string, metrics: AgentMetrics): Promise<AgentMetrics>;
  recordEnvironmentFailure(id: string, failure: Failure): Promise<{ recorded: true }>;
  recordAgentFailure(id: string, failure: Failure): Promise<{ recorded: true }>;
  endRun(id: string, options?: { cleanup?: boolean; metrics?: AgentMetrics }): Promise<SignedResult>;
  cleanupRun(id: string): Promise<{ cleaned: true; resultRetained: true }>;
  getResult(id: string): Promise<SignedResult>;
  publicKeyPath?: string;
}
/** 只由控制进程读取配置；不要把 token 交给模型或被测页面。 */
export function createClient(options?: { controlPath?: string; baseUrl?: string; token?: string }): Promise<BenchClient>;
export const DEFAULT_CONTROL_PATH: string;
