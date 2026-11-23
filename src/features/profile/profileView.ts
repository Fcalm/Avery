import type { ProfileCategory } from '../../types/domain';
import { ProfileCategoryLabel } from '../../shared/utils/format';
import { ProfileTemplateSections } from './profileDraft';

/** 档案正文是「[小节] + 字段：值」的行式文本；此处解析为只读视图所需的分节结构。 */
export interface ProfileViewSection {
  title: string;
  fields: Array<{ label: string; value: string }>;
}

/** 侧栏与抽屉列表行的描述：取前几个已填字段拼成一句话，空档案给固定提示。 */
export function GetProfileSummary(content: string, maxFields = 2): string {
  const filled = ParseProfileSections(content)
    .flatMap((section) => section.fields)
    .filter((field) => field.value);
  if (!filled.length) return '还没有填写内容。';
  return filled.slice(0, maxFields).map((field) => `${field.label} ${field.value}`).join('，') + (filled.length > maxFields ? ' 等' : '');
}

/**
 * 解析档案正文。约定与 profileDraft 的写入格式一致：
 * 每个小节以 [标题] 开头，字段行形如「标签：值」；模板多行字段内的后续段落归入该字段，
 * 与编辑器使用相同的字段边界，避免预览丢失粘贴内容。
 */
export function ParseProfileSections(content: string): ProfileViewSection[] {
  const sections: ProfileViewSection[] = [];
  let current: ProfileViewSection | null = null;
  let multilineField: ProfileViewSection['fields'][number] | null = null;
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    const sectionMatch = line.match(/^\[([^\[\]]+)\]$/);
    if (sectionMatch) {
      multilineField = null;
      current = { title: sectionMatch[1].trim(), fields: [] };
      sections.push(current);
      continue;
    }
    const fieldMatch = line.match(/^([^：:]{1,40})[：:](.*)$/);
    const template = Object.values(ProfileTemplateSections).flat().find((section) => section.title === current?.title);
    if (multilineField && (!fieldMatch || !template?.fields.some((field) => field.label === fieldMatch[1].trim()))) {
      multilineField.value += `\n${rawLine}`;
      continue;
    }
    if (!line) continue;
    if (fieldMatch) {
      const field = { label: fieldMatch[1].trim(), value: fieldMatch[2].trim() };
      if (current) current.fields.push(field);
      else sections.push({ title: '', fields: [field] });
      multilineField = template?.fields.find((item) => item.label === field.label)?.multiline ? field : null;
    }
  }
  for (const section of sections) for (const field of section.fields) field.value = field.value.trim();
  return sections.filter((section) => section.title || section.fields.length);
}

/** 档案分类在页面与选择菜单中的固定展示顺序；未收录的分类排在最后。 */
const ProfileCategoryOrder: ProfileCategory[] = ['application', 'job_intention', 'education', 'project', 'work', 'skill_certificate', 'other'];

export function CompareProfileCategory(left: ProfileCategory, right: ProfileCategory): number {
  const leftIndex = ProfileCategoryOrder.indexOf(left);
  const rightIndex = ProfileCategoryOrder.indexOf(right);
  return (leftIndex === -1 ? ProfileCategoryOrder.length : leftIndex) - (rightIndex === -1 ? ProfileCategoryOrder.length : rightIndex);
}

export function ProfileCategoryTitle(category: ProfileCategory): string {
  return ProfileCategoryLabel[category];
}

/** 复制到剪贴板的纯文本形态：小节标题 + 「标签：值」行，与正文存储格式一致。 */
export function BuildProfilePlainText(sections: ProfileViewSection[]): string {
  return sections
    .map((section) => [section.title ? `[${section.title}]` : '', ...section.fields.map((field) => `${field.label}：${field.value}`)].filter(Boolean).join('\n'))
    .filter(Boolean)
    .join('\n\n');
}
