import type { AgentMessage, TurnGroup } from './types';

/** 判断是否为一个真实用户轮次：排除运行时上下文与摘要消息。 */
export function IsUserTurn(message: AgentMessage): boolean {
  return message.role === 'user'
    && message.metadata?.source !== 'runtime'
    && !String(message.content).startsWith('<runtime-context>')
    && !String(message.content).startsWith('<summary');
}

/** 按完整 TurnGroup 切分历史：每个真实用户消息开始一个新组，工具调用与结果不会被拆开。 */
export function SplitTurnGroups(history: AgentMessage[]): TurnGroup[] {
  const groups: TurnGroup[] = [];
  let prefixMessages: AgentMessage[] = [];
  let current: TurnGroup | null = null;
  for (const message of history) {
    if (IsUserTurn(message)) {
      if (current) groups.push(current);
      current = { ...(prefixMessages.length ? { prefixMessages } : {}), userMessage: message, messages: [] };
      prefixMessages = [];
    } else if (current) {
      current.messages.push(message);
    } else {
      prefixMessages.push(message);
    }
  }
  if (current) groups.push(current);
  else if (prefixMessages.length) {
    const [userMessage, ...messages] = prefixMessages;
    groups.push({ userMessage, messages });
  }
  return groups;
}

function FlattenTurnGroup(group: TurnGroup): AgentMessage[] {
  return [...(group.prefixMessages ?? []), group.userMessage, ...group.messages];
}

/** 保留最近 count 个完整 TurnGroup；不会在工具链中间截断。 */
export function KeepRecentTurnGroups(history: AgentMessage[], count: number): AgentMessage[] {
  const groups = SplitTurnGroups(history);
  if (groups.length <= count) return history;
  const recent = groups.slice(-count);
  return recent.flatMap(FlattenTurnGroup);
}

/** 从最早完整 TurnGroup 开始丢弃 count 组；不足时返回空数组。 */
export function DropOldestTurnGroups(history: AgentMessage[], count: number): AgentMessage[] {
  const groups = SplitTurnGroups(history);
  if (groups.length <= count) return [];
  return groups.slice(count).flatMap(FlattenTurnGroup);
}
