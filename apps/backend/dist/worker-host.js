"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CreateWorkerHost = CreateWorkerHost;
const business_store_client_1 = require("./infra/business-store-client");
const observability_store_client_1 = require("./infra/observability-store-client");
/**
 * 组装业务与可观测性两个 DB Worker 的生命周期，向 Backend 提供统一的异步存储入口；
 * Business 与 Observability 各由唯一 Worker 持有连接，better-sqlite3 同步调用只存在于 Worker 内。
 */
function CreateWorkerHost({ workspacePath, userDataPath, smoke = false, upgradeFailure }) {
    const business = (0, business_store_client_1.CreateBusinessStoreClient)({ workspacePath, smoke, ...(smoke && upgradeFailure ? { upgradeFailure } : {}) });
    const observability = (0, observability_store_client_1.CreateObservabilityStoreClient)({ userDataPath, smoke });
    return {
        business,
        observability,
        /** 同时等待两个 Worker 的启动握手，任一失败 reject 带稳定 code 的 Error。 */
        async Ready() {
            await Promise.all([business.ready, observability.ready]);
            return { business: business.methods, observability: observability.methods };
        },
        /** 关闭并终止两个 DB Worker；供应用退出或 Backend 重启时调用。 */
        Close() {
            business.close();
            observability.close();
        },
    };
}
