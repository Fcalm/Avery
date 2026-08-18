"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.RestartDelayMs = RestartDelayMs;
exports.CreateBackendHost = CreateBackendHost;
const electron_1 = require("electron");
const node_path_1 = require("node:path");
const node_crypto_1 = require("node:crypto");
const router_1 = require("./router");
/** 返回崩溃退避重启延迟：1s/2s/4s/…/30s 封顶，attempt 从 0 开始累计。 */
function RestartDelayMs(attempt) {
    return Math.min(1000 * 2 ** attempt, 30000);
}
/** 管理 Backend Utility Process 生命周期：fork、握手、健康检查、请求超时、取消、崩溃退避重启与在途拒绝。 */
function CreateBackendHost({ appContext, desktopCapabilities = {}, onEvent }) {
    const channels = [...Object.keys(router_1.MethodRoutes), ...router_1.FunctionRouteChannels];
    let child = null;
    let state = 'starting';
    let stopped = false;
    let restartAttempt = 0;
    let restartTimer = null;
    let readyResolve = null;
    let eventListener = onEvent;
    let pingTimer = null;
    let missedPongs = 0;
    // 幂等记录会跨应用启动持久化；不能在每次启动后从 req-1 重新计数，否则新的写命令会
    // 被误判为旧请求的冲突重放。启动实例 ID 只用于传输幂等键，不包含用户数据。
    const commandSessionId = (0, node_crypto_1.randomUUID)();
    let nextRequestId = 1;
    const pending = new Map();
    /** 以稳定错误码拒绝全部在途请求，供崩溃与关闭场景使用。 */
    function FailAll(code, message) {
        const error = Object.assign(new Error(message), { code, retryable: true });
        for (const entry of pending.values()) {
            clearTimeout(entry.timer);
            entry.reject(error);
        }
        pending.clear();
    }
    /** 每 15 秒发送健康检查；连续 3 次未收到 pong 判定崩溃并强制重启。 */
    function StartPing() {
        pingTimer = setInterval(() => {
            if (state !== 'ready' || !child)
                return;
            try {
                child.postMessage({ kind: 'ping', seq: nextRequestId++ });
            }
            catch {
                return;
            }
            missedPongs += 1;
            if (missedPongs >= 3) {
                try {
                    child.kill();
                }
                catch { /* 已退出的进程无需重复终止。 */ }
            }
        }, 15000);
    }
    function StopPing() {
        if (pingTimer) {
            clearInterval(pingTimer);
            pingTimer = null;
        }
    }
    /** 派生并监听 Backend 子进程；ready 握手成功后接受命令，崩溃时按指数退避自动重启。 */
    function Spawn() {
        state = 'starting';
        const backendPath = (0, node_path_1.join)(__dirname, 'index.js');
        child = electron_1.utilityProcess.fork(backendPath, [], { serviceName: 'offerget-backend' });
        child.once('spawn', () => {
            child?.stdout?.on('data', (chunk) => process.stdout.write(chunk));
            child?.stderr?.on('data', (chunk) => process.stderr.write(chunk));
        });
        child.on('message', async (message) => {
            const typed = message;
            if (!typed || typeof typed.kind !== 'string')
                return;
            if (typed.kind === 'backend-error') {
                console.error(`[backend-error] code=${typed.code} message=${typed.message}`);
                return;
            }
            if (typed.kind === 'debug') {
                return;
            }
            if (typed.kind === 'ready') {
                state = 'ready';
                restartAttempt = 0;
                missedPongs = 0;
                readyResolve?.();
                readyResolve = null;
                StartPing();
                return;
            }
            if (typed.kind === 'result') {
                const entry = typed.requestId ? pending.get(typed.requestId) : undefined;
                if (!entry)
                    return;
                pending.delete(typed.requestId);
                clearTimeout(entry.timer);
                entry.resolve(typed.result);
                return;
            }
            if (typed.kind === 'event') {
                eventListener?.(typed.payload);
                return;
            }
            if (typed.kind === 'pong') {
                missedPongs = 0;
                return;
            }
            if (typed.kind === 'desktop') {
                const capability = typed.capability ? desktopCapabilities[typed.capability] : undefined;
                if (typeof capability !== 'function') {
                    try {
                        child?.postMessage({ kind: 'desktop-result', id: typed.id, ok: false, error: 'Desktop capability is unknown.' });
                    }
                    catch { /* 子进程已退出时丢弃。 */ }
                    return;
                }
                try {
                    const data = await capability(...(Array.isArray(typed.args) ? typed.args : []));
                    try {
                        child?.postMessage({ kind: 'desktop-result', id: typed.id, ok: true, data });
                    }
                    catch { /* 子进程已退出时丢弃。 */ }
                }
                catch (error) {
                    try {
                        child?.postMessage({ kind: 'desktop-result', id: typed.id, ok: false, error: error instanceof Error ? error.message : 'Desktop capability failed.' });
                    }
                    catch { /* 子进程已退出时丢弃。 */ }
                }
                return;
            }
        });
        child.on('exit', (code) => {
            FailAll('INTERNAL_ERROR', `Backend exited with code ${code}.`);
            StopPing();
            state = 'restarting';
            if (!stopped) {
                const delay = RestartDelayMs(restartAttempt++);
                restartTimer = setTimeout(Spawn, delay);
            }
        });
        child.postMessage({ kind: 'hello', app: appContext });
    }
    Spawn();
    return {
        /** 返回当前后端状态：starting | ready | restarting | stopped。 */
        state: () => state,
        /** 返回仅需 ipcMain.handle 注册的命令通道，供 Main Gateway 遍历。 */
        HandleChannels() { return [...channels]; },
        /** 绑定事件回调（agent:stream 回流 Renderer）。 */
        OnEvent(listener) { eventListener = listener; },
        /** 向 Backend 发送一条命令并等待统一结果信封；后端不可用或超时以 INTERNAL_ERROR 拒绝。 */
        async Command(channel, ...args) {
            if (state !== 'ready')
                throw Object.assign(new Error(`Backend is ${state}.`), { code: 'INTERNAL_ERROR', retryable: true, details: { backendState: state } });
            if (!channels.includes(channel))
                throw Object.assign(new Error(`Unknown IPC channel: ${channel}.`), { code: 'INTERNAL_ERROR' });
            const requestId = `req-${commandSessionId}-${nextRequestId++}`;
            const timeout = channel === 'agent:send' ? 5 * 60 * 1000
                : channel === 'workspace:migrate' ? 2 * 60 * 1000
                    : 30000;
            return new Promise((resolve, reject) => {
                const timer = setTimeout(() => {
                    if (pending.has(requestId)) {
                        pending.delete(requestId);
                        reject(Object.assign(new Error('Backend request timed out.'), { code: 'INTERNAL_ERROR', retryable: true, details: { backendState: state } }));
                    }
                }, timeout);
                pending.set(requestId, { resolve, reject, timer });
                child?.postMessage({ kind: 'command', requestId, channel, payload: args });
            });
        },
        /** 优雅关闭 Backend：发 shutdown 并延迟兜底 kill，阻止自动重启。 */
        Shutdown() {
            stopped = true;
            StopPing();
            if (restartTimer)
                clearTimeout(restartTimer);
            FailAll('INTERNAL_ERROR', 'Backend is shutting down.');
            try {
                child?.postMessage({ kind: 'shutdown' });
            }
            catch { /* 子进程已退出时忽略。 */ }
            setTimeout(() => { try {
                child?.kill();
            }
            catch { /* 终止阶段无需额外处理。 */ } }, 800);
        },
        /** 返回当前子进程实例，供冒烟测试模拟崩溃。 */
        GetChild() { return child; },
    };
}
