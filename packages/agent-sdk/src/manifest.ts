/** 模块清单与槽位契约：Host 依据清单校验槽位、加载顺序与版本兼容性。 */

/** 六槽固定加载顺序：模块数组按此顺序排序与快照。 */
export const SlotOrder = ['model-provider', 'context-builder', 'compaction', 'tools', 'interaction', 'observability'] as const;

/** 模块槽位名。 */
export type SlotName = (typeof SlotOrder)[number];

/** 模块清单：每个 Agent 模块必须声明；工具槽必须声明能力上限。 */
export interface ModuleManifest {
  /** 包名（如 @avery/agent-modules-defaults）。 */
  packageName: string;
  /** 模块短名（如 avery.agent-defaults）。 */
  name: string;
  /** 语义版本；不兼容版本由 Host 拒绝。 */
  version: string;
  /** 模块所基于的 SDK 契约版本；与宿主支持的版本不匹配即拒绝，不做静默回退。 */
  sdkVersion: string;
  /** 所属槽位，决定 Kernel 调用点与加载顺序。 */
  slot: SlotName;
  /** 能力声明：如模型补全、工具数量与权限上限；工具槽必须含 tools:N。 */
  capabilities: string[];
}
