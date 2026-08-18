"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SlotToModuleKey = void 0;
/** 槽位名 → AgentModules 聚合键名映射：SlotOrder 为连字符命名，聚合键为驼峰命名。 */
exports.SlotToModuleKey = {
    'model-provider': 'modelProvider',
    'context-builder': 'contextBuilder',
    compaction: 'compaction',
    tools: 'tools',
    interaction: 'interaction',
    observability: 'observability',
};
