import { describe, expect, it, vi, afterEach } from 'vitest';
import type { AgentMessage } from '../../../packages/agent-sdk/src/index';
import { CompactContextHistory } from '../../../packages/agent-core/src/context-compaction';
import { RunAgentLoop } from '../../../packages/agent-core/src/kernel';
import { CreateCompactionModule } from '../../../packages/agent-modules-defaults/src/compaction';
import { CreateProviderModule } from '../../../packages/agent-modules-defaults/src/provider';
import { CreateKernelHarness, CreateRegisteredTool } from './test-helpers';

afterEach(() => vi.unstubAllGlobals());
const estimate = (value: unknown) => Math.ceil(JSON.stringify(value).length / 4);
function History(): AgentMessage[] {
  return [{ role: 'user', content: '核对教育日期，不提交。' }, ...Array.from({ length: 5 }, (_, i): AgentMessage[] => [
    { role: 'assistant', content: '', tool_calls: [{ id: `r${i}`, type: 'function', function: { name: 'Read', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: `r${i}`, content: `事实${i}：${'旧过程'.repeat(650)}` },
  ]).flat()];
}
function Setup(history = History()) {
  const h = CreateKernelHarness({});
  h.modules.compaction = CreateCompactionModule();
  h.modules.modelProvider.EstimateTokens = estimate;
  h.modules.modelProvider.GetRuntimeLimits = () => ({ contextLimit: 2000, threshold: 80 });
  h.modules.modelProvider.CreateSummary = vi.fn(async () => ({ content: '教育日期待核对；禁止提交，继续剩余字段。' }));
  const input = { modules: h.modules, history, provider: 'DeepSeek', model: 'deepseek-v4-flash', reasoningEffort: 'xhigh' as const,
    system: '系统规则', tools: [], signal: new AbortController().signal, createId: () => 'test' };
  return { ...h, compact: input };
}

describe('预算化上下文压缩', () => {
  it('只有一个用户轮次也压缩完整早期工具步骤，保留原文供提交归档', async () => {
    const h = Setup(); const original = JSON.stringify(h.compact.history);
    const result = await CompactContextHistory(h.compact);
    expect(result.after).toBeLessThan(result.before);
    expect(result.archive?.original).toEqual(h.compact.history);
    expect(JSON.stringify(h.compact.history)).toBe(original);
    expect(result.history.some((m) => m.role === 'user' && m.content === '核对教育日期，不提交。')).toBe(true);
    expect(h.modules.modelProvider.CreateSummary).toHaveBeenCalledWith('DeepSeek', 'deepseek-v4-flash', expect.any(Array), undefined, expect.objectContaining({ reasoningEffort: 'xhigh' }));
  });

  it('摘要失败最多重试一次，使用相同原文且不丢最早步骤', async () => {
    const h = Setup([{ role: 'user', content: '早期事实'.repeat(200) }, { role: 'assistant', content: '解释'.repeat(350) }, { role: 'user', content: '当前问题' }]);
    const original = JSON.stringify(h.compact.history);
    const summary = vi.fn(async () => { throw new Error('temporary failure'); });
    h.modules.modelProvider.CreateSummary = summary;
    await expect(CompactContextHistory({ ...h.compact, force: true })).rejects.toThrow('压缩失败');
    expect(summary).toHaveBeenCalledTimes(2);
    expect(summary.mock.calls[0]).toEqual(summary.mock.calls[1]);
    expect(JSON.stringify(h.compact.history)).toBe(original);
  });

  it('最近保留的用户纠正作为摘要参考，不能只看到旧事实', async () => {
    const h = Setup([...History(), { role: 'user', content: '更正：入学日期是2020-09，仍不要提交。' }]);
    await CompactContextHistory(h.compact);
    expect(h.modules.modelProvider.CreateSummary).toHaveBeenCalledWith(expect.any(String), expect.any(String), expect.any(Array), undefined,
      expect.objectContaining({ recentContext: expect.arrayContaining([expect.objectContaining({ content: '更正：入学日期是2020-09，仍不要提交。' })]) }));
  });

  it('迟到的摘要响应在取消后不能进入候选或用量', async () => {
    const h = Setup(); const controller = new AbortController(); const onUsage = vi.fn();
    h.modules.modelProvider.CreateSummary = async () => { controller.abort(); return { content: 'late' }; };
    await expect(CompactContextHistory({ ...h.compact, signal: controller.signal, onUsage })).rejects.toThrow();
    expect(onUsage).not.toHaveBeenCalled();
  });

  it('未完成工具批次拒绝切分，不调用摘要', async () => {
    const h = Setup(History().slice(0, -1));
    await expect(CompactContextHistory(h.compact)).rejects.toThrow('未完成工具');
    expect(h.modules.modelProvider.CreateSummary).not.toHaveBeenCalled();
  });

  it('摘要未缩小上下文时拒绝候选，不修改原数组', async () => {
    const h = Setup(); const original = [...h.compact.history];
    h.modules.modelProvider.CreateSummary = vi.fn(async () => ({ content: '过长摘要'.repeat(1000) }));
    await expect(CompactContextHistory(h.compact)).rejects.toThrow();
    expect(h.compact.history).toEqual(original);
  });

  it('当前用户原文本身超限时直接暂停，不浪费摘要调用', async () => {
    const h = Setup([...History(), { role: 'user', content: '不可裁剪的当前请求'.repeat(2000) }]);
    await expect(CompactContextHistory(h.compact)).rejects.toThrow('当前用户原文');
    expect(h.modules.modelProvider.CreateSummary).not.toHaveBeenCalled();
  });

  it('保留快照增量时保留完整依赖，预算不足时移走整条链', () => {
    const history: AgentMessage[] = [{ role: 'user', content: '继续浏览器任务' }];
    for (const [id, mode] of [['s1', 'full'], ['s2', 'delta']] as const) history.push(
      { role: 'assistant', content: '', tool_calls: [{ id, type: 'function', function: { name: 'BrowserSnapshot', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: id, content: JSON.stringify({ ok: true, data: { mode, refs: { e1: { name: '学校' } } } }) },
    );
    const module = CreateCompactionModule();
    const enough = module.SplitRecentTurns(history, { maxRecentTokens: 5, estimate: (m) => m.length });
    expect(enough.recent.filter((m) => m.role === 'tool')).toHaveLength(2);
    const small = module.SplitRecentTurns(history, { maxRecentTokens: 3, estimate: (m) => m.length });
    expect(small.recent.filter((m) => m.role === 'tool')).toHaveLength(0);
  });

  it('同一个 Run 在工具返回后重新检查预算并先压缩再续答', async () => {
    const read = CreateRegisteredTool('Read');
    const h = CreateKernelHarness({ tools: [read], executeTool: async (call) => ({ role: 'tool', tool_call_id: call.id, content: '事实'.repeat(12000) }), completions: [
      { content: '', toolCalls: [{ id: 'read', type: 'function', function: { name: 'Read', arguments: '{}' } }] },
      { content: '完成', toolCalls: [] },
    ] });
    h.modules.compaction = CreateCompactionModule();
    h.modules.modelProvider.EstimateTokens = estimate;
    h.modules.modelProvider.GetRuntimeLimits = () => ({ contextLimit: 8000, threshold: 70 });
    const result = await RunAgentLoop(h.input);
    expect(result.compressionCount).toBe(1);
    expect(h.modules.modelProvider.CreateSummary).toHaveBeenCalled();
  });

  it('压缩后旧页面动作被拦截，成功重新观察后才放行动作', async () => {
    const tool = (id: string, name: string) => ({ id, type: 'function' as const, function: { name, arguments: '{}' } });
    const click = CreateRegisteredTool('BrowserClick', { isConcurrencySafe: false });
    const snapshot = CreateRegisteredTool('BrowserSnapshot');
    const h = CreateKernelHarness({ tools: [click, snapshot], history: [{ role: 'user', content: '<summary>页面曾出现按钮</summary>', metadata: { source: 'runtime', visibility: 'hidden', kind: 'context_summary', summaryId: 'summary-old' } }],
      executeTool: async (call) => ({ role: 'tool', tool_call_id: call.id, content: '{"ok":true}' }), completions: [
        { content: '', toolCalls: [tool('old', 'BrowserClick')] },
        { content: '', toolCalls: [tool('observe', 'BrowserSnapshot')] },
        { content: '', toolCalls: [tool('new', 'BrowserClick')] },
        { content: '完成', toolCalls: [] },
      ] });
    await RunAgentLoop(h.input);
    expect(vi.mocked(h.modules.tools.ExecuteToolCall).mock.calls.map(([call]) => call.function.name)).toEqual(['BrowserSnapshot', 'BrowserClick']);
    expect(h.input.histories.get('session-1')?.find((message) => message.tool_call_id === 'old')?.content).toContain('BROWSER_SNAPSHOT_CONTEXT_LOST');
  });

  it('归档未成功前不发布摘要视图，失败后原历史和已接受输入仍在', async () => {
    const h = CreateKernelHarness({ shouldCompact: true, history: [{ role: 'user', content: '早期事实' }, { role: 'assistant', content: '解释' }], completions: [{ content: '不应调用', toolCalls: [] }] });
    h.input.archiveHistory = async () => {
      expect(h.input.histories.get('session-1')?.some((message) => message.metadata?.kind === 'context_summary')).toBe(false);
      throw new Error('archive disk failed');
    };
    expect(await RunAgentLoop(h.input)).toMatchObject({ outcome: 'paused', reason: 'context_compaction' });
    const saved = h.input.histories.get('session-1')!;
    expect(saved.some((message) => message.content === '早期事实')).toBe(true);
    expect(saved.some((message) => message.content === 'test request')).toBe(true);
    expect(saved.some((message) => message.metadata?.kind === 'context_summary')).toBe(false);
  });

  it.each([true, false])('摘要沿用当前思考开关 %s、强度映射，不含强制工具参数或旧推理', async (thinkingEnabled) => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: '摘要' }, finish_reason: 'stop' }] })));
    vi.stubGlobal('fetch', fetch);
    const provider = CreateProviderModule({ getConfig: async () => ({ provider: 'DeepSeek', model: 'deepseek-v4-flash', baseUrl: 'https://api.deepseek.com', apiKey: 'test', thinkingEnabled, contextLimit: 256000, compressionThreshold: 80 }), saveConfig: async () => {}, getStoredSettings: async () => ({}) });
    await provider.CreateSummary('DeepSeek', 'deepseek-v4-flash', [{ role: 'assistant', content: '业务事实', reasoning_content: 'hidden-test-reasoning' }], undefined, { reasoningEffort: 'max', compressionInstructions: '优化后的要求' });
    const body = JSON.parse(String(fetch.mock.calls[0]?.[1]?.body));
    expect(body.thinking).toEqual({ type: thinkingEnabled ? 'enabled' : 'disabled' });
    if (thinkingEnabled) expect(body.reasoning_effort).toBe('max');
    expect(body).not.toHaveProperty('tool_choice');
    expect(JSON.stringify(body)).not.toContain('hidden-test-reasoning');
    expect(JSON.stringify(body)).toContain('优化后的要求');
  });
});
