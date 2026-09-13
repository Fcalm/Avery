import { describe, expect, it } from 'vitest';
import { BuildProfilePlainText, CompareProfileCategory, GetProfileSummary, ParseProfileSections } from '../../../src/features/profile/profileView';

describe('ParseProfileSections', () => {
  it('把「[小节] + 字段：值」正文解析为分节字段结构', () => {
    const content = '[教育经历]\n学校名称：同济大学\n开始时间：2015-09\n\n[项目经历]\n项目名称：结算中心改版\n项目角色：主导设计';
    expect(ParseProfileSections(content)).toEqual([
      { title: '教育经历', fields: [{ label: '学校名称', value: '同济大学' }, { label: '开始时间', value: '2015-09' }] },
      { title: '项目经历', fields: [{ label: '项目名称', value: '结算中心改版' }, { label: '项目角色', value: '主导设计' }] },
    ]);
  });

  it('空值字段保留为空字符串，供视图显示占位', () => {
    const sections = ParseProfileSections('[求职意向]\n期望薪资：\n到岗时间：1月内');
    expect(sections[0].fields).toEqual([{ label: '期望薪资', value: '' }, { label: '到岗时间', value: '1月内' }]);
  });

  it('小节外的散行归入无标题小节，空行与无效行被忽略', () => {
    const sections = ParseProfileSections('\n备注：海外投递时用英文名\n\n随机文本行');
    expect(sections).toEqual([{ title: '', fields: [{ label: '备注', value: '海外投递时用英文名' }] }]);
  });
});

describe('GetProfileSummary', () => {
  it('取前几个已填字段拼成列表行描述，超出部分以「等」收尾', () => {
    const content = '[教育经历]\n学校名称：同济大学\n专业名称：工业设计\n学历：本科';
    expect(GetProfileSummary(content)).toBe('学校名称 同济大学，专业名称 工业设计 等');
    expect(GetProfileSummary(content, 3)).toBe('学校名称 同济大学，专业名称 工业设计，学历 本科');
  });

  it('没有已填字段时返回固定提示', () => {
    expect(GetProfileSummary('[教育经历]\n学校名称：')).toBe('还没有填写内容。');
  });
});

describe('BuildProfilePlainText', () => {
  it('还原为与存储格式一致的小节文本，供复制到剪贴板', () => {
    const text = BuildProfilePlainText([
      { title: '求职意向', fields: [{ label: '期望职能', value: '产品设计师' }, { label: '期望薪资', value: '' }] },
      { title: '', fields: [{ label: '备注', value: '远程优先' }] },
    ]);
    expect(text).toBe('[求职意向]\n期望职能：产品设计师\n期望薪资：\n\n备注：远程优先');
  });
});

describe('CompareProfileCategory', () => {
  it('按页面展示顺序比较分类：个人信息、求职意向、教育、项目、工作、证书、其他', () => {
    expect(CompareProfileCategory('application', 'work')).toBeLessThan(0);
    expect(CompareProfileCategory('education', 'job_intention')).toBeGreaterThan(0);
    expect(CompareProfileCategory('other', 'other')).toBe(0);
  });
});
