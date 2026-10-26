import { safeStorage } from 'electron';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { Cookie } from 'electron';

export const MimoSessionCookieNames = new Set(['api-platform_serviceToken', 'userId', 'api-platform_ph', 'api-platform_slh']);
/** 保存的本地授权在连续 30 天未成功使用后过期；供应商 Cookie 自带的期限仍优先。 */
export const MimoSessionRetentionMs = 30 * 24 * 60 * 60 * 1000;
export type MimoSessionCookie = Pick<Cookie, 'name' | 'value' | 'domain' | 'path' | 'httpOnly' | 'secure' | 'sameSite' | 'hostOnly' | 'expirationDate'>;
export interface MimoSessionSnapshot { version: 1; validUntil: number; cookies: MimoSessionCookie[] }
export interface MimoSessionStore {
  Load(): Promise<MimoSessionSnapshot | null>;
  Save(snapshot: MimoSessionSnapshot): Promise<void>;
  Clear(): Promise<void>;
}

/** 固定文本错误可安全交给界面；文件内容、解密异常与 Cookie 永不进入错误消息。 */
export class MimoSessionStoreError extends Error {}

/** 仅接收目标平台四个账户 Cookie，拒绝扩展域名、过大凭据及不受支持的属性。 */
export function IsMimoSessionCookie(value: unknown): value is MimoSessionCookie {
  if (!value || typeof value !== 'object') return false;
  const cookie = value as Record<string, unknown>;
  return typeof cookie.name === 'string' && MimoSessionCookieNames.has(cookie.name)
    && typeof cookie.value === 'string' && cookie.value.length > 0 && cookie.value.length <= 16384
    && typeof cookie.domain === 'string' && ['xiaomimimo.com', '.xiaomimimo.com', 'platform.xiaomimimo.com', '.platform.xiaomimimo.com'].includes(cookie.domain)
    && typeof cookie.path === 'string' && cookie.path.startsWith('/') && cookie.path.length <= 256
    && typeof cookie.secure === 'boolean' && typeof cookie.httpOnly === 'boolean' && typeof cookie.hostOnly === 'boolean'
    && ['unspecified', 'no_restriction', 'lax', 'strict'].includes(String(cookie.sameSite))
    && (cookie.expirationDate === undefined || (typeof cookie.expirationDate === 'number' && Number.isFinite(cookie.expirationDate)));
}

/** 异步原子写入系统加密的授权快照；不复制系统浏览器数据，不回退到明文保存。 */
export function CreateMimoSessionStore(userDataPath: string): MimoSessionStore {
  const storePath = join(userDataPath, 'mimo-account-session.enc');
  return {
    async Load() {
      let encrypted: Buffer;
      try { encrypted = await readFile(storePath); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw new MimoSessionStoreError('无法读取已保存的 MiMo 授权，请重新登录。'); }
      if (!safeStorage.isEncryptionAvailable()) throw new MimoSessionStoreError('系统安全存储不可用，无法恢复 MiMo 授权。');
      try {
        if (encrypted.length > 128 * 1024) throw new Error();
        const parsed: unknown = JSON.parse(safeStorage.decryptString(encrypted));
        if (!parsed || typeof parsed !== 'object') throw new Error();
        const snapshot = parsed as MimoSessionSnapshot;
        if (snapshot.version !== 1 || !Number.isFinite(snapshot.validUntil) || !Array.isArray(snapshot.cookies) || snapshot.cookies.length > 16 || !snapshot.cookies.every(IsMimoSessionCookie)) throw new Error();
        return snapshot.validUntil > Date.now() ? snapshot : null;
      } catch { throw new MimoSessionStoreError('已保存的 MiMo 授权无法恢复，请重新登录。'); }
    },
    async Save(snapshot) {
      if (!safeStorage.isEncryptionAvailable()) throw new MimoSessionStoreError('系统安全存储不可用，MiMo 授权无法安全保存。');
      const temporaryPath = `${storePath}.${randomUUID()}.tmp`;
      try {
        await mkdir(userDataPath, { recursive: true });
        const encrypted = safeStorage.encryptString(JSON.stringify(snapshot));
        await writeFile(temporaryPath, encrypted, { flag: 'wx', mode: 0o600 });
        await rename(temporaryPath, storePath);
      } catch { throw new MimoSessionStoreError('MiMo 授权保存失败，请检查本地安全存储后重试。'); }
      finally { await rm(temporaryPath, { force: true }).catch(() => undefined); }
    },
    async Clear() {
      try { await rm(storePath, { force: true }); }
      catch { throw new MimoSessionStoreError('已保存的 MiMo 授权清理失败，请重试断开授权。'); }
    },
  };
}
