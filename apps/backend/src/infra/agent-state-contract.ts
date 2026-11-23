/** 内部持久化协议：不经过 Renderer；一批变更与历史切换必须在同一 SQLite 事务中提交。 */
export interface AgentStatePatch {
  commitId: string;
  expectedRevision: number;
  rows: Array<{ bucket: string; key: string; value?: unknown; deleted?: boolean }>;
  histories: Array<{ sessionId: string; from: number; messages: unknown[]; deleted?: boolean }>;
}
export interface AgentStateSnapshot {
  revision: number;
  state: Record<string, unknown>;
  unloadedHistories?: string[];
}
export interface AgentStatePort {
  ReadAgentState(options?: { includeHistory?: boolean }): Promise<AgentStateSnapshot>;
  ReadAgentHistory?(sessionId: string): Promise<unknown[]>;
  CommitAgentState(patch: AgentStatePatch): Promise<{ revision: number }>;
}
export const AgentStateBuckets = [
  'tasks', 'projectEnvironments', 'sessionUsage', 'sessionScenarios', 'sessionAssistantStates', 'sessionResumeBindings',
  'toolLedger', 'pendingBrowserActions', 'pendingCronTasks', 'pendingEdits', 'pendingQuestions', 'pausedRuns',
  'interactionDecisions', 'requestSessions', 'runSnapshots', 'loadedSkills', 'loadedSkillResources', 'documentChangeBaselines',
  'sessionGoals', 'egoWorkspaces',
] as const;
