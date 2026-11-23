import { describe, expect, it } from 'vitest';
import { BuildConversationHistory, ExtendProjectConversationOrder } from '../../../src/features/conversation/conversationHistory';
import type { Conversation } from '../../../src/types/domain';

const ConversationItem = (id: string, extra: Partial<Conversation> = {}): Conversation => ({ id, title: id, messages: [], ...extra });

describe('对话历史的最近全集和项目固定顺序', () => {
  it('最近包含项目会话，按活动时间倒序，归档不进入任何列表', () => {
    const source = [ConversationItem('project', { projectId: 'p', updatedAt: 30 }), ConversationItem('old', { updatedAt: 10 }), ConversationItem('new', { updatedAt: 40 }), ConversationItem('archive', { projectId: 'p', archived: true, updatedAt: 50 })];
    const history = BuildConversationHistory(source, ExtendProjectConversationOrder(source, {}), {}, {}, '');
    expect(history.recent.map((item) => item.id)).toEqual(['new', 'project', 'old']);
    expect(history.groups[0].items.map((item) => item.id)).toEqual(['project']);
    expect(source.map((item) => item.id)).toEqual(['project', 'old', 'new', 'archive']);
  });

  it('更新消息、重命名及数据源重排都不改变已保存的项目顺序，新会话追加', () => {
    const source = [ConversationItem('first', { projectId: 'p', updatedAt: 10 }), ConversationItem('second', { projectId: 'p', updatedAt: 20 })];
    const saved = ExtendProjectConversationOrder(source, {});
    const changed = [{ ...source[1], title: '新标题', updatedAt: 100 }, { ...source[0], updatedAt: 200 }, ConversationItem('third', { projectId: 'p', updatedAt: 300 })];
    const next = ExtendProjectConversationOrder(changed, saved);
    expect(BuildConversationHistory(changed, next, {}, {}, '').groups[0].items.map((item) => item.id)).toEqual(['first', 'second', 'third']);
    expect(ExtendProjectConversationOrder(changed, next)).toBe(next);
    expect(saved).toEqual({ first: '1', second: '2' });
  });

  it('搜索不改变固定位置，项目移除只隐藏分组，最近仍保留会话', () => {
    const source = [ConversationItem('first', { projectId: 'p', title: 'AI 简历' }), ConversationItem('second', { projectId: 'p', title: 'AI 面试' }), ConversationItem('third', { projectId: 'q', title: 'AI 求职' })];
    const saved = ExtendProjectConversationOrder(source, {});
    const searched = BuildConversationHistory(source, saved, { p: '项目别名' }, {}, ' ai 面试 ');
    expect(searched.groups[0].name).toBe('项目别名');
    expect(searched.groups[0].items.map((item) => item.id)).toEqual(['second']);
    expect(BuildConversationHistory(source, saved, {}, { p: 'removed' }, '').visible).toHaveLength(3);
    expect(BuildConversationHistory(source, saved, {}, { p: 'removed' }, '').groups.map((item) => item.projectId)).toEqual(['q']);
  });

  it('归档恢复后沿用原项目位置，缺少活动时间时排序稳定', () => {
    const source = [ConversationItem('a', { projectId: 'p', archived: true }), ConversationItem('b', { projectId: 'p' })];
    const saved = ExtendProjectConversationOrder(source, {});
    const restored = [{ ...source[1] }, { ...source[0], archived: false }];
    const history = BuildConversationHistory(restored, saved, {}, {}, '');
    expect(history.recent.map((item) => item.id)).toEqual(['a', 'b']);
    expect(history.groups[0].items.map((item) => item.id)).toEqual(['a', 'b']);
  });

  it('显式置顶优先，取消后恢复最近时间顺序与项目固定位置', () => {
    const source = [ConversationItem('first', { projectId: 'p', updatedAt: 10 }), ConversationItem('second', { projectId: 'p', updatedAt: 5 }), ConversationItem('other', { projectId: 'q', updatedAt: 20 })];
    const saved = ExtendProjectConversationOrder(source, {});
    const pinned = source.map((item) => item.id === 'second' ? { ...item, pinned: true } : item);
    const history = BuildConversationHistory(pinned, saved, {}, {}, '');
    expect(history.recent.map((item) => item.id)).toEqual(['second', 'other', 'first']);
    expect(history.groups.map((item) => item.projectId)).toEqual(['p', 'q']);
    expect(history.groups[0].items.map((item) => item.id)).toEqual(['second', 'first']);
    const unpinned = pinned.map((item) => ({ ...item, pinned: false }));
    const restored = BuildConversationHistory(unpinned, saved, {}, {}, '');
    expect(restored.recent.map((item) => item.id)).toEqual(['other', 'first', 'second']);
    expect(restored.groups[0].items.map((item) => item.id)).toEqual(['first', 'second']);
    expect(ExtendProjectConversationOrder(pinned, saved)).toBe(saved);
  });
});
