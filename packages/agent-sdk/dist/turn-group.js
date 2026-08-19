"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.IsUserTurn = IsUserTurn;
exports.SplitTurnGroups = SplitTurnGroups;
exports.KeepRecentTurnGroups = KeepRecentTurnGroups;
exports.DropOldestTurnGroups = DropOldestTurnGroups;
/** 判断是否为一个真实用户轮次：排除运行时上下文与摘要消息。 */
function IsUserTurn(message) {
    return message.role === 'user'
        && !String(message.content).startsWith('<runtime-context>')
        && !String(message.content).startsWith('<summary');
}
/** 按完整 TurnGroup 切分历史：每个真实用户消息开始一个新组，工具调用与结果不会被拆开。 */
function SplitTurnGroups(history) {
    const groups = [];
    let current = [];
    for (const message of history) {
        if (IsUserTurn(message) && current.length > 0) {
            const [userMessage, ...messages] = current;
            groups.push({ userMessage, messages });
            current = [];
        }
        current.push(message);
    }
    if (current.length > 0) {
        const [userMessage, ...messages] = current;
        groups.push({ userMessage, messages });
    }
    return groups;
}
/** 保留最近 count 个完整 TurnGroup；不会在工具链中间截断。 */
function KeepRecentTurnGroups(history, count) {
    const groups = SplitTurnGroups(history);
    if (groups.length <= count)
        return history;
    const recent = groups.slice(-count);
    return recent.flatMap((group) => [group.userMessage, ...group.messages]);
}
/** 从最早完整 TurnGroup 开始丢弃 count 组；不足时返回空数组。 */
function DropOldestTurnGroups(history, count) {
    const groups = SplitTurnGroups(history);
    if (groups.length <= count)
        return [];
    return groups.slice(count).flatMap((group) => [group.userMessage, ...group.messages]);
}
