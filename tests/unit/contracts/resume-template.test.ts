import { describe, expect, it } from 'vitest';
import { CreateEmptyResumeData, CreateResumeDocumentMarkup } from '@avery/contracts';
import { CreateResumeHtml } from '../../../apps/desktop/src/resume-export';

describe('统一简历文档模板', () => {
  const resume = {
    name: '王小明 <候选人>',
    summary: '不应出现在简历预览中',
    content: '王小明｜13800000000｜candidate@example.com\n教育背景\n南昌大学｜工商管理\n# 项目经历\n### Avery｜求职助手\n- **负责** 简历优化与岗位管理\n- https://example.com',
  };

  it('将 Markdown 内容归一为统一的安全简历排版', () => {
    const markup = CreateResumeDocumentMarkup(resume);
    expect(markup).toContain('class="resume-document"');
    expect(markup).toContain('<h1>王小明</h1>');
    expect(markup).toContain('13800000000');
    expect(markup).toContain('candidate@example.com');
    expect(markup).toContain('<h2>项目经历</h2>');
    // 534ac4e 起项目标题同时携带通用条目类名与 project 标记类，断言同步当前模板行为。
    expect(markup).toContain('<h3 class="resume-entry-title resume-project-title">Avery｜求职助手</h3>');
    expect(markup).toContain('<strong>负责</strong>');
    expect(markup).toContain('南昌大学｜工商管理');
    expect(markup).not.toContain('<h2>教育背景</h2>');
    expect(markup).not.toContain('不应出现在简历预览中');
    expect(markup).not.toContain('简历内容');
  });

  it('HTML 与 PDF 导出共享同一份文档正文和打印样式', () => {
    const html = CreateResumeHtml(resume);
    expect(html).toContain(CreateResumeDocumentMarkup(resume));
    expect(html).toContain('@page { size: A4;');
    expect(html).toContain('margin: 7mm 9mm');
    expect(html).toContain('10.5pt/1.4 "Segoe UI Variable Text"');
    expect(html).toContain('resume-document-section h2');
  });

  it('学校、公司和项目的时间与标题同排，GitHub 图标只出现在链接前', () => {
    const data = CreateEmptyResumeData();
    data.personal = { name: '测试姓名', email: 'test@example.com', phone: '13800000000', github: 'https://github.com/example' };
    data.education = [{ school: '示例大学', degree: '本科', major: '工商管理', start: '2022-09', end: '2026-06' }];
    data.work = [{ company: '示例公司', project: '', role: '产品实习生', start: '2025-07', end: '2025-09', descriptions: ['用户研究'] }];
    data.projects = [{ name: 'Avery', role: '负责人', start: '2026-01', end: '至今', descriptions: ['制作原型'] }];
    const input = { name: '简历', summary: '', content: '', data };
    const markup = CreateResumeDocumentMarkup(input);
    expect(markup.match(/class="resume-entry-heading"/g)).toHaveLength(3);
    expect(markup).toContain('<h3>示例大学 · 本科 · 工商管理</h3><span class="resume-entry-period">2022-09 – 2026-06</span>');
    expect(markup).toContain('class="resume-github-icon"');
    expect(markup.indexOf('resume-github-icon')).toBeLessThan(markup.lastIndexOf('https://github.com/example'));
    expect(CreateResumeHtml(input)).toContain('text-align: right');
    data.personal.github = '';
    expect(CreateResumeDocumentMarkup(input)).not.toContain('class="resume-github-icon"');
  });
});
