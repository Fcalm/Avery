"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DefaultsSdkVersion = exports.DefaultsVersion = exports.DefaultsPackageName = void 0;
exports.CreateDefaultModules = CreateDefaultModules;
const provider_1 = require("./provider");
const context_1 = require("./context");
const compaction_1 = require("./compaction");
const tools_1 = require("./tools");
const interaction_1 = require("./interaction");
const observability_1 = require("./observability");
/** 默认模块包名与契约版本：解析器据此校验。 */
exports.DefaultsPackageName = '@offerget/agent-modules-defaults';
exports.DefaultsVersion = '0.1.0';
exports.DefaultsSdkVersion = '0.1.0';
/** 构造官方默认六槽聚合；端口（密钥/文件/简历/观测存储）全部由宿主注入，模块不持有任何 Node 业务能力。 */
function CreateDefaultModules(ports) {
    return {
        modelProvider: (0, provider_1.CreateProviderModule)(ports),
        contextBuilder: (0, context_1.CreateContextBuilderModule)(ports),
        compaction: (0, compaction_1.CreateCompactionModule)(),
        tools: (0, tools_1.CreateToolsModule)(ports),
        interaction: (0, interaction_1.CreateInteractionModule)(),
        observability: (0, observability_1.CreateObservabilityModule)(ports),
    };
}
