import type { AgentMessage, CompactionModule } from '@avery/agent-sdk';
import { AgentSdkContractVersion, DropOldestTurnGroups, IsUserTurn, KeepRecentTurnGroups, SplitTurnGroups } from '@avery/agent-sdk';

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

/** 完整工具批次是最小裁剪单元；未结束的调用不能参与压缩。 */
function MessageBatches(messages: AgentMessage[]): AgentMessage[][] {
  const batches: AgentMessage[][] = [];
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    const batch = [message];
    if (message.tool_calls?.length) {
      const remaining = new Set(message.tool_calls.map((call) => call.id));
      while (messages[index + 1]?.role === 'tool') {
        const result = messages[++index];
        if (!remaining.has(result.tool_call_id ?? '')) throw new Error('工具回执重复或来源不匹配，暂不能压缩。');
        remaining.delete(result.tool_call_id ?? '');
        batch.push(result);
      }
      if (remaining.size) throw new Error('存在未完成工具调用，暂不能压缩。');
    } else if (message.role === 'tool') throw new Error('工具回执缺少调用来源，暂不能压缩。');
    batches.push(batch);
  }
  return batches;
}

/** 压缩模块提供预算切分；摘要和受控重试由核心引擎编排，旧轮次接口仅保留兼容。 */
export function CreateCompactionModule(): CompactionModule {
  return {
    packageName: '@avery/agent-modules-defaults',
    name: 'avery.agent-defaults',
    version: '0.1.0',
    sdkVersion: AgentSdkContractVersion,
    slot: 'compaction',
    capabilities: ['compaction'],
    /** 估算占比达到阈值时返回需要压缩；与既有运行时语义一致（>= 阈值即压缩）。 */
    ShouldCompact(estimate, contextLimit, threshold) {
      return estimate / contextLimit * 100 >= threshold;
    },
    /** 按预算保留最近步骤与最新用户原文，支持在同一复杂用户轮次内总结早期批次。 */
    SplitRecentTurns(history, budget = { maxRecentTokens: 16000, estimate: (messages) => Math.ceil(JSON.stringify(messages).length / 4) }) {
      const { base, pinned } = PartitionSkillControls(history);
      const batches = MessageBatches(base);
      const latestUser = [...base].reverse().find((message) => IsUserTurn(message));
      const latestReminder = [...base].reverse().find((message) => message.metadata?.kind === 'runtime_reminder');
      const keep = new Set<number>();
      let used = budget.estimate(pinned);
      batches.forEach((batch, index) => {
        if (batch.includes(latestUser!) || batch.includes(latestReminder!)) {
          keep.add(index); used += budget.estimate(batch);
        }
      });
      for (let index = batches.length - 1; index >= 0; index -= 1) {
        if (keep.has(index)) continue;
        const size = budget.estimate(batches[index]);
        if (used + size > budget.maxRecentTokens) break;
        keep.add(index); used += size;
      }
      // 页面观察是依赖链，保留了增量就必须同时保留其全量和中间结果；放不下时整链归入摘要。
      const chains: Array<{ indices: Set<number>; complete: boolean }> = [];
      let chain = { indices: new Set<number>(), complete: false };
      batches.forEach((batch, index) => {
        const snapshotIds = new Set(batch[0].tool_calls?.filter((call) => call.function.name === 'BrowserSnapshot').map((call) => call.id));
        for (const message of batch.filter((item) => item.role === 'tool' && snapshotIds.has(item.tool_call_id!))) {
          try {
            const raw = JSON.parse(message.content);
            const snapshot = raw.data ?? raw;
            if (snapshot.mode === 'full') {
              if (chain.indices.size) chains.push(chain);
              chain = { indices: new Set(), complete: snapshot.truncated !== true && snapshot.partialTextTruncated !== true };
            }
            if (['full', 'delta', 'unchanged'].includes(snapshot.mode)) chain.indices.add(index);
          } catch { /* 非快照结果由普通工具批次规则处理。 */ }
        }
      });
      if (chain.indices.size) chains.push(chain);
      for (const item of chains.reverse()) {
        if (![...item.indices].some((index) => keep.has(index))) continue;
        const missing = [...item.indices].filter((index) => !keep.has(index));
        const cost = missing.reduce((sum, index) => sum + budget.estimate(batches[index]), 0);
        if (item.complete && used + cost <= budget.maxRecentTokens) {
          missing.forEach((index) => keep.add(index)); used += cost;
        } else for (const index of item.indices) {
          if (keep.delete(index)) used -= budget.estimate(batches[index]);
        }
      }
      return { earlier: batches.filter((_, index) => !keep.has(index)).flat(), recent: [...pinned, ...batches.filter((_, index) => keep.has(index)).flat()] };
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
