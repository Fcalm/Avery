import { describe, expect, it } from 'vitest';
import { CreateEmptyResumeData, CreateResumeDocumentMarkup, GetResumeData, ReconcileResumeText, ResumeDataSchema, ResumeDataToText, ValidateResumeData } from '@avery/contracts';

export function ExampleResumeData() {
  const data = CreateEmptyResumeData();
  data.personal = { name: '林小雨', email: 'lin@example.com', phone: '+86 13800000000', github: '' };
  data.education = [{ school: '示例大学', degree: '本科', major: '工商管理', start: '2022-09', end: '2026-06' }];
  data.work = [{ company: '示例公司', project: '', role: '产品实习生', start: '2025-07', end: '2025-09', descriptions: ['完成用户调研'] }];
  data.projects = [{ name: 'Avery', role: '负责人', start: '2026-01', end: '至今', descriptions: ['制作交互原型', '交付 MVP'] }];
  data.sections = [{ title: '核心能力', items: ['SQL 分析', '需求分析'] }];
  return data;
}

describe('结构化简历数据', () => {
  it('两项选填可留空，其余字段校验必填并定位到具体内容', () => {
    const data = ExampleResumeData();
    expect(ValidateResumeData(data)).toEqual([]);
    data.personal.name = ' ';
    data.education[0].major = '';
    data.work[0].role = '';
    data.projects[0].descriptions[1] = '';
    data.sections[0].title = '';
    expect(ValidateResumeData(data).map((issue) => issue.path)).toEqual(['personal.name', 'education.0.major', 'work.0.role', 'projects.0.descriptions.1', 'sections.0.title']);
  });
  it('校验联系方式、GitHub 地址与倒序时间，接受至今与国际电话', () => {
    const data = ExampleResumeData();
    data.personal.email = 'wrong'; data.personal.phone = 'abc'; data.personal.github = 'javascript:alert(1)';
    data.education[0].end = '2020-01';
    expect(ValidateResumeData(data).map((issue) => issue.path)).toEqual(['personal.email', 'personal.phone', 'personal.github', 'education.0.end']);
  });
  it.each(['education', 'work', 'projects', 'sections'] as const)('%s 最多三组，既不截断也不忽略第四组', (key) => {
    const data = ExampleResumeData();
    // 通过运行时构造超限载荷，验证 IPC 使用的同一个 Schema。
    const row = data[key][0];
    const full = { ...data, [key]: [row, row, row] };
    expect(ResumeDataSchema.safeParse(full).success).toBe(true);
    expect(ResumeDataSchema.safeParse({ ...data, [key]: [row, row, row, row] }).success).toBe(false);
  });
  it.each(['work', 'projects', 'sections'] as const)('%s 内容必须为1至5条', (key) => {
    const data = ExampleResumeData();
    const field = key === 'sections' ? 'items' : 'descriptions';
    for (const count of [0, 1, 5, 6]) {
      const payload = { ...data, [key]: [{ ...data[key][0], [field]: Array.from({ length: count }, () => '内容') }] };
      expect(ResumeDataSchema.safeParse(payload).success).toBe(count >= 1 && count <= 5);
    }
  });
  it('旧 HTML、超三组和未知栏目原文逐字保留，不做启发式拆分', () => {
    const content = '<h1>旧姓名</h1>\n# 未知栏目\n' + Array.from({ length: 8 }, (_, i) => `经历${i}\n六条描述`).join('\n');
    const legacy = GetResumeData({ content });
    expect(legacy.mode).toBe('legacy');
    expect(ResumeDataToText(legacy)).toBe(content);
    const converted = { ...legacy, mode: 'structured' as const, personal: ExampleResumeData().personal };
    expect(ResumeDataToText(converted)).toContain(content);
  });
  it('模板只改变排版，保留所有内容并转义危险 HTML', () => {
    const data = ExampleResumeData();
    data.sections[0].items.push('<script>alert(1)</script>');
    const baseline = structuredClone(data);
    for (const templateId of ['classic', 'compact'] as const) {
      const markup = CreateResumeDocumentMarkup({ name: '简历', summary: '', content: '', data, templateId });
      expect(markup).toContain(`resume-template-${templateId}`);
      expect(markup).toContain('示例大学'); expect(markup).toContain('完成用户调研'); expect(markup).toContain('交付 MVP');
      expect(markup).toContain('&lt;script&gt;'); expect(markup).not.toContain('<script>');
    }
    expect(data).toEqual(baseline);
  });
  it('旧 Agent 全文修改可完全往返时同步结构，否则返回原文兼容分支', () => {
    const data = ExampleResumeData();
    const text = ResumeDataToText(data).replace('制作交互原型', '制作高保真交互原型');
    const updated = ReconcileResumeText(data, text)!;
    expect(updated.projects[0].descriptions[0]).toBe('制作高保真交互原型');
    expect(ResumeDataToText(updated)).toBe(text);
    expect(ReconcileResumeText(data, '自由格式的新简历')).toBeNull();
    expect(ReconcileResumeText(data, text.replace('- 交付 MVP', '未知的多行段落\n另一行'))).toBeNull();
  });
});
