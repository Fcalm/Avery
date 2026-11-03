import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { BrowserWindowConstructorOptions } from 'electron';
import { CreateResumeDocumentMarkup, ResumeDataToText, type ResumeDocumentInput } from '@avery/contracts';

type HiddenWindow = { loadURL: (url: string) => Promise<void>; webContents: { executeJavaScript: (source: string) => Promise<unknown>; printToPDF: (options: Electron.PrintToPDFOptions) => Promise<Buffer>; capturePage: (rect: Electron.Rectangle) => Promise<Electron.NativeImage> }; setContentSize: (width: number, height: number) => void; isDestroyed: () => boolean; destroy: () => void };
type BrowserWindowFactory = new (options: BrowserWindowConstructorOptions) => HiddenWindow;
export type ExportFormat = 'html' | 'pdf' | 'docx' | 'png';
export type ResumeExportInput = ResumeDocumentInput;
const ResumeExportFormats: readonly ExportFormat[] = ['html', 'pdf', 'docx', 'png'];
const PdfOptions: Electron.PrintToPDFOptions = { pageSize: 'A4', printBackground: true, preferCSSPageSize: true, margins: { top: 0, bottom: 0, left: 0, right: 0 } };
const PdfCache = new Map<string, { bytes: Buffer; expires: number }>();
const PdfFlights = new Map<string, Promise<Buffer>>();
let pdfQueue: Promise<unknown> = Promise.resolve();
let fontFacePromise: Promise<string> | undefined;

/** 从随应用分发的图标库嵌入字形；字体先加载完成再打印，PDF 内含真实字形。 */
async function LoadFontFace(): Promise<string> {
  fontFacePromise ??= (async () => {
    let bytes: Buffer;
    try { bytes = await readFile(join(__dirname, '../../../dist/fonts/phosphor/Phosphor-Regular.woff2')); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      bytes = await readFile(join(__dirname, '../../../public/fonts/phosphor/Phosphor-Regular.woff2'));
    }
    return `@font-face { font-family: "Avery Resume Icons"; src: url(data:font/woff2;base64,${bytes.toString('base64')}) format("woff2"); font-weight: normal; font-style: normal; }`;
  })().catch((error) => { fontFacePromise = undefined; throw error; });
  return fontFacePromise;
}

/**
 * 预览和导出取同一份 PDF 字节；相同内容合并请求，最多串行打开一个隐藏打印窗口。
 * 有界内存缓存不落盘，过期或超过总大小后释放；所有窗口始终启用 sandbox。
 */
export async function RenderResumePdf(BrowserWindow: BrowserWindowFactory, resume: ResumeExportInput): Promise<Buffer> {
  const html = CreateResumeHtml(resume, await LoadFontFace());
  const key = createHash('sha256').update(html).digest('hex');
  const now = Date.now();
  for (const [id, cached] of PdfCache) if (cached.expires <= now) PdfCache.delete(id);
  const cached = PdfCache.get(key);
  if (cached) return cached.bytes;
  const existing = PdfFlights.get(key);
  if (existing) return existing;
  const task = pdfQueue.catch(() => undefined).then(async () => {
    const window = new BrowserWindow({ show: false, width: 794, height: 1123, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
    try {
      await window.loadURL('about:blank');
      await window.webContents.executeJavaScript(`document.open();document.write(${JSON.stringify(html)});document.close();`);
      await window.webContents.executeJavaScript('document.fonts.load(\'14px "Avery Resume Icons"\', "\\ue576").then(() => document.fonts.ready)');
      const bytes = await window.webContents.printToPDF(PdfOptions);
      if (bytes.length <= 16 * 1024 * 1024) {
        let total = bytes.length;
        for (const entry of PdfCache.values()) total += entry.bytes.length;
        while (PdfCache.size && (PdfCache.size >= 6 || total > 16 * 1024 * 1024)) {
          const oldest = PdfCache.keys().next().value!; total -= PdfCache.get(oldest)!.bytes.length; PdfCache.delete(oldest);
        }
        PdfCache.set(key, { bytes, expires: Date.now() + 5 * 60 * 1000 });
      }
      return bytes;
    } finally { if (!window.isDestroyed()) window.destroy(); }
  });
  PdfFlights.set(key, task); pdfQueue = task;
  try { return await task; } finally { PdfFlights.delete(key); }
}

/** 预览只返回当前输入生成的 PDF，不暴露磁盘路径，也不往 exports 写临时文件。 */
export async function PreviewResumePdf(BrowserWindow: BrowserWindowFactory, resume: ResumeExportInput): Promise<{ base64: string }> {
  const bytes = await RenderResumePdf(BrowserWindow, resume);
  if (bytes.length > 20 * 1024 * 1024) throw new Error('简历 PDF 过大，无法预览，请精简内容后重试');
  return { base64: bytes.toString('base64') };
}

function escapeXml(value: string): string { return value.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[character] as string)); }
export function SanitizeFileName(value: string): string { return (value || '未命名简历').replace(/[\\/:*?"<>|\x00-\x1f]/g, ' ').replace(/\s+/g, ' ').trim().replace(/[. ]+$/g, '').slice(0, 120) || '未命名简历'; }
export function CreateResumeHtml(resume: ResumeExportInput, fontFace = ''): string {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><style>
    @page { size: A4; margin: 7mm 9mm; }
    ${fontFace}
    * { box-sizing: border-box; }
    body { margin: 0; color: #172038; background: #fff; font: 10.5pt/1.4 "Segoe UI Variable Text", "Segoe UI", -apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif; }
    .resume-document { overflow-wrap: anywhere; }
    .resume-document-header { margin-bottom: 10pt; overflow: hidden; text-align: center; }
    .resume-document-identity { display: flex; flex-wrap: nowrap; align-items: baseline; justify-content: center; white-space: nowrap; }
    .resume-document-header h1 { margin: 0; color: #172038; font-size: 10.5pt; font-weight: 400; line-height: 1.4; }
    .resume-document-header h1.is-emphasized { font-size: 13pt; font-weight: 700; line-height: 1.35; }
    .resume-document-contact, .resume-document-education { color: #172038; font-size: 10.5pt; line-height: 1.4; white-space: nowrap; }
    .resume-document-contact { margin-left: 8pt; }
    .resume-header-separator { display: inline-block; margin: 0 6pt; color: #64748b; font-weight: 400; }
    .resume-document-education { margin: 4pt 0 0; }
    .resume-document-section { margin: 0 0 8pt; }
    .resume-document-section h2 { margin: 0 0 5pt; border-bottom: 1.5pt solid #244c9a; padding: 0 0 2pt; color: #244c9a; font-size: 15pt; font-weight: 500; line-height: 1.3; break-after: avoid; }
    .resume-document-section h3 { margin: 0 0 3pt; color: #172038; font-size: 11.5pt; line-height: 1.4; break-after: avoid; }
    .resume-document-section .resume-entry-title { margin: 0 0 7pt; padding: 6pt 8pt; color: #172038; background: #f1f1f1; font-size: 12pt; font-weight: 700; }
    .resume-document-section .resume-project-link { display: inline-block; margin: 0 0 8pt; color: #2455a6; font-size: 11pt; font-weight: 700; text-decoration: underline; }
    .resume-document-section p { margin: 0 0 2pt; text-align: justify; widows: 2; orphans: 2; }
    .resume-document-section ul { margin: 0 0 3pt; padding-left: 15pt; }
    .resume-document-section li { margin: 0 0 1pt; padding-left: 1pt; widows: 2; orphans: 2; }
    .resume-document-section strong { font-weight: 700; }
    .resume-document a { color: #244c9a; text-decoration: underline; text-underline-offset: 1pt; }
    .resume-entry { margin-bottom: 6pt; break-inside: avoid; }
    .resume-entry-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 12pt; break-after: avoid; }
    .resume-entry-heading h3 { flex: 1; min-width: 0; }
    .resume-entry-period { flex: none; max-width: 45%; text-align: right; color: #64748b; font-size: 10pt; line-height: 1.4; }
    .resume-github-icon { font-family: "Avery Resume Icons"; font-style: normal; font-weight: normal; display: inline-block; margin-right: 3pt; vertical-align: -1pt; }
    .resume-template-compact .resume-document-header { text-align: left; }
    :is(.resume-template-classic, .resume-template-compact) .resume-document-contact { display: block; margin-left: 0; white-space: normal; }
    .resume-template-compact .resume-document-identity { justify-content: flex-start; }
    .resume-template-compact .resume-document-contact { margin-left: 0; }
    .resume-template-compact .resume-document-section { margin-bottom: 6pt; }
    .resume-template-compact .resume-document-section h2 { border-bottom-width: 1pt; font-size: 12pt; }
    .resume-template-compact .resume-entry { margin-bottom: 4pt; }
  </style></head><body>${CreateResumeDocumentMarkup(resume)}</body></html>`;
}
export async function CreateDocxBuffer(resume: ResumeExportInput): Promise<Buffer> {
  const JSZip = (await import('jszip')).default;
  const zip = new JSZip();
  const content = resume.data ? ResumeDataToText(resume.data) : resume.content;
  const paragraphs = [resume.name || '未命名简历', resume.summary || '', ...content.split(/\r?\n/)].map((line) => `<w:p><w:r><w:t xml:space="preserve">${escapeXml(line)}</w:t></w:r></w:p>`).join('');
  zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  zip.folder('_rels')?.file('.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  zip.folder('word')?.file('document.xml', `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paragraphs}<w:sectPr/></w:body></w:document>`);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}
/** 导出窗口始终 sandbox；返回值只含文件名，物理路径不回流 Renderer。 */
export async function ExportResume({ BrowserWindow, workspacePath, resume, format, outputDirectory, requireCompleteImage = false }: { BrowserWindow: BrowserWindowFactory; workspacePath: string; resume: ResumeExportInput; format: ExportFormat; outputDirectory?: string; requireCompleteImage?: boolean }): Promise<{ path: string; fileName: string }> {
  if (!ResumeExportFormats.includes(format)) throw new Error('Unsupported resume export format.');
  const destinationDirectory = outputDirectory ?? join(workspacePath, 'exports');
  await mkdir(destinationDirectory, { recursive: true });
  const fileName = `${SanitizeFileName(resume.name)}.${format}`;
  const outputPath = join(destinationDirectory, fileName);
  if (format === 'html') { await writeFile(outputPath, CreateResumeHtml(resume, await LoadFontFace()), 'utf8'); return { path: outputPath, fileName }; }
  if (format === 'docx') { await writeFile(outputPath, await CreateDocxBuffer(resume)); return { path: outputPath, fileName }; }
  if (format === 'pdf') { await writeFile(outputPath, await RenderResumePdf(BrowserWindow, resume)); return { path: outputPath, fileName }; }
  const window = new BrowserWindow({ show: false, width: 794, height: 1123, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  try {
    await window.loadURL('about:blank');
    await window.webContents.executeJavaScript(`document.open();document.write(${JSON.stringify(CreateResumeHtml(resume, await LoadFontFace()))});document.close();`);
    await window.webContents.executeJavaScript('document.fonts ? document.fonts.ready : Promise.resolve()');
    const pageHeight = await window.webContents.executeJavaScript('Math.max(document.documentElement.scrollHeight,1123)');
    if (requireCompleteImage && typeof pageHeight === 'number' && pageHeight > 16000) throw new Error('The resume image exceeds the complete PNG capture limit.');
    const height = typeof pageHeight === 'number' ? Math.min(pageHeight, 16000) : 1123;
    window.setContentSize(794, height);
    await writeFile(outputPath, (await window.webContents.capturePage({ x: 0, y: 0, width: 794, height })).toPNG());
    return { path: outputPath, fileName };
  } finally { if (!window.isDestroyed()) window.destroy(); }
}
