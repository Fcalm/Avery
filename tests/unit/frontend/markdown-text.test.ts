import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { MarkdownText } from '../../../src/shared/components/MarkdownText';

describe('MarkdownText 表格渲染', () => {
  it('将 GFM 表头、分隔行和数据行渲染为语义化表格', () => {
    const html = renderToStaticMarkup(createElement(MarkdownText, {
      content: '| 岗位 | 匹配分 |\n| :--- | ---: |\n| 产品经理 | 91 |',
    }));

    expect(html).toContain('<table>');
    expect(html).toContain('<thead>');
    expect(html).toContain('is-align-left');
    expect(html).toContain('is-align-right');
    expect(html).toContain('产品经理');
  });

  it('不将代码块中的竖线误判为表格', () => {
    const html = renderToStaticMarkup(createElement(MarkdownText, {
      content: '```text\n| 保持原样 |\n| --- |\n```',
    }));

    expect(html).not.toContain('<table>');
    expect(html).toContain('<pre');
  });
});
