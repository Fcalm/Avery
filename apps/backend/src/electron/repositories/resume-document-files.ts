import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * 仅业务 Worker 使用的独立 JSON 存储。和 SQLite 事务保持串行；主进程和 Renderer 不执行文件 I/O。
 * 数据库保留版本快照作为崩溃恢复基线；未提交的磁盘差异先留恢复副本，再恢复已提交版本。
 */
export class ResumeDocumentFiles {
  private readonly directory: string;
  constructor(workspacePath: string) {
    const workspace = realpathSync(workspacePath);
    this.directory = join(workspace, 'resumes');
    mkdirSync(this.directory, { recursive: true });
    if (lstatSync(this.directory).isSymbolicLink() || resolve(realpathSync(this.directory)) !== resolve(this.directory)) throw new Error('简历目录不允许使用符号链接');
  }
  /** 使用完整 ID 哈希而非用户名称构造路径，避免路径穿越、保留名和重名覆盖。 */
  Path(id: string): string { return join(this.directory, `${createHash('sha256').update(id).digest('hex')}.json`); }
  private AssertDirectory(): void {
    if (lstatSync(this.directory).isSymbolicLink() || resolve(realpathSync(this.directory)) !== resolve(this.directory)) throw new Error('简历目录已变更，拒绝写入不安全路径');
  }
  Read(id: string): string | null {
    this.AssertDirectory();
    const file = this.Path(id);
    if (!existsSync(file)) return null;
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4000000) throw new Error('简历 JSON 文件不可安全读取');
    return readFileSync(file, 'utf8');
  }
  Write(id: string, content: string | null): void {
    this.AssertDirectory();
    const file = this.Path(id);
    // 即使目标文件已经存在，也不允许跟随其指向工作空间外部。
    if (existsSync(file) && lstatSync(file).isSymbolicLink()) throw new Error('简历 JSON 文件不允许使用符号链接');
    if (content === null) { if (existsSync(file)) unlinkSync(file); return; }
    const temporary = join(this.directory, `.${randomUUID()}.tmp`);
    let descriptor: number | undefined;
    try {
      descriptor = openSync(temporary, 'wx', 0o600);
      writeFileSync(descriptor, content, 'utf8'); fsyncSync(descriptor); closeSync(descriptor); descriptor = undefined;
      renameSync(temporary, file);
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
      if (existsSync(temporary)) unlinkSync(temporary);
    }
  }
  Serialize(resume: unknown): string { return `${JSON.stringify({ format: 'avery-resume', version: 1, resume }, null, 2)}\n`; }
  /** 启动迁移幂等：不改数据库或旧快照；差异文件保留副本，绝不静默覆盖唯一内容。 */
  Recover(resumes: Array<{ id: string }>): void {
    for (const resume of resumes) {
      const current = this.Read(resume.id);
      const expected = this.Serialize(resume);
      if (current === expected) continue;
      if (current !== null) writeFileSync(join(this.directory, `${createHash('sha256').update(resume.id).digest('hex')}.recovered-${randomUUID()}.json`), current, { flag: 'wx', mode: 0o600 });
      this.Write(resume.id, expected);
    }
  }
}
