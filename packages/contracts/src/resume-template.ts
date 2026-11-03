/**
 * 简历正文的跨端模板：Renderer 预览与桌面端导出共用相同的结构，
 * 只接受文本和受限的 Markdown 行内标记，避免把简历内容作为可执行 HTML 注入。
 */
import { type ResumeData, type ResumeTemplateId } from './resume-data';

export interface ResumeDocumentInput {
  name: string;
  summary: string;
  content: string;
  data?: ResumeData;
  templateId?: ResumeTemplateId;
}

const CommonSectionTitles = new Set([
  '教育背景', '教育经历', '工作经历', '实习经历', '项目经历', '项目经验',
  '校园经历', '技能证书', '技能/证书', '专业技能', '个人优势', '自我评价', '其他信息',
]);
const EducationSectionTitles = new Set(['教育背景', '教育经历']);
const ProjectSectionTitles = new Set(['项目经历', '项目经验']);
const ExperienceSectionTitles = new Set(['工作经历', '实习经历', '项目经历', '项目经验', '校园经历']);

function EscapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character] as string));
}

function DecodeHtmlEntities(value: string) {
  return value
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
}

/** 将历史 HTML 或纯文本统一归一为安全的行内容；旧简历无需迁移即可套用新模板。 */
function NormalizeResumeLines(content: string) {
  return DecodeHtmlEntities(content
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\s*\/(?:p|div|li|h[1-6]|tr)\s*>/gi, '\n')
    .replace(/<[^>]*>/g, ''))
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim());
}

function ToInlineHtml(value: string) {
  let html = EscapeHtml(value);
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_match, label: string, href: string) => `<a href="${href}" target="_blank" rel="noreferrer">${IsGithubLink(href) ? GithubIconMarkup : ''}${label}</a>`);
  return html;
}

/** 使用项目已有 Phosphor GitHub 字形；导出窗口嵌入同一字体，离线打印不会丢图标。 */
const GithubIconMarkup = '<span class="resume-github-icon" aria-hidden="true">&#xe576;</span>';
function IsGithubLink(value: string) { return /^https?:\/\/(?:www\.)?github\.com(?:\/|$)/i.test(value); }
function ContactHtml(value: string) {
  const href = /^https?:\/\//i.test(value) ? value : `https://${value}`;
  return IsGithubLink(href) ? `<a class="resume-github-link" href="${EscapeHtml(href)}" target="_blank" rel="noreferrer">${GithubIconMarkup}${EscapeHtml(value)}</a>` : ToInlineHtml(value);
}

/** 姓名只有被内容明确标记为加粗时才使用强调字号，避免普通个人信息行喧宾夺主。 */
function HasBoldMarkdown(value: string) {
  return /\*\*[^*]+\*\*/.test(value);
}

function ToSectionTitle(value: string) {
  return value.replace(/^#{1,6}\s*/, '').replace(/^\d+[.、]\s*/, '').replace(/[：:]+$/, '').trim();
}

function IsSectionTitle(value: string) {
  const title = ToSectionTitle(value);
  return /^#{1,6}\s+/.test(value) || CommonSectionTitles.has(title);
}

function IsSubheading(value: string) {
  return /^#{3,6}\s+/.test(value);
}

function ToProjectLink(value: string) {
  const label = value.trim();
  const href = /^https?:\/\//i.test(label) ? label : `https://${label}`;
  if (!/^(?:https?:\/\/)?(?:www\.)?(?:github\.com|gitlab\.com|gitee\.com)\//i.test(label)) return null;
  return `<a class="resume-project-link" href="${EscapeHtml(href)}" target="_blank" rel="noreferrer">${IsGithubLink(href) ? GithubIconMarkup : ''}${ToInlineHtml(label)}</a>`;
}

/**
 * 生成可复用的简历内容片段。未知格式会退化为段落，确保所有历史简历都可展示；
 * 支持常见 Markdown 标题与列表，便于 Agent 后续直接生成结构化内容。
 */
export function CreateResumeDocumentMarkup(resume: ResumeDocumentInput) {
  if (resume.data?.mode === 'structured') return CreateStructuredMarkup(resume.data, resume.templateId ?? 'classic');
  const sections: string[] = [];
  let currentTitle = '';
  let currentBlocks: string[] = [];
  let listItems: string[] = [];
  const headerLines: string[] = [];
  let bodyStarted = false;

  const FlushList = () => {
    if (!listItems.length) return;
    currentBlocks.push(`<ul>${listItems.map((item) => `<li>${ToInlineHtml(item)}</li>`).join('')}</ul>`);
    listItems = [];
  };
  const FlushSection = () => {
    FlushList();
    if (!currentBlocks.length) return;
    const heading = currentTitle ? `<h2>${ToInlineHtml(currentTitle)}</h2>` : '';
    sections.push(`<section class="resume-document-section">${heading}${currentBlocks.join('')}</section>`);
    currentBlocks = [];
  };

  for (const line of NormalizeResumeLines(resume.content)) {
    const sectionTitle = ToSectionTitle(line);
    if (!bodyStarted) {
      if (EducationSectionTitles.has(sectionTitle)) continue;
      if (IsSectionTitle(line)) { bodyStarted = true; }
      else { headerLines.push(line); continue; }
    }
    if (!line) { FlushList(); continue; }
    if (IsSubheading(line)) {
      FlushList();
      const className = ExperienceSectionTitles.has(currentTitle) ? ` class="resume-entry-title${ProjectSectionTitles.has(currentTitle) ? ' resume-project-title' : ''}"` : '';
      currentBlocks.push(`<h3${className}>${ToInlineHtml(ToSectionTitle(line))}</h3>`);
      continue;
    }
    if (IsSectionTitle(line)) {
      FlushSection();
      currentTitle = ToSectionTitle(line);
      continue;
    }
    const listItem = line.match(/^(?:[-*•]|\d+[.)、])\s+(.+)$/);
    if (listItem) { listItems.push(listItem[1]); continue; }
    FlushList();
    if (ExperienceSectionTitles.has(currentTitle) && !currentBlocks.length) {
      const className = `resume-entry-title${ProjectSectionTitles.has(currentTitle) ? ' resume-project-title' : ''}`;
      currentBlocks.push(`<h3 class="${className}">${ToInlineHtml(line)}</h3>`);
      continue;
    }
    if (ProjectSectionTitles.has(currentTitle)) {
      const link = ToProjectLink(line);
      if (link) { currentBlocks.push(link); continue; }
    }
    currentBlocks.push(`<p>${ToInlineHtml(line)}</p>`);
  }
  FlushSection();

  const firstHeaderLine = headerLines.shift() ?? '';
  const headerParts = firstHeaderLine.split(/[|｜]/).map((part) => part.trim()).filter(Boolean);
  const title = headerParts.shift() || resume.name.trim() || '未命名简历';
  const contact = headerParts.map(ContactHtml).join('<span class="resume-header-separator">|</span>');
  const education = headerLines.filter(Boolean).map(ToInlineHtml).join(' ');
  const nameClass = HasBoldMarkdown(title) ? ' class="is-emphasized"' : '';
  return `<article class="resume-document${resume.templateId === 'compact' ? ' resume-template-compact' : ''}"><header class="resume-document-header"><div class="resume-document-identity"><h1${nameClass}>${ToInlineHtml(title)}</h1>${contact ? `<span class="resume-document-contact">${contact}</span>` : ''}</div>${education ? `<p class="resume-document-education">${education}</p>` : ''}</header><div class="resume-document-body">${sections.join('') || '<section class="resume-document-section"><p>暂未填写简历内容。</p></section>'}</div></article>`;
}

/** 新模板直接消费同一份数据，不依赖对 Markdown 的逆向解析；所有用户文本先转义。 */
function CreateStructuredMarkup(data: ResumeData, template: ResumeTemplateId): string {
  const Text = (value: string) => ToInlineHtml(value).replace(/\n/g, '<br>');
  const Heading = (title: string, row: { start: string; end: string }) => `<div class="resume-entry-heading"><h3>${Text(title)}</h3><span class="resume-entry-period">${Text(row.start)} – ${Text(row.end)}</span></div>`;
  const List = (items: string[]) => `<ul>${items.map((line) => `<li>${Text(line)}</li>`).join('')}</ul>`;
  const Section = (title: string, content: string) => `<section class="resume-document-section"><h2>${Text(title)}</h2>${content}</section>`;
  const education = data.education.length ? Section('教育经历', data.education.map((row) => `<div class="resume-entry">${Heading(`${row.school} · ${row.degree} · ${row.major}`, row)}</div>`).join('')) : '';
  const work = data.work.length ? Section('工作经历', data.work.map((row) => `<div class="resume-entry">${Heading(`${row.company}${row.project ? ` · ${row.project}` : ''} · ${row.role}`, row)}${List(row.descriptions)}</div>`).join('')) : '';
  const projects = data.projects.length ? Section('项目经历', data.projects.map((row) => `<div class="resume-entry">${Heading(`${row.name} · ${row.role}`, row)}${List(row.descriptions)}</div>`).join('')) : '';
  // 旧原文经既有安全渲染器展示，既不丢换行/列表，也不让历史 HTML 获得执行能力。
  const legacy = data.legacyContent ? Section('保留的旧版内容', `<div class="resume-legacy-content">${EscapeHtml(data.legacyContent).replace(/\n/g, '<br>')}</div>`) : '';
  const contacts = [data.personal.email, data.personal.phone, data.personal.github].filter(Boolean).map(ContactHtml).join('<span class="resume-header-separator">|</span>');
  return `<article class="resume-document resume-template-${template === 'compact' ? 'compact' : 'classic'}"><header class="resume-document-header"><h1 class="is-emphasized">${Text(data.personal.name)}</h1><div class="resume-document-contact">${contacts}</div></header><div class="resume-document-body">${education}${work}${projects}${data.sections.map((row) => Section(row.title, List(row.items))).join('')}${legacy}</div></article>`;
}
