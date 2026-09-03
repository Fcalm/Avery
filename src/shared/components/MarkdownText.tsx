import { Fragment, type ReactNode } from 'react';

type MarkdownTableAlignment = 'left' | 'center' | 'right';

function SafeHref(value: string) {
  try {
    const url = new URL(value, 'https://avery.local');
    if (url.protocol === 'https:' || url.protocol === 'http:' || url.protocol === 'mailto:') return value;
  } catch {
    // Invalid URLs are rendered as ordinary text.
  }
  return null;
}

function InlineText({ value }: { value: string }) {
  const tokens = value.split(/(`[^`]+`|\*\*[^*]+\*\*|~~[^~]+~~|\*[^*]+\*|\[[^\]]+\]\([^\s)]+\))/g);
  return <>{tokens.map((token, index) => {
    if (!token) return null;
    if (token.startsWith('`') && token.endsWith('`')) return <code key={index}>{token.slice(1, -1)}</code>;
    if (token.startsWith('**') && token.endsWith('**')) return <strong key={index}>{token.slice(2, -2)}</strong>;
    if (token.startsWith('~~') && token.endsWith('~~')) return <s key={index}>{token.slice(2, -2)}</s>;
    if (token.startsWith('*') && token.endsWith('*')) return <em key={index}>{token.slice(1, -1)}</em>;
    const link = token.match(/^\[([^\]]+)\]\(([^\s)]+)\)$/);
    if (link) {
      const href = SafeHref(link[2]);
      return href ? <a key={index} href={href} target="_blank" rel="noreferrer">{link[1]}</a> : <Fragment key={index}>{link[1]}</Fragment>;
    }
    return <Fragment key={index}>{token}</Fragment>;
  })}</>;
}

function IsBlockStart(line: string) {
  return /^#{1,3}\s|^[-*]\s|^\d+\.\s|^>\s|^```|^---$/.test(line);
}

/** 分割 GFM 表格行，并保留单元格内用反斜杠转义的竖线。 */
function SplitTableRow(line: string): string[] {
  let value = line.trim();
  if (value.startsWith('|')) value = value.slice(1);
  if (value.endsWith('|') && !value.endsWith('\\|')) value = value.slice(0, -1);
  const cells: string[] = [];
  let cell = '';
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character === '\\' && value[index + 1] === '|') { cell += '|'; index += 1; continue; }
    if (character === '|') { cells.push(cell.trim()); cell = ''; continue; }
    cell += character;
  }
  cells.push(cell.trim());
  return cells;
}

function GetTableAlignment(value: string): MarkdownTableAlignment | null {
  const normalized = value.trim();
  if (!/^:?-{3,}:?$/.test(normalized)) return null;
  if (normalized.startsWith(':') && normalized.endsWith(':')) return 'center';
  return normalized.endsWith(':') ? 'right' : 'left';
}

function ParseMarkdownTable(lines: string[], startIndex: number): { headers: string[]; alignments: MarkdownTableAlignment[]; rows: string[][]; endIndex: number } | null {
  const headerLine = lines[startIndex] ?? '';
  const dividerLine = lines[startIndex + 1] ?? '';
  // GFM 表格必须使用竖线分列，避免把“标题\n---”误识别为单列表格。
  if (!headerLine.includes('|') || !dividerLine.includes('|')) return null;
  const headers = SplitTableRow(headerLine);
  const divider = SplitTableRow(dividerLine);
  if (!headers.length || headers.length !== divider.length || divider.some((cell) => GetTableAlignment(cell) === null)) return null;

  const rows: string[][] = [];
  let index = startIndex + 2;
  while (index < lines.length && lines[index].trim() && lines[index].includes('|') && !IsBlockStart(lines[index])) {
    const row = SplitTableRow(lines[index]);
    rows.push(headers.map((_, columnIndex) => row[columnIndex] ?? ''));
    index += 1;
  }
  return { headers, alignments: divider.map((cell) => GetTableAlignment(cell) ?? 'left'), rows, endIndex: index };
}

function MarkdownText({ content, className = '' }: { content: string; className?: string }) {
  const lines = content.replace(/\r\n?/g, '\n').split('\n');
  const nodes: ReactNode[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) { index += 1; continue; }
    if (line.startsWith('```')) {
      const language = line.slice(3).trim();
      const code: string[] = [];
      index += 1;
      while (index < lines.length && !lines[index].startsWith('```')) code.push(lines[index++]);
      if (index < lines.length) index += 1;
      nodes.push(<pre key={nodes.length} data-language={language || undefined}><code>{code.join('\n')}</code></pre>);
      continue;
    }
    const table = ParseMarkdownTable(lines, index);
    if (table) {
      nodes.push(<div className="markdown-table-wrap" key={nodes.length}><table><thead><tr>{table.headers.map((header, columnIndex) => <th key={columnIndex} className={`is-align-${table.alignments[columnIndex]}`}><InlineText value={header} /></th>)}</tr></thead><tbody>{table.rows.map((row, rowIndex) => <tr key={rowIndex}>{row.map((cell, columnIndex) => <td key={columnIndex} className={`is-align-${table.alignments[columnIndex]}`}><InlineText value={cell} /></td>)}</tr>)}</tbody></table></div>);
      index = table.endIndex;
      continue;
    }
    if (line === '---') { nodes.push(<hr key={nodes.length} />); index += 1; continue; }
    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    if (heading) {
      const level = heading[1].length;
      const Tag = (`h${level}` as 'h1' | 'h2' | 'h3');
      nodes.push(<Tag key={nodes.length}><InlineText value={heading[2]} /></Tag>);
      index += 1;
      continue;
    }
    if (line.startsWith('> ')) {
      const quote: string[] = [];
      while (index < lines.length && lines[index].startsWith('> ')) quote.push(lines[index++].slice(2));
      nodes.push(<blockquote key={nodes.length}><InlineText value={quote.join('\n')} /></blockquote>);
      continue;
    }
    const listMatch = line.match(/^([-*]|\d+\.)\s+(.+)$/);
    if (listMatch) {
      const ordered = /\d+\./.test(listMatch[1]);
      const items: string[] = [];
      while (index < lines.length) {
        const item = lines[index].match(ordered ? /^\d+\.\s+(.+)$/ : /^[-*]\s+(.+)$/);
        if (!item) break;
        items.push(item[1]);
        index += 1;
      }
      nodes.push(ordered
        ? <ol key={nodes.length}>{items.map((item, itemIndex) => <li key={itemIndex}><InlineText value={item} /></li>)}</ol>
        : <ul key={nodes.length}>{items.map((item, itemIndex) => <li key={itemIndex}><InlineText value={item} /></li>)}</ul>);
      continue;
    }
    const paragraph: string[] = [line];
    index += 1;
    while (index < lines.length && lines[index].trim() && !IsBlockStart(lines[index])) paragraph.push(lines[index++]);
    nodes.push(<p key={nodes.length}>{paragraph.map((item, itemIndex) => <Fragment key={itemIndex}><InlineText value={item} />{itemIndex < paragraph.length - 1 && <br />}</Fragment>)}</p>);
  }

  return <div className={`markdown-text ${className}`}>{nodes}</div>;
}

export { MarkdownText };
