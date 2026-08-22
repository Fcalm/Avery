import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  DropOldestTurnGroups, KeepRecentTurnGroups, SlotOrder, SlotToModuleKey, SplitTurnGroups,
} from '../../../packages/agent-sdk/src/index';
import type {
  AgentMessage, FileReadPort, KernelRunInput, NormalizedUsage, ProviderUsageFact, RunDisposition,
  RunState, ToolPorts,
} from '../../../packages/agent-sdk/src/index';

describe('agent-sdk 六槽与窄契约', () => {
  it('固定六槽顺序及聚合键映射', () => {
    expect(SlotOrder).toEqual(['model-provider', 'context-builder', 'compaction', 'tools', 'interaction', 'observability']);
    expect(SlotToModuleKey).toEqual({
      'model-provider': 'modelProvider',
      'context-builder': 'contextBuilder',
      compaction: 'compaction',
      tools: 'tools',
      interaction: 'interaction',
      observability: 'observability',
    });
  });

  it('工具端口保持业务窄接口，Kernel usage 回调显式区分 provider 与 unavailable', () => {
    type UsageCallback = NonNullable<KernelRunInput['onModelUsage']>;
    expectTypeOf<ToolPorts['file']>().toEqualTypeOf<FileReadPort>();
    expectTypeOf<Parameters<UsageCallback>[0]>().toEqualTypeOf<ProviderUsageFact>();
    expectTypeOf<NormalizedUsage['source']>().toEqualTypeOf<'provider'>();
  });

  it('Run 终态与等待态使用稳定字面量联合', () => {
    const terminalStates = ['completed', 'failed', 'cancelled'] satisfies RunState[];
    const resumableDispositions = ['waiting_user_input', 'waiting_confirmation', 'paused'] satisfies RunDisposition[];

    expect(new Set(terminalStates).size).toBe(3);
    expect(resumableDispositions).toEqual(['waiting_user_input', 'waiting_confirmation', 'paused']);
  });

  it('按完整 TurnGroup 保留与丢弃历史，不切断工具调用和结果', () => {
    const history: AgentMessage[] = [];
    for (let index = 1; index <= 7; index += 1) {
      history.push(
        { role: 'user', content: `user-${index}` },
        { role: 'assistant', content: '', tool_calls: [{ id: `call-${index}`, type: 'function', function: { name: 'Read', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: `call-${index}`, content: `result-${index}${index === 3 ? '【待确认】' : ''}` },
        { role: 'assistant', content: `answer-${index}` },
      );
    }

    const groups = SplitTurnGroups(history);
    const recent = KeepRecentTurnGroups(history, 5);
    const dropped = DropOldestTurnGroups(history, 2);

    expect(groups).toHaveLength(7);
    expect(recent[0]).toEqual({ role: 'user', content: 'user-3' });
    expect(recent.some((message) => message.content.includes('【待确认】'))).toBe(true);
    expect(dropped).toEqual(recent);
    for (const group of SplitTurnGroups(recent)) {
      const callIds = group.messages.flatMap((message) => message.tool_calls?.map((call) => call.id) ?? []);
      const resultIds = group.messages.flatMap((message) => message.tool_call_id ? [message.tool_call_id] : []);
      expect(resultIds).toEqual(callIds);
    }
  });
});
