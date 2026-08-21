/** agent-module-host：模块解析、校验与会话模块快照；宿主据此装配六槽并持久化模块状态。 */
export { HostSdkVersion, ModuleResolutionError, ResolveModules } from './resolver';
export type { ModuleOverride, ModuleResolution, ModuleSlotDescriptor, ResolveModulesInput, SessionModuleSnapshot } from './resolver';
export { CreateRunSnapshot } from './run-snapshot';
export type { CreateRunSnapshotInput, ImmutableRunSnapshot, RunDataScopeSnapshot, RunProviderSnapshot } from './run-snapshot';
