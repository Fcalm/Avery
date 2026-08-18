"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ResolveModules = exports.ModuleResolutionError = exports.HostSdkVersion = void 0;
/** agent-module-host：模块解析、校验与会话模块快照；宿主据此装配六槽并持久化模块状态。 */
var resolver_1 = require("./resolver");
Object.defineProperty(exports, "HostSdkVersion", { enumerable: true, get: function () { return resolver_1.HostSdkVersion; } });
Object.defineProperty(exports, "ModuleResolutionError", { enumerable: true, get: function () { return resolver_1.ModuleResolutionError; } });
Object.defineProperty(exports, "ResolveModules", { enumerable: true, get: function () { return resolver_1.ResolveModules; } });
