import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ConversationMessage } from '../../../src/features/assistant/components/ConversationMessage';
import { MarkdownText } from '../../../src/shared/components/MarkdownText';
import type { ConversationPresentation } from '../../../packages/agent-sdk/src/conversation';

const presentation: ConversationPresentation = {
  version: 1, requestId: 'req1', sequence: 5, status: 'completed', parts: [
    { id: 'think1', stepId: 's1', type: 'reasoning', text: '先读资料' },
    { id: 'comment1', stepId: 's1', type: 'text', text: '正在读取简历' },
    { id: 'tool1', stepId: 's1', type: 'tool', name: 'UpdateResume', toolCallId: 'c1', status: 'succeeded', summary: '已保存', startedAt: 1, completedAt: 2 },
    { id: 'ref1', stepId: 's1', type: 'resource', resource: { kind: 'resume', id: 'r1', title: '产品简历', revision: 2, produced: true, lineChanges: { added: 3, removed: 2 } } },
    { id: 'answer1', stepId: 's2', type: 'text', text: '已准备好[产品简历](avery://resume/r1?revision=2)。' },
  ],
};
function Render(snapshot = presentation) {
  return renderToStaticMarkup(createElement(ConversationMessage, { message: { id: 'reply-req1', role: 'assistant', content: '', presentation: snapshot }, onOpenResource: () => undefined }));
}
describe('对话组件内容与默认状态', () => {
  it('一级与二级过程均默认收起，中间正文只在一级内，最终报告在所有卡片外', () => {
    const html = Render();
    expect(html.match(/<details class="conversation-process-card">/g)).toHaveLength(2);
    expect(html).toContain('<details class="conversation-process">');
    expect(html).not.toMatch(/<details[^>]*class="conversation-process-card"[^>]*\bopen/);
    const first = html.indexOf('正在读取简历');
    const final = html.indexOf('已准备好');
    for (const [position, expectedDepth] of [[first, 1], [final, 0]]) {
      let depth = 0;
      for (const tag of html.slice(0, position).matchAll(/<details\b[^>]*>|<\/details>/g)) depth += tag[0].startsWith('</') ? -1 : 1;
      expect(depth).toBe(expectedDepth);
    }
    const cards = [...html.matchAll(/<details class="conversation-process-card">/g)].map((match) => match.index!);
    expect(cards[0]).toBeLessThan(first);
    expect(first).toBeLessThan(cards[1]);
    expect(cards[1]).toBeLessThan(final);
    expect(html.match(/已准备好/g)).toHaveLength(1);
    expect(html).toContain('1 段思考'); expect(html).toContain('1 项工具');
  });
  it('等待浏览器接管时原因显示在折叠过程之外，切回会话仍能看到', () => {
    const html = Render({ ...presentation, status: 'waiting', statusMessage: '请重新加载 Avery Browser 扩展，再发送继续任务。' });
    const note = html.indexOf('请重新加载 Avery Browser');
    expect(note).toBeGreaterThan(-1);
    expect(note).toBeLessThan(html.indexOf('<details class="conversation-process-card"'));
    expect(html).toContain('role="status"');
  });
  it('压缩请求在过程投影到达前使用同一工作动画，终态不会重复或残留动画', () => {
    const pending = renderToStaticMarkup(createElement(ConversationMessage, { message: { id: 'reply-compact', role: 'assistant', content: '' }, working: true, onOpenResource: () => undefined }));
    expect(pending).toContain('conversation-work-art');
    const completed = renderToStaticMarkup(createElement(ConversationMessage, { message: { id: 'reply-req1', role: 'assistant', content: '', presentation }, working: true, onOpenResource: () => undefined }));
    expect(completed).not.toContain('conversation-work-art');
    const running = renderToStaticMarkup(createElement(ConversationMessage, { message: { id: 'reply-req1', role: 'assistant', content: '', presentation: { ...presentation, status: 'running' } }, working: true, onOpenResource: () => undefined }));
    expect(running.match(/class="conversation-work-art"/g)).toHaveLength(1);
  });
  it('完成后默认折叠过程，产物与最终回答在折叠组外，工作动画消失', () => {
    const html = Render();
    expect(html).toContain('<details class="conversation-process-card">');
    expect(html).not.toContain('conversation-work');
    const resourcePosition = html.indexOf('class="conversation-resource"');
    expect(resourcePosition).toBeGreaterThan(html.lastIndexOf('</details>'));
    expect(resourcePosition).toBeGreaterThan(html.indexOf('已准备好'));
    expect(html.slice(0, resourcePosition)).toContain('href="avery://resume/r1?revision=2"');
    expect(html.slice(resourcePosition)).toContain('class="is-added" aria-label="新增 3 行">+3');
    expect(html.slice(resourcePosition)).toContain('class="is-removed" aria-label="删除 2 行">−2');
    expect(html).not.toContain('已保存，点击查看');
  });
  it('仅运行时显示工作动画，等待和暂停显示静态状态，过程仍可展开', () => {
    const running = Render({ ...presentation, status: 'running' });
    expect(running).toContain('<details class="conversation-process-card">');
    expect(running).toContain('conversation-work');
    expect(running).not.toContain('class="conversation-resource"');
    expect(Render({ ...presentation, status: 'waiting' })).not.toContain('conversation-work-art');
    expect(Render({ ...presentation, status: 'paused' })).not.toContain('conversation-work-art');
    expect(Render({ ...presentation, status: 'waiting' })).toContain('等待你的确认或回答');
  });
  it('修改归零时不显示卡片，纯新增不显示删除计数', () => {
    const changed = structuredClone(presentation);
    const resource = changed.parts.find((part) => part.type === 'resource');
    if (resource?.type !== 'resource') throw new Error('fixture resource missing');
    resource.resource.lineChanges = { added: 0, removed: 0 };
    expect(Render(changed)).not.toContain('class="conversation-resource"');
    resource.resource.lineChanges = { added: 3, removed: 0 };
    expect(Render(changed)).toContain('class="is-added"');
    expect(Render(changed)).not.toContain('class="is-removed"');
  });
  it('应用内链接必须匹配授权资源，脚本和未知资源不能渲染成可执行链接', () => {
    const html = renderToStaticMarkup(createElement(MarkdownText, { content: '[未知](avery://resume/unknown) [脚本](javascript:alert) [正文](https://example.com)', resources: [], onOpenResource: () => undefined }));
    expect(html).not.toContain('href="avery:');
    expect(html).not.toContain('href="javascript:');
    expect(html).toContain('href="https://example.com"');
  });
});
