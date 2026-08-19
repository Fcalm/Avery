import type { AgentMessage, CompactionModule } from '@offerget/agent-sdk';
import { DropOldestTurnGroups, IsUserTurn, KeepRecentTurnGroups, SplitTurnGroups } from '@offerget/agent-sdk';

/** 压缩模块：判定、切分与降级原语；摘要生成由 model-provider 承担，重试循环在 Kernel。 */
export function CreateCompactionModule(): CompactionModule {
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
    /** 按完整 TurnGroup 切分历史，保留最近五个完整用户轮次及其后续工具链。 */
    SplitRecentTurns(history) {
      const groups = SplitTurnGroups(history);
      if (groups.length <= 5) return { earlier: [], recent: history };
      const recentGroups = groups.slice(-5);
      return {
        earlier: groups.slice(0, -5).flatMap((group) => [group.userMessage, ...group.messages]),
        recent: recentGroups.flatMap((group) => [group.userMessage, ...group.messages]),
      };
    },
    /** 从最早的完整 TurnGroup 开始截断，单次最多移除五组；不会拆开工具链。 */
    DropOldestTurns(history, count) {
      return DropOldestTurnGroups(history, count);
    },
    /** 保留最近 count 个完整用户轮次（供 Kernel 历史快照使用）。 */
    KeepRecentTurnGroups(history: AgentMessage[], count: number): AgentMessage[] {
      return KeepRecentTurnGroups(history, count);
    },
  };
}

export { IsUserTurn, SplitTurnGroups };
