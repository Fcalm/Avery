import type { AgentModules, SlotName } from '@offerget/agent-sdk';
import { SlotOrder, SlotToModuleKey } from '@offerget/agent-sdk';

/** 宿主当前支持的 SDK 契约版本；模块 sdkVersion 必须与之完全匹配，否则拒绝启动（不做静默回退）。 */
export const HostSdkVersion = '0.1.0';

const VersionPattern = /^\d+\.\d+\.\d+$/;

/** 模块解析失败：缺槽、槽位错配、版本不兼容或覆盖工厂失败均抛出；配置启动被阻止。 */
export class ModuleResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ModuleResolutionError';
  }
}

/** 槽位覆盖：本阶段机制就位、入口延后；工厂失败必须向上抛出，不静默回退到默认实现。 */
export interface ModuleOverride {
  packageName: string;
  name: string;
  version: string;
  sdkVersion: string;
  create: () => unknown;
}

/** 单槽模块描述：进入会话模块快照的稳定形状。 */
export interface ModuleSlotDescriptor {
  slot: SlotName;
  name: string;
  version: string;
  sdkVersion: string;
  capabilities: string[];
}

/** 会话模块快照：记录每会话实际加载的六槽模块，宿主持久化以检测模块漂移。 */
export interface SessionModuleSnapshot {
  snapshotId: string;
  sessionId: string;
  sessionRevision: number;
  modules: ModuleSlotDescriptor[];
  orderedSlots: SlotName[];
}

export interface ResolveModulesInput {
  sessionId: string;
  sessionRevision: number;
  /** 官方默认六槽聚合（宿主经 CreateDefaultModules 构造）。 */
  defaults: AgentModules;
  /** 按槽覆盖：本阶段为空；覆盖工厂失败不静默回退。 */
  overrides?: Partial<Record<SlotName, ModuleOverride>>;
  /** 生成快照标识的注入函数：宿主提供 crypto.randomUUID，保持包无 Node 依赖。 */
  createId: () => string;
}

export interface ModuleResolution {
  modules: AgentModules;
  snapshot: SessionModuleSnapshot;
}

/** 校验单槽模块：清单字段完整、槽位匹配、版本合规、SDK 契约兼容。 */
function ValidateSlotModule(module: unknown, slot: SlotName): asserts module is Record<string, unknown> {
  if (!module || typeof module !== 'object') throw new ModuleResolutionError(`Slot ${slot} module is missing.`);
  const manifest = module as Record<string, unknown>;
  if (manifest.slot !== slot) throw new ModuleResolutionError(`Slot ${slot} module declares slot ${String(manifest.slot)}.`);
  if (typeof manifest.name !== 'string' || typeof manifest.version !== 'string' || !VersionPattern.test(manifest.version)) {
    throw new ModuleResolutionError(`Slot ${slot} module version is invalid: ${String(manifest.version)}.`);
  }
  if (manifest.sdkVersion !== HostSdkVersion) {
    throw new ModuleResolutionError(`Slot ${slot} module sdkVersion ${String(manifest.sdkVersion)} is incompatible with ${HostSdkVersion}.`);
  }
  if (!Array.isArray(manifest.capabilities)) throw new ModuleResolutionError(`Slot ${slot} module capabilities are invalid.`);
}

/** 按槽覆盖解析：缺槽、顺序漂移与版本不兼容都阻止启动；不静默回退。 */
export function ResolveModules(input: ResolveModulesInput): ModuleResolution {
  const overrides = input.overrides ?? {};
  const aggregate: Record<keyof AgentModules, unknown> = {} as Record<keyof AgentModules, unknown>;
  const descriptors: ModuleSlotDescriptor[] = [];

  for (const slot of SlotOrder) {
    const override = overrides[slot];
    const moduleKey = SlotToModuleKey[slot];
    let candidate: unknown;
    if (override) {
      // 覆盖工厂失败必须阻止启动（不静默回退到默认实现），错误统一包装并携带原因。
      try {
        candidate = override.create();
      } catch (error) {
        throw new ModuleResolutionError(`Slot ${slot} override failed to load: ${error instanceof Error ? error.message : String(error)}.`);
      }
    } else {
      candidate = input.defaults[moduleKey];
    }
    ValidateSlotModule(candidate, slot);
    aggregate[moduleKey] = candidate;
    descriptors.push({
      slot,
      name: String(candidate.name),
      version: String(candidate.version),
      sdkVersion: String(candidate.sdkVersion),
      capabilities: [...(candidate.capabilities as string[])],
    });
  }

  const snapshot: SessionModuleSnapshot = {
    snapshotId: input.createId(),
    sessionId: input.sessionId,
    sessionRevision: input.sessionRevision,
    modules: descriptors,
    orderedSlots: [...SlotOrder],
  };
  return { modules: aggregate as unknown as AgentModules, snapshot };
}
