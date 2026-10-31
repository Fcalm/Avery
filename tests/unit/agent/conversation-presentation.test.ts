import { describe, expect, it } from 'vitest';
import { ApplyConversationActivity, CreateConversationPresentation, GetConversationArtifacts, GetConversationResult, IsConversationPresentation, MatchConversationResourceHref, type ConversationActivity } from '../../../packages/agent-sdk/src/conversation';
import { RunAgentLoop } from '../../../packages/agent-core/src/kernel';
import { GetToolResources } from '../../../packages/agent-core/src/conversation-resources';
import { CreateKernelHarness, CreateRegisteredTool } from './test-helpers';

function Project(activities: ConversationActivity[]) {
  return activities.reduce((value, activity, index) => ApplyConversationActivity(value, activity, index + 1, 100 + index), CreateConversationPresentation('request-1'));
}

describe('会话展示投影', () => {
  it('暂停和等待冻结用时，静态工具更新不延长暂停时间，恢复运行后清除冻结点', () => {
    const initial = ApplyConversationActivity(CreateConversationPresentation('timing'), { kind: 'step' }, 1, 1000);
    const paused = ApplyConversationActivity(initial, { kind: 'status', status: 'paused', summary: '请登录' }, 2, 2000);
    const updated = ApplyConversationActivity(paused, { kind: 'tool', name: 'BrowserSnapshot', toolCallId: 's', toolStatus: 'paused' }, 3, 9000);
    expect(updated.pausedAt).toBe(2000);
    expect(IsConversationPresentation(JSON.parse(JSON.stringify(updated)))).toBe(true);
    const resumed = ApplyConversationActivity(updated, { kind: 'status', status: 'running' }, 4, 10000);
    expect(resumed.pausedAt).toBeUndefined();
    expect(resumed.statusMessage).toBeUndefined();
  });
  it('产物保留最后版本和首尾统计，重复回执不覆盖真实名称，读取不会覆盖产物', () => {
    const resource = { kind: 'resume' as const, id: 'r1', title: '产品简历', revision: 2, produced: true, lineChanges: { added: 3, removed: 2 } };
    const value = Project([
      { kind: 'resource', resource },
      { kind: 'resource', stepId: 's1', toolCallId: 'c1', resource: { ...resource, title: '简历', lineChanges: undefined } },
      { kind: 'resource', resource: { ...resource, revision: 3, lineChanges: { added: 1, removed: 1 } } },
      { kind: 'resource', resource: { ...resource, produced: false, lineChanges: undefined } },
    ]);
    expect(value.parts[0]).toMatchObject({ toolCallId: 'c1', resource: { title: '产品简历', lineChanges: { added: 3, removed: 2 } } });
    expect(GetConversationArtifacts(value)).toEqual([{ ...resource, revision: 3, lineChanges: { added: 1, removed: 1 } }]);
    expect(IsConversationPresentation(JSON.parse(JSON.stringify(value)))).toBe(true);
  });

  it('同一档案更新统计归零后隐藏；多份资料保持独立，旧记录不补造行数', () => {
    const profile = { kind: 'profile' as const, id: 'p1', title: '求职意向', produced: true };
    const value = Project([
      { kind: 'resource', resource: { ...profile, lineChanges: { added: 2, removed: 1 } } },
      { kind: 'resource', resource: { kind: 'resume', id: 'r1', title: '旧版简历', produced: true } },
      { kind: 'resource', resource: { ...profile, lineChanges: { added: 0, removed: 0 } } },
      { kind: 'resource', resource: { kind: 'profile', id: 'p2', title: '只读档案', produced: false } },
    ]);
    expect(GetConversationArtifacts(value)).toEqual([{ kind: 'resume', id: 'r1', title: '旧版简历', produced: true }]);
    const invalid = structuredClone(value);
    const part = invalid.parts[0];
    if (part.type === 'resource') part.resource.lineChanges = { added: -1, removed: 0 };
    expect(IsConversationPresentation(invalid)).toBe(false);
  });

  it('分开的思考块保持顺序，同块增量拼接，旧序号不能回滚', () => {
    const value = Project([
      { kind: 'reasoning', stepId: 'step1', partId: 'reason1', delta: '先' },
      { kind: 'reasoning', stepId: 'step1', partId: 'reason1', delta: '读取' },
      { kind: 'text', stepId: 'step1', partId: 'text1', delta: '开始处理' },
      { kind: 'reasoning', stepId: 'step2', partId: 'reason2', delta: '再分析' },
    ]);
    expect(value.parts.map((part) => part.type)).toEqual(['reasoning', 'text', 'reasoning']);
    expect(value.parts[0]).toMatchObject({ text: '先读取' });
    expect(ApplyConversationActivity(value, { kind: 'status', status: 'failed' }, 1, 500)).toBe(value);
    expect(IsConversationPresentation(JSON.parse(JSON.stringify(value)))).toBe(true);
  });

  it('相同名称的并行调用和后续步骤复用调用 ID 都有独立状态', () => {
    const value = Project([
      { kind: 'tool', stepId: 'step1', toolCallId: 'call1', name: 'Read', toolStatus: 'running' },
      { kind: 'tool', stepId: 'step1', toolCallId: 'call2', name: 'Read', toolStatus: 'running' },
      { kind: 'tool', stepId: 'step1', toolCallId: 'call2', name: 'Read', toolStatus: 'succeeded' },
      { kind: 'tool', stepId: 'step1', toolCallId: 'call1', name: 'Read', toolStatus: 'failed' },
      { kind: 'tool', stepId: 'step2', toolCallId: 'call1', name: 'Read', toolStatus: 'running' },
    ]);
    expect(value.parts.map((part) => part.type === 'tool' && part.status)).toEqual(['failed', 'succeeded', 'running']);
    expect(new Set(value.parts.map((part) => part.id)).size).toBe(3);
  });

  it('完成后最终正文排除工具之前的解说，未确认的工具不会被推测成功', () => {
    const value = Project([
      { kind: 'text', stepId: 'step1', partId: 'comment', delta: '我先查询' },
      { kind: 'tool', stepId: 'step1', toolCallId: 'call1', name: 'ReadJobs', toolStatus: 'running' },
      { kind: 'text', stepId: 'step2', partId: 'final', delta: '找到三个机会' },
      { kind: 'status', status: 'completed' },
    ]);
    expect(GetConversationResult(value)).toBe('找到三个机会');
    expect(value.parts.find((part) => part.type === 'tool')).toMatchObject({ status: 'skipped' });
  });

  it('同一资源从读取升级为产物不会重复，版本之间仍保持独立', () => {
    const ref = { kind: 'resume' as const, id: 'resume-1', title: '简历', revision: 2 };
    const value = Project([
      { kind: 'resource', resource: ref },
      { kind: 'resource', resource: { ...ref, produced: true } },
      { kind: 'resource', resource: { ...ref, revision: 3, produced: true } },
    ]);
    expect(value.parts).toHaveLength(2);
    expect(value.parts[0]).toMatchObject({ resource: { produced: true } });
  });

  it('实体保存事件先到时，后续工具回执补齐来源且不重复产物', () => {
    const resource = { kind: 'resume' as const, id: 'r1', title: '简历', revision: 2, produced: true };
    const value = Project([
      { kind: 'resource', resource },
      { kind: 'resource', stepId: 's1', toolCallId: 'c1', resource: { ...resource, title: '产品简历' } },
      { kind: 'resource', resource: { ...resource, produced: false } },
    ]);
    expect(value.parts).toHaveLength(1);
    expect(value.parts[0]).toMatchObject({ stepId: 's1', toolCallId: 'c1', resource: { title: '产品简历', produced: true } });
  });

  it('应用内链接仅能匹配宿主资源和正确版本，路径/脚本协议不能获得操作能力', () => {
    const resource = { kind: 'file' as const, id: 'asset://resume/123', title: '导出文件' };
    expect(MatchConversationResourceHref('avery://file/' + encodeURIComponent(resource.id), [resource])).toBe(resource);
    for (const href of ['file:///C:/secret.txt', 'javascript:alert(1)', 'avery://file/unknown', 'avery://file/asset%3A%2F%2Fresume%2F123?revision=2', 'avery://user@file/asset%3A%2F%2Fresume%2F123', 'avery://file/%zz']) {
      expect(MatchConversationResourceHref(href, [resource]), href).toBeUndefined();
    }
  });
});

describe('Kernel 展示事件', () => {
  it('多轮推理、工具与最终回答有明确步骤，工具资源按调用归属', async () => {
    const tool = CreateRegisteredTool('ReadResume');
    const harness = CreateKernelHarness({
      tools: [tool],
      completions: [
        { content: '先读简历', reasoningContent: '先了解背景', toolCalls: [{ id: 'c1', type: 'function', function: { name: 'ReadResume', arguments: '{}' } }] },
        { content: '最终结果', reasoningContent: '综合判断', toolCalls: [] },
      ],
      executeTool: async () => ({ role: 'tool', tool_call_id: 'c1', content: JSON.stringify({ ok: true, resume: { id: 'r1', name: '简历', revision: 2 } }) }),
    });
    await RunAgentLoop(harness.input);
    const activities = harness.events.flatMap((event) => event.activity ? [event.activity] : []);
    expect(activities.filter((activity) => activity.kind === 'step')).toHaveLength(2);
    expect(activities.filter((activity) => activity.kind === 'reasoning').map((activity) => activity.partId)).toHaveLength(2);
    expect(activities.find((activity) => activity.kind === 'resource')).toMatchObject({ toolCallId: 'c1', resource: { id: 'r1' } });
    const projected = Project(activities);
    expect(GetConversationResult(projected)).toBe('最终结果');
  });

  it('Provider 不发流式回调时仍保存完整正文与思考', async () => {
    const harness = CreateKernelHarness({ streamCompletion: async () => ({ content: '完整答案', reasoningContent: '一次性思考', toolCalls: [] }) });
    await RunAgentLoop(harness.input);
    expect(harness.events.find((event) => event.type === 'content_delta')).toMatchObject({ delta: '完整答案' });
    expect(harness.events.find((event) => event.type === 'thinking_delta')).toMatchObject({ delta: '一次性思考' });
  });

  it('已发送正文前缀只补齐尾部，不重复整份 completion', async () => {
    const harness = CreateKernelHarness({ streamCompletion: async ({ onDelta }) => { onDelta({ content: '完整', reasoning: '' }); return { content: '完整答案', toolCalls: [] }; } });
    await RunAgentLoop(harness.input);
    expect(harness.events.filter((event) => event.type === 'content_delta').map((event) => event.delta).join('')).toBe('完整答案');
  });
});

describe('工具产物提取', () => {
  it('读取岗位使用真实 items/jobId 回执，失败回执不创建卡片', () => {
    expect(GetToolResources('ReadJobs', { ok: true, items: [{ jobId: 'job1', title: '产品经理' }] }, {})).toEqual([{ kind: 'job', id: 'job1', title: '产品经理', produced: false }]);
    expect(GetToolResources('UpdateResume', { ok: false, resumeId: 'r1', revision: 2 }, {})).toEqual([]);
    expect(GetToolResources('UpdateResume', { ok: true, saved: true, resumeId: 'r1', revision: 2 }, {})).toEqual([{ kind: 'resume', id: 'r1', title: '简历', revision: 2, produced: true }]);
  });
});
