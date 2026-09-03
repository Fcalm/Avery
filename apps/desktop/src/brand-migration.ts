import { constants } from 'node:fs';
import { access, copyFile, lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';

const LegacyLowerName = ['offer', 'get'].join('');
const LegacyProductName = ['Offer', 'Get'].join('');
const CurrentProductName = 'Avery';
const LegacyDatabaseName = `${LegacyLowerName}.db`;
const CurrentDatabaseName = 'avery.db';

async function Exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}
function MapLegacyEntryName(name: string): string {
  if (name === LegacyDatabaseName) return CurrentDatabaseName;
  if (name === `${LegacyDatabaseName}-wal`) return `${CurrentDatabaseName}-wal`;
  if (name === `${LegacyDatabaseName}-shm`) return `${CurrentDatabaseName}-shm`;
  return name;
}

/**
 * 只复制目标中尚不存在的数据，并拒绝跟随符号链接。
 * 品牌升级不能覆盖用户已经由新版本写入的文件，旧目录也保留用于人工回退。
 */
async function CopyMissingTree(source: string, destination: string): Promise<void> {
  const sourceStat = await lstat(source);
  if (sourceStat.isSymbolicLink()) return;
  if (sourceStat.isDirectory()) {
    await mkdir(destination, { recursive: true });
    for (const entry of await readdir(source, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      await CopyMissingTree(join(source, entry.name), join(destination, MapLegacyEntryName(entry.name)));
    }
    return;
  }
  if (!sourceStat.isFile() || await Exists(destination)) return;
  await mkdir(dirname(destination), { recursive: true });
  await copyFile(source, destination, constants.COPYFILE_EXCL);
  if (basename(destination) !== 'manifest.json') return;
  try {
    const text = await readFile(destination, 'utf8');
    if (text.includes(LegacyDatabaseName)) await writeFile(destination, text.replaceAll(LegacyDatabaseName, CurrentDatabaseName), 'utf8');
  } catch {
    // 非 JSON 或非 UTF-8 的同名文件保持原样；后续恢复校验仍会拒绝不合法清单。
  }
}

/**
 * 将旧品牌的用户目录合并到 Avery 目录。迁移是幂等且非破坏性的：只复制缺失项，绝不删除旧数据。
 */
export async function MigrateLegacyUserData(userDataPath: string): Promise<void> {
  const currentRoot = resolve(userDataPath);
  const legacyRoot = resolve(dirname(currentRoot), LegacyLowerName);
  if (legacyRoot === currentRoot || !await Exists(legacyRoot)) return;
  await mkdir(currentRoot, { recursive: true });
  for (const entry of await readdir(legacyRoot, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const destinationName = entry.name === `${LegacyProductName} Workspace` ? `${CurrentProductName} Workspace` : entry.name;
    await CopyMissingTree(join(legacyRoot, entry.name), join(currentRoot, destinationName));
  }
}
