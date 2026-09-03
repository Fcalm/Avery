import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import * as path from 'node:path';

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_MARKDOWN_BYTES = 5 * 1024 * 1024;

export interface AttachmentMarkdownConverter {
  Convert(input: { sourcePath: string; originalName: string; mimeType: string }): Promise<string>;
}

interface MarkItDownConverterOptions {
  command?: string;
  prefixArgs?: string[];
  timeoutMs?: number;
  spawnProcess?: typeof spawn;
}

function ResolveCommand(): string {
  const configured = process.env.AVERY_MARKITDOWN_EXECUTABLE?.trim();
  if (configured) return configured;
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  if (resourcesPath) {
    const bundled = path.join(resourcesPath, 'markitdown', process.platform === 'win32' ? 'markitdown.exe' : 'markitdown');
    if (existsSync(bundled)) return bundled;
  }
  return process.platform === 'win32' ? 'markitdown.exe' : 'markitdown';
}

function CreateChildEnvironment(): NodeJS.ProcessEnv {
  const allowed = ['PATH', 'Path', 'SYSTEMROOT', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR', 'HOME', 'LANG'];
  const environment: NodeJS.ProcessEnv = { PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' };
  for (const key of allowed) {
    const value = process.env[key];
    if (value) environment[key] = value;
  }
  return environment;
}

/**
 * Microsoft MarkItDown 的离线窄适配器。只启用内建转换器，不传入插件、云端解析或模型参数；
 * 子进程使用参数数组启动，附件名和路径永远不会进入 shell。
 */
export class MarkItDownAttachmentConverter implements AttachmentMarkdownConverter {
  private command: string;
  private prefixArgs: string[];
  private timeoutMs: number;
  private spawnProcess: typeof spawn;

  constructor(options: MarkItDownConverterOptions = {}) {
    this.command = options.command ?? ResolveCommand();
    this.prefixArgs = [...(options.prefixArgs ?? [])];
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.spawnProcess = options.spawnProcess ?? spawn;
  }

  Convert({ sourcePath, originalName, mimeType }: { sourcePath: string; originalName: string; mimeType: string }): Promise<string> {
    const extension = path.extname(originalName).toLowerCase();
    const args = [...this.prefixArgs, sourcePath, ...(extension ? ['--extension', extension] : []), ...(mimeType ? ['--mime-type', mimeType] : [])];
    return new Promise((resolve, reject) => {
      let child: ReturnType<typeof spawn>;
      try {
        child = this.spawnProcess(this.command, args, {
          shell: false,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: CreateChildEnvironment(),
        });
      } catch (error) {
        reject(Object.assign(new Error('MarkItDown attachment parser is unavailable.'), { code: 'ATTACHMENT_PARSER_UNAVAILABLE', cause: error }));
        return;
      }
      const stdout: Buffer[] = [];
      let stdoutBytes = 0;
      let settled = false;
      const Finish = (error?: Error, markdown?: string): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve(markdown ?? '');
      };
      const timer = setTimeout(() => {
        child.kill();
        Finish(Object.assign(new Error('MarkItDown attachment parsing timed out.'), { code: 'ATTACHMENT_PARSE_TIMEOUT' }));
      }, this.timeoutMs);
      timer.unref?.();
      child.stdout!.on('data', (chunk: Buffer | string) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        stdoutBytes += buffer.length;
        if (stdoutBytes > MAX_MARKDOWN_BYTES) {
          child.kill();
          Finish(Object.assign(new Error('The Markdown attachment snapshot exceeds the 5 MB limit.'), { code: 'ATTACHMENT_SNAPSHOT_TOO_LARGE' }));
          return;
        }
        stdout.push(buffer);
      });
      child.stderr!.on('data', (chunk: Buffer | string) => {
        // MarkItDown 诊断可能包含工作空间物理路径；仅持续排空管道，不向 IPC 或模型回显。
        void chunk;
      });
      child.on('error', (error) => Finish(Object.assign(new Error('MarkItDown attachment parser is unavailable.'), { code: 'ATTACHMENT_PARSER_UNAVAILABLE', cause: error })));
      child.on('close', (code) => {
        if (settled) return;
        if (code !== 0) {
          Finish(Object.assign(new Error('MarkItDown could not parse the attachment.'), { code: 'ATTACHMENT_PARSE_FAILED' }));
          return;
        }
        const markdown = Buffer.concat(stdout).toString('utf8').replace(/^\uFEFF/, '');
        Finish(undefined, markdown || '_MarkItDown did not extract textual content from this attachment._\n');
      });
    });
  }
}
