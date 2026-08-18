"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
// @ts-nocheck
const { dialog, BrowserWindow, safeStorage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { ExportResume } = require('./resume-export.js');
/** 带父窗口的目录选择；主窗口尚未创建时退化为无父对话框。 */
function ShowDirectoryDialog(getWindow, properties) {
    const window = getWindow();
    const options = { properties };
    return window && !window.isDestroyed()
        ? dialog.showOpenDialog(window, options)
        : dialog.showOpenDialog(options);
}
/** 桌面能力适配器：目录选择与简历导出只在这里使用 Electron 对话框 / BrowserWindow；凭据经 safeStorage 加解密。 */
function CreateDesktopAdapters({ getWindow, userDataPath }) {
    const configPath = path.join(userDataPath, 'agent-config.json');
    return {
        /** 选择并返回项目环境目录（名称供展示）。 */
        SelectProjectDirectory: async () => {
            const result = await ShowDirectoryDialog(getWindow, ['openDirectory']);
            return result.canceled || !result.filePaths[0] ? null : { path: result.filePaths[0], name: path.basename(result.filePaths[0]) };
        },
        /** 选择高级用户明确信任的本地 Agent 模块目录。 */
        SelectModuleDirectory: async () => {
            const result = await ShowDirectoryDialog(getWindow, ['openDirectory']);
            return result.canceled || !result.filePaths[0] ? null : { path: result.filePaths[0], name: path.basename(result.filePaths[0]) };
        },
        /** 选择工作空间迁移目标目录；可新建目录。 */
        SelectWorkspaceDirectory: async () => {
            const result = await ShowDirectoryDialog(getWindow, ['openDirectory', 'createDirectory']);
            return result.canceled || !result.filePaths[0] ? null : result.filePaths[0];
        },
        /** 以隐藏渲染窗口导出简历；workspacePath 由 Backend 传入，属 Main 可信边界；只返回掩码文件名，不暴露导出路径。 */
        ExportResume: async ({ workspacePath, resume, format }) => {
            const result = await ExportResume({ BrowserWindow, workspacePath, resume, format });
            return { fileName: result.fileName, exported: true };
        },
        /** 读取主进程私有配置并解密 API Key；损坏或缺省返回 null。 */
        CredentialLoad: async () => {
            try {
                const stored = JSON.parse(await fs.promises.readFile(configPath, 'utf8'));
                const apiKey = stored.encryptedApiKey && safeStorage.isEncryptionAvailable()
                    ? safeStorage.decryptString(Buffer.from(stored.encryptedApiKey, 'base64'))
                    : '';
                return { ...stored, apiKey };
            }
            catch {
                return null;
            }
        },
        /** 保存经校验的模型配置，API Key 仅以 safeStorage 密文落盘。 */
        CredentialSave: async (config) => {
            if (!safeStorage.isEncryptionAvailable())
                throw new Error('Secure storage is unavailable on this device.');
            await fs.promises.mkdir(path.dirname(configPath), { recursive: true });
            await fs.promises.writeFile(configPath, JSON.stringify({
                provider: config.provider,
                baseUrl: config.baseUrl,
                model: config.model,
                thinkingEnabled: config.thinkingEnabled, contextLimit: config.contextLimit, compressionThreshold: config.compressionThreshold,
                encryptedApiKey: safeStorage.encryptString(config.apiKey).toString('base64'),
            }, null, 2), 'utf8');
        },
    };
}
module.exports = { CreateDesktopAdapters };
