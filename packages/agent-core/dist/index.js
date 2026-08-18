"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ScrubTraceContent = exports.RunAgentLoop = void 0;
/** agent-core：纯 Agent 内核——RunAgentLoop 状态机；无 Node/Electron 依赖，业务态全部经参数与上下文注入。 */
var kernel_1 = require("./kernel");
Object.defineProperty(exports, "RunAgentLoop", { enumerable: true, get: function () { return kernel_1.RunAgentLoop; } });
Object.defineProperty(exports, "ScrubTraceContent", { enumerable: true, get: function () { return kernel_1.ScrubTraceContent; } });
