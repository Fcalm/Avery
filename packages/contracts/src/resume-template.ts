/**
 * 简历正文的跨端模板：Renderer 预览与桌面端导出共用相同的结构，
 * 只接受文本和受限的 Markdown 行内标记，避免把简历内容作为可执行 HTML 注入。
 */
export interface ResumeDocumentInput {
  name: string;
  summary: string;
  content: string;
}

const CommonSectionTitles = new Set([
  '教育背景', '教育经历', '工作经历', '实习经历', '项目经历', '项目经验',
  '校园经历', '技能证书', '技能/证书', '专业技能', '个人优势', '自我评价', '其他信息',
]);
const EducationSectionTitles = new Set(['教育背景', '教育经历']);
const ProjectSectionTitles = new Set(['项目经历', '项目经验']);

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
  html = html.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
  return html;
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
  return `<a class="resume-project-link" href="${EscapeHtml(href)}" target="_blank" rel="noreferrer">${ToInlineHtml(label)}</a>`;
}

/**
 * 生成可复用的简历内容片段。未知格式会退化为段落，确保所有历史简历都可展示；
 * 支持常见 Markdown 标题与列表，便于 Agent 后续直接生成结构化内容。
 */
export function CreateResumeDocumentMarkup(resume: ResumeDocumentInput) {
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
      const className = ProjectSectionTitles.has(currentTitle) ? ' class="resume-project-title"' : '';
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
    if (ProjectSectionTitles.has(currentTitle) && !currentBlocks.length) {
      currentBlocks.push(`<h3 class="resume-project-title">${ToInlineHtml(line)}</h3>`);
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
  const contact = headerParts.map(ToInlineHtml).join('<span class="resume-header-separator">|</span>');
  const education = headerLines.filter(Boolean).map(ToInlineHtml).join(' ');
  return `<article class="resume-document"><header class="resume-document-header"><div class="resume-document-identity"><h1>${ToInlineHtml(title)}</h1>${contact ? `<span class="resume-document-contact">${contact}</span>` : ''}</div>${education ? `<p class="resume-document-education">${education}</p>` : ''}</header><div class="resume-document-body">${sections.join('') || '<section class="resume-document-section"><p>暂未填写简历内容。</p></section>'}</div></article>`;
}
