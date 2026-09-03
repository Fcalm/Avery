import { describe, expect, it } from 'vitest';
import { CreateResumeDocumentMarkup } from '@avery/contracts';
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
    expect(markup).toContain('<h3 class="resume-project-title">Avery｜求职助手</h3>');
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
    expect(html).toContain('resume-document-section h2');
  });
});
