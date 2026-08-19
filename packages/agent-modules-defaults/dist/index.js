"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DefaultScenario = exports.CompilePrompt = exports.BuildDefaultPromptFragments = exports.BuildDefaultCompiledInstructions = exports.ApplicationScenarioPlaceholder = exports.DefaultsVersion = exports.DefaultsSdkVersion = exports.DefaultsPackageName = exports.CreateDefaultModules = void 0;
/** agent-modules-defaults：官方默认六槽模块实现与默认模块端口。 */
var defaults_1 = require("./defaults");
Object.defineProperty(exports, "CreateDefaultModules", { enumerable: true, get: function () { return defaults_1.CreateDefaultModules; } });
Object.defineProperty(exports, "DefaultsPackageName", { enumerable: true, get: function () { return defaults_1.DefaultsPackageName; } });
Object.defineProperty(exports, "DefaultsSdkVersion", { enumerable: true, get: function () { return defaults_1.DefaultsSdkVersion; } });
Object.defineProperty(exports, "DefaultsVersion", { enumerable: true, get: function () { return defaults_1.DefaultsVersion; } });
var prompts_1 = require("./prompts");
Object.defineProperty(exports, "ApplicationScenarioPlaceholder", { enumerable: true, get: function () { return prompts_1.ApplicationScenarioPlaceholder; } });
Object.defineProperty(exports, "BuildDefaultCompiledInstructions", { enumerable: true, get: function () { return prompts_1.BuildDefaultCompiledInstructions; } });
Object.defineProperty(exports, "BuildDefaultPromptFragments", { enumerable: true, get: function () { return prompts_1.BuildDefaultPromptFragments; } });
Object.defineProperty(exports, "CompilePrompt", { enumerable: true, get: function () { return prompts_1.CompilePrompt; } });
Object.defineProperty(exports, "DefaultScenario", { enumerable: true, get: function () { return prompts_1.DefaultScenario; } });
