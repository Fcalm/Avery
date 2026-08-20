/** 返回崩溃退避重启延迟：1s/2s/4s/…/30s 封顶，attempt 从 0 开始累计。 */
export declare function RestartDelayMs(attempt: number): number;
export interface BackendHostOptions {
    appContext: any;
    desktopCapabilities?: Record<string, (...args: any[]) => any>;
    onEvent?: (payload: unknown) => void;
}
/** 管理 Backend Utility Process 生命周期：fork、握手、健康检查、请求超时、取消、崩溃退避重启与在途拒绝。 */
export declare function CreateBackendHost({ appContext, desktopCapabilities, onEvent }: BackendHostOptions): {
    state: () => string;
    HandleChannels(): string[];
    OnEvent(listener: (payload: unknown) => void): void;
    Command(channel: string, idempotencyKey: string | undefined, ...args: unknown[]): Promise<unknown>;
    Shutdown(): void;
    GetChild(): Electron.UtilityProcess | null;
};
