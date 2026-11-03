import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { describe, expect, it } from 'vitest';
import { CreateEmptyResumeData } from '@avery/contracts';
import { CreateResumeDraft, ApplyResumeDraft, ValidateResumeDraft } from '../../../src/features/resume/resumeDraft';
import { ResumeEditor } from '../../../src/features/resume/components/ResumeEditor';

describe('共享简历编辑器', () => {
  const resume = { id: 'one', name: '原简历', content: '旧正文\n保留换行', summary: '旧摘要', targetRoles: ['产品'], revision: 5 };
  it('草稿更换模板不改写旧原文、目标岗位或版本元数据', () => {
    const draft = CreateResumeDraft(resume);
    draft.templateId = 'compact';
    const saved = ApplyResumeDraft(resume, draft);
    expect(saved).toMatchObject({ ...resume, data: { mode: 'legacy', legacyContent: resume.content }, templateId: 'compact' });
    expect(resume).not.toHaveProperty('data');
  });
  it('结构化字段渲染五个分区，选填字段不标必填', () => {
    const markup = renderToStaticMarkup(createElement(ResumeEditor, { value: { name: '新简历', data: CreateEmptyResumeData(), templateId: 'classic' }, onChange: () => undefined, validationAttempt: 1 }));
    for (const label of ['个人信息', '教育经历', '工作经历', '项目经历', '自由栏目']) expect(markup).toContain(label);
    expect(markup).toContain('aria-required="false"');
    expect(markup).toContain('aria-invalid="true"');
    expect(markup).toContain('此项为必填项');
  });
  it('旧内容仍可直接编辑，转换结构前不展示空的必填字段', () => {
    const markup = renderToStaticMarkup(createElement(ResumeEditor, { value: CreateResumeDraft(resume), onChange: () => undefined, validationAttempt: 0 }));
    expect(markup).toContain('转为结构化编辑');
    expect(markup).toContain('旧正文\n保留换行');
    expect(markup).toContain('maxLength="200000"');
    expect(markup).not.toContain('type="email"');
  });
  it('标题跟随草稿保存，保留正文和元数据并拒绝空白及过长标题', () => {
    const draft = CreateResumeDraft(resume);
    expect(draft.name).toBe(resume.name);
    draft.name = '  产品经理简历  ';
    expect(ApplyResumeDraft(resume, draft)).toMatchObject({ ...resume, name: '产品经理简历' });
    expect(resume.name).toBe('原简历');
    expect(ValidateResumeDraft(draft)).toEqual([]);
    for (const name of ['  ', '字'.repeat(201)]) {
      expect(ValidateResumeDraft({ ...draft, name })).toContainEqual(expect.objectContaining({ path: 'name' }));
    }
    const markup = renderToStaticMarkup(createElement(ResumeEditor, { value: { ...draft, name: '' }, onChange: () => undefined, validationAttempt: 1 }));
    expect(markup).toContain('简历标题');
    expect(markup).toContain('maxLength="200"');
    expect(markup).toContain('aria-invalid="true"');
  });
});
