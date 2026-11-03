import { z } from 'zod';
import type { ResumeData } from '@avery/agent-sdk';
export type { ResumeData, ResumeTemplateId } from '@avery/agent-sdk';

export const ResumeLimits = { groups: 3, lines: 5 } as const;
export const ResumeTemplates = [{ id: 'classic', label: '经典' }, { id: 'compact', label: '简洁' }] as const;
const Text = z.string().max(2000);
const Lines = z.array(z.string().max(20000)).min(1).max(ResumeLimits.lines);
const Period = { start: Text, end: Text };
/** 数据不包含排版信息；旧版原文单独保存，迁移绝不猜测或截断未知字段。 */
export const ResumeDataSchema = z.object({
  version: z.literal(1),
  mode: z.enum(['structured', 'legacy']),
  personal: z.object({ name: Text, email: Text, phone: Text, github: Text }),
  education: z.array(z.object({ school: Text, degree: Text, major: Text, ...Period })).max(3),
  work: z.array(z.object({ company: Text, project: Text, role: Text, ...Period, descriptions: Lines })).max(3),
  projects: z.array(z.object({ name: Text, role: Text, ...Period, descriptions: Lines })).max(3),
  sections: z.array(z.object({ title: Text, items: Lines })).max(3),
  legacyContent: z.string().max(200000).optional(),
}) satisfies z.ZodType<ResumeData>;

/** PDF 预览与导出的有限输入；文档元数据不参与排版，不允许传入 HTML 模板或文件路径。 */
export const ResumeDocumentInputSchema = z.object({
  name: z.string().max(200), summary: z.string().max(20000).default(''), content: z.string().max(200000),
  data: ResumeDataSchema.optional(), templateId: z.enum(['classic', 'compact']).optional(),
});

/** Agent 只填写业务字段；宿主补上格式版本和结构化模式，不允许模型选择旧版兼容模式。 */
export const AgentResumeDataSchema = ResumeDataSchema.omit({ version: true, mode: true, legacyContent: true }).strict();
/** JSON Schema 仅由后端注册工具时生成，避免渲染进程为未使用的 Agent 协议做初始化。 */
export function CreateAgentResumeDataJsonSchema() {
  const { $schema: _metaSchema, ...schema } = z.toJSONSchema(AgentResumeDataSchema, { target: 'draft-7' });
  return schema;
}

/** 写入工具和确认回调共用校验，缺少事实时拒绝写入并让模型先向用户补问。 */
export function ParseAgentResumeData(input: unknown, retainedLegacyContent?: string): ResumeData {
  const data: ResumeData = { ...AgentResumeDataSchema.parse(input), version: 1, mode: 'structured', ...(retainedLegacyContent !== undefined ? { legacyContent: retainedLegacyContent } : {}) };
  const issues = ValidateResumeData(data);
  if (issues.length) throw new Error(`简历字段不完整或无效：${issues.map((issue) => `${issue.path} ${issue.message}`).join('；')}。请先询问用户缺失信息，不要编造。`);
  return data;
}
export interface ResumeValidationIssue { path: string; message: string }

export function CreateEmptyResumeData(): ResumeData {
  return { version: 1, mode: 'structured', personal: { name: '', email: '', phone: '', github: '' }, education: [], work: [], projects: [], sections: [] };
}

/** 只在明确不存在结构化数据时进入兼容模式；不解析格式不确定的旧正文。 */
export function GetResumeData(resume: { data?: ResumeData; content: string }): ResumeData {
  if (resume.data) return structuredClone(ResumeDataSchema.parse(resume.data));
  return { ...CreateEmptyResumeData(), mode: resume.content.trim() ? 'legacy' : 'structured', ...(resume.content ? { legacyContent: resume.content } : {}) };
}

/** 前后端共享业务校验；经历组可为零，用户添加的每一组与每一条内容都必须完整。 */
export function ValidateResumeData(data: ResumeData): ResumeValidationIssue[] {
  const parsed = ResumeDataSchema.safeParse(data);
  if (!parsed.success) return parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.code === 'too_big' ? '超过数量或长度限制' : '数据格式不完整' }));
  if (data.mode === 'legacy') return data.legacyContent?.trim() ? [] : [{ path: 'legacyContent', message: '请填写简历原文' }];
  const issues: ResumeValidationIssue[] = [];
  const Required = (path: string, value: string) => { if (!value.trim()) issues.push({ path, message: '此项为必填项' }); };
  Required('personal.name', data.personal.name);
  Required('personal.email', data.personal.email);
  Required('personal.phone', data.personal.phone);
  if (data.personal.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.personal.email)) issues.push({ path: 'personal.email', message: '请输入有效邮箱' });
  if (data.personal.phone && !/^\+?[\d\s()-]{6,25}$/.test(data.personal.phone)) issues.push({ path: 'personal.phone', message: '请输入有效手机号（可含国家区号）' });
  if (data.personal.github && !/^https:\/\/(?:www\.)?github\.com\/[\w-]+\/?$/i.test(data.personal.github)) issues.push({ path: 'personal.github', message: '请输入完整 GitHub 主页地址' });
  const Period = (path: string, row: { start: string; end: string }) => {
    Required(`${path}.start`, row.start); Required(`${path}.end`, row.end);
    if (/^\d{4}-\d{2}$/.test(row.start) && /^\d{4}-\d{2}$/.test(row.end) && row.start > row.end) issues.push({ path: `${path}.end`, message: '结束时间不能早于开始时间' });
  };
  data.education.forEach((row, i) => { const path = `education.${i}`; Required(`${path}.school`, row.school); Required(`${path}.degree`, row.degree); Required(`${path}.major`, row.major); Period(path, row); });
  data.work.forEach((row, i) => { const path = `work.${i}`; Required(`${path}.company`, row.company); Required(`${path}.role`, row.role); Period(path, row); row.descriptions.forEach((line, j) => Required(`${path}.descriptions.${j}`, line)); });
  data.projects.forEach((row, i) => { const path = `projects.${i}`; Required(`${path}.name`, row.name); Required(`${path}.role`, row.role); Period(path, row); row.descriptions.forEach((line, j) => Required(`${path}.descriptions.${j}`, line)); });
  data.sections.forEach((row, i) => { Required(`sections.${i}.title`, row.title); row.items.forEach((line, j) => Required(`sections.${i}.items.${j}`, line)); });
  if (ResumeDataToText(data).length > 200000) issues.push({ path: 'content', message: '简历总长度不能超过 200000 个字符，请精简内容后保存' });
  return issues;
}

/** 兼容 Agent、全文检索与 DOCX 的纯文本投影；模板变更不会影响投影或填写数据。 */
export function ResumeDataToText(data: ResumeData): string {
  if (data.mode === 'legacy') return data.legacyContent ?? '';
  const lines = [data.personal.name, [data.personal.email, data.personal.phone, data.personal.github].filter(Boolean).join(' | ')];
  const Period = (row: { start: string; end: string }) => `${row.start} – ${row.end}`;
  if (data.education.length) lines.push('## 教育经历', ...data.education.flatMap((row) => [`### ${row.school} | ${row.degree} | ${row.major}`, Period(row)]));
  if (data.work.length) lines.push('## 工作经历', ...data.work.flatMap((row) => [`### ${row.company}${row.project ? ` | ${row.project}` : ''} | ${row.role}`, Period(row), ...row.descriptions.map((line) => `- ${line}`)]));
  if (data.projects.length) lines.push('## 项目经历', ...data.projects.flatMap((row) => [`### ${row.name} | ${row.role}`, Period(row), ...row.descriptions.map((line) => `- ${line}`)]));
  data.sections.forEach((row) => lines.push(`## ${row.title}`, ...row.items.map((line) => `- ${line}`)));
  if (data.legacyContent) lines.push('## 保留的旧版内容', data.legacyContent);
  return lines.join('\n');
}

/**
 * 兼容旧 Agent 的全文更新接口。只接受能够完全往返的新结构化投影，拒绝猜测自由格式；
 * 返回 null 时调用方保留整份新原文，旧结构化版本仍可从版本历史还原。
 */
export function ReconcileResumeText(previous: ResumeData, content: string): ResumeData | null {
  if (previous.mode !== 'structured') return null;
  const next = CreateEmptyResumeData();
  const marker = '\n## 保留的旧版内容\n';
  const legacyAt = content.indexOf(marker);
  const body = legacyAt >= 0 ? content.slice(0, legacyAt) : content;
  if (legacyAt >= 0) next.legacyContent = content.slice(legacyAt + marker.length);
  const lines = body.split('\n');
  next.personal.name = lines.shift() ?? '';
  const contacts = (lines.shift() ?? '').split(' | ');
  if (contacts.length < 2 || contacts.length > 3) return null;
  [next.personal.email, next.personal.phone] = contacts;
  next.personal.github = contacts[2] ?? '';
  let current: 'education' | 'work' | 'projects' | 'sections' | null = null;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.startsWith('## ')) {
      const title = line.slice(3);
      current = title === '教育经历' ? 'education' : title === '工作经历' ? 'work' : title === '项目经历' ? 'projects' : 'sections';
      if (current === 'sections') next.sections.push({ title, items: [] });
      continue;
    }
    if (current === 'sections' && line.startsWith('- ')) { next.sections.at(-1)!.items.push(line.slice(2)); continue; }
    if (!line.startsWith('### ') || !current || current === 'sections') return null;
    const fields = line.slice(4).split(' | ');
    const period = (lines[++i] ?? '').split(' – ');
    if (period.length !== 2) return null;
    const [start, end] = period;
    if (current === 'education') {
      if (fields.length !== 3) return null;
      next.education.push({ school: fields[0], degree: fields[1], major: fields[2], start, end });
    } else {
      const descriptions: string[] = [];
      while (lines[i + 1]?.startsWith('- ')) descriptions.push(lines[++i].slice(2));
      if (current === 'work') {
        if (fields.length !== 2 && fields.length !== 3) return null;
        next.work.push({ company: fields[0], project: fields.length === 3 ? fields[1] : '', role: fields.at(-1)!, start, end, descriptions });
      } else {
        if (fields.length !== 2) return null;
        next.projects.push({ name: fields[0], role: fields[1], start, end, descriptions });
      }
    }
  }
  if (ValidateResumeData(next).length || ResumeDataToText(next) !== content) return null;
  return next;
}
