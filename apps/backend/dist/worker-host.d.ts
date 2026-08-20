export interface CreateWorkerHostOptions {
    workspacePath: string;
    userDataPath: string;
    smoke?: boolean;
    upgradeFailure?: string;
}
/**
 * 组装业务与可观测性两个 DB Worker 的生命周期，向 Backend 提供统一的异步存储入口；
 * Business 与 Observability 各由唯一 Worker 持有连接，better-sqlite3 同步调用只存在于 Worker 内。
 */
export declare function CreateWorkerHost(options: CreateWorkerHostOptions): {
    business: any;
    observability: any;
    Ready(): Promise<{
        business: any;
        observability: any;
    }>;
    Close(): void;
};
