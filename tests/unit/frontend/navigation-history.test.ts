import { describe, expect, it } from 'vitest';
import { AppendRoute, CreateNavigationHistory, MaxNavigationHistory, MoveNavigationIndex, SameRoute, type RouteSnapshot } from '../../../src/app/navigationHistory';

const Route = (page: RouteSnapshot['page'], conversationId: string | null = null, settingsTab: RouteSnapshot['settingsTab'] = 'general'): RouteSnapshot => ({ page, conversationId, settingsTab });

describe('顶栏页面历史', () => {
  it('初始位置不能后退或前进', () => {
    const history = CreateNavigationHistory(Route('assistant'));
    expect(MoveNavigationIndex(history, -1)).toBeNull();
    expect(MoveNavigationIndex(history, 1)).toBeNull();
  });

  it('相同位置不重复入栈', () => {
    const history = CreateNavigationHistory(Route('assistant'));
    const next = AppendRoute(history, Route('assistant'));
    expect(next).toBe(history);
    expect(SameRoute(next.entries[next.index], Route('assistant'))).toBe(true);
  });

  it('后退后从新位置跳转会丢弃原前进分支', () => {
    let history = CreateNavigationHistory(Route('assistant'));
    history = AppendRoute(history, Route('jobs'));
    history = AppendRoute(history, Route('resumes'));

    const back = MoveNavigationIndex(history, -1);
    expect(back?.route.page).toBe('jobs');
    expect(back?.history.index).toBe(1);

    const forward = back ? MoveNavigationIndex(back.history, 1) : null;
    expect(forward?.route.page).toBe('resumes');

    const rebased = back ? AppendRoute(back.history, Route('profiles')) : history;
    expect(rebased.entries.map((entry) => entry.page)).toEqual(['assistant', 'jobs', 'profiles']);
    expect(rebased.index).toBe(2);
    expect(MoveNavigationIndex(rebased, 1)).toBeNull();
  });

  it('页面内的会话和设置分类变化同样形成历史位置', () => {
    let history = CreateNavigationHistory(Route('assistant', null));
    history = AppendRoute(history, Route('assistant', 'conversation-a'));
    history = AppendRoute(history, Route('settings', 'conversation-a', 'archive'));
    expect(MoveNavigationIndex(history, -1)?.route).toEqual({ page: 'assistant', conversationId: 'conversation-a', settingsTab: 'general' });
  });

  it('超出上限时丢弃最早的位置，始终停留在最新位置', () => {
    let history = CreateNavigationHistory(Route('assistant'));
    for (let index = 0; index < MaxNavigationHistory + 5; index += 1) {
      history = AppendRoute(history, Route(index % 2 === 0 ? 'jobs' : 'resumes', String(index)));
    }
    expect(history.entries).toHaveLength(MaxNavigationHistory);
    expect(history.index).toBe(MaxNavigationHistory - 1);
    expect(history.entries.at(-1)?.conversationId).toBe(String(MaxNavigationHistory + 4));
  });
});
