import { BrowserWindow, dialog, safeStorage } from 'electron';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, basename, join } from 'node:path';
import { ExportResume } from './resume-export';

type WindowGetter = () => BrowserWindow | undefined;
type CredentialConfig = { provider: unknown; baseUrl: unknown; model: unknown; thinkingEnabled: unknown; contextLimit: unknown; compressionThreshold: unknown; apiKey: string };

async function selectDirectory(getWindow: WindowGetter, properties: Array<'openDirectory' | 'createDirectory'>): Promise<string | null> {
  const window = getWindow();
  const result = window && !window.isDestroyed() ? await dialog.showOpenDialog(window, { properties }) : await dialog.showOpenDialog({ properties });
  return result.canceled || !result.filePaths[0] ? null : result.filePaths[0];
}

/** 仅在 Main 进程接触原生目录、文件系统与 safeStorage。 */
export function CreateDesktopAdapters({ getWindow, userDataPath }: { getWindow: WindowGetter; userDataPath: string }) {
  const configPath = join(userDataPath, 'agent-config.json');
  return {
    SelectProjectDirectory: async () => { const selected = await selectDirectory(getWindow, ['openDirectory']); return selected ? { path: selected, name: basename(selected) } : null; },
    SelectModuleDirectory: async () => { const selected = await selectDirectory(getWindow, ['openDirectory']); return selected ? { path: selected, name: basename(selected) } : null; },
    SelectWorkspaceDirectory: () => selectDirectory(getWindow, ['openDirectory', 'createDirectory']),
    ExportResume: async ({ workspacePath, resume, format }: { workspacePath: string; resume: { name: string; summary: string; content: string }; format: 'pdf' | 'docx' | 'png' }) => {
      const result = await ExportResume({ BrowserWindow, workspacePath, resume, format });
      return { fileName: result.fileName, exported: true };
    },
    CredentialLoad: async () => {
      try {
        const stored = JSON.parse(await readFile(configPath, 'utf8')) as Record<string, unknown>;
        const encrypted = typeof stored.encryptedApiKey === 'string' ? stored.encryptedApiKey : '';
        return { ...stored, apiKey: encrypted && safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(Buffer.from(encrypted, 'base64')) : '' };
      } catch { return null; }
    },
    CredentialSave: async (config: CredentialConfig) => {
      if (!safeStorage.isEncryptionAvailable()) throw new Error('Secure storage is unavailable on this device.');
      await mkdir(dirname(configPath), { recursive: true });
      await writeFile(configPath, JSON.stringify({ provider: config.provider, baseUrl: config.baseUrl, model: config.model, thinkingEnabled: config.thinkingEnabled, contextLimit: config.contextLimit, compressionThreshold: config.compressionThreshold, encryptedApiKey: safeStorage.encryptString(config.apiKey).toString('base64') }, null, 2), 'utf8');
    },
  };
}
