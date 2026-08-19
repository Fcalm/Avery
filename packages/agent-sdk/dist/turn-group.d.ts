import type { AgentMessage, TurnGroup } from './types';
/** 判断是否为一个真实用户轮次：排除运行时上下文与摘要消息。 */
export declare function IsUserTurn(message: AgentMessage): boolean;
/** 按完整 TurnGroup 切分历史：每个真实用户消息开始一个新组，工具调用与结果不会被拆开。 */
export declare function SplitTurnGroups(history: AgentMessage[]): TurnGroup[];
/** 保留最近 count 个完整 TurnGroup；不会在工具链中间截断。 */
export declare function KeepRecentTurnGroups(history: AgentMessage[], count: number): AgentMessage[];
/** 从最早完整 TurnGroup 开始丢弃 count 组；不足时返回空数组。 */
export declare function DropOldestTurnGroups(history: AgentMessage[], count: number): AgentMessage[];
