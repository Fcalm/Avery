import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ChatMessageDto } from '@avery/contracts';
import { UserMessage } from '../../../src/features/assistant/components/UserMessage';

const Render = (message: Omit<ChatMessageDto, 'id' | 'role'>) => renderToStaticMarkup(createElement(UserMessage, { message: { id: 'user1', role: 'user', ...message } }));

describe('用户消息气泡', () => {
  it('附件位于气泡内的正文上方，技能标签位于正文首段句首', () => {
    const html = Render({ content: '请修改**第一段**。', skill: { id: 'resume-tailoring', label: '简历定制' }, attachments: [
      { name: '简历.pdf', path: 'attachment://a1/简历.pdf' }, { name: '岗位要求.txt', path: 'attachment://a2/岗位要求.txt' },
    ] });
    expect(html).toMatch(/^<div class="user-message-bubble">/);
    expect(html.indexOf('user-message-attachments')).toBeLessThan(html.indexOf('markdown-text'));
    expect(html.indexOf('user-message-skill')).toBeGreaterThan(html.indexOf('<p>'));
    expect(html.indexOf('/resume-tailoring')).toBeLessThan(html.indexOf('请修改'));
    expect(html).toContain('<strong>第一段</strong>');
    expect(html).toContain('简历.pdf'); expect(html).toContain('岗位要求.txt');
    expect(html).not.toContain('attachment://');
    expect(html).not.toContain('移除');
  });

  it('旧消息与未选择技能的普通消息不生成多余标签', () => {
    const html = Render({ content: '普通消息\n第二行' });
    expect(html).not.toContain('user-message-attachments');
    expect(html).not.toContain('user-message-skill');
    expect(html).toContain('普通消息<br/>第二行');
  });

  it('技能不进入列表、表格或代码块内部，保留原有 Markdown 结构', () => {
    const html = Render({ content: '```text\n原始正文\n```', skill: { id: 'resume-tailoring', label: '简历定制' } });
    expect(html.indexOf('user-message-skill')).toBeLessThan(html.indexOf('markdown-code-block'));
    expect(html).toContain('<code>原始正文</code>');
  });

  it('文件名和技能名称按普通文本转义，标签不生成路径链接', () => {
    const html = Render({ content: '', skill: { id: 'resume-tailoring', label: '<script>恶意文本</script>' }, attachments: [{ name: '<img src=x>.pdf', path: 'attachment://a1/file.pdf' }] });
    expect(html).toContain('&lt;img src=x&gt;.pdf');
    expect(html).not.toContain('<img'); expect(html).not.toContain('<script>');
    expect(html).not.toContain('href=');
  });
});
