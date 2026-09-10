import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  BrowserWindow: class {},
  dialog: {},
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(`encrypted:${value}`, 'utf8'),
    decryptString: (value: Buffer) => value.toString('utf8').replace(/^encrypted:/, ''),
  },
}));

import { CreateDesktopAdapters } from '../../../apps/desktop/src/adapters';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

function Config(provider: 'DeepSeek' | 'Z.AI', apiKey: string) {
  return {
    provider,
    apiKey,
    baseUrl: provider === 'DeepSeek' ? 'https://api.deepseek.com' : 'https://open.bigmodel.cn/api/paas/v4',
    model: provider === 'DeepSeek' ? 'deepseek-v4-flash' : 'glm-5.3-flash',
    thinkingEnabled: true,
    contextLimit: 256000,
    contextLimitMode: 'default' as const,
    compressionThreshold: 80,
  };
}

describe('Desktop Credential adapter', () => {
  it('按 Provider 分别加密保存 API Key，切换后仍能完整加载', async () => {
    const root = await mkdtemp(join(tmpdir(), 'avery-provider-credentials-'));
    roots.push(root);
    const adapters = CreateDesktopAdapters({ getWindow: () => undefined, userDataPath: root });

    await adapters.CredentialSave(Config('DeepSeek', 'deepseek-secret'));
    await adapters.CredentialSave(Config('Z.AI', 'zai-secret'));
    const loaded = await adapters.CredentialLoad();
    const storedText = await readFile(join(root, 'agent-config.json'), 'utf8');

    expect(loaded).toMatchObject({
      provider: 'Z.AI', apiKey: 'zai-secret',
      providerConfigs: { DeepSeek: { apiKey: 'deepseek-secret' }, 'Z.AI': { apiKey: 'zai-secret' } },
    });
    expect(storedText).not.toContain('deepseek-secret');
    expect(storedText).not.toContain('zai-secret');
    expect(JSON.parse(storedText)).toMatchObject({ schemaVersion: 2, activeProvider: 'Z.AI' });
  });

  it('读取旧版单 Provider 文件，并在下一次保存时无损迁移', async () => {
    const root = await mkdtemp(join(tmpdir(), 'avery-provider-credential-migration-'));
    roots.push(root);
    await writeFile(join(root, 'agent-config.json'), JSON.stringify({
      ...Config('DeepSeek', ''), encryptedApiKey: Buffer.from('encrypted:legacy-secret').toString('base64'),
    }), 'utf8');
    const adapters = CreateDesktopAdapters({ getWindow: () => undefined, userDataPath: root });

    await expect(adapters.CredentialLoad()).resolves.toMatchObject({ provider: 'DeepSeek', apiKey: 'legacy-secret' });
    await adapters.CredentialSave(Config('Z.AI', 'zai-secret'));
    await expect(adapters.CredentialLoad()).resolves.toMatchObject({
      providerConfigs: { DeepSeek: { apiKey: 'legacy-secret' }, 'Z.AI': { apiKey: 'zai-secret' } },
    });
  });
});
