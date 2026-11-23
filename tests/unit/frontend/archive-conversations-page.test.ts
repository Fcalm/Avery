import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import { UiStoreProvider } from '../../../src/app/UiStore';
import { ArchivedConversationsPage } from '../../../src/features/settings/pages/ArchivedConversationsPage';
import { DefaultSettings, WORKSPACE_QUERY_KEY } from '../../../src/features/workspace/api/workspaceData';
import type { Conversation } from '../../../src/types/domain';

function Render(conversations: Conversation[]) {
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });
  client.setQueryData(WORKSPACE_QUERY_KEY, { conversations, settings: DefaultSettings, jobs: [], applications: [], resumes: [], profiles: [] });
  try {
    return renderToStaticMarkup(createElement(QueryClientProvider, { client }, createElement(UiStoreProvider, { children: createElement(ArchivedConversationsPage) })));
  } finally { client.clear(); }
}

describe('归档管理页面数据绑定', () => {
  it('空归档时显示空态并禁用删除全部，不填充原型演示数据', () => {
    const html = Render([{ id: 'live', title: '未归档对话', archived: false, messages: [] }]);
    expect(html).toContain('暂无归档对话');
    expect(html).toMatch(/class="archive-delete-all"[^>]*disabled/);
    expect(html).not.toContain('未归档对话');
    expect(html).not.toContain('字节跳动');
  });

  it('归档数据绑定真实标题、项目和未知清理时间，筛选使用项目的统一选择组件', () => {
    const html = Render([{ id: 'archived', title: '简历 & 面试', projectId: 'project-one', projectName: '秋招', archived: true, messages: [] }]);
    expect(html).toContain('简历 &amp; 面试');
    expect(html).toContain('秋招');
    expect(html).toContain('未设定');
    expect(html).toContain('custom-select-trigger');
    expect(html).toContain('aria-label="恢复：简历 &amp; 面试"');
    expect(html).toContain('aria-label="删除：简历 &amp; 面试"');
    expect(html).not.toContain('<select');
  });
});
