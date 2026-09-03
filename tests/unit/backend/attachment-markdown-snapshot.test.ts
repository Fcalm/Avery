import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MarkItDownAttachmentConverter } from '../../../apps/backend/src/electron/backend/markitdown-attachment-converter';
import { WorkspaceOperationService } from '../../../apps/backend/src/electron/backend/services/workspace-operation-service';
import { EnsureWorkspaceDirectories, WorkspaceService } from '../../../apps/backend/src/electron/backend/services/workspace-service';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const temporaryDirectories: string[] = [];

function CreateTemporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

function CreateWorkspaceService(converter: { Convert(input: { sourcePath: string; originalName: string; mimeType: string }): Promise<string> }): { db: any; service: WorkspaceService; workspace: string } {
  const workspace = CreateTemporaryDirectory('avery-markdown-snapshot-');
  EnsureWorkspaceDirectories(workspace);
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE attachments (
      id TEXT PRIMARY KEY, sha256 TEXT NOT NULL UNIQUE, original_name TEXT NOT NULL, mime_type TEXT NOT NULL,
      byte_size INTEGER NOT NULL, storage_key TEXT NOT NULL UNIQUE, parse_status TEXT NOT NULL DEFAULT 'pending',
      created_at INTEGER NOT NULL, deleted_at INTEGER, orphaned_at INTEGER, cleanup_attempted_at INTEGER, cleanup_error TEXT
    );
    CREATE TABLE workspace_operations (
      id TEXT PRIMARY KEY, operation_type TEXT NOT NULL, operation_version INTEGER NOT NULL DEFAULT 1,
      state TEXT NOT NULL, payload_json TEXT NOT NULL, error_code TEXT, created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL, completed_at INTEGER
    );
  `);
  const workspaceOperations = new WorkspaceOperationService({ db, workspacePath: workspace });
  const emptyService = { ListAll: () => [] };
  const service = new WorkspaceService({
    db,
    conversationService: emptyService,
    resumeService: emptyService,
    jobService: emptyService,
    applicationService: emptyService,
    workspacePath: workspace,
    profilePath: join(workspace, 'profile.json'),
    attachmentLifecycle: {},
    workspaceOperations,
    attachmentConverter: converter,
  });
  return { db, service, workspace };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('MarkItDown attachment snapshots', () => {
  it('通过无 shell 子进程调用转换器，并传递原始扩展名与 MIME 提示', async () => {
    const directory = CreateTemporaryDirectory('avery-markitdown-cli-');
    const source = join(directory, 'content-addressed-source');
    const fakeCli = join(directory, 'fake-markitdown.cjs');
    writeFileSync(source, 'source', 'utf8');
    writeFileSync(fakeCli, "process.stdout.write('# converted\\n' + process.argv.slice(2).join('|'));", 'utf8');
    const converter = new MarkItDownAttachmentConverter({ command: process.execPath, prefixArgs: [fakeCli], timeoutMs: 5000 });

    const markdown = await converter.Convert({ sourcePath: source, originalName: 'resume.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });

    expect(markdown).toContain('# converted');
    expect(markdown).toContain('--extension|.docx');
    expect(markdown).toContain('--mime-type|application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  });

  it('导入时持久化 Markdown 快照，并让文本解析地址与上传原件分离', async () => {
    const converter = { Convert: vi.fn(async () => '# Candidate\n\nTypeScript engineer\n') };
    const { db, service, workspace } = CreateWorkspaceService(converter);
    const source = join(workspace, 'resume.docx');
    writeFileSync(source, 'fake docx bytes', 'utf8');

    const imported = await service.ImportAttachment(source, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    const original = service.ResolveAttachmentUri(imported.uri);
    const snapshot = await service.ResolveAttachmentMarkdownUri(imported.uri);
    const row = db.prepare('SELECT sha256, parse_status FROM attachments WHERE id = ?').get(imported.id);

    expect(original.physicalPath).toBe(join(workspace, 'attachments', row.sha256));
    expect(snapshot.physicalPath).toBe(join(workspace, 'derived', 'markdown', `${row.sha256}.md`));
    expect(snapshot.mimeType).toBe('text/markdown');
    expect(readFileSync(snapshot.physicalPath, 'utf8')).toContain('TypeScript engineer');
    expect(row.parse_status).toBe('ready');
    expect(converter.Convert).toHaveBeenCalledTimes(1);
  });

  it('旧附件缺失快照时首次读取补建，后续读取复用同一快照', async () => {
    const converter = { Convert: vi.fn(async () => '# Backfilled\n') };
    const { db, service, workspace } = CreateWorkspaceService(converter);
    const sha256 = 'b'.repeat(64);
    writeFileSync(join(workspace, 'attachments', sha256), 'legacy attachment', 'utf8');
    db.prepare(`INSERT INTO attachments(id, sha256, original_name, mime_type, byte_size, storage_key, parse_status, created_at)
      VALUES(?, ?, ?, ?, ?, ?, 'pending', ?)`).run('legacy', sha256, 'legacy.pdf', 'application/pdf', 17, `attachments/${sha256}`, Date.now());
    const uri = 'attachment://legacy/legacy.pdf';

    const first = await service.ResolveAttachmentMarkdownUri(uri);
    const second = await service.ResolveAttachmentMarkdownUri(uri);

    expect(first.physicalPath).toBe(second.physicalPath);
    expect(readFileSync(first.physicalPath, 'utf8')).toBe('# Backfilled\n');
    expect(converter.Convert).toHaveBeenCalledTimes(1);
    expect(db.prepare('SELECT parse_status FROM attachments WHERE id = ?').get('legacy').parse_status).toBe('ready');
  });

  it('MarkItDown 转换失败时拒绝导入且不遗留未登记原件', async () => {
    const converter = { Convert: vi.fn(async () => { throw Object.assign(new Error('conversion failed'), { code: 'ATTACHMENT_PARSE_FAILED' }); }) };
    const { db, service, workspace } = CreateWorkspaceService(converter);
    const source = join(workspace, 'broken.pdf');
    writeFileSync(source, 'broken pdf', 'utf8');

    await expect(service.ImportAttachment(source, 'application/pdf')).rejects.toMatchObject({ code: 'ATTACHMENT_PARSE_FAILED' });

    expect(db.prepare('SELECT COUNT(*) AS count FROM attachments').get().count).toBe(0);
    expect(readdirSync(join(workspace, 'attachments'))).toEqual([]);
    expect(readdirSync(join(workspace, 'derived', 'markdown'))).toEqual([]);
  });
});
