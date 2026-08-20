export interface RpcWorker {
    Methods(): string[];
    Ready(): Promise<{
        methods: string[];
    }>;
    OnExit(listener: (code: number) => void): void;
    Call(method: string, args?: unknown[]): Promise<unknown>;
    Close(): void;
}
/** 返回崩溃退避重启延迟：1s/2s/4s/…/30s 封顶，attempt 从 0 开始累计。 */
export declare function RestartDelayMs(attempt: number): number;
/**
 * 创建一个绑定单个 Worker 的 RPC 客户端：启动握手、请求-响应往返、错误归一与崩溃退避重启。
 * transport-agnostic——workerPath 指向任意持有统一消息协议（type: ready/error/response）的入口文件，
 * 因此 DB Worker 从 worker_threads 切到 utilityProcess 时只需替换本模块的 Worker 实现。
 */
export declare function CreateRpcWorker({ workerPath, workerData }: {
    workerPath: string;
    workerData: Record<string, unknown>;
}): RpcWorker;
