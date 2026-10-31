import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentHost } from '../../../apps/backend/src/electron/backend/agent-host';
import { CompactionArchive } from '../../../apps/backend/src/electron/backend/compaction-archive';
import { ModelConfigurationService } from '../../../apps/backend/src/electron/backend/model-configuration-service';
import { CreateKernelHarness } from '../agent/test-helpers';
import { CreateCompactionModule } from '../../../packages/agent-modules-defaults/src/compaction';
import type { AgentMessage, AgentStreamEvent, ConversationPresentation } from '../../../packages/agent-sdk/src/index';
import { GetConversationResult } from '../../../packages/agent-sdk/src/index';
import { BuildTimeline } from '../../../src/features/assistant/components/traceModel';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const call = { id: 'compact-call', type: 'function' as const, function: { name: 'CompactContext', arguments: JSON.stringify({ compressionInstructions: '保留教育经历差异与未完成字段，不提交。' }) } };
async function Host() {
  const root = await mkdtemp(path.join(tmpdir(), 'avery-compact-')); roots.push(root);
  const h = CreateKernelHarness({});
  const modelConfigurations = new ModelConfigurationService({ userDataPath: root });
  await modelConfigurations.Save({ provider: 'DeepSeek', model: 'deepseek-v4-flash', overrides: { contextWindow: 16000, maxOutput: 8192 }, expectedRevision: 0 });
  const events: AgentStreamEvent[] = [];
  const presentations: ConversationPresentation[] = [];
  h.modules.compaction = CreateCompactionModule();
  h.modules.contextBuilder.SerializeSessionContext = () => '会话规则';
  h.modules.modelProvider.EstimateTokens = (value) => Math.ceil(JSON.stringify(value).length / 4);
  h.modules.modelProvider.GetRuntimeLimits = () => ({ contextLimit: 16000, threshold: 80 });
  h.modules.modelProvider.ResolveRequestModel = (model) => model ?? 'deepseek-v4-flash';
  h.modules.modelProvider.StreamCompletion = vi.fn(async () => ({ content: '', toolCalls: [call] }));
  h.modules.modelProvider.CreateSummary = vi.fn(async () => ({ content: '教育日期存在差异，尚未提交；继续核对未完成字段。' }));
  const history: AgentMessage[] = [
    { role: 'user', content: `旧任务信息${'事实'.repeat(2000)}` },
    { role: 'assistant', content: '历史解释'.repeat(2000) },
    { role: 'user', content: '现在核对教育经历，未授权提交。' },
    { role: 'assistant', content: '页面和档案有日期差异。' },
  ];
  const state = {
    modules: h.modules, modelConfigurations, statePath: path.join(root, 'agent-state.json'),
    histories: new Map([['s', history]]), tasks: new Map(), toolLedger: new Map(),
    executingSessions: new Set(), compactRequests: new Set(), controllers: new Map(), requestSessions: new Map(),
    pausedRuns: new Map(), browserRunId: null, sessionUsage: new Map(), compressionCount: 0,
    conversationRecorders: new Map(),
    business: { SaveConversationPresentation: vi.fn(async (_id, presentation) => { presentations.push(structuredClone(presentation)); return { saved: true }; }) },
    Emit: (event: AgentStreamEvent) => { state.conversationRecorders.get(event.requestId)?.Accept(event); events.push(event); },
    EmitPresentation: (event: AgentStreamEvent) => { events.push(event); },
    sessionSnapshots: new Map([['s', { instructions: { ...h.input.instructions, compiled: '系统规则' }, session: {}, tool: {}, module: {}, scenarioId: 'default' }]]),
    RestoreSessionAssistantState: vi.fn(async () => ({ provider: 'DeepSeek', model: 'deepseek-v4-flash', reasoningEffort: 'medium' })),
    EnsureModuleSnapshotCompatible: vi.fn(), HydrateToolSnapshot: vi.fn(() => []),
    LoadOrCreateSnapshots: vi.fn(async () => state.sessionSnapshots.get('s')),
    RecordSessionUsage: vi.fn(), SaveState: vi.fn(),
  };
  const host = Object.assign(Object.create(AgentHost.prototype), state) as AgentHost;
  return { host, state, history, modules: h.modules, root, events, presentations };
}

describe('手动压缩命令与归档', () => {
  it('首次快照刷新追加 Skill reset 后冻结新历史，不误判为并发修改', async () => {
    const h = await Host();
    const reset: AgentMessage = { role: 'user', content: '<skill-state-reset>过期失效</skill-state-reset>', metadata: { source: 'runtime', visibility: 'hidden', kind: 'skill_state_reset', reason: 'ttl_elapsed', sessionRevision: 2 } };
    h.state.LoadOrCreateSnapshots.mockImplementation(async () => {
      h.state.histories.set('s', [...h.history, reset]);
      return h.state.sessionSnapshots.get('s');
    });
    expect(await h.host.CompactSession({ requestId: 'first', sessionId: 's' })).toMatchObject({ compacted: true });
    expect(h.state.histories.get('s')).toContainEqual(reset);
  });

  it('单次工具调用过程、整理后的要求和摘要进入可恢复的对话与轨迹', async () => {
    const h = await Host();
    h.modules.modelProvider.StreamCompletion = vi.fn(async (request) => {
      request.onRequest?.({ kind: 'completion', model: 'test', messages: request.history, toolCount: 1 });
      request.onDelta({ reasoning: '结合当前任务整理重点', content: '' });
      return { content: '', toolCalls: [call] };
    });
    h.modules.modelProvider.CreateSummary = vi.fn(async (_provider, model, messages, onRequest) => {
      onRequest?.({ kind: 'summary', model, messages, toolCount: 0 });
      return { content: '教育日期存在差异，尚未提交；继续核对未完成字段。' };
    });
    const result = await h.host.CompactSession({ requestId: 'visible', sessionId: 's', instructions: '保留教育' });
    const toolStates = h.events.flatMap((event) => event.activity?.kind === 'tool' ? [event.activity.toolStatus] : []);
    expect(toolStates).toEqual(['running', 'running', 'succeeded']);
    const presentation = h.presentations.at(-1)!;
    expect(presentation.status).toBe('completed');
    expect(presentation.parts).toContainEqual(expect.objectContaining({ type: 'tool', name: 'CompactContext', status: 'succeeded', summary: expect.stringContaining('保留教育经历差异') }));
    expect(GetConversationResult(presentation)).toContain(result.summary);
    const traces = vi.mocked(h.modules.observability.AppendTraceEvent).mock.calls.map(([, eventType, payload], ordinal) => ({ ordinal, eventType, payload, tokenCount: 0, createdAt: ordinal }));
    expect(traces.filter((event) => event.eventType === 'provider_request')).toHaveLength(2);
    const timeline = BuildTimeline('visible', 1, traces);
    expect(timeline.some((event) => event.title === 'Tool')).toBe(true);
    expect(timeline.some((event) => event.title === 'Assistant' && JSON.stringify(event.payload).includes(result.summary!))).toBe(true);
    expect(h.state.conversationRecorders.size).toBe(0);
    expect(h.events.at(-1)?.type).toBe('run_released');
  });

  it('摘要失败保留错误原因、失败工具状态和旧历史，而非只有用量', async () => {
    const h = await Host();
    h.modules.modelProvider.CreateSummary = vi.fn(async () => { throw new Error('summary-provider-error'); });
    await expect(h.host.CompactSession({ requestId: 'failed', sessionId: 's' })).rejects.toThrow('summary-provider-error');
    expect(h.state.histories.get('s')).toBe(h.history);
    expect(h.presentations.at(-1)).toMatchObject({ status: 'failed', error: expect.stringContaining('summary-provider-error') });
    expect(h.presentations.at(-1)?.parts).toContainEqual(expect.objectContaining({ type: 'tool', status: 'failed' }));
    expect(h.modules.observability.AppendTraceEvent).toHaveBeenCalledWith('failed', 'error', expect.objectContaining({ message: expect.stringContaining('summary-provider-error') }));
  });

  it('翻译结束后的迟到增量不能再改动对话投影，摘要阶段取消仍可保留过程', async () => {
    const h = await Host();
    let lateDelta!: Parameters<typeof h.modules.modelProvider.StreamCompletion>[0]['onDelta'];
    h.modules.modelProvider.StreamCompletion = vi.fn(async (request) => {
      lateDelta = request.onDelta;
      return { content: '', toolCalls: [call] };
    });
    h.modules.modelProvider.CreateSummary = vi.fn(async () => {
      lateDelta({ reasoning: '', content: '迟到内容不得出现' });
      await h.host.Cancel('cancel-summary');
      return { content: '迟到摘要' };
    });
    await expect(h.host.CompactSession({ requestId: 'cancel-summary', sessionId: 's' })).rejects.toThrow();
    expect(h.presentations.at(-1)?.status).toBe('cancelled');
    expect(JSON.stringify(h.presentations)).not.toContain('迟到内容不得出现');
    expect(h.state.histories.get('s')).toBe(h.history);
    expect(h.state.controllers.size).toBe(0);
  });
  it('沿用所选思考强度、只接受一次工具调用，原始后缀不会交给摘要模型', async () => {
    const h = await Host();
    const result = await h.host.CompactSession({ requestId: 'c1', sessionId: 's', instructions: 'RAW_FOCUS_仅翻译可见', reasoningEffort: 'max' });
    expect(result.compacted).toBe(true);
    expect(result.afterTokens).toBeLessThan(result.beforeTokens);
    const translate = vi.mocked(h.modules.modelProvider.StreamCompletion).mock.calls[0][0];
    expect(translate.reasoningEffort).toBe('max');
    expect(translate).not.toHaveProperty('tool_choice');
    expect(translate.tools.map((t) => t.definition.function.name)).toEqual(['CompactContext']);
    expect(JSON.stringify(translate.history)).toContain('RAW_FOCUS_');
    const summaries = vi.mocked(h.modules.modelProvider.CreateSummary).mock.calls;
    expect(JSON.stringify(summaries.map((args) => [args[2], args[4]?.compressionInstructions]))).not.toContain('RAW_FOCUS_');
    expect(summaries[0][4]).toMatchObject({ reasoningEffort: 'max', compressionInstructions: '保留教育经历差异与未完成字段，不提交。' });
    const summary = h.state.histories.get('s')![0];
    expect(summary.metadata?.kind).toBe('context_summary');
    expect(h.state.controllers.size).toBe(0);
    expect(Reflect.get(h.host, 'compressionCount')).toBe(1);
  });

  it.each([0, 2])('工具调用 %s 次时明确失败，不更新历史或执行摘要', async (count) => {
    const h = await Host();
    h.modules.modelProvider.StreamCompletion = vi.fn(async () => ({ content: '普通回答', toolCalls: Array.from({ length: count }, (_, i) => ({ ...call, id: `call-${i}` })) }));
    await expect(h.host.CompactSession({ requestId: 'c', sessionId: 's', instructions: '保留教育' })).rejects.toThrow('单次调用');
    expect(h.modules.modelProvider.CreateSummary).not.toHaveBeenCalled();
    expect(h.state.histories.get('s')).toBe(h.history);
    expect(h.state.executingSessions.size).toBe(0);
  });

  it('状态落盘失败回退旧历史，原文归档不覆盖原视图', async () => {
    const h = await Host();
    h.state.sessionUsage.set('s', { source: 'actual', compressionCount: 2, contextPending: false });
    h.state.SaveState.mockImplementation(() => { throw new Error('disk failure'); });
    await expect(h.host.CompactSession({ requestId: 'c', sessionId: 's' })).rejects.toThrow('disk failure');
    expect(h.state.histories.get('s')).toBe(h.history);
    expect(h.state.sessionUsage.get('s')).toMatchObject({ compressionCount: 2, contextPending: false });
  });

  it('手动压缩后上下文进度待测，累计真实用量不被估算值替换', async () => {
    const h = await Host();
    h.state.sessionUsage.set('s', { source: 'actual', inputTokens: 9000, compressionCount: 2, totalTokens: 12000 });
    await h.host.CompactSession({ requestId: 'c', sessionId: 's' });
    expect(h.state.sessionUsage.get('s')).toMatchObject({ source: 'actual', inputTokens: 9000, compressionCount: 3, totalTokens: 12000, contextPending: true });
  });

  it('提交后的 Trace 写入与收尾故障不能改变成功结果或卡住会话锁', async () => {
    const h = await Host();
    h.modules.observability.AppendTraceEvent = vi.fn(() => { throw new Error('trace disk failed'); });
    h.modules.observability.FinishTrace = vi.fn(() => { throw new Error('trace finish failed'); });
    expect(await h.host.CompactSession({ requestId: 'c', sessionId: 's' })).toMatchObject({ compacted: true });
    expect(h.state.histories.get('s')).not.toBe(h.history);
    expect(h.state.executingSessions.size).toBe(0);
    expect(h.state.controllers.size).toBe(0);
  });

  it('翻译迟到返回时取消有效，不进入摘要或覆盖历史', async () => {
    const h = await Host();
    let resolve!: (value: { content: string; toolCalls: typeof call[] }) => void;
    h.modules.modelProvider.StreamCompletion = vi.fn(() => new Promise((done) => { resolve = done; }));
    const pending = h.host.CompactSession({ requestId: 'c', sessionId: 's' });
    await vi.waitFor(() => expect(resolve).toBeTypeOf('function'));
    await h.host.Cancel('c');
    resolve({ content: '', toolCalls: [call] });
    await expect(pending).rejects.toThrow();
    expect(h.modules.modelProvider.CreateSummary).not.toHaveBeenCalled();
    expect(h.state.histories.get('s')).toBe(h.history);
  });

  it('忙碌会话拒绝手动压缩，空历史不发模型请求', async () => {
    const h = await Host();
    h.state.executingSessions.add('s');
    await expect(h.host.CompactSession({ requestId: 'c', sessionId: 's' })).rejects.toMatchObject({ code: 'AGENT_BUSY' });
    h.state.executingSessions.clear(); h.state.histories.clear();
    expect(await h.host.CompactSession({ requestId: 'c', sessionId: 's' })).toMatchObject({ compacted: false });
    expect(h.modules.modelProvider.StreamCompletion).not.toHaveBeenCalled();
  });

  it('摘要来源可递归展开，隔离会话并随会话删除', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'avery-compact-archive-')); roots.push(root);
    const store = new CompactionArchive(root); const signal = new AbortController().signal;
    const original: AgentMessage[] = [{ role: 'user', content: '早期教育日期' }];
    await store.Save('s', { summaryId: 'summary-one', messages: original });
    const summary: AgentMessage = { role: 'user', content: '旧摘要', metadata: { source: 'runtime', visibility: 'hidden', kind: 'context_summary', summaryId: 'summary-one' } };
    await store.Save('s', { summaryId: 'summary-two', messages: [summary, { role: 'assistant', content: '后续信息' }] });
    const top = { ...summary, metadata: { ...summary.metadata!, kind: 'context_summary' as const, summaryId: 'summary-two' } };
    expect(await store.Expand('s', [top], signal)).toEqual([...original, { role: 'assistant', content: '后续信息' }]);
    await expect(store.Expand('other', [summary], signal)).rejects.toThrow();
    await store.RemoveSession('s');
    await expect(store.Expand('s', [summary], signal)).rejects.toThrow();
  });
});
