import { describe, expect, it } from 'vitest';
import { ModeOfScenario, ScenarioOfMode } from '../../../src/features/conversation/workspaceMode';

describe('聊天/工作模式与会话场景映射', () => {
  it('聊天模式使用 default，工作模式使用 application', () => {
    expect(ScenarioOfMode('chat')).toBe('default');
    expect(ScenarioOfMode('work')).toBe('application');
  });

  it('读取会话场景时旧数据缺省按聊天处理', () => {
    expect(ModeOfScenario('application')).toBe('work');
    expect(ModeOfScenario('default')).toBe('chat');
    expect(ModeOfScenario(undefined)).toBe('chat');
  });
});
