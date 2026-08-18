"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
// @ts-nocheck
/** Backend → Main 的反向 RPC 客户端：请求桌面能力（对话框/导出/凭据）并等待 Main 适配器返回结果。 */
function CreateDesktopCapabilityClient(postMessage) {
    const pending = new Map();
    let nextId = 1;
    return {
        /** 由 Backend 消息循环调用，处理 Main 返回的 desktop-result。 */
        OnMessage(message) {
            if (!message || message.kind !== 'desktop-result')
                return;
            const entry = pending.get(message.id);
            if (!entry)
                return;
            pending.delete(message.id);
            if (message.ok)
                entry.resolve(message.data);
            else
                entry.reject(new Error(message.error || 'Desktop capability failed.'));
        },
        /** 调用一个桌面能力；能力未实现或异常时以错误拒绝。 */
        Call(capability, args = []) {
            const id = `desktop-${nextId++}`;
            return new Promise((resolve, reject) => {
                pending.set(id, { resolve, reject });
                postMessage({ kind: 'desktop', id, capability, args });
            });
        },
    };
}
module.exports = { CreateDesktopCapabilityClient };
