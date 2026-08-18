"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
// @ts-nocheck
/** Backend 侧凭据端口：经反向 RPC 把 API Key 移交 Main 侧 safeStorage 加解密，Backend 自身永不落盘。 */
function CreateCredentialClient(desktopCapability) {
    return {
        /** 读取主进程私有配置；未配置返回 null。 */
        async Load() {
            const result = await desktopCapability.Call('CredentialLoad');
            return result || null;
        },
        /** 保存经校验的模型配置，API Key 由 Main 加密后落盘。 */
        async Save(config) {
            await desktopCapability.Call('CredentialSave', [config]);
        },
    };
}
module.exports = { CreateCredentialClient };
