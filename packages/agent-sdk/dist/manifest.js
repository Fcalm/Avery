"use strict";
/** 模块清单与槽位契约：Host 依据清单校验槽位、加载顺序与版本兼容性。 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.SlotOrder = void 0;
/** 六槽固定加载顺序：模块数组按此顺序排序与快照。 */
exports.SlotOrder = ['model-provider', 'context-builder', 'compaction', 'tools', 'interaction', 'observability'];
