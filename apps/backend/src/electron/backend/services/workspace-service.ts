import { createHash, randomUUID } from 'node:crypto';
import {
  copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync,
  renameSync, rmdirSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs';
import * as path from 'node:path';
import { GetNow, CreateId } from '../../repositories/helpers';
import { MarkItDownAttachmentConverter, type AttachmentMarkdownConverter } from '../markitdown-attachment-converter';

/** 原子创建工作空间内需要的目录，避免附件和备份服务各自处理目录初始化。 */
export function EnsureWorkspaceDirectories(workspacePath: string): void {
  for (const directory of ['attachments', 'exports', 'backups', path.join('derived', 'ocr'), path.join('derived', 'markdown')]) {
    mkdirSync(path.join(workspacePath, directory), { recursive: true });
  }
}

/** 工作空间的应用服务：状态、聚合视图、附件导入、备份、迁移与审计，持有业务数据库的唯一写句柄。 */
export class WorkspaceService {
  private db: any;
  private conversations: any;
  private resumes: any;
  private jobs: any;
  private applications: any;
  private workspacePath: string;
  private profilePath: string;
  private attachmentLifecycle: any;
  private workspaceOperations: any;
  private databasePath: string;
  private attachmentConverter: AttachmentMarkdownConverter;
  private pendingSnapshots = new Map<string, Promise<string>>();
  private integrityCache: { at: number; result: string } | null = null;

  constructor({ db, conversationService, resumeService, jobService, applicationService, workspacePath, profilePath, attachmentLifecycle, workspaceOperations, attachmentConverter }: any) {
    this.db = db;
    this.conversations = conversationService;
    this.resumes = resumeService;
    this.jobs = jobService;
    this.applications = applicationService;
    this.workspacePath = workspacePath;
    this.profilePath = profilePath;
    this.attachmentLifecycle = attachmentLifecycle;
    this.workspaceOperations = workspaceOperations;
    this.databasePath = path.join(workspacePath, 'offerget.db');
    this.attachmentConverter = attachmentConverter ?? new MarkItDownAttachmentConverter();
  }

  /** 执行完整 integrity_check 并缓存 30 秒；未过期直接返回缓存结果，避免高频状态查询触发全库扫描。 */
  RunIntegrityCheck(): string {
    const now = GetNow();
    if (this.integrityCache && now - this.integrityCache.at < 30000) return this.integrityCache.result;
    const result = this.db.pragma('integrity_check', { simple: true });
    this.integrityCache = { at: now, result };
    return result;
  }

  /** 返回不含敏感配置的工作空间健康状态；只暴露目录名掩码，绝不包含绝对路径。 */
  GetStatus(): any {
    const metadata = this.db.prepare("SELECT workspace_id, schema_version, created_at, last_opened_at FROM workspace_meta WHERE id = 'workspace'").get();
    return { name: path.basename(this.workspacePath), metadata, integrity: this.RunIntegrityCheck() };
  }

  /** 从各领域 Application Service 聚合页面所需的业务 ViewModel；空库返回空集合而非种子。 */
  LoadViewModel(): any {
    return {
      conversations: this.conversations.ListAll(),
      resumes: this.resumes.ListAll(),
      jobs: this.jobs.ListAll(),
      applications: this.applications.ListAll(),
    };
  }

  /** 复制、校验并准备切换到空目标目录；源工作空间保持不变以便发生故障时回退；拒绝符号链接/Junction 目标。 */
  CopyWorkspaceTo(destinationPath: string): any {
    this.workspaceOperations.RequireWritable();
    const sourcePath = path.resolve(this.workspacePath);
    const targetPath = path.resolve(destinationPath);
    try {
      const targetStat = lstatSync(targetPath, { throwIfNoEntry: false });
      if (targetStat && (targetStat.isSymbolicLink() || targetStat.isDirectory() === false)) throw new Error('The destination workspace must be a real directory, not a symbolic link.');
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('The destination workspace must be a real directory')) throw error;
    }
    const relativeTarget = path.relative(sourcePath, targetPath);
    const relativeSource = path.relative(targetPath, sourcePath);
    if (!relativeTarget || (!relativeTarget.startsWith('..') && !path.isAbsolute(relativeTarget)) || (!relativeSource.startsWith('..') && !path.isAbsolute(relativeSource))) {
      throw new Error('The destination workspace must not contain or be contained by the current workspace.');
    }
    if (existsSync(targetPath) && readdirSync(targetPath).length > 0) throw new Error('The destination directory must be empty before migration.');
    const operationId = this.workspaceOperations.Begin('copy_workspace', { destinationPath: targetPath });
    const temporaryPath = `${targetPath}.offerget-migration-${operationId}`;
    mkdirSync(temporaryPath, { recursive: true });
    try {
      EnsureWorkspaceDirectories(temporaryPath);
      const copiedDatabasePath = path.join(temporaryPath, 'offerget.db');
      this.db.exec(`VACUUM INTO '${copiedDatabasePath.replace(/'/g, "''")}'`);
      if (existsSync(this.profilePath)) copyFileSync(this.profilePath, path.join(temporaryPath, 'profile.json'));
      for (const directory of ['attachments', 'exports', 'backups', 'derived']) {
        const sourceDirectory = path.join(sourcePath, directory);
        if (existsSync(sourceDirectory)) cpSync(sourceDirectory, path.join(temporaryPath, directory), { recursive: true, force: true });
      }
      const Database = require('better-sqlite3') as any;
      const verification = new Database(copiedDatabasePath);
      const integrity = verification.pragma('integrity_check', { simple: true });
      verification.prepare("UPDATE workspace_operations SET state = 'completed', completed_at = ?, updated_at = ?, error_code = NULL WHERE id = ?").run(GetNow(), GetNow(), operationId);
      verification.close();
      if (integrity !== 'ok') throw new Error('The copied workspace database failed integrity verification.');
      writeFileSync(path.join(temporaryPath, 'migration-manifest.json'), JSON.stringify({ migratedAt: GetNow(), sourceWorkspace: path.basename(sourcePath), databaseIntegrity: integrity }, null, 2), 'utf8');
      if (!existsSync(targetPath)) {
        renameSync(temporaryPath, targetPath);
      } else {
        for (const entry of readdirSync(temporaryPath)) renameSync(path.join(temporaryPath, entry), path.join(targetPath, entry));
        rmdirSync(temporaryPath);
      }
      this.workspaceOperations.Advance(operationId, 'file_written');
      this.workspaceOperations.Advance(operationId, 'db_committed');
      this.workspaceOperations.Advance(operationId, 'completed');
      return { workspacePath: targetPath, integrity };
    } catch (error) {
      this.workspaceOperations.RemoveDirectorySafely(temporaryPath, path.dirname(targetPath));
      this.workspaceOperations.MarkRollback(operationId, 'COPY_WORKSPACE_FAILED');
      throw error;
    }
  }

  private SnapshotPath(sha256: string): string {
    return path.join(this.workspacePath, 'derived', 'markdown', `${sha256}.md`);
  }

  private ValidateMarkdownSnapshot(snapshotPath: string): string {
    const stat = lstatSync(snapshotPath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 5 * 1024 * 1024) throw new Error('The attachment Markdown snapshot is unsafe or exceeds the 5 MB limit.');
    return snapshotPath;
  }

  /** 转换结果先写临时文件再原子替换；相同内容并发导入时共用一次 MarkItDown 任务。 */
  private EnsureMarkdownSnapshot(input: { sha256: string; sourcePath: string; originalName: string; mimeType: string }): Promise<string> {
    const snapshotPath = this.SnapshotPath(input.sha256);
    if (existsSync(snapshotPath)) return Promise.resolve(this.ValidateMarkdownSnapshot(snapshotPath));
    const pending = this.pendingSnapshots.get(input.sha256);
    if (pending) return pending;
    const conversion = this.attachmentConverter.Convert(input).then((markdown) => {
      const bytes = Buffer.from(markdown, 'utf8');
      if (bytes.length > 5 * 1024 * 1024) throw Object.assign(new Error('The Markdown attachment snapshot exceeds the 5 MB limit.'), { code: 'ATTACHMENT_SNAPSHOT_TOO_LARGE' });
      const temporary = `${snapshotPath}.${process.pid}.${randomUUID()}.tmp`;
      writeFileSync(temporary, bytes, { flag: 'wx' });
      try {
        if (!existsSync(snapshotPath)) renameSync(temporary, snapshotPath);
      } finally {
        if (existsSync(temporary)) unlinkSync(temporary);
      }
      return this.ValidateMarkdownSnapshot(snapshotPath);
    }).finally(() => this.pendingSnapshots.delete(input.sha256));
    this.pendingSnapshots.set(input.sha256, conversion);
    return conversion;
  }

  /** 复制用户主动选择的附件，并在入库前生成持久化 Markdown 快照；源物理路径不对模型暴露。 */
  async ImportAttachment(sourcePath: string, mimeType = 'application/octet-stream'): Promise<any> {
    this.workspaceOperations.RequireWritable();
    const stat = statSync(sourcePath);
    if (!stat.isFile() || stat.size <= 0 || stat.size > 5 * 1024 * 1024) throw new Error('Attachment must be a non-empty file no larger than 5 MB.');
    const content = readFileSync(sourcePath);
    const sha256 = createHash('sha256').update(content).digest('hex');
    const storageKey = path.join('attachments', sha256);
    const destination = path.join(this.workspacePath, storageKey);
    const existing = this.db.prepare('SELECT id, original_name, deleted_at FROM attachments WHERE sha256 = ?').get(sha256);
    const id = existing?.id ?? CreateId();
    const name = path.basename(sourcePath);
    const createdAt = GetNow();
    const normalizedStorageKey = storageKey.replace(/\\/g, '/');
    if (!existsSync(destination)) {
      writeFileSync(destination, content, { flag: 'wx' });
    } else {
      const destinationStat = lstatSync(destination);
      if (!destinationStat.isFile() || destinationStat.isSymbolicLink()) throw new Error('Attachment storage entry is unsafe.');
      const destinationHash = createHash('sha256').update(readFileSync(destination)).digest('hex');
      if (destinationHash !== sha256) throw new Error('Attachment storage content does not match its address.');
    }
    try {
      await this.EnsureMarkdownSnapshot({ sha256, sourcePath: destination, originalName: name, mimeType });
    } catch (error) {
      if (!existing && existsSync(destination)) unlinkSync(destination);
      throw error;
    }
    const snapshotKey = path.join('derived', 'markdown', `${sha256}.md`).replace(/\\/g, '/');
    const snapshotSha256 = createHash('sha256').update(readFileSync(this.SnapshotPath(sha256))).digest('hex');
    const operationId = this.workspaceOperations.Begin('import_attachment', { attachmentId: id, sha256, originalName: name, mimeType, byteSize: stat.size, storageKey: normalizedStorageKey, snapshotKey, snapshotSha256, createdAt });
    try {
      this.workspaceOperations.Advance(operationId, 'file_written');
      if (!existing) {
        this.db.prepare("INSERT INTO attachments(id, sha256, original_name, mime_type, byte_size, storage_key, parse_status, created_at, orphaned_at) VALUES(?, ?, ?, ?, ?, ?, 'ready', ?, ?)")
          .run(id, sha256, name, mimeType, stat.size, normalizedStorageKey, createdAt, createdAt);
      } else {
        this.db.prepare(`UPDATE attachments SET original_name = ?, mime_type = ?, byte_size = ?, storage_key = ?,
          parse_status = 'ready', deleted_at = NULL, orphaned_at = ?, cleanup_attempted_at = NULL, cleanup_error = NULL WHERE id = ?`)
          .run(name, mimeType, stat.size, normalizedStorageKey, createdAt, id);
      }
      this.workspaceOperations.Advance(operationId, 'db_committed');
      this.workspaceOperations.Advance(operationId, 'completed');
      return { id, name, uri: `attachment://${id}/${encodeURIComponent(name)}` };
    } catch (error) {
      this.workspaceOperations.MarkRollback(operationId, 'IMPORT_ATTACHMENT_FAILED');
      throw error;
    }
  }

  /** 将虚拟附件 URI 解析为受控工作空间文件，拒绝任意物理路径输入。 */
  ResolveAttachmentUri(uri: string): any {
    const matched = /^attachment:\/\/([^/]+)\//.exec(String(uri));
    if (!matched) throw new Error('The attachment URI is invalid.');
    const attachment = this.db.prepare('SELECT id, original_name, mime_type, storage_key FROM attachments WHERE id = ? AND deleted_at IS NULL').get(matched[1]);
    if (!attachment) throw new Error('The attachment is unavailable.');
    const attachmentRoot = realpathSync(path.resolve(this.workspacePath, 'attachments'));
    const candidatePath = path.resolve(this.workspacePath, attachment.storage_key);
    const lexicalRelative = path.relative(attachmentRoot, candidatePath);
    if (!lexicalRelative || lexicalRelative.startsWith('..') || path.isAbsolute(lexicalRelative) || !existsSync(candidatePath)) throw new Error('The attachment storage entry is unavailable.');
    const physicalPath = realpathSync(candidatePath);
    const realRelative = path.relative(attachmentRoot, physicalPath);
    if (!realRelative || realRelative.startsWith('..') || path.isAbsolute(realRelative)) throw new Error('The attachment storage entry escapes the workspace.');
    return { id: attachment.id, name: attachment.original_name, mimeType: attachment.mime_type, physicalPath };
  }

  /**
   * Agent 文本工具只读取 MarkItDown 快照；图片保留原文件交给视觉/OCR 路径。
   * 旧工作空间缺少快照时在首次读取时补建，后续 Run 复用同一内容寻址快照。
   */
  async ResolveAttachmentMarkdownUri(uri: string): Promise<any> {
    const original = this.ResolveAttachmentUri(uri);
    const attachment = this.db.prepare('SELECT sha256 FROM attachments WHERE id = ? AND deleted_at IS NULL').get(original.id);
    if (!attachment?.sha256) throw new Error('The attachment snapshot metadata is unavailable.');
    let snapshotPath: string;
    try {
      snapshotPath = await this.EnsureMarkdownSnapshot({
        sha256: attachment.sha256,
        sourcePath: original.physicalPath,
        originalName: original.name,
        mimeType: original.mimeType,
      });
    } catch (error) {
      this.db.prepare("UPDATE attachments SET parse_status = 'error' WHERE id = ?").run(original.id);
      throw error;
    }
    this.db.prepare("UPDATE attachments SET parse_status = 'ready' WHERE id = ?").run(original.id);
    if (String(original.mimeType ?? '').toLowerCase().startsWith('image/')) return original;
    const snapshotRoot = realpathSync(path.join(this.workspacePath, 'derived', 'markdown'));
    const physicalPath = realpathSync(snapshotPath);
    const relative = path.relative(snapshotRoot, physicalPath);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('The attachment snapshot escapes the workspace.');
    return { ...original, name: `${original.name}.md`, mimeType: 'text/markdown', physicalPath };
  }

  /** 创建一致性的业务数据库和档案备份；附件以原始内容寻址文件继续由 manifest 引用；只返回掩码结果，不含备份目录路径。 */
  CreateBackup(): any {
    this.workspaceOperations.RequireWritable();
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const directoryName = `daily-${stamp}`;
    const operationId = this.workspaceOperations.Begin('create_backup', { directoryName });
    const directory = path.join(this.workspacePath, 'backups', directoryName);
    try {
      mkdirSync(directory, { recursive: true });
      const databaseBackupPath = path.join(directory, 'offerget.db');
      const escapedPath = databaseBackupPath.replace(/'/g, "''");
      this.db.exec(`VACUUM INTO '${escapedPath}'`);
      const Database = require('better-sqlite3') as any;
      const backupDatabase = new Database(databaseBackupPath);
      backupDatabase.prepare("UPDATE workspace_operations SET state = 'completed', completed_at = ?, updated_at = ?, error_code = NULL WHERE id = ?").run(GetNow(), GetNow(), operationId);
      backupDatabase.close();
      const profileBackupPath = path.join(directory, 'profile.json');
      if (existsSync(this.profilePath)) copyFileSync(this.profilePath, profileBackupPath);
      const attachments = this.db.prepare('SELECT sha256, storage_key FROM attachments WHERE deleted_at IS NULL ORDER BY sha256').all();
      writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify({ createdAt: GetNow(), database: 'offerget.db', profile: existsSync(profileBackupPath) ? 'profile.json' : null, attachments }, null, 2), 'utf8');
      this.workspaceOperations.Advance(operationId, 'file_written');
      this.workspaceOperations.Advance(operationId, 'db_committed');
      this.PruneDailyBackups();
      const retainedCount = readdirSync(path.join(this.workspacePath, 'backups')).filter((name) => name.startsWith('daily-')).length;
      this.workspaceOperations.Advance(operationId, 'completed');
      return { created: true, timestamp: GetNow(), retainedCount };
    } catch (error) {
      this.workspaceOperations.MarkRollback(operationId, 'CREATE_BACKUP_FAILED');
      throw error;
    }
  }

  /** 只删除本服务生成且超出 7 份限制的日备份目录。 */
  PruneDailyBackups(): void {
    const backupRoot = path.join(this.workspacePath, 'backups');
    const directories = readdirSync(backupRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory() && !entry.isSymbolicLink() && entry.name.startsWith('daily-'))
      .map((entry) => ({ name: entry.name, path: path.join(backupRoot, entry.name), time: statSync(path.join(backupRoot, entry.name)).mtimeMs }))
      .sort((left, right) => right.time - left.time);
    for (const directory of directories.slice(7)) this.workspaceOperations.RemoveDirectorySafely(directory.path, backupRoot);
  }

  /** 关闭数据库句柄，供应用退出或后续工作空间迁移时安全调用。 */
  Close(): void {
    try {
      this.db?.close();
    } catch {
      // 退出阶段重复关闭原生句柄无需额外处理。
    }
  }
}
