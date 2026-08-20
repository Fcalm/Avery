"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
// @ts-nocheck
const { ipcMain } = require('electron');
const { MethodRoutes, FunctionRouteChannels } = require('../../backend/dist/router.js');
const MaxGatewayPayloadBytes = 10 * 1024 * 1024;
const WindowControlChannels = ['window:minimize', 'window:toggle-maximize', 'window:close'];
/** 单窗口/通道令牌桶：允许短时突发 30 次，随后以每秒 20 次恢复；长期超限返回结构化限流错误。 */
function CreateGatewayLimiter({ burst = 30, refillPerSecond = 20 } = {}) {
    const buckets = new Map();
    return {
        Allow(key, now = Date.now()) {
            const previous = buckets.get(key) ?? { tokens: burst, at: now };
            const elapsed = Math.max(0, now - previous.at);
            const tokens = Math.min(burst, previous.tokens + elapsed / 1000 * refillPerSecond);
            if (tokens < 1) {
                buckets.set(key, { tokens, at: now });
                return false;
            }
            buckets.set(key, { tokens: tokens - 1, at: now });
            return true;
        },
    };
}
/**
 * 校验 IPC 消息来源：必须来自受信任主窗口的 webContents，且发送帧与主窗口当前加载页同源。
 * 打包模式两端均为 file://，开发模式均为 Vite dev server origin；异源 iframe 或窗口被跳转到恶意站点时帧 URL origin 不同而拒绝。
 * 注意：不依赖 VITE_DEV_SERVER_URL 环境变量——dev:desktop 未设置该变量，旧的「file:// 或 devServer 前缀」判定会让开发模式所有 IPC 返回 PERMISSION_DENIED。
 */
function ValidateSender(event, webContentsGetter) {
    const window = webContentsGetter();
    if (!window || window.isDestroyed() || event.sender !== window.webContents)
        return false;
    const frame = event.senderFrame;
    if (!frame)
        return false;
    const frameUrl = String(frame.url || '');
    const loadedUrl = String(window.webContents.getURL() || '');
    if (frameUrl.startsWith('file://') && loadedUrl.startsWith('file://'))
        return true;
    try {
        return new URL(frameUrl).origin === new URL(loadedUrl).origin;
    }
    catch {
        return false;
    }
}
/** 按后端命令路由表注册渲染进程可调用的受限 IPC；所有 handler 先校验来源窗口，再统一结果信封出口。 */
function RegisterGateway({ backendHost, webContentsGetter }) {
    const channels = [...Object.keys(MethodRoutes), ...FunctionRouteChannels];
    const limiter = CreateGatewayLimiter();
    for (const channel of channels) {
        ipcMain.handle(channel, async (event, ...args) => {
            if (!ValidateSender(event, webContentsGetter)) {
                return { ok: false, error: { code: 'PERMISSION_DENIED', message: 'IPC sender is invalid.', retryable: false } };
            }
            const senderId = String(event.sender?.id ?? 'unknown');
            if (!limiter.Allow(`${senderId}:${channel}`)) {
                return { ok: false, error: { code: 'WORKSPACE_BUSY', message: '请求过于频繁，请稍后重试。', retryable: true } };
            }
            let serialized;
            try {
                serialized = JSON.stringify(args);
            }
            catch {
                return { ok: false, error: { code: 'VALIDATION_ERROR', message: 'IPC payload is not serializable.', retryable: false } };
            }
            if (serialized && Buffer.byteLength(serialized, 'utf8') > MaxGatewayPayloadBytes) {
                return { ok: false, error: { code: 'VALIDATION_ERROR', message: 'IPC payload is too large.', retryable: false } };
            }
            try {
                return await backendHost.Command(channel, undefined, ...args);
            }
            catch (error) {
                return { ok: false, error: { code: 'INTERNAL_ERROR', message: error?.message || 'Backend is unavailable.', retryable: true, details: { backendState: backendHost.state() } } };
            }
        });
    }
    backendHost.OnEvent((event) => {
        const window = webContentsGetter();
        if (window && !window.isDestroyed())
            window.webContents.send('agent:stream', event);
    });
}
/** 窗口控制同样只接受当前受信任渲染进程的请求，避免 frameless 窗口把 Electron 能力直接暴露给页面。 */
function RegisterWindowControls({ webContentsGetter }) {
    const actions = {
        'window:minimize': (window) => { window.minimize(); return true; },
        'window:toggle-maximize': (window) => {
            if (window.isMaximized())
                window.unmaximize();
            else
                window.maximize();
            return window.isMaximized();
        },
        'window:close': (window) => { window.close(); return true; },
    };
    for (const channel of WindowControlChannels) {
        ipcMain.handle(channel, (event) => {
            if (!ValidateSender(event, webContentsGetter))
                return false;
            const window = webContentsGetter();
            return window && !window.isDestroyed() ? actions[channel](window) : false;
        });
    }
}
module.exports = { CreateGatewayLimiter, MaxGatewayPayloadBytes, RegisterGateway, RegisterWindowControls, ValidateSender, WindowControlChannels };
