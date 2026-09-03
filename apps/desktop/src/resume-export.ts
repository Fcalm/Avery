import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { BrowserWindowConstructorOptions } from 'electron';
import { CreateResumeDocumentMarkup } from '@avery/contracts';

type HiddenWindow = { loadURL: (url: string) => Promise<void>; webContents: { executeJavaScript: (source: string) => Promise<unknown>; printToPDF: (options: Electron.PrintToPDFOptions) => Promise<Buffer>; capturePage: (rect: Electron.Rectangle) => Promise<Electron.NativeImage> }; setContentSize: (width: number, height: number) => void; isDestroyed: () => boolean; destroy: () => void };
type BrowserWindowFactory = new (options: BrowserWindowConstructorOptions) => HiddenWindow;
export type ExportFormat = 'html' | 'pdf' | 'docx' | 'png';
export type ResumeExportInput = { name: string; summary: string; content: string };
const ResumeExportFormats: readonly ExportFormat[] = ['html', 'pdf', 'docx', 'png'];

function escapeXml(value: string): string { return value.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[character] as string)); }
export function SanitizeFileName(value: string): string { return (value || '未命名简历').replace(/[\\/:*?"<>|\x00-\x1f]/g, ' ').replace(/\s+/g, ' ').trim().replace(/[. ]+$/g, '').slice(0, 120) || '未命名简历'; }
export function CreateResumeHtml(resume: ResumeExportInput): string {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><style>
    @page { size: A4; margin: 16mm 17mm; }
    * { box-sizing: border-box; }
    body { margin: 0; color: #172038; background: #fff; font: 10.5pt/1.65 "Noto Serif CJK SC", "Songti SC", "SimSun", serif; }
    .resume-document { overflow-wrap: anywhere; }
    .resume-document-header { margin-bottom: 18pt; text-align: center; }
    .resume-document-identity { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: center; }
    .resume-document-header h1 { margin: 0; color: #172038; font-size: 15pt; font-weight: 700; line-height: 1.3; }
    .resume-document-contact, .resume-document-education { color: #172038; font-size: 10.5pt; line-height: 1.6; }
    .resume-document-contact { margin-left: 8pt; }
    .resume-header-separator { display: inline-block; margin: 0 6pt; color: #64748b; font-weight: 400; }
    .resume-document-education { margin: 4pt 0 0; }
    .resume-document-section { break-inside: avoid; margin: 0 0 14pt; }
    .resume-document-section h2 { margin: 0 0 8pt; border-bottom: 1.5pt solid #244c9a; padding: 0 0 3pt; color: #244c9a; font-size: 15pt; font-weight: 500; line-height: 1.35; }
    .resume-document-section h3 { margin: 0 0 5pt; color: #172038; font-size: 11.5pt; line-height: 1.45; }
    .resume-document-section .resume-project-title { margin: 0 0 7pt; padding: 6pt 8pt; color: #172038; background: #f1f1f1; font-size: 12pt; font-weight: 700; }
    .resume-document-section .resume-project-link { display: inline-block; margin: 0 0 8pt; color: #2455a6; font-size: 11pt; font-weight: 700; text-decoration: underline; }
    .resume-document-section p { margin: 0 0 5pt; text-align: justify; }
    .resume-document-section ul { margin: 0 0 5pt; padding-left: 17pt; }
    .resume-document-section li { margin: 0 0 3pt; padding-left: 1pt; }
    .resume-document-section strong { font-weight: 700; }
    .resume-document-section a { color: #244c9a; text-decoration: underline; }
  </style></head><body>${CreateResumeDocumentMarkup(resume)}</body></html>`;
}
export async function CreateDocxBuffer(resume: ResumeExportInput): Promise<Buffer> {
  const JSZip = (await import('jszip')).default;
  const zip = new JSZip();
  const paragraphs = [resume.name || '未命名简历', resume.summary || '', ...resume.content.split(/\r?\n/)].map((line) => `<w:p><w:r><w:t xml:space="preserve">${escapeXml(line)}</w:t></w:r></w:p>`).join('');
  zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  zip.folder('_rels')?.file('.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  zip.folder('word')?.file('document.xml', `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paragraphs}<w:sectPr/></w:body></w:document>`);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}
/** 导出窗口始终 sandbox；返回值只含文件名，物理路径不回流 Renderer。 */
export async function ExportResume({ BrowserWindow, workspacePath, resume, format }: { BrowserWindow: BrowserWindowFactory; workspacePath: string; resume: ResumeExportInput; format: ExportFormat }): Promise<{ path: string; fileName: string }> {
  if (!ResumeExportFormats.includes(format)) throw new Error('Unsupported resume export format.');
  const outputDirectory = join(workspacePath, 'exports');
  mkdirSync(outputDirectory, { recursive: true });
  const fileName = `${SanitizeFileName(resume.name)}.${format}`;
  const outputPath = join(outputDirectory, fileName);
  if (format === 'html') { writeFileSync(outputPath, CreateResumeHtml(resume), 'utf8'); return { path: outputPath, fileName }; }
  if (format === 'docx') { writeFileSync(outputPath, await CreateDocxBuffer(resume)); return { path: outputPath, fileName }; }
  const window = new BrowserWindow({ show: false, width: 794, height: 1123, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  try {
    await window.loadURL('about:blank');
    await window.webContents.executeJavaScript(`document.open();document.write(${JSON.stringify(CreateResumeHtml(resume))});document.close();`);
    await window.webContents.executeJavaScript('document.fonts ? document.fonts.ready : Promise.resolve()');
    if (format === 'pdf') writeFileSync(outputPath, await window.webContents.printToPDF({ pageSize: 'A4', printBackground: true }));
    else {
      const pageHeight = await window.webContents.executeJavaScript('Math.min(Math.max(document.documentElement.scrollHeight,1123),16000)');
      const height = typeof pageHeight === 'number' ? pageHeight : 1123;
      window.setContentSize(794, height);
      writeFileSync(outputPath, (await window.webContents.capturePage({ x: 0, y: 0, width: 794, height })).toPNG());
    }
    return { path: outputPath, fileName };
  } finally { if (!window.isDestroyed()) window.destroy(); }
}
