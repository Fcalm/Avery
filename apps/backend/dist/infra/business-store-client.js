"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CreateBusinessStoreClient = CreateBusinessStoreClient;
const node_path_1 = require("node:path");
const worker_rpc_1 = require("./worker-rpc");
/**
 * 业务数据库的异步 RPC 客户端：把 Worker 内 BusinessStore 的全部方法暴露为 Promise 调用，
 * 行为与同步 Store 保持一致；客户端自身不加载 better-sqlite3，避免在 Backend 进程引入原生依赖。
 */
function CreateBusinessStoreClient({ workspacePath, smoke = false, upgradeFailure }) {
    const workerPath = (0, node_path_1.join)(__dirname, '..', 'workers', 'business-worker.js');
    const rpc = (0, worker_rpc_1.CreateRpcWorker)({ workerPath, workerData: { workspacePath, smoke, ...(smoke && upgradeFailure ? { upgradeFailure } : {}) } });
    // Proxy 只放行方法与元属性；未知属性按 RPC 方法调用，握手校验会拒绝未暴露的内部方法。
    return new Proxy({}, {
        get: (_target, prop) => {
            if (typeof prop === 'symbol' || prop === 'then')
                return undefined;
            const name = String(prop);
            if (name === 'ready')
                return rpc.Ready();
            if (name === 'methods')
                return rpc.Methods();
            if (name === 'onExit')
                return rpc.OnExit;
            if (name === 'close')
                return rpc.Close;
            if (name === 'call')
                return rpc.Call;
            if (name === 'worker')
                return rpc;
            return (...args) => rpc.Call(name, args);
        },
    });
}
