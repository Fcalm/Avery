import { describe, expect, it } from 'vitest';
import {
  ChangeProfileDraftCategory,
  CreateProfileDraft,
  GetProfileDraftErrors,
  GetProfileField,
  GetProfileFieldId,
  IsProfileDateValue,
  ProfileTemplateForCategory,
  ProfileTemplateSections,
  UpdateProfileField,
} from '../../../src/features/profile/profileDraft';

describe('档案草稿模板', () => {
  it('每种档案分类创建时均使用本类型模板', () => {
    const expectedSections = {
      application: '个人信息', education: '教育经历', work: '工作经历', job_intention: '求职意向', project: '项目经历', skill_certificate: '技能/证书', other: '其他资料',
    } as const;

    for (const [category, section] of Object.entries(expectedSections)) {
      const draft = CreateProfileDraft(category as keyof typeof expectedSections);
      expect(draft.content).toContain(`[${section}]`);
      expect(draft.content).toBe(ProfileTemplateForCategory(category as keyof typeof expectedSections));
    }
  });

  it('附件要求的各类字段均写入对应模板', () => {
    expect(ProfileTemplateSections.application[0].fields.map((field) => field.label)).toEqual([
      '姓名', '性别', '出生日期', '邮箱', '手机号码', '证件号码', '毕业时间', '工作年限', '国籍/地区', '籍贯', '民族', '政治面貌', '现居住地', '户口所在地',
    ]);
    expect(ProfileTemplateSections.education[0].fields.map((field) => field.label)).toEqual(['学校名称', '开始时间', '结束时间', '学历类型', '专业名称', '学历', '学位']);
    expect(ProfileTemplateSections.work[0].fields.map((field) => field.label)).toContain('工作职责/内容');
    expect(ProfileTemplateSections.job_intention[0].fields.map((field) => field.label)).toEqual(['期望工作城市', '期望职能', '期望薪资', '到岗时间']);
    expect(ProfileTemplateSections.education[0].fields.find((field) => field.label === '学历类型')?.options).toEqual(['统招全日制', '统招非全日制', '海外及港澳台', '其他']);
    expect(ProfileTemplateSections.job_intention[0].fields.find((field) => field.label === '到岗时间')?.options).toEqual(['1周内', '1月内', '三月内']);
    expect(ProfileTemplateSections.project[0].fields.map((field) => field.label)).toContain('项目职责/内容');
  });

  it('附件标注为必填的字段保留 required 标记', () => {
    expect(ProfileTemplateSections.work[0].fields.find((field) => field.label === '部门')?.required).toBeUndefined();
    expect(ProfileTemplateSections.work[0].fields.find((field) => field.label === '公司名称')?.required).toBe(true);
    expect(ProfileTemplateSections.project[0].fields.find((field) => field.label === '项目描述')?.required).toBe(true);
  });

  it('从未修改模板切换分类时替换为目标分类模板', () => {
    const personal = CreateProfileDraft('application');
    const changed = ChangeProfileDraftCategory(personal, 'work');

    expect(changed).toEqual(CreateProfileDraft('work'));
  });

  it('切换分类时保留已经编辑的内容', () => {
    const personal = CreateProfileDraft('application');
    const edited = { ...personal, content: UpdateProfileField(personal.content ?? '', '个人信息', '姓名', '范炜乾') };

    expect(ChangeProfileDraftCategory(edited, 'other')).toEqual({ ...edited, category: 'other' });
  });

  it('更新一个字段不会覆盖相邻字段', () => {
    const template = ProfileTemplateForCategory('education');
    const updated = UpdateProfileField(template, '教育经历', '学校名称', '测试大学');

    expect(GetProfileField(updated, '教育经历', '学校名称')).toBe('测试大学');
    expect(GetProfileField(updated, '教育经历', '开始时间')).toBe('');
    expect(GetProfileField(updated, '教育经历', '学位')).toBe('');
  });

  it('不读取未分区旧档案中的同名字段', () => {
    expect(GetProfileField('姓名：旧版用户', '个人信息', '姓名')).toBe('');
  });

  it('日期字段只接受横线或点号分隔的年月或年月日', () => {
    expect(IsProfileDateValue('2026-09')).toBe(true);
    expect(IsProfileDateValue('2026.09.08')).toBe(true);
    expect(IsProfileDateValue('2026/09')).toBe(false);
    expect(IsProfileDateValue('202609')).toBe(false);
  });

  it('所有分类的空模板均报告每个缺失必填项，空白输入不能通过校验', () => {
    for (const category of Object.keys(ProfileTemplateSections) as Array<keyof typeof ProfileTemplateSections>) {
      const draft = CreateProfileDraft(category);
      const errors = GetProfileDraftErrors(draft);
      const required = ProfileTemplateSections[category].flatMap((section, sectionIndex) => section.fields
        .flatMap((field, fieldIndex) => field.required ? [GetProfileFieldId(category, sectionIndex, fieldIndex)] : []));
      expect(Object.keys(errors)).toEqual(required);
      expect(GetProfileDraftErrors({ ...draft, title: ' \t ' })['profile-title']).toBe('请填写标题');
      const firstSection = ProfileTemplateSections[category][0];
      const firstRequired = firstSection.fields.findIndex((field) => field.required);
      const content = UpdateProfileField(draft.content!, firstSection.title, firstSection.fields[firstRequired].label, ' \t ');
      expect(GetProfileDraftErrors({ ...draft, content })[GetProfileFieldId(category, 0, firstRequired)]).toBeTruthy();
    }
  });

  it('只填写必填项即可保存，各分类空选填项不阻拦，包含下拉和多行字段', () => {
    for (const category of Object.keys(ProfileTemplateSections) as Array<keyof typeof ProfileTemplateSections>) {
      const draft = CreateProfileDraft(category);
      let content = draft.content!;
      for (const section of ProfileTemplateSections[category]) {
        for (const field of section.fields.filter((field) => field.required)) {
          content = UpdateProfileField(content, section.title, field.label, field.date ? '2026-10' : field.options?.[0] ?? '已填写');
        }
      }
      expect(GetProfileDraftErrors({ ...draft, content })).toEqual({});
    }
  });

  it('日期格式错误关联到具体控件，修正后仅移除该字段的错误', () => {
    const draft = CreateProfileDraft('work');
    const content = UpdateProfileField(draft.content!, '工作经历', '开始时间', '2026/10');
    const errors = GetProfileDraftErrors({ ...draft, content });
    expect(errors[GetProfileFieldId('work', 0, 1)]).toContain('格式');
    const corrected = GetProfileDraftErrors({ ...draft, content: UpdateProfileField(content, '工作经历', '开始时间', '2026.10') });
    const { [GetProfileFieldId('work', 0, 1)]: _dateError, ...remaining } = errors;
    expect(corrected).toEqual(remaining);
  });

  it('选填日期留空允许，但已填的错误日期仍需修正', () => {
    const draft = CreateProfileDraft('skill_certificate');
    const content = UpdateProfileField(draft.content!, '技能/证书', '技能/证书名称', '测试证书');
    expect(GetProfileDraftErrors({ ...draft, content })).toEqual({});
    const invalid = UpdateProfileField(content, '技能/证书', '获得时间', '202610');
    expect(Object.keys(GetProfileDraftErrors({ ...draft, content: invalid }))).toEqual([GetProfileFieldId('skill_certificate', 0, 2)]);
  });
});
