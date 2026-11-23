import type { WorkspaceMode } from '../../types/domain';

/** 模式与落库场景一一对应：聊天沿用历史 ID `default`，工作为 `application`。 */
export function ScenarioOfMode(mode: WorkspaceMode): 'default' | 'application' {
  return mode === 'work' ? 'application' : 'default';
}

/** 读取会话快照里的场景；旧数据缺省按聊天处理，与后端读取时的归一规则一致。 */
export function ModeOfScenario(scenario: 'default' | 'application' | undefined): WorkspaceMode {
  return scenario === 'application' ? 'work' : 'chat';
}
