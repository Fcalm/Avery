"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
// @ts-nocheck
const fs = require('node:fs');
const path = require('node:path');
/** 转义 HTML，确保简历正文只能作为文本渲染。 */
function EscapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
}
/** 转义 Open XML 文本节点。 */
function EscapeXml(value) {
    return String(value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[character]));
}
/** 将展示名称收敛为跨平台安全的导出文件名。 */
function SanitizeFileName(value) {
    const normalized = String(value || '未命名简历').replace(/[\\/:*?"<>|\x00-\x1f]/g, ' ').replace(/\s+/g, ' ').trim().replace(/[. ]+$/g, '');
    return (normalized || '未命名简历').slice(0, 120);
}
/** 返回用于 PDF/PNG 渲染的单页简历 HTML。 */
function CreateResumeHtml(resume) {
    const title = EscapeHtml(resume.name || '未命名简历');
    const summary = EscapeHtml(resume.summary || '');
    const content = EscapeHtml(resume.content || '').replace(/\r?\n/g, '<br>');
    return `<!doctype html><html><head><meta charset="utf-8"><style>
    @page { size: A4; margin: 18mm; } * { box-sizing: border-box; } body { margin: 0; color: #252525; font: 14px/1.72 -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif; background: #fffdf9; }
    main { width: 100%; padding: 18mm; } h1 { margin: 0 0 5px; font-size: 26px; letter-spacing: .02em; } .summary { color: #6b655d; margin-bottom: 18px; } article { white-space: normal; overflow-wrap: anywhere; } 
  </style></head><body><main><h1>${title}</h1>${summary ? `<div class="summary">${summary}</div>` : ''}<article>${content}</article></main></body></html>`;
}
/** 创建只含原始文本的兼容 DOCX，避免引入模板执行和外部资源。 */
async function CreateDocxBuffer(resume) {
    // jszip 首用动态加载：ExportResume 首次执行 docx 分支时才加载，不进桌面壳启动路径。
    const JSZip = require('jszip');
    const zip = new JSZip();
    const paragraphs = [resume.name || '未命名简历', resume.summary || '', ...(String(resume.content || '').split(/\r?\n/))]
        .map((line) => `<w:p><w:r><w:t xml:space="preserve">${EscapeXml(line)}</w:t></w:r></w:p>`).join('');
    zip.file('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
    zip.folder('_rels').file('.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
    zip.folder('word').file('document.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paragraphs}<w:sectPr/></w:body></w:document>`);
    return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}
/** 生成由用户在应用内触发的简历文件。 */
async function ExportResume({ BrowserWindow, workspacePath, resume, format }) {
    if (!['pdf', 'docx', 'png'].includes(format))
        throw new Error('Unsupported resume export format.');
    if (!resume || typeof resume.name !== 'string' || typeof resume.content !== 'string')
        throw new Error('The resume content is invalid.');
    const outputDirectory = path.join(workspacePath, 'exports');
    fs.mkdirSync(outputDirectory, { recursive: true });
    const baseName = SanitizeFileName(resume.name);
    const outputPath = path.join(outputDirectory, `${baseName}.${format}`);
    if (format === 'docx') {
        fs.writeFileSync(outputPath, await CreateDocxBuffer(resume));
        return { path: outputPath, fileName: `${baseName}.${format}` };
    }
    // 导出窗口同样是 Renderer，不降低 sandbox 隔离等级。
    const window = new BrowserWindow({ show: false, width: 794, height: 1123, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
    try {
        await window.loadURL('about:blank');
        await window.webContents.executeJavaScript(`document.open(); document.write(${JSON.stringify(CreateResumeHtml(resume))}); document.close();`);
        await window.webContents.executeJavaScript('document.fonts ? document.fonts.ready : Promise.resolve()');
        if (format === 'pdf')
            fs.writeFileSync(outputPath, await window.webContents.printToPDF({ pageSize: 'A4', printBackground: true, marginsType: 1 }));
        else {
            const height = await window.webContents.executeJavaScript('Math.min(Math.max(document.documentElement.scrollHeight, 1123), 16000)');
            window.setContentSize(794, height);
            const image = await window.webContents.capturePage({ x: 0, y: 0, width: 794, height });
            fs.writeFileSync(outputPath, image.toPNG());
        }
        return { path: outputPath, fileName: `${baseName}.${format}` };
    }
    finally {
        if (!window.isDestroyed())
            window.destroy();
    }
}
module.exports = { CreateDocxBuffer, CreateResumeHtml, ExportResume, SanitizeFileName };
