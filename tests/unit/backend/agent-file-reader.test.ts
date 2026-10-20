import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import JSZip from 'jszip';
import { AgentFileReader } from '../../../apps/backend/src/electron/backend/agent-file-reader';
import { InstallBrowserPolyfills } from '../../../apps/backend/src/electron/backend/pdf-polyfills';

const directories: string[] = [];
function Directory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'avery-file-reader-'));
  directories.push(directory);
  return directory;
}
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

/** 本地最小 PDF，验证实际解析器的文本层处理，不读取用户文件。 */
function Pdf(text: string): string {
  const stream = text ? `BT /F1 12 Tf 10 50 Td (${text}) Tj ET` : '';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let content = '%PDF-1.7\n';
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(content));
    content += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(content);
  content += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}`;
  return `${content}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
}

describe('文件读取与模型视觉输入边界', () => {
  it('按宿主授权的 Markdown 快照名读取附件，不按原始 PDF 文件名分派', async () => {
    const file = join(Directory(), 'snapshot');
    writeFileSync(file, '# 简历\n经历内容');
    const reader = new AgentFileReader(async () => ({ physicalPath: file, name: 'resume.pdf.md' }));
    expect(await reader.ResolveAttachmentUri('attachment://one/resume.pdf')).toBe(file);
    expect(await reader.ReadAuthorizedFile(file, 'resume.pdf')).toEqual({ content: '# 简历\n经历内容', truncated: false });
  });

  it.each(['png', 'jpg', 'jpeg', 'webp', 'gif'])('图片 %s 明确要求使用模型视觉输入，不伪造文字结果', async (extension) => {
    const reader = new AgentFileReader(async () => null);
    await expect(reader.ReadAuthorizedFile(`image.${extension}`)).rejects.toThrow('vision-capable model');
  });

  it('取消和超时检查仍在读取入口生效', async () => {
    const reader = new AgentFileReader(async () => null);
    await expect(reader.ReadAuthorizedFile('image.png', undefined, { signal: AbortSignal.abort() })).rejects.toThrow('cancelled');
    await expect(reader.ReadAuthorizedFile('resume.txt', undefined, { deadline: Date.now() - 1 })).rejects.toThrow('cancelled');
  });

  it('文本 PDF 保留正文提取，无文本层 PDF 返回明确警告', async () => {
    InstallBrowserPolyfills();
    const directory = Directory();
    const reader = new AgentFileReader(async () => null);
    const textPdf = join(directory, 'text.pdf');
    const emptyPdf = join(directory, 'empty.pdf');
    writeFileSync(textPdf, Pdf('Resume experience'));
    writeFileSync(emptyPdf, Pdf(''));
    expect(await reader.ReadAuthorizedFile(textPdf)).toMatchObject({ content: expect.stringContaining('Resume experience'), pages: 1, warnings: [] });
    const empty = await reader.ReadAuthorizedFile(emptyPdf);
    expect(empty.content.trim()).toBe('');
    expect(empty).toMatchObject({ pages: 1, warnings: [expect.stringContaining('no extractable text layer')] });
  });

  it('Word 文本解析保留', async () => {
    const zip = new JSZip();
    zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
    zip.file('_rels/.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
    zip.file('word/document.xml', '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Resume experience</w:t></w:r></w:p></w:body></w:document>');
    const file = join(Directory(), 'resume.docx');
    writeFileSync(file, await zip.generateAsync({ type: 'nodebuffer' }));
    const reader = new AgentFileReader(async () => null);
    expect(await reader.ReadAuthorizedFile(file)).toMatchObject({ content: expect.stringContaining('Resume experience'), warnings: [] });
  });
});
