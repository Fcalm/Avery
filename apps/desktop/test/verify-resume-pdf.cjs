// 使用真实 Electron 打印器和应用的 PDF.js 构建验证文档；不启动应用业务或操作界面控件。
const { app, BrowserWindow } = require('electron');
const { mkdtempSync, mkdirSync, readdirSync, statSync, writeFileSync, readFileSync } = require('node:fs');
const { join } = require('node:path');
const { pathToFileURL } = require('node:url');
const { tmpdir } = require('node:os');
const assert = require('node:assert/strict');
const { PreviewResumePdf, ExportResume } = require('../dist/resume-export.js');
const { CreateEmptyResumeData, ResumeDataToText } = require('../../../packages/contracts/dist/index.js');
const root = process.argv[2] || mkdtempSync(join(tmpdir(), 'avery-pdf-verification-'));
mkdirSync(root, { recursive: true });
mkdirSync(join(root, 'electron-state'), { recursive: true });
app.setPath('userData', join(root, 'electron-state'));
app.on('window-all-closed', () => { /* 打印窗口按任务关闭，测试完成后统一退出。 */ });

app.whenReady().then(async () => {
  let viewer;
  try {
    const data = CreateEmptyResumeData();
    data.personal = { name: '林小雨', email: 'lin@example.com', phone: '13800000000', github: 'https://github.com/example' };
    data.education = [{ school: '示例大学', degree: '本科', major: '工商管理', start: '2022-09', end: '2026-06' }];
    data.work = [{ company: '示例科技有限公司', project: '', role: '产品实习生', start: '2025-07', end: '2025-09', descriptions: ['参与用户访谈与需求分析，将调研结果整理为可执行的产品方案。', '协调设计与研发团队，推动原型评审和版本交付。'] }];
    data.projects = [{ name: 'Avery 智能求职助手', role: '项目负责人', start: '2026-01', end: '至今', descriptions: ['独立完成需求分析、PRD、交互原型与 MVP 验证。', '建立用户反馈与迭代流程，持续改进简历和岗位管理体验。'] }];
    data.sections = [{ title: '核心能力', items: ['SQL 数据分析、用户研究、原型设计、跨团队协作。'] }];
    const resume = { name: '单页测试简历', summary: '', content: ResumeDataToText(data), data, templateId: 'classic' };
    const preview = await PreviewResumePdf(BrowserWindow, resume);
    const exported = await ExportResume({ BrowserWindow, workspacePath: root, resume, format: 'pdf' });
    assert.deepEqual(readFileSync(exported.path), Buffer.from(preview.base64, 'base64'));
    const longData = structuredClone(data);
    const longDescription = '围绕用户目标开展访谈、竞品分析、需求优先级评估和交互设计，形成可验证的产品方案，并通过数据分析持续追踪交付效果。'.repeat(14);
    longData.projects = Array.from({ length: 3 }, (_, i) => ({ ...data.projects[0], name: `长篇项目 ${i + 1}`, descriptions: Array.from({ length: 5 }, () => longDescription) }));
    const multi = await PreviewResumePdf(BrowserWindow, { ...resume, name: '多页测试简历', data: longData, content: ResumeDataToText(longData) });
    writeFileSync(join(root, 'multiple-pages.pdf'), Buffer.from(multi.base64, 'base64'));
    const assets = join(__dirname, '../../../dist/assets');
    const runtime = readdirSync(assets).filter((name) => /^pdfRuntime-.*\.js$/.test(name)).sort((a, b) => statSync(join(assets, b)).mtimeMs - statSync(join(assets, a)).mtimeMs)[0];
    assert.ok(runtime, 'PDF.js 预览构建必须存在');
    const documentPath = join(root, 'pdf-runtime.html');
    writeFileSync(documentPath, '<!doctype html><meta charset="utf-8"><div id="root"></div><canvas id="page"></canvas>');
    viewer = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
    await viewer.loadFile(documentPath);
    const results = [];
    for (const [name, base64] of [['single', preview.base64], ['multiple', multi.base64]]) {
      const result = await viewer.webContents.executeJavaScript(`(async () => {
        const { LoadResumePdf } = await import(${JSON.stringify(pathToFileURL(join(assets, runtime)).href)});
        const loaded = LoadResumePdf(${JSON.stringify(base64)});
        try {
          const pdf = await loaded.task.promise;
          const page = await pdf.getPage(1);
          const viewport = page.getViewport({ scale: 1.5 });
          const canvas = document.getElementById('page'); canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height);
          await page.render({ canvas, viewport }).promise;
          const text = (await page.getTextContent()).items.filter(item => 'str' in item).map(item => item.str).join(' ');
          const links = (await page.getAnnotations()).filter(item => item.subtype === 'Link').map(item => item.url);
          return { pages: pdf.numPages, text, links, png: canvas.toDataURL('image/png').split(',')[1] };
        } finally { await loaded.Destroy(); }
      })()`);
      assert.ok(result.text.includes('林小雨')); assert.ok(result.links.includes('https://github.com/example'));
      if (name === 'single') assert.equal(result.pages, 1); else assert.ok(result.pages > 1);
      writeFileSync(join(root, `${name}-page-1.png`), Buffer.from(result.png, 'base64'));
      results.push({ name, pages: result.pages, githubLink: true });
    }
    writeFileSync(join(root, 'result.json'), JSON.stringify({ sharedPdfBytes: true, results }, null, 2));
    process.stdout.write(JSON.stringify({ root, sharedPdfBytes: true, results }) + '\n');
  } finally { if (viewer && !viewer.isDestroyed()) viewer.destroy(); app.quit(); }
}).catch((error) => { process.stderr.write(error.stack + '\n'); app.exit(1); });
