import { Fragment, type ReactNode } from 'react';

function SafeHref(value: string) {
  try {
    const url = new URL(value, 'https://offerget.local');
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
