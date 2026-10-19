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
    { id: 'ref1', stepId: 's1', type: 'resource', resource: { kind: 'resume', id: 'r1', title: '产品简历', revision: 2, produced: true } },
    { id: 'answer1', stepId: 's2', type: 'text', text: '已准备好[产品简历](avery://resume/r1?revision=2)。' },
  ],
};
function Render(snapshot = presentation) {
  return renderToStaticMarkup(createElement(ConversationMessage, { message: { id: 'reply-req1', role: 'assistant', content: '', presentation: snapshot }, onOpenResource: () => undefined }));
}
describe('对话组件内容与默认状态', () => {
  it('完成后默认折叠过程，产物与最终回答在折叠组外，工作动画消失', () => {
    const html = Render();
    expect(html).toContain('<details class="conversation-process">');
    expect(html).not.toContain('conversation-work');
    const resourcePosition = html.indexOf('class="conversation-resource"');
    expect(resourcePosition).toBeGreaterThan(html.indexOf('</details></div></details>'));
    expect(html.slice(resourcePosition)).toContain('已准备好');
    expect(html.slice(resourcePosition)).toContain('href="avery://resume/r1?revision=2"');
  });
  it('运行与等待期间保持过程展开和工作动画入口', () => {
    expect(Render({ ...presentation, status: 'running' })).toContain('class="conversation-process" open=""');
    expect(Render({ ...presentation, status: 'waiting' })).toContain('data-mode="waiting"');
  });
  it('应用内链接必须匹配授权资源，脚本和未知资源不能渲染成可执行链接', () => {
    const html = renderToStaticMarkup(createElement(MarkdownText, { content: '[未知](avery://resume/unknown) [脚本](javascript:alert) [正文](https://example.com)', resources: [], onOpenResource: () => undefined }));
    expect(html).not.toContain('href="avery:');
    expect(html).not.toContain('href="javascript:');
    expect(html).toContain('href="https://example.com"');
  });
});
