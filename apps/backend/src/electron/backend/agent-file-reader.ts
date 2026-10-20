import { readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import * as path from 'node:path';

const MAX_FILE_BYTES = 5 * 1024 * 1024;
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);

/**
 * 宿主侧文件读取端口（FileReadPort 注入默认 tools 模块）：
 * 承载 pdf/docx/txt 解析、物理路径校验与资源边界；默认模块不持有任何 Node 解析能力。
 * 注意：pdf-parse/mammoth 仅在解析方法首次调用时 require——该时机必然晚于 apps/backend/dist/index.js 的
 * InstallBrowserPolyfills()（启动即注入），因此首用加载不会破坏 pdf-parse 的浏览器全局依赖。
 */
export class AgentFileReader {
  private _resolveAttachment: (uri: string) => Promise<unknown>;
  private _authorizedMetadata = new Map<string, { name: string | null }>();

  constructor(ResolveAttachmentUri: (uri: string) => Promise<unknown>) {
    this._resolveAttachment = ResolveAttachmentUri;
  }

  /** FileReadPort 接口：将 attachment:// 虚拟 URI 解析为宿主私有物理路径；回调返回字符串或含 physicalPath 的对象，统一归一化；未注册返回 null。 */
  async ResolveAttachmentUri(uri: string): Promise<string | null> {
    const resolved = await this._resolveAttachment(uri);
    if (resolved == null) return null;
    const physicalPath = typeof resolved === 'string' ? resolved : (resolved as { physicalPath?: string | null }).physicalPath ?? null;
    if (physicalPath && typeof resolved === 'object') {
      const meta = resolved as { name?: unknown };
      this._authorizedMetadata.set(physicalPath, { name: typeof meta.name === 'string' ? meta.name : null });
      if (this._authorizedMetadata.size > 500) this._authorizedMetadata.delete(this._authorizedMetadata.keys().next().value as string);
    }
    return physicalPath;
  }

  /** 解析项目内请求路径并校验真实路径仍位于会话绑定的项目目录，拒绝符号链接越界。 */
  ResolveProjectPath(projectRoot: string | null, requestedPath: string): string {
    if (!projectRoot) throw new Error('No project environment is bound to this session.');
    const root = realpathSync(projectRoot);
    const candidate = path.resolve(root, requestedPath);
    const relative = path.relative(root, candidate);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Unable to access paths outside the project environment.');
    const realPath = realpathSync(candidate);
    const realRelative = path.relative(root, realPath);
    if (realRelative.startsWith('..') || path.isAbsolute(realRelative)) throw new Error('Unable to access paths outside the project environment.');
    return realPath;
  }

  /** 枚举项目环境内的常规文件，跳过依赖缓存、隐藏目录和符号链接，限制扫描规模；返回绝对路径与相对 POSIX 路径。 */
  ListProjectFiles(projectPath: string, limit = 1000): Array<{ path: string; name: string }> {
    const files: Array<{ path: string; name: string }> = [];
    const root = realpathSync(projectPath);
    const visit = (directory: string): void => {
      if (files.length >= limit) return;
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (files.length >= limit || entry.name === 'node_modules' || entry.name === '.git' || entry.name.startsWith('.')) continue;
        const candidate = path.join(directory, entry.name);
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) visit(candidate);
        else if (entry.isFile()) files.push({ path: candidate, name: path.relative(root, candidate).replace(/\\/g, '/') });
      }
    };
    visit(root);
    return files;
  }

  /** 将受限 Glob 模式转换为文件名匹配正则，先保护双星号以避免被单星号二次替换。 */
  CreateGlobMatcher(pattern: string): RegExp {
    const placeholder = '__AVERY_GLOBSTAR__';
    const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, placeholder).replace(/\*/g, '[^/\\\\]*').replace(/\?/g, '.').replace(new RegExp(placeholder, 'g'), '.*');
    return new RegExp(`^${escaped}$`, 'i');
  }

  /** 读取受限文本内容：所有文件受 5 MB 物理上限及 5,000 字符上下文上限保护。 */
  ReadTextFile(filePath: string): { content: string; truncated: boolean } {
    const stat = statSync(filePath);
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) throw new Error('The file is unavailable or exceeds the 5 MB reading limit.');
    const content = readFileSync(filePath, 'utf8');
    if (content.includes('\u0000')) throw new Error('This file is not a readable text file.');
    return { content: content.slice(0, 5000), truncated: content.length > 5000 };
  }

  /** 提取受限 DOCX 文本；仅读取段落与表格文本，不执行宏、脚本或外部链接。 */
  async ReadDocxFile(filePath: string): Promise<{ content: string; truncated: boolean; warnings: string[] }> {
    const stat = statSync(filePath);
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) throw new Error('The file is unavailable or exceeds the 5 MB reading limit.');
    const mammoth = require('mammoth') as any;
    const result = await mammoth.extractRawText({ path: filePath });
    const content = String(result.value ?? '');
    return { content: content.slice(0, 5000), truncated: content.length > 5000, warnings: result.messages.map((message: any) => message.message).slice(0, 10) };
  }

  /** 提取不超过十页的 PDF 文本；扫描型或无文本层 PDF 会明确返回空文本。 */
  async ReadPdfFile(filePath: string): Promise<{ content: string; truncated: boolean; pages: number; warnings: string[] }> {
    const stat = statSync(filePath);
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) throw new Error('The file is unavailable or exceeds the 5 MB reading limit.');
    const { PDFParse } = require('pdf-parse') as any;
    const parser = new PDFParse({ data: readFileSync(filePath) });
    try {
      const info = await parser.getInfo();
      if (info.total > 10) throw new Error('PDF files are limited to 10 pages.');
      // 不把解析器自动添加的页码分隔文字误判为 PDF 正文。
      const result = await parser.getText({ pageJoiner: '' });
      const content = String(result.text ?? '');
      return {
        content: content.slice(0, 5000), truncated: content.length > 5000, pages: info.total,
        warnings: content.trim() ? [] : ['This PDF has no extractable text layer. Provide a text-based PDF or an image attachment for a vision-capable model.'],
      };
    } finally {
      await parser.destroy();
    }
  }

  /** 按受限文件类型分派解析器，所有输出均受 5,000 字符上下文上限约束。 */
  async ReadAuthorizedFile(filePath: string, sourceName: string = filePath, execution?: { signal?: AbortSignal; deadline?: number }): Promise<any> {
    if (execution?.signal?.aborted || (execution?.deadline !== undefined && Date.now() >= execution.deadline)) throw new Error('File read was cancelled.');
    const metadata = this._authorizedMetadata.get(filePath);
    const authoritativeName = metadata?.name || sourceName;
    const extension = path.extname(authoritativeName).toLowerCase();
    if (extension === '.pdf') return this.ReadPdfFile(filePath);
    if (extension === '.docx') return this.ReadDocxFile(filePath);
    if (['.txt', '.md', '.json', '.yaml', '.yml', '.csv', '.ts', '.tsx', '.js', '.jsx', '.css', '.html', '.py', '.java', '.go', '.rs'].includes(extension)) return this.ReadTextFile(filePath);
    if (IMAGE_EXTENSIONS.has(extension)) {
      throw Object.assign(new Error('Image text extraction is unavailable. Use the original attachment with a vision-capable model.'), { code: 'VALIDATION_ERROR' });
    }
    throw new Error('This file type is not supported by the reader.');
  }
}
