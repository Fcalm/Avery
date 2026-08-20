import { type ErrorCodeValue } from '@offerget/contracts';
/** 单条命令 payload 上限；合法业务负载（如批量会话消息）远小于此，超过视为调用方缺陷。 */
export declare const MaxCommandPayloadBytes: number;
/** 只读命令通道集合：工作空间迁移期间仍放行，保证 UI 能读到当前数据。 */
export declare const ReadOnlyChannels: Set<string>;
/**
 * 校验信封级 requestId：只读显式参数，永不读取业务 payload（防止 payload 内 requestId 被误认或污染业务数据）。
 * 缺失时由 Router 生成；超长或非字符串按调用方缺陷拒绝，不静默替换。
 */
export declare function ExtractRequestId(requestId: unknown): string;
interface MethodRoute {
    service: string;
    method: string;
}
/** 通道 → 命名服务与方法的静态路由表；preload 方法签名与通道名不变。 */
export declare const MethodRoutes: Record<string, MethodRoute>;
/** 函数路由通道（编排型，由 CreateBackend 注入实现）。 */
export declare const FunctionRouteChannels: string[];
/** 事件发送通道：preload 用 ipcRenderer.on 订阅，不经 HandleCommand 分发。 */
export declare const EventChannels: string[];
/** 可重放写命令通道：Gateway 仅为这些通道接受 WriteCommandEnvelope，避免读取命令协议漂移。 */
export declare const WriteCommandChannels: Set<string>;
export interface BackendContainer {
    [service: string]: any;
}
export type FunctionRoutes = Record<string, (...args: any[]) => Promise<unknown> | unknown>;
export interface CreateBackendOptions {
    container: BackendContainer;
    functionRoutes?: FunctionRoutes;
    idempotencyStore?: {
        Get(key: string, payloadHash: string): {
            hit: boolean;
            conflict: boolean;
            result?: unknown;
        };
        Put(key: string, payloadHash: string, result: unknown): void;
    };
}
interface CommandLogEntry {
    requestId: string;
    channel: string;
    ok: boolean;
    at: number;
    agentRequestId?: string;
    idempotencyKey?: string;
}
/**
 * 组装后端命令分发器：container 提供命名服务，functionRoutes 覆盖编排型通道（如迁移热替换）。
 */
export declare function CreateBackend(options: CreateBackendOptions): {
    HandleCommand(channel: string, requestId: unknown, idempotencyKey: unknown, ...args: unknown[]): Promise<{
        ok: boolean;
        data?: unknown;
        error?: {
            code: ErrorCodeValue;
            message: string;
            retryable: boolean;
            details?: unknown;
        };
    }>;
    HandleChannels(): string[];
    Channels(): string[];
    GetCommandLog(): CommandLogEntry[];
};
export {};
