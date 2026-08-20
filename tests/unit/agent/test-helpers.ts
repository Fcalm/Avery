import { vi } from 'vitest';
import type {
  AgentMessage, AgentModules, AgentStreamEvent, KernelRunInput, ModelCompletion, ModelUsage,
  RegisteredAgentTool, ToolCallFragment, ToolContext, ToolExecutionResult,
} from '../../../packages/agent-sdk/src/index';

export function CreateRegisteredTool(
  name: string,
  options: Partial<RegisteredAgentTool> = {},
): RegisteredAgentTool {
  return {
    definition: {
      type: 'function',
      function: {
        name,
        description: `${name} test tool`,
        parameters: { type: 'object', properties: {}, additionalProperties: true },
      },
    },
    timeoutMs: 1_000,
    isConcurrencySafe: true,
    sideEffect: 'none',
    resourceKeys: () => [`test:${name}`],
    ...options,
  };
}

export function CreateToolContext(overrides: Partial<ToolContext> = {}): ToolContext {
  const ledgerEntries = new Map<string, import('../../../packages/agent-sdk/src/index').ToolLedgerEntry>();
  return {
    sessionId: 'session-1',
    requestId: 'request-1',
    runId: 'run-1',
    confirmationMode: '无需确认',
    resumeEditing: false,
    projectRoot: null,
    attachments: [],
    profileSnapshot: [],
    resumeSnapshot: null,
    ports: {
      file: {
        ReadAuthorizedFile: vi.fn(),
        ReadTextFile: vi.fn(),
        ListProjectFiles: vi.fn(() => []),
        ResolveProjectPath: vi.fn(),
        ResolveAttachmentUri: vi.fn(),
        CreateGlobMatcher: vi.fn(() => /.*/u),
      },
      resumeRead: { ReadCurrent: vi.fn() },
      resumeWrite: {
        AcquireLock: vi.fn(),
        ReleaseLock: vi.fn(),
        Save: vi.fn(),
      },
    },
    tasks: new Map(),
    pendingEdits: new Map(),
    pendingQuestions: new Map(),
    ledger: {
      Start: vi.fn((entry) => ledgerEntries.set(entry.ledgerId, { ...entry, status: 'started' })),
      Finish: vi.fn((ledgerId, status, extra) => {
        const current = ledgerEntries.get(ledgerId);
        if (current) ledgerEntries.set(ledgerId, { ...current, status, ...extra });
      }),
      FindByIdempotencyKey: vi.fn((key) => [...ledgerEntries.values()].find((entry) => entry.idempotencyKey === key && entry.status !== 'started')),
    },
    emit: vi.fn(),
    persistSessionState: vi.fn(),
    ...overrides,
  };
}

export interface KernelHarness {
  input: KernelRunInput;
  modules: AgentModules;
  events: AgentStreamEvent[];
  usages: Array<ModelUsage | undefined>;
  trace: {
    append: ReturnType<typeof vi.fn>;
    finish: ReturnType<typeof vi.fn>;
    log: ReturnType<typeof vi.fn>;
  };
}

export function CreateKernelHarness(options: {
  completions?: ModelCompletion[];
  streamCompletion?: AgentModules['modelProvider']['StreamCompletion'];
  executeTool?: (call: ToolCallFragment, context: ToolContext) => Promise<ToolExecutionResult>;
  tools?: RegisteredAgentTool[];
  history?: AgentMessage[];
  shouldCompact?: boolean;
  createSummary?: AgentModules['modelProvider']['CreateSummary'];
  splitRecentTurns?: AgentModules['compaction']['SplitRecentTurns'];
  dropOldestTurns?: AgentModules['compaction']['DropOldestTurns'];
  signal?: AbortSignal;
  scenarioToolNames?: string[];
} = {}): KernelHarness {
  const completions = [...(options.completions ?? [{ content: 'done', toolCalls: [] }])];
  const events: AgentStreamEvent[] = [];
  const usages: Array<ModelUsage | undefined> = [];
  const trace = { append: vi.fn(), finish: vi.fn(), log: vi.fn() };
  const streamCompletion = options.streamCompletion ?? vi.fn(async ({ onDelta }) => {
    const completion = completions.shift();
    if (!completion) throw new Error('No test completion remains.');
    if (completion.content) onDelta({ reasoning: '', content: completion.content });
    return completion;
  });

  const modules = {
    modelProvider: {
      packageName: 'test', name: 'test-provider', version: '0.1.0', sdkVersion: '0.1.0', slot: 'model-provider', capabilities: ['model'],
      Configure: vi.fn(), TestConnection: vi.fn(), GetBalance: vi.fn(), GetModels: vi.fn(), GetStatus: vi.fn(),
      ResolveRequestModel: vi.fn((model?: string) => model ?? 'test-model'),
      StreamCompletion: streamCompletion,
      CreateSummary: options.createSummary ?? vi.fn(async () => ({ content: 'summary' })),
      EstimateTokens: vi.fn(() => options.shouldCompact ? 800 : 100),
      GetRuntimeLimits: vi.fn(() => ({ contextLimit: 1_000, threshold: 70 })),
      BaseUrl: vi.fn(() => 'https://example.test'),
    },
    contextBuilder: {
      packageName: 'test', name: 'test-context', version: '0.1.0', sdkVersion: '0.1.0', slot: 'context-builder', capabilities: ['context'],
      BuildSessionContextSnapshot: vi.fn(), SerializeSessionContext: vi.fn(), CreateDynamicSnapshot: vi.fn(),
    },
    compaction: {
      packageName: 'test', name: 'test-compaction', version: '0.1.0', sdkVersion: '0.1.0', slot: 'compaction', capabilities: ['compaction'],
      ShouldCompact: vi.fn(() => options.shouldCompact ?? false),
      SplitRecentTurns: options.splitRecentTurns ?? vi.fn((history: AgentMessage[]) => ({ earlier: history.slice(0, 1), recent: history.slice(1) })),
      DropOldestTurns: options.dropOldestTurns ?? vi.fn((history: AgentMessage[]) => history.slice(1)),
    },
    tools: {
      packageName: 'test', name: 'test-tools', version: '0.1.0', sdkVersion: '0.1.0', slot: 'tools', capabilities: ['tools'],
      GetToolDefinitions: vi.fn(() => options.tools ?? []),
      ExecuteToolCall: vi.fn(options.executeTool ?? (async (call: ToolCallFragment) => ({ role: 'tool', tool_call_id: call.id, content: '{"ok":true}' }))),
    },
    interaction: {
      packageName: 'test', name: 'test-interaction', version: '0.1.0', sdkVersion: '0.1.0', slot: 'interaction', capabilities: ['interaction'],
      ConfirmResumeEdit: vi.fn(), GetPendingQuestions: vi.fn(), ClearPendingQuestion: vi.fn(),
    },
    observability: {
      packageName: 'test', name: 'test-observability', version: '0.1.0', sdkVersion: '0.1.0', slot: 'observability', capabilities: ['observability'],
      RecordLog: trace.log, StartTrace: vi.fn(), AppendTraceEvent: trace.append, FinishTrace: trace.finish,
      GetLogs: vi.fn(), GetTraces: vi.fn(), GetTraceEvents: vi.fn(), DeleteTraces: vi.fn(), SetTraceRetention: vi.fn(), ClearObservability: vi.fn(), SnapshotLocalLogs: vi.fn(() => []),
    },
  } satisfies AgentModules;

  const controller = new AbortController();
  const tools = options.tools ?? [];
  const input: KernelRunInput = {
    requestId: 'request-1',
    sessionId: 'session-1',
    model: 'test-model',
    systemContext: '<system-context />',
    requestHistory: options.history ?? [],
    userContent: 'test request',
    histories: new Map(),
    toolArray: tools,
    modules,
    toolContext: CreateToolContext(),
    emit: (event) => events.push(event),
    onModelUsage: (usage) => usages.push(usage),
    signal: options.signal ?? controller.signal,
    maxTurns: 12,
    contextLimit: 1_000,
    thresholdPercent: 70,
    createId: () => 'generated-id',
    scenario: {
      id: 'default', name: '默认场景', enabled: true, status: 'active',
      toolNames: options.scenarioToolNames ?? tools.map((tool) => tool.definition.function.name),
      budgets: { maxModelTurns: 12, maxToolCalls: 12 },
    },
    instructions: {
      manifest: {
        manifestVersion: 1, compilerVersion: 'test', fragments: [], scenarioId: 'default',
        toolPolicyHash: 'test-tools', outputContractVersion: 'test', compiledHash: 'test-prompt',
      },
      compiled: 'compiled system prompt',
    },
  };

  return { input, modules, events, usages, trace };
}
