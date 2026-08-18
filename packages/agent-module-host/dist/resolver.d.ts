import type { AgentModules, SlotName } from '@offerget/agent-sdk';
/** 宿主当前支持的 SDK 契约版本；模块 sdkVersion 必须与之完全匹配，否则拒绝启动（不做静默回退）。 */
export declare const HostSdkVersion = "0.1.0";
/** 模块解析失败：缺槽、槽位错配、版本不兼容或覆盖工厂失败均抛出；配置启动被阻止。 */
export declare class ModuleResolutionError extends Error {
    constructor(message: string);
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
/** 按槽覆盖解析：缺槽、顺序漂移与版本不兼容都阻止启动；不静默回退。 */
export declare function ResolveModules(input: ResolveModulesInput): ModuleResolution;
