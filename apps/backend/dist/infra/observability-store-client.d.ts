export interface ObservabilityStoreClientOptions {
    userDataPath: string;
    smoke?: boolean;
}
/**
 * 可观测性数据库的异步 RPC 客户端：把 Worker 内 ObservabilityStore 的全部方法暴露为 Promise 调用，
 * 行为与同步 Store 保持一致；客户端自身不加载 better-sqlite3。
 * 动态方法门面使用 any 的原因同 business-store-client。
 */
export declare function CreateObservabilityStoreClient(options: ObservabilityStoreClientOptions): any;
