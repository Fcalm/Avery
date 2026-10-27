import { describe, expect, it } from 'vitest';
import type { ConversationPart } from '@avery/contracts';
import { GroupConversationProcess } from '../../../src/features/assistant/conversationProcessGroups';

const Reason = (id: string): ConversationPart => ({ id, stepId: 'step', type: 'reasoning', text: id });
const Tool = (id: string): ConversationPart => ({ id, stepId: 'step', type: 'tool', toolCallId: id, name: 'ReadResume', status: 'succeeded', summary: '已读取', startedAt: 1, completedAt: 2 });
const Text = (id: string, text: string): ConversationPart => ({ id, stepId: 'step', type: 'text', text });

describe('按正文划分工作过程卡片', () => {
  it('将两段正文前的连续思考和工具分别分组，保留原顺序且不改写输入', () => {
    const parts = [Reason('r1'), Tool('t1'), Reason('r2'), Text('text1', '先查岗位'), Tool('t2'), Tool('t3'), Reason('r3'), Text('text2', '已找到岗位')];
    const original = structuredClone(parts);
    const blocks = GroupConversationProcess(parts);
    expect(blocks.map((block) => block.type)).toEqual(['process', 'text', 'process', 'text']);
    expect(blocks.filter((block) => block.type === 'process').map((block) => block.events.map((event) => event.id))).toEqual([['r1', 't1', 'r2'], ['t2', 't3', 'r3']]);
    expect(parts).toEqual(original);
  });

  it('资源元数据和空正文不切断过程，正在生成的尾组仍独立保留', () => {
    const resource: ConversationPart = { id: 'resource', stepId: 'step', type: 'resource', resource: { kind: 'resume', id: 'resume', title: '简历' } };
    const blocks = GroupConversationProcess([Tool('t1'), resource, Text('empty', ' \n'), Reason('r1'), Text('body', '正文'), Tool('t2')]);
    expect(blocks.map((block) => block.type)).toEqual(['process', 'text', 'process']);
    expect(blocks[0]).toMatchObject({ id: 'process:t1', events: [{ id: 't1' }, { id: 'r1' }] });
    expect(blocks[2]).toMatchObject({ id: 'process:t2', events: [{ id: 't2' }] });
  });

  it('流式追加保留卡片 ID；纯正文不创建空卡片', () => {
    const initial = [Reason('r1')];
    expect(GroupConversationProcess(initial)[0].id).toBe(GroupConversationProcess([...initial, Tool('t1'), Text('body', '正文')])[0].id);
    expect(GroupConversationProcess([Text('one', '第一段'), Text('two', '第二段')]).map((block) => block.type)).toEqual(['text', 'text']);
    expect(GroupConversationProcess([])).toEqual([]);
  });
});
