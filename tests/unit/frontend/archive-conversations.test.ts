import { describe, expect, it } from 'vitest';
import { ArchiveDayMs, ArchiveProjectKey, ArchiveProjectLabel, BuildArchivedConversations, FilterArchivedConversations, FormatArchiveRemaining } from '../../../src/features/settings/archiveConversations';
import type { Conversation } from '../../../src/types/domain';

const preferences = { aliases: { renamed: '新的项目名' }, removed: { removed: '1' } };
const Source = (id: string, extra: Partial<Conversation> & { archivedAt?: number | null; autoDeleteAt?: number | null } = {}) => ({ id, title: id, archived: true, messages: [], ...extra });

describe('归档管理展示与时间边界', () => {
  it('只读取已归档记录，缺少归档时间时不以 updatedAt 伪造倒计时', () => {
    const items = BuildArchivedConversations([Source('old', { updatedAt: Date.now() }), Source('live', { archived: false })], preferences);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ id: 'old', archivedAt: null, autoDeleteAt: null });
    expect(FormatArchiveRemaining(items[0].autoDeleteAt, Date.now())).toBe('未设定');
  });

  it('项目别名与移除状态沿用导航偏好；同名项目保留不同筛选键', () => {
    const items = BuildArchivedConversations([
      Source('a', { projectId: 'renamed', projectName: '旧名' }),
      Source('b', { projectId: 'removed', projectName: '新的项目名' }), Source('c'),
    ], preferences);
    expect(ArchiveProjectLabel(items[0])).toBe('新的项目名');
    expect(ArchiveProjectLabel(items[1])).toBe('新的项目名（已移除）');
    expect(ArchiveProjectKey(items[0])).not.toBe(ArchiveProjectKey(items[1]));
    expect(ArchiveProjectLabel(items[2])).toBe('未分组');
  });

  it('按标题与项目组合过滤，空白查询不改变匹配', () => {
    const items = BuildArchivedConversations([Source('a', { title: 'AI 面试', projectId: 'one' }), Source('b', { title: 'AI 面试', projectId: 'two' }), Source('c')], preferences);
    expect(FilterArchivedConversations(items, ' ai ', 'project:one', 'expiry').map((item) => item.id)).toEqual(['a']);
    expect(FilterArchivedConversations(items, ' ', 'ungrouped', 'expiry').map((item) => item.id)).toEqual(['c']);
    expect(FilterArchivedConversations(items, '不存在', 'all', 'expiry')).toEqual([]);
  });

  it('最近归档和最早清理使用各自时间，未知值最后，排序不改变原集合', () => {
    const items = BuildArchivedConversations([Source('old'), Source('a', { archivedAt: 200, autoDeleteAt: 900 }), Source('b', { archivedAt: 100, autoDeleteAt: 500 })], preferences);
    expect(FilterArchivedConversations(items, '', 'all', 'archive').map((item) => item.id)).toEqual(['a', 'b', 'old']);
    expect(FilterArchivedConversations(items, '', 'all', 'expiry').map((item) => item.id)).toEqual(['b', 'a', 'old']);
    expect(items.map((item) => item.id)).toEqual(['old', 'a', 'b']);
  });

  it('倒计时跨天、小时和不足一分钟时可读，到期仍保留待清理记录', () => {
    const now = 1_000_000;
    expect(FormatArchiveRemaining(now + 2 * ArchiveDayMs + 5 * 3_600_000, now)).toBe('2 天 5 小时');
    expect(FormatArchiveRemaining(now + 9 * 3_600_000 + 24 * 60_000, now)).toBe('9 小时 24 分钟');
    expect(FormatArchiveRemaining(now + 1, now)).toBe('1 分钟');
    expect(FormatArchiveRemaining(now, now)).toBe('待清理');
    const expired = BuildArchivedConversations([Source('expired', { autoDeleteAt: now - 1 })], preferences);
    expect(FilterArchivedConversations(expired, '', 'all', 'expiry')).toHaveLength(1);
  });

  it('拒绝无效和超出 Date 范围的时间，避免页面渲染异常', () => {
    const items = BuildArchivedConversations([Source('invalid', { archivedAt: NaN, autoDeleteAt: Infinity }), Source('out-of-range', { autoDeleteAt: 1e20 })], preferences);
    expect(items.every((item) => item.archivedAt === null && item.autoDeleteAt === null)).toBe(true);
  });
});
