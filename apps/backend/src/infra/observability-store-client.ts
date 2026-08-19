import { join } from 'node:path';
import { CreateRpcWorker, type RpcWorker } from './worker-rpc';

export interface ObservabilityStoreClientOptions {
  userDataPath: string;
  smoke?: boolean;
}

/**
 * 可观测性数据库的异步 RPC 客户端：把 Worker 内 ObservabilityStore 的全部方法暴露为 Promise 调用，
 * 行为与同步 Store 保持一致；客户端自身不加载 better-sqlite3。
 * 动态方法门面使用 any 的原因同 business-store-client。
 */
export function CreateObservabilityStoreClient(options: ObservabilityStoreClientOptions): any {
  const workerPath = join(__dirname, '..', 'workers', 'observability-worker.js');
  const rpc: RpcWorker = CreateRpcWorker({
    workerPath,
    workerData: { userDataPath: options.userDataPath, smoke: options.smoke ?? false },
  });

  return new Proxy({}, {
    get: (_target, prop) => {
      if (typeof prop === 'symbol' || prop === 'then') return undefined;
      const name = String(prop);
      if (name === 'ready') return rpc.Ready();
      if (name === 'methods') return rpc.Methods();
      if (name === 'onExit') return rpc.OnExit;
      if (name === 'close') return rpc.Close;
      if (name === 'call') return rpc.Call;
      if (name === 'worker') return rpc;
      return (...args: unknown[]) => rpc.Call(name, args);
    },
  });
}
