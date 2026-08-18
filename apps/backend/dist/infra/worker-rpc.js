"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.RestartDelayMs = RestartDelayMs;
exports.CreateRpcWorker = CreateRpcWorker;
const node_worker_threads_1 = require("node:worker_threads");
/** 返回崩溃退避重启延迟：1s/2s/4s/…/30s 封顶，attempt 从 0 开始累计。 */
function RestartDelayMs(attempt) {
    return Math.min(1000 * 2 ** attempt, 30000);
}
/**
 * 创建一个绑定单个 Worker 的 RPC 客户端：启动握手、请求-响应往返、错误归一与崩溃退避重启。
 * transport-agnostic——workerPath 指向任意持有统一消息协议（type: ready/error/response）的入口文件，
 * 因此 DB Worker 从 worker_threads 切到 utilityProcess 时只需替换本模块的 Worker 实现。
 */
function CreateRpcWorker({ workerPath, workerData }) {
    let worker = null;
    let nextId = 1;
    let methods = [];
    let readyPromise = null;
    let resolveReady = null;
    let rejectReady = null;
    let closed = false;
    let restartAttempt = 0;
    let restartTimer = null;
    let bootError = null;
    let exitListener = null;
    const pending = new Map();
    /** 以稳定错误码拒绝全部在途请求，供崩溃与关闭场景使用。 */
    function FailAll(code, message) {
        const error = Object.assign(new Error(message), { code });
        for (const entry of pending.values())
            entry.reject(error);
        pending.clear();
    }
    /** 记录启动失败原因并拒绝握手；设置 bootError 后崩溃退出不再自动重启。 */
    function RejectReady(code, message) {
        bootError = Object.assign(new Error(message), { code });
        rejectReady?.(bootError);
        rejectReady = null;
    }
    /** 派生并监听一个新的 Worker 线程；启动失败以错误信封传回，运行中崩溃则按指数退避自动重启。 */
    function Spawn() {
        readyPromise = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
        bootError = null;
        worker = new node_worker_threads_1.Worker(workerPath, { workerData });
        worker.on('message', (message) => {
            if (!message || typeof message.type !== 'string')
                return;
            if (message.type === 'ready') {
                methods = Array.isArray(message.methods) ? message.methods : [];
                restartAttempt = 0;
                resolveReady?.({ methods });
                resolveReady = null;
                return;
            }
            if (message.type === 'error') {
                RejectReady(message.code ? String(message.code) : 'STORAGE_ERROR', message.message ? String(message.message) : 'Worker failed to initialize.');
                return;
            }
            if (message.type === 'response') {
                const id = message.id === undefined || message.id === null ? '' : String(message.id);
                const entry = pending.get(id);
                if (!entry)
                    return;
                pending.delete(id);
                if (message.ok)
                    entry.resolve(message.data);
                else {
                    const workerError = Object.assign(new Error(message.error?.message ? String(message.error.message) : 'Worker method failed.'), { code: message.error?.code ? String(message.error.code) : 'STORAGE_ERROR' });
                    if (message.error?.details && typeof message.error.details === 'object')
                        workerError.details = message.error.details;
                    if (message.error?.retryable === true)
                        workerError.retryable = true;
                    entry.reject(workerError);
                }
            }
        });
        worker.on('error', (error) => {
            RejectReady('STORAGE_ERROR', error?.message || 'Worker thread crashed.');
            FailAll('STORAGE_ERROR', error?.message || 'Worker thread crashed.');
        });
        worker.on('exit', (code) => {
            FailAll('STORAGE_ERROR', `Worker exited with code ${code}.`);
            // 运行中崩溃才自动重启；启动失败（bootError 已记录）重复同一 workerData 无意义，交由宿主上报。
            if (!closed && code !== 0 && !bootError) {
                const delay = RestartDelayMs(restartAttempt++);
                restartTimer = setTimeout(Spawn, delay);
            }
            exitListener?.(code);
        });
    }
    Spawn();
    return {
        /** 返回当前暴露的方法清单；握手完成前为空数组。 */
        Methods() { return [...methods]; },
        /** 等待启动握手完成：成功 resolve 方法清单，初始化失败 reject 带稳定 code 的 Error。 */
        Ready() { return readyPromise; },
        /** 绑定崩溃退出监听；回调收到子线程退出码，供宿主记录与恢复。 */
        OnExit(listener) { exitListener = listener; },
        /** 调用 Worker 暴露的方法；方法未在握手清单内时以 INTERNAL_ERROR 拒绝，防止内部方法被误放行。 */
        async Call(method, args = []) {
            if (closed)
                throw Object.assign(new Error('Worker is closed.'), { code: 'STORAGE_ERROR' });
            // Spawn() 启动即初始化 readyPromise，此处恒非空。
            const ready = (await readyPromise);
            if (!ready.methods.includes(method))
                throw Object.assign(new Error(`Worker method "${method}" is not exposed.`), { code: 'INTERNAL_ERROR' });
            const id = String(nextId++);
            return new Promise((resolve, reject) => {
                pending.set(id, { resolve, reject });
                worker?.postMessage({ type: 'request', id, method, args });
            });
        },
        /** 关闭并终止 Worker；在途请求以 STORAGE_ERROR 拒绝，此后不再自动重启。 */
        Close() {
            closed = true;
            if (restartTimer)
                clearTimeout(restartTimer);
            FailAll('STORAGE_ERROR', 'Worker is closing.');
            try {
                void worker?.terminate();
            }
            catch { /* 终止阶段重复关闭无需额外处理。 */ }
        },
    };
}
