import { createHash } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { GetNow } from './helpers';
import { IsCurrentProfileCategory, ProfileItemToStorage, ProfileItemToDisplay } from './enum-map';

/** 档案的唯一事实源 profile.json；以临时文件写入后 fsync 原子替换，并维护哈希基线供外部修改检测。 */
export class ProfileRepository {
  private profilePath: string;
  private profileHash: string | null = null;

  constructor({ profilePath }: { profilePath: string }) {
    this.profilePath = profilePath;
  }

  /** 写入统计专用只读快照，不刷新 profileHash，避免把外部改动认可为新的写入基线。 */
  async ReadSnapshot(): Promise<import('@avery/agent-sdk').ProfileSnapshotItem[]> {
    let raw: string;
    try { raw = await readFile(this.profilePath, 'utf8'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const parsed = JSON.parse(raw) as { items?: unknown };
    if (!Array.isArray(parsed.items)) throw new Error('Profiles payload is invalid.');
    return parsed.items.map(ProfileItemToDisplay).filter((item) => IsCurrentProfileCategory(item?.category));
  }

  /** 读取档案并认可当前磁盘内容为哈希基线；缺失或损坏时返回安全回退值。 */
  Load(fallback: any[]): { items: any[]; hash: string | null } {
    try {
      const raw = readFileSync(this.profilePath, 'utf8');
      const parsed = JSON.parse(raw) as { items?: unknown };
      const hash = createHash('sha256').update(raw).digest('hex');
      const items = Array.isArray(parsed?.items)
        ? parsed.items.map(ProfileItemToDisplay).filter((item) => IsCurrentProfileCategory(item?.category))
        : fallback;
      this.profileHash = hash;
      return { items, hash };
    } catch {
      this.profileHash = null;
      return { items: fallback, hash: null };
    }
  }

  /** 判断磁盘文件是否在应用认可基线后被外部修改；从未读取或文件缺失时视为未修改。 */
  IsModified(): boolean {
    if (this.profileHash == null) return false;
    try {
      const raw = readFileSync(this.profilePath, 'utf8');
      return createHash('sha256').update(raw).digest('hex') !== this.profileHash;
    } catch {
      return false;
    }
  }

  /** 通过临时文件、fsync 和原子替换保存档案；检测到外部修改时除非强制覆盖否则拒绝。 */
  Save(items: any[], force = false): { count: number; hash: string } {
    if (!Array.isArray(items)) throw new Error('Profiles payload is invalid.');
    if (this.IsModified() && !force) {
      const conflict = new Error('The profile file was modified outside the application.') as Error & { code: string };
      conflict.code = 'PROFILE_CONFLICT';
      throw conflict;
    }
    const payload = { schemaVersion: 1, updatedAt: GetNow(), items: items.map(ProfileItemToStorage) };
    const temporaryPath = `${this.profilePath}.tmp`;
    const raw = JSON.stringify(payload, null, 2);
    const descriptor = openSync(temporaryPath, 'w');
    try {
      writeFileSync(descriptor, raw, 'utf8');
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    renameSync(temporaryPath, this.profilePath);
    this.profileHash = createHash('sha256').update(raw).digest('hex');
    return { count: items.length, hash: this.profileHash };
  }

  /** 重新读取磁盘档案并更新哈希基线，供冲突界面「重新加载磁盘版本」使用。 */
  Reload(fallback: any[]): { items: any[]; hash: string | null } {
    return this.Load(fallback);
  }

  /** 返回最近一次认可的档案哈希基线。 */
  GetHash(): string | null {
    return this.profileHash;
  }
}
