"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SanitizeFileName = SanitizeFileName;
exports.CreateResumeHtml = CreateResumeHtml;
exports.CreateDocxBuffer = CreateDocxBuffer;
exports.ExportResume = ExportResume;
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
function escapeHtml(value) { return value.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character])); }
function escapeXml(value) { return value.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[character])); }
function SanitizeFileName(value) { return (value || '未命名简历').replace(/[\\/:*?"<>|\x00-\x1f]/g, ' ').replace(/\s+/g, ' ').trim().replace(/[. ]+$/g, '').slice(0, 120) || '未命名简历'; }
function CreateResumeHtml(resume) {
    const title = escapeHtml(resume.name || '未命名简历');
    const summary = escapeHtml(resume.summary || '');
    const content = escapeHtml(resume.content || '').replace(/\r?\n/g, '<br>');
    return `<!doctype html><meta charset="utf-8"><style>@page{size:A4;margin:18mm}*{box-sizing:border-box}body{margin:0;color:#252525;font:14px/1.72 -apple-system,"Microsoft YaHei",sans-serif;background:#fffdf9}main{padding:18mm}h1{margin:0 0 5px;font-size:26px}.summary{color:#6b655d;margin-bottom:18px}article{overflow-wrap:anywhere}</style><main><h1>${title}</h1>${summary ? `<div class="summary">${summary}</div>` : ''}<article>${content}</article></main>`;
}
async function CreateDocxBuffer(resume) {
    const JSZip = (await import('jszip')).default;
    const zip = new JSZip();
    const paragraphs = [resume.name || '未命名简历', resume.summary || '', ...resume.content.split(/\r?\n/)].map((line) => `<w:p><w:r><w:t xml:space="preserve">${escapeXml(line)}</w:t></w:r></w:p>`).join('');
    zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
    zip.folder('_rels')?.file('.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
    zip.folder('word')?.file('document.xml', `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paragraphs}<w:sectPr/></w:body></w:document>`);
    return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}
/** 导出窗口始终 sandbox；返回值只含文件名，物理路径不回流 Renderer。 */
async function ExportResume({ BrowserWindow, workspacePath, resume, format }) {
    const outputDirectory = (0, node_path_1.join)(workspacePath, 'exports');
    (0, node_fs_1.mkdirSync)(outputDirectory, { recursive: true });
    const fileName = `${SanitizeFileName(resume.name)}.${format}`;
    const outputPath = (0, node_path_1.join)(outputDirectory, fileName);
    if (format === 'docx') {
        (0, node_fs_1.writeFileSync)(outputPath, await CreateDocxBuffer(resume));
        return { path: outputPath, fileName };
    }
    const window = new BrowserWindow({ show: false, width: 794, height: 1123, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
    try {
        await window.loadURL('about:blank');
        await window.webContents.executeJavaScript(`document.open();document.write(${JSON.stringify(CreateResumeHtml(resume))});document.close();`);
        await window.webContents.executeJavaScript('document.fonts ? document.fonts.ready : Promise.resolve()');
        if (format === 'pdf')
            (0, node_fs_1.writeFileSync)(outputPath, await window.webContents.printToPDF({ pageSize: 'A4', printBackground: true }));
        else {
            const pageHeight = await window.webContents.executeJavaScript('Math.min(Math.max(document.documentElement.scrollHeight,1123),16000)');
            const height = typeof pageHeight === 'number' ? pageHeight : 1123;
            window.setContentSize(794, height);
            (0, node_fs_1.writeFileSync)(outputPath, (await window.webContents.capturePage({ x: 0, y: 0, width: 794, height })).toPNG());
        }
        return { path: outputPath, fileName };
    }
    finally {
        if (!window.isDestroyed())
            window.destroy();
    }
}
