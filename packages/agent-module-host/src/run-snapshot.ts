import type { CompiledInstructions, RegisteredAgentTool, ScenarioSnapshot } from '@avery/agent-sdk';

/** Run 可读取的数据边界；快照只记录授权标识，不包含凭据或业务正文。 */
export interface RunDataScopeSnapshot {
  projectId?: string;
  projectRoot?: string;
  resumeId?: string;
  attachmentPaths: string[];
}

/** Provider 选择快照；运行期间不得因配置重载切换模块或模型。 */
export interface RunProviderSnapshot {
  moduleName: string;
  moduleVersion: string;
  model: string;
  capabilities: string[];
  contextLimit: number;
  compressionThreshold: number;
}

/** 一次 Run 的原子输入快照；Kernel 必须从同一对象消费场景、Prompt、工具、数据范围与 Provider。 */
export interface ImmutableRunSnapshot {
  snapshotId: string;
  sessionId: string;
  sessionRevision: number;
  scenario: ScenarioSnapshot;
  instructions: CompiledInstructions;
  tools: RegisteredAgentTool[];
  toolNames: string[];
  dataScope: RunDataScopeSnapshot;
  provider: RunProviderSnapshot;
}

export interface CreateRunSnapshotInput {
  snapshotId: string;
  sessionId: string;
  sessionRevision: number;
  scenario: ScenarioSnapshot;
  instructions: CompiledInstructions;
  tools: RegisteredAgentTool[];
  dataScope: RunDataScopeSnapshot;
  provider: RunProviderSnapshot;
}

/** 递归冻结纯数据节点；函数仅作为不可变工具元数据引用保留。 */
function DeepFreeze<T>(value: T): T {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) DeepFreeze(child);
  return Object.freeze(value);
}

/** 克隆并冻结 Run 输入，避免模块配置或调用方数组在运行中修改已授权边界。 */
export function CreateRunSnapshot(input: CreateRunSnapshotInput): ImmutableRunSnapshot {
  const tools = input.tools.map((tool) => ({
    ...tool,
    definition: JSON.parse(JSON.stringify(tool.definition)) as RegisteredAgentTool['definition'],
    ...(tool.limits ? { limits: { ...tool.limits } } : {}),
    ...(tool.allowedScenarios ? { allowedScenarios: [...tool.allowedScenarios] } : {}),
  }));
  const scenario = {
    ...input.scenario,
    toolNames: [...input.scenario.toolNames],
    ...(input.scenario.budgets ? { budgets: { ...input.scenario.budgets } } : {}),
  };
  const instructions = {
    ...input.instructions,
    manifest: {
      ...input.instructions.manifest,
      fragments: input.instructions.manifest.fragments.map((fragment) => ({ ...fragment })),
    },
    ...(input.instructions.layers ? { layers: input.instructions.layers.map((layer) => ({ ...layer })) } : {}),
  };
  const snapshot: ImmutableRunSnapshot = {
    snapshotId: input.snapshotId,
    sessionId: input.sessionId,
    sessionRevision: input.sessionRevision,
    scenario,
    instructions,
    tools,
    toolNames: tools.map((tool) => tool.definition.function.name),
    dataScope: { ...input.dataScope, attachmentPaths: [...input.dataScope.attachmentPaths] },
    provider: { ...input.provider, capabilities: [...input.provider.capabilities] },
  };
  if (snapshot.toolNames.some((name) => !snapshot.scenario.toolNames.includes(name))) {
    throw new Error('Run tool snapshot contains a tool outside the scenario whitelist.');
  }
  return DeepFreeze(snapshot);
}
