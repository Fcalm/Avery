import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const security = vi.hoisted(() => ({ available: true }));
vi.mock('electron', () => ({ safeStorage: {
  isEncryptionAvailable: () => security.available,
  encryptString: (value: string) => Buffer.from(Buffer.from(value).map((byte) => byte ^ 0x5a)),
  decryptString: (value: Buffer) => Buffer.from(value.map((byte) => byte ^ 0x5a)).toString('utf8'),
} }));
import { CreateMimoSessionStore, IsMimoSessionCookie, MimoSessionRetentionMs, type MimoSessionSnapshot } from '../../../apps/desktop/src/mimo-session-store';

const roots: string[] = [];
afterEach(async () => { security.available = true; await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
const Snapshot = (): MimoSessionSnapshot => ({ version: 1, validUntil: Date.now() + MimoSessionRetentionMs, cookies: [{ name: 'api-platform_serviceToken', value: 'private-session-token', domain: 'platform.xiaomimimo.com', path: '/', hostOnly: true, secure: true, httpOnly: true, sameSite: 'lax' }] });
async function Setup() { const root = await mkdtemp(join(tmpdir(), 'avery-mimo-session-')); roots.push(root); return { root, store: CreateMimoSessionStore(root) }; }

describe('MiMo 系统加密授权存储', () => {
  it('进程重建后可恢复，文件不包含明文 Cookie，断开授权后文件消失', async () => {
    const { root, store } = await Setup();
    const snapshot = Snapshot();
    await store.Save(snapshot);
    expect((await readFile(join(root, 'mimo-account-session.enc'))).toString('utf8')).not.toContain('private-session-token');
    expect(await CreateMimoSessionStore(root).Load()).toEqual(snapshot);
    await store.Clear(); expect(await CreateMimoSessionStore(root).Load()).toBeNull();
  });
  it('安全存储不可用时明确失败，禁止回退到明文', async () => {
    const { root, store } = await Setup(); security.available = false;
    await expect(store.Save(Snapshot())).rejects.toThrow('系统安全存储不可用');
    await expect(readFile(join(root, 'mimo-account-session.enc'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('本地授权过期后不恢复，损坏数据不泄漏内容', async () => {
    const { root, store } = await Setup();
    await store.Save({ ...Snapshot(), validUntil: Date.now() - 1000 }); expect(await store.Load()).toBeNull();
    await writeFile(join(root, 'mimo-account-session.enc'), 'private-cookie-invalid');
    await expect(store.Load()).rejects.toThrow('已保存的 MiMo 授权无法恢复');
  });
  it('拒绝非平台 Cookie 和伪造域名，属性不会被扩大', () => {
    const cookie = Snapshot().cookies[0];
    expect(IsMimoSessionCookie(cookie)).toBe(true);
    expect(IsMimoSessionCookie({ ...cookie, domain: 'platform.xiaomimimo.com.evil.test' })).toBe(false);
    expect(IsMimoSessionCookie({ ...cookie, name: 'unrelated-browser-cookie' })).toBe(false);
    expect(IsMimoSessionCookie({ ...cookie, value: '' })).toBe(false);
  });
});
