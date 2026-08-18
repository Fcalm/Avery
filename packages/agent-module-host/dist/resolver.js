"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ModuleResolutionError = exports.HostSdkVersion = void 0;
exports.ResolveModules = ResolveModules;
const agent_sdk_1 = require("@offerget/agent-sdk");
/** 宿主当前支持的 SDK 契约版本；模块 sdkVersion 必须与之完全匹配，否则拒绝启动（不做静默回退）。 */
exports.HostSdkVersion = '0.1.0';
const VersionPattern = /^\d+\.\d+\.\d+$/;
/** 模块解析失败：缺槽、槽位错配、版本不兼容或覆盖工厂失败均抛出；配置启动被阻止。 */
class ModuleResolutionError extends Error {
    constructor(message) {
        super(message);
        this.name = 'ModuleResolutionError';
    }
}
exports.ModuleResolutionError = ModuleResolutionError;
/** 校验单槽模块：清单字段完整、槽位匹配、版本合规、SDK 契约兼容。 */
function ValidateSlotModule(module, slot) {
    if (!module || typeof module !== 'object')
        throw new ModuleResolutionError(`Slot ${slot} module is missing.`);
    const manifest = module;
    if (manifest.slot !== slot)
        throw new ModuleResolutionError(`Slot ${slot} module declares slot ${String(manifest.slot)}.`);
    if (typeof manifest.name !== 'string' || typeof manifest.version !== 'string' || !VersionPattern.test(manifest.version)) {
        throw new ModuleResolutionError(`Slot ${slot} module version is invalid: ${String(manifest.version)}.`);
    }
    if (manifest.sdkVersion !== exports.HostSdkVersion) {
        throw new ModuleResolutionError(`Slot ${slot} module sdkVersion ${String(manifest.sdkVersion)} is incompatible with ${exports.HostSdkVersion}.`);
    }
    if (!Array.isArray(manifest.capabilities))
        throw new ModuleResolutionError(`Slot ${slot} module capabilities are invalid.`);
}
/** 按槽覆盖解析：缺槽、顺序漂移与版本不兼容都阻止启动；不静默回退。 */
function ResolveModules(input) {
    const overrides = input.overrides ?? {};
    const aggregate = {};
    const descriptors = [];
    for (const slot of agent_sdk_1.SlotOrder) {
        const override = overrides[slot];
        const moduleKey = agent_sdk_1.SlotToModuleKey[slot];
        let candidate;
        if (override) {
            // 覆盖工厂失败必须阻止启动（不静默回退到默认实现），错误统一包装并携带原因。
            try {
                candidate = override.create();
            }
            catch (error) {
                throw new ModuleResolutionError(`Slot ${slot} override failed to load: ${error instanceof Error ? error.message : String(error)}.`);
            }
        }
        else {
            candidate = input.defaults[moduleKey];
        }
        ValidateSlotModule(candidate, slot);
        aggregate[moduleKey] = candidate;
        descriptors.push({
            slot,
            name: String(candidate.name),
            version: String(candidate.version),
            sdkVersion: String(candidate.sdkVersion),
            capabilities: [...candidate.capabilities],
        });
    }
    const snapshot = {
        snapshotId: input.createId(),
        sessionId: input.sessionId,
        sessionRevision: input.sessionRevision,
        modules: descriptors,
        orderedSlots: [...agent_sdk_1.SlotOrder],
    };
    return { modules: aggregate, snapshot };
}
