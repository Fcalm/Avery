import { ApplicationScenario, DefaultScenario } from '@avery/agent-modules-defaults';

/** 默认工具与正式场景同源；浏览器测评默认只使用资料读取、受控浏览器和交互工具。 */
export function EvaluationToolPolicy(runnerType: 'prompt' | 'browser', selected?: readonly string[]) {
  const allowed = [...(runnerType === 'prompt' ? DefaultScenario.toolNames : ApplicationScenario.toolNames)];
  const defaults = runnerType === 'prompt' ? allowed : allowed.filter(name => /^(?:Read|Glob|Grep|LoadSkill|AskUserQuestion|Browser)/.test(name));
  const invalid = (selected ?? []).filter(name => !allowed.includes(name));
  // 旧写工具只在工作场景建议合并；聊天场景始终移除，不能通过名称迁移扩大权限。
  const suggested = [...new Set((selected ?? defaults).map(name => ['CreateTodo', 'UpdateTodo'].includes(name) ? 'WriteTodo' : name).filter(name => allowed.includes(name)))];
  return { allowed, defaults, invalid, suggested };
}
