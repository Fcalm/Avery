"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CreateDesktopAdapters = CreateDesktopAdapters;
const electron_1 = require("electron");
const promises_1 = require("node:fs/promises");
const node_path_1 = require("node:path");
const resume_export_1 = require("./resume-export");
async function selectDirectory(getWindow, properties) {
    const window = getWindow();
    const result = window && !window.isDestroyed() ? await electron_1.dialog.showOpenDialog(window, { properties }) : await electron_1.dialog.showOpenDialog({ properties });
    return result.canceled || !result.filePaths[0] ? null : result.filePaths[0];
}
/** 仅在 Main 进程接触原生目录、文件系统与 safeStorage。 */
function CreateDesktopAdapters({ getWindow, userDataPath }) {
    const configPath = (0, node_path_1.join)(userDataPath, 'agent-config.json');
    return {
        SelectProjectDirectory: async () => { const selected = await selectDirectory(getWindow, ['openDirectory']); return selected ? { path: selected, name: (0, node_path_1.basename)(selected) } : null; },
        SelectModuleDirectory: async () => { const selected = await selectDirectory(getWindow, ['openDirectory']); return selected ? { path: selected, name: (0, node_path_1.basename)(selected) } : null; },
        SelectWorkspaceDirectory: () => selectDirectory(getWindow, ['openDirectory', 'createDirectory']),
        ExportResume: async ({ workspacePath, resume, format }) => {
            const result = await (0, resume_export_1.ExportResume)({ BrowserWindow: electron_1.BrowserWindow, workspacePath, resume, format });
            return { fileName: result.fileName, exported: true };
        },
        CredentialLoad: async () => {
            try {
                const stored = JSON.parse(await (0, promises_1.readFile)(configPath, 'utf8'));
                const encrypted = typeof stored.encryptedApiKey === 'string' ? stored.encryptedApiKey : '';
                return { ...stored, apiKey: encrypted && electron_1.safeStorage.isEncryptionAvailable() ? electron_1.safeStorage.decryptString(Buffer.from(encrypted, 'base64')) : '' };
            }
            catch {
                return null;
            }
        },
        CredentialSave: async (config) => {
            if (!electron_1.safeStorage.isEncryptionAvailable())
                throw new Error('Secure storage is unavailable on this device.');
            await (0, promises_1.mkdir)((0, node_path_1.dirname)(configPath), { recursive: true });
            await (0, promises_1.writeFile)(configPath, JSON.stringify({ provider: config.provider, baseUrl: config.baseUrl, model: config.model, thinkingEnabled: config.thinkingEnabled, contextLimit: config.contextLimit, compressionThreshold: config.compressionThreshold, encryptedApiKey: electron_1.safeStorage.encryptString(config.apiKey).toString('base64') }, null, 2), 'utf8');
        },
    };
}
