"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SlotToModuleKey = exports.SlotOrder = void 0;
/** agent-sdk：Agent 模块化 SDK——六槽接口、窄 Port、Manifest、Tool 契约与 Kernel 接口的唯一来源；零运行时依赖。 */
var manifest_1 = require("./manifest");
Object.defineProperty(exports, "SlotOrder", { enumerable: true, get: function () { return manifest_1.SlotOrder; } });
var modules_1 = require("./modules");
Object.defineProperty(exports, "SlotToModuleKey", { enumerable: true, get: function () { return modules_1.SlotToModuleKey; } });
