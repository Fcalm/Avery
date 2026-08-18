"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CreateCompactionModule = CreateCompactionModule;
/** 判定真实用户轮次：排除运行时上下文与既有摘要消息。 */
function IsUserTurn(message) {
    return message.role === 'user' && !String(message.content).startsWith('<runtime-context>') && !String(message.content).startsWith('<summary');
}
/** 压缩模块：判定、切分与降级原语；摘要生成由 model-provider 承担，重试循环在 Kernel。 */
function CreateCompactionModule() {
    return {
        packageName: '@offerget/agent-modules-defaults',
        name: 'offerget.agent-defaults',
        version: '0.1.0',
        sdkVersion: '0.1.0',
        slot: 'compaction',
        capabilities: ['compaction'],
        /** 估算占比达到阈值时返回需要压缩；与既有运行时语义一致（>= 阈值即压缩）。 */
        ShouldCompact(estimate, contextLimit, threshold) {
            return estimate / contextLimit * 100 >= threshold;
        },
        /** 按真实用户消息切分历史，保留最近五个完整用户轮次及其后续工具链。 */
        SplitRecentTurns(history) {
            const userIndexes = history.reduce((indexes, message, index) => {
                if (IsUserTurn(message))
                    indexes.push(index);
                return indexes;
            }, []);
            if (userIndexes.length <= 5)
                return { earlier: [], recent: history };
            const start = userIndexes[userIndexes.length - 5];
            return { earlier: history.slice(0, start), recent: history.slice(start) };
        },
        /** 从最早的完整轮次开始截断，单次最多移除五轮以供压缩重试。 */
        DropOldestTurns(history, count) {
            const userIndexes = history.reduce((indexes, message, index) => {
                if (IsUserTurn(message))
                    indexes.push(index);
                return indexes;
            }, []);
            if (!userIndexes.length)
                return history.slice(Math.min(5, history.length));
            const cutoff = userIndexes[Math.min(count, userIndexes.length - 1)] ?? history.length;
            return history.slice(cutoff);
        },
    };
}
