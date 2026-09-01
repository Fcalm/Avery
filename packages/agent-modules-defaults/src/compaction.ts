import type { AgentMessage, CompactionModule } from '@offerget/agent-sdk';
import { DropOldestTurnGroups, IsUserTurn, KeepRecentTurnGroups, SplitTurnGroups } from '@offerget/agent-sdk';

const SkillControlKinds = new Set(['skill_index', 'loaded_skill', 'loaded_skill_resource', 'skill_state_reset']);

/** Skill 控制消息不参与用户 TurnGroup；压缩时保留最新索引、最近 reset 及其后的最新正文/资源。 */
function PartitionSkillControls(history: AgentMessage[]): { base: AgentMessage[]; pinned: AgentMessage[] } {
  const resetIndex = history.reduce((latest, message, index) => message.metadata?.kind === 'skill_state_reset' ? index : latest, -1);
  const selected = new Map<string, { index: number; message: AgentMessage }>();
  history.forEach((message, index) => {
    const metadata = message.metadata;
    if (!metadata || !SkillControlKinds.has(metadata.kind)) return;
    if (metadata.kind === 'skill_index') selected.set('index', { index, message });
    else if (metadata.kind === 'skill_state_reset' && index === resetIndex) selected.set('reset', { index, message });
    else if (index > resetIndex && metadata.kind === 'loaded_skill') selected.set(`skill:${metadata.skillId.toLowerCase()}`, { index, message });
    else if (index > resetIndex && metadata.kind === 'loaded_skill_resource') {
      selected.set(`resource:${metadata.skillId.toLowerCase()}:${metadata.resourcePath}`, { index, message });
    }
  });
  return {
    base: history.filter((message) => !message.metadata || !SkillControlKinds.has(message.metadata.kind)),
    pinned: [...selected.values()].sort((left, right) => left.index - right.index).map((entry) => entry.message),
  };
}

function FlattenGroup(group: ReturnType<typeof SplitTurnGroups>[number]): AgentMessage[] {
  return [...(group.prefixMessages ?? []), group.userMessage, ...group.messages];
}

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
      const { base, pinned } = PartitionSkillControls(history);
      const groups = SplitTurnGroups(base);
      if (groups.length <= 5) return { earlier: [], recent: history };
      const recentGroups = groups.slice(-5);
      return {
        earlier: groups.slice(0, -5).flatMap(FlattenGroup),
        recent: [...pinned, ...recentGroups.flatMap(FlattenGroup)],
      };
    },
    /** 从最早的完整 TurnGroup 开始截断，单次最多移除五组；不会拆开工具链。 */
    DropOldestTurns(history, count) {
      const { base, pinned } = PartitionSkillControls(history);
      return [...pinned, ...DropOldestTurnGroups(base, count)];
    },
    /** 保留最近 count 个完整用户轮次（供 Kernel 历史快照使用）。 */
    KeepRecentTurnGroups(history: AgentMessage[], count: number): AgentMessage[] {
      const { base, pinned } = PartitionSkillControls(history);
      if (SplitTurnGroups(base).length <= count) return history;
      return [...pinned, ...KeepRecentTurnGroups(base, count)];
    },
  };
}

export { IsUserTurn, SplitTurnGroups };
