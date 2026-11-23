import type { ProfileCategory, ProfileItem } from '../../types/domain';

type ProfileTemplateField = {
  label: string;
  required?: boolean;
  date?: boolean;
  multiline?: boolean;
  options?: readonly string[];
};

type ProfileTemplateSection = {
  title: string;
  fields: readonly ProfileTemplateField[];
};

const DatePlaceholder = 'YYYY-MM 或 YYYY.MM';

/** 档案按分类独立创建，避免再以一张聚合投递资料承载所有经历。 */
const ProfileTemplateSections: Record<ProfileCategory, readonly ProfileTemplateSection[]> = {
  application: [{
    title: '个人信息',
    fields: [
      { label: '姓名', required: true }, { label: '性别', required: true }, { label: '出生日期', required: true, date: true },
      { label: '邮箱', required: true }, { label: '手机号码', required: true }, { label: '证件号码', required: true },
      { label: '毕业时间', required: true, date: true }, { label: '工作年限', required: true }, { label: '国籍/地区', required: true },
      { label: '籍贯', required: true }, { label: '民族', required: true }, { label: '政治面貌', required: true },
      { label: '现居住地', required: true }, { label: '户口所在地', required: true },
    ],
  }],
  education: [{
    title: '教育经历',
    fields: [
      { label: '学校名称', required: true }, { label: '开始时间', required: true, date: true }, { label: '结束时间', required: true, date: true },
      { label: '学历类型', required: true, options: ['统招全日制', '统招非全日制', '海外及港澳台', '其他'] }, { label: '专业名称', required: true }, { label: '学历', required: true }, { label: '学位', required: true },
    ],
  }],
  work: [{
    title: '工作经历',
    fields: [
      { label: '公司名称', required: true }, { label: '开始时间', required: true, date: true }, { label: '结束时间', required: true, date: true },
      { label: '职位名称', required: true }, { label: '部门' }, { label: '企业性质' }, { label: '企业规模' }, { label: '职位年薪' },
      { label: '工作职责/内容', required: true, multiline: true },
    ],
  }],
  job_intention: [{
    title: '求职意向',
    fields: [
      { label: '期望工作城市', required: true }, { label: '期望职能', required: true }, { label: '期望薪资', required: true }, { label: '到岗时间', required: true, options: ['1周内', '1月内', '三月内'] },
    ],
  }],
  project: [{
    title: '项目经历',
    fields: [
      { label: '项目名称', required: true }, { label: '开始时间', required: true, date: true }, { label: '结束时间', required: true, date: true },
      { label: '项目描述', required: true, multiline: true }, { label: '项目角色', required: true }, { label: '项目职责/内容', required: true, multiline: true },
    ],
  }],
  skill_certificate: [{
    title: '技能/证书',
    fields: [
      { label: '技能/证书名称', required: true }, { label: '等级' }, { label: '获得时间', date: true }, { label: '发证机构' }, { label: '说明', multiline: true },
    ],
  }],
  other: [{
    title: '其他资料',
    fields: [{ label: '资料说明', required: true, multiline: true }],
  }],
};

const DefaultProfileTitles: Record<ProfileCategory, string> = {
  application: '个人信息', education: '教育经历', work: '工作经历', job_intention: '求职意向', project: '项目经历', skill_certificate: '技能/证书', other: '其他资料',
};

function EscapeRegularExpression(value: string) { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function ProfileTemplateForCategory(category: ProfileCategory): string {
  return ProfileTemplateSections[category]
    .map((section) => `[${section.title}]\n${section.fields.map((field) => `${field.label}：`).join('\n')}`)
    .join('\n\n');
}

function CreateProfileDraft(category: ProfileCategory): Partial<ProfileItem> {
  return { category, title: DefaultProfileTitles[category], content: ProfileTemplateForCategory(category) };
}

/** 多行字段延续到模板中的下一字段；正文里的冒号、列表和空行不再被截成隐藏内容。 */
function ProfileFieldPattern(sectionTitle: string, fieldLabel: string): RegExp {
  const section = Object.values(ProfileTemplateSections).flat().find((item) => item.title === sectionTitle);
  const prefix = `(^[\\t ]*${EscapeRegularExpression(fieldLabel)}[：:][\\t ]*)`;
  if (!section?.fields.find((field) => field.label === fieldLabel)?.multiline) return new RegExp(`${prefix}([^\\r\\n]*)`, 'm');
  const labels = section.fields.map((field) => EscapeRegularExpression(field.label)).join('|');
  return new RegExp(`${prefix}([^\\r\\n]*(?:\\r?\\n(?![\\t ]*(?:${labels})[：:])[^\\r\\n]*)*)`, 'm');
}

function GetProfileField(content: string, sectionTitle: string, fieldLabel: string) {
  const sectionPattern = new RegExp(`\\[${EscapeRegularExpression(sectionTitle)}\\]\\s*([\\s\\S]*?)(?=\\r?\\n\\s*\\[[^\\]\\r\\n]+\\]|$)`);
  const sectionMatch = content.match(sectionPattern);
  const section = sectionMatch?.[1] ?? '';
  // 冒号后的空白只能匹配行内空格；\\s 会吞掉换行并把下一字段标签当作当前字段值。
  const value = section.match(ProfileFieldPattern(sectionTitle, fieldLabel))?.[2] ?? '';
  const multiline = Object.values(ProfileTemplateSections).flat().find((item) => item.title === sectionTitle)?.fields.find((field) => field.label === fieldLabel)?.multiline;
  // 多行输入保留末尾换行，否则输入 Enter 后受控文本框会立即把换行删掉。
  return multiline ? value : value.trim();
}

function UpdateProfileField(content: string, sectionTitle: string, fieldLabel: string, value: string) {
  const sectionPattern = new RegExp(`(\\[${EscapeRegularExpression(sectionTitle)}\\]\\s*[\\s\\S]*?)(?=\\r?\\n\\s*\\[[^\\]\\r\\n]+\\]|$)`);
  const fieldPattern = ProfileFieldPattern(sectionTitle, fieldLabel);
  if (!sectionPattern.test(content)) return `${content.trimEnd()}\n\n[${sectionTitle}]\n${fieldLabel}：${value}`;
  return content.replace(sectionPattern, (section) => {
    // 回调替换避免粘贴文本中的 $&、$1 被解释成正则替换指令。
    if (fieldPattern.test(section)) return section.replace(fieldPattern, (_match, prefix: string) => `${prefix}${value}`);
    return `${section}${section.endsWith('\n') ? '' : '\n'}${fieldLabel}：${value}`;
  });
}

/** 保留已编辑内容；只有空草稿或未修改模板切换分类时才替换为目标分类模板。 */
function ChangeProfileDraftCategory(draft: Partial<ProfileItem>, nextCategory: ProfileCategory): Partial<ProfileItem> {
  const currentTemplate = draft.category ? ProfileTemplateForCategory(draft.category) : '';
  const canReplace = !draft.content?.trim() || draft.content === currentTemplate;
  return canReplace ? CreateProfileDraft(nextCategory) : { ...draft, category: nextCategory };
}

function IsProfileDateValue(value: string): boolean {
  return /^\d{4}[-.]\d{1,2}(?:[-.]\d{1,2})?$/.test(value.trim());
}

/** 校验与表单共用字段定位，必填缺失和日期格式错误都返回到对应控件。 */
function GetProfileFieldId(category: ProfileCategory, sectionIndex: number, fieldIndex: number): string {
  return `profile-${category}-${sectionIndex}-${fieldIndex}`;
}

function GetProfileDraftErrors(draft: Partial<ProfileItem>): Record<string, string> {
  const errors: Record<string, string> = {};
  if (!draft.title?.trim()) errors['profile-title'] = '请填写标题';
  const category = draft.category;
  if (!category) return errors;
  ProfileTemplateSections[category].forEach((section, sectionIndex) => {
    section.fields.forEach((field, fieldIndex) => {
      const value = GetProfileField(draft.content ?? '', section.title, field.label);
      const fieldId = GetProfileFieldId(category, sectionIndex, fieldIndex);
      if (field.required && !value.trim()) errors[fieldId] = `请填写${field.label}`;
      else if (field.date && value && !IsProfileDateValue(value)) errors[fieldId] = `请使用 ${DatePlaceholder} 格式`;
    });
  });
  return errors;
}

export {
  ChangeProfileDraftCategory,
  CreateProfileDraft,
  DatePlaceholder,
  DefaultProfileTitles,
  GetProfileField,
  GetProfileFieldId,
  GetProfileDraftErrors,
  IsProfileDateValue,
  ProfileTemplateForCategory,
  ProfileTemplateSections,
  UpdateProfileField,
};
