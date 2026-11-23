import { access, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentHost } from '../../../apps/backend/src/electron/backend/agent-host';
import { CreateDefaultModules } from '../../../packages/agent-modules-defaults/src';
import type { AgentMessage, AgentModules, AgentStreamEvent, ModelCompletion } from '../../../packages/agent-sdk/src';
import type { ConversationRecorder } from '../../../apps/backend/src/electron/backend/conversation-recorder';

const fixtureRoot = resolve(process.env.AVERY_TEST_ARTIFACT_DIR ?? tmpdir());
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) {
    const child = relative(fixtureRoot, resolve(root));
    if (!child || child.startsWith('..') || isAbsolute(child)) throw new Error('测试清理路径超出隔离目录。');
    await rm(root, { recursive: true, force: true });
  }
});

interface HostState {
  controllers: Map<string, AbortController>;
  runtimeControls: Map<string, unknown>;
  runReleases: Map<string, Promise<unknown>>;
  histories: Map<string, AgentMessage[]>;
  pausedRuns: Map<string, { cancelled?: boolean; result?: AgentMessage; status: string }>;
  conversationRecorders: Map<string, ConversationRecorder>;
  SaveState(): void;
  RestoreConversationRecorder(requestId: string, sessionId: string): Promise<ConversationRecorder | undefined>;
}

async function Fixture(startWaitingRun = true) {
  await mkdir(fixtureRoot, { recursive: true });
  const directory = await mkdtemp(join(fixtureRoot, 'avery-boundaries-')); roots.push(directory);
  const events: AgentStreamEvent[] = [];
  const finishTrace = vi.fn();
  const completions: ModelCompletion[] = [
    { content: '', toolCalls: [{ id: 'question-tool', type: 'function', function: { name: 'AskUserQuestion', arguments: JSON.stringify({ questions: [{ id: 'q', question: '请选择', options: ['是'] }] }) } }] },
    { content: '继续完成', toolCalls: [] },
  ];
  const stream = vi.fn(async () => completions.shift() ?? { content: '新任务完成', toolCalls: [] });
  const business = {
    GetStoredSettings: async () => ({}), GetProfiles: async () => ({ items: [] }),
    GetConversationSnapshots: async (_sessionId: string) => null,
    SetConversationSnapshots: vi.fn(async () => ({ saved: true })),
    ResolveAttachmentUri: vi.fn(async (_uri: string): Promise<{ physicalPath: string; mimeType: string } | null> => null),
    RetainAgentImages: vi.fn(async () => undefined),
    GetConversationPresentations: async () => [], SaveConversationPresentation: vi.fn(async () => ({ saved: true })),
  };
  const options = {
    userDataPath: directory, workspacePath: directory, Emit: (event: unknown) => events.push(event as AgentStreamEvent),
    business, observability: { FinishTrace: finishTrace }, credentialPort: { Load: async () => null },
    browserRuntime: { Close: async () => {}, GetBrowserTaskId: () => undefined, ResetPageReferences() {}, GetStatus: async () => ({}) } as never,
    createDefaultModules: (ports: Parameters<typeof CreateDefaultModules>[0]) => {
      const modules = CreateDefaultModules(ports);
      modules.modelProvider.GetStatus = async () => ({ configured: true, provider: 'DeepSeek', model: 'deepseek-flash' });
      modules.modelProvider.StreamCompletion = stream;
      return modules;
    },
  };
  const host = new AgentHost(options), state = host as unknown as HostState;
  await host.Ready();
  const input = { requestId: 'waiting-run', sessionId: 'boundary-session', content: '请先询问我', scenarioId: 'default' as const };
  if (startWaitingRun) await host.Send(input);
  else completions.shift();
  const question = events.find(event => event.type === 'question_requested');
  if (startWaitingRun && !question?.confirmationId) throw new Error('测试未进入真实问答等待点。');
  const response = { kind: 'answer' as const, requestId: input.requestId, sessionId: input.sessionId, interactionId: question?.confirmationId ?? 'idle', answers: { q: '是' } };
  return { host, state, events, directory, business, finishTrace, stream, input, response, options };
}

describe('对话恢复和取消的故障边界', () => {
  it.each([1, 2, 3])('第 %i 次会话快照准备读取卡住时可取消，迟到结果不冻结新快照', async readIndex => {
    const { host, input, business, stream, events } = await Fixture(false);
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    let reads = 0;
    const read = vi.spyOn(business, 'GetConversationSnapshots').mockImplementation(async () => {
      if (++reads === readIndex) { entered(); await gate; }
      return null;
    });
    const pending = host.Send(input);
    try {
      await started;
      await host.Cancel(input.requestId);
      await expect(pending).resolves.toMatchObject({ cancelled: true });
      release(); await new Promise(resolve => setImmediate(resolve));
      expect(business.SetConversationSnapshots).not.toHaveBeenCalled();
      expect(stream).not.toHaveBeenCalled();
      expect(events.filter(event => event.type === 'cancelled')).toHaveLength(1);
      expect(host.IsBusy()).toBe(false);
      read.mockRestore();
      await expect(host.Send({ ...input, requestId: 'after-snapshot-cancel' })).resolves.toMatchObject({ accepted: true });
      expect(stream).toHaveBeenCalledTimes(1);
    } finally { release(); await pending; read.mockRestore(); await host.Close(); }
  });

  it('浏览器初始化读取设置卡住时仍能取消，迟到读取不调用模型，新请求可继续', async () => {
    const { host, input, business, stream, events } = await Fixture(false);
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const read = vi.spyOn(business, 'GetStoredSettings').mockImplementationOnce(async () => { entered(); await gate; return {}; });
    const pending = host.Send({ ...input, scenarioId: 'application' });
    try {
      await started;
      await expect(host.Cancel(input.requestId)).resolves.toEqual({ cancelled: true });
      await expect(pending).resolves.toMatchObject({ cancelled: true });
      expect(host.IsBusy()).toBe(false);
      expect(stream).not.toHaveBeenCalled();
      expect(events.filter(event => event.type === 'cancelled')).toHaveLength(1);
      release(); read.mockRestore();
      await expect(host.Send({ ...input, requestId: 'after-init-cancel' })).resolves.toMatchObject({ accepted: true });
      expect(stream).toHaveBeenCalledTimes(1);
    } finally { release(); await pending; read.mockRestore(); await host.Close(); }
  });

  it('凭据/模型准备读取不返回时取消立即结束该 Run，迟到状态不继续执行', async () => {
    const { host, input, state, stream } = await Fixture(false);
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const modules = (state as unknown as { modules: AgentModules }).modules;
    const read = vi.spyOn(modules.modelProvider, 'GetStatus').mockImplementationOnce(async () => { entered(); await gate; return { configured: true, provider: 'DeepSeek', model: 'deepseek-flash' }; });
    const pending = host.Send(input);
    try {
      await started; await host.Cancel(input.requestId);
      await expect(pending).resolves.toMatchObject({ cancelled: true });
      expect(host.IsBusy()).toBe(false);
      release(); await Promise.resolve();
      expect(stream).not.toHaveBeenCalled();
    } finally { release(); await pending; read.mockRestore(); await host.Close(); }
  });

  it('旧图不可用时不调用模型，不修改历史，仍释放运行状态', async () => {
    const { host, input, state, stream } = await Fixture(false);
    const old: AgentMessage = { role: 'user', content: '旧参考图', imageAttachments: [{ uri: 'attachment://old/old.png', mimeType: 'image/png', detail: 'auto' }] };
    state.histories.set(input.sessionId, [old]);
    try {
      await expect(host.Send(input)).rejects.toMatchObject({ code: 'STORAGE_ERROR' });
      expect(stream).not.toHaveBeenCalled();
      expect(state.histories.get(input.sessionId)).toEqual([old]);
      expect(state.histories.get(input.sessionId)?.find(message => message.content === old.content)).toMatchObject({ imageAttachments: old.imageAttachments });
      expect(host.IsBusy()).toBe(false);
    } finally { await host.Close(); }
  });

  it('问答恢复后的模型请求仍使用完全相同的图片内容', async () => {
    const { host, input, state, stream, events, business, directory } = await Fixture(false);
    const physicalPath = join(directory, 'old.png');
    await writeFile(physicalPath, Buffer.from('iVBORw0KGgo=', 'base64'));
    business.ResolveAttachmentUri.mockResolvedValue({ physicalPath, mimeType: 'image/png' });
    state.histories.set(input.sessionId, [{ role: 'user', content: '旧参考图', imageAttachments: [{ uri: 'attachment://old/old.png', mimeType: 'image/png', detail: 'auto' }] }]);
    stream.mockResolvedValueOnce({ content: '', toolCalls: [{ id: 'image-question', type: 'function', function: { name: 'AskUserQuestion', arguments: JSON.stringify({ questions: [{ id: 'q', question: '继续？', options: ['是'] }] }) } }] });
    try {
      await host.Send(input);
      const interactionId = events.find(event => event.type === 'question_requested')?.confirmationId;
      if (!interactionId) throw new Error('等待点缺失。');
      await host.RespondToInteraction({ kind: 'answer', requestId: input.requestId, sessionId: input.sessionId, interactionId, answers: { q: '是' } });
      const request = stream.mock.calls[1] as unknown as [{ history: AgentMessage[] }];
      const first = stream.mock.calls[0] as unknown as [{ history: AgentMessage[] }];
      expect(request[0].history.find(message => message.content === '旧参考图')?.providerContent).toEqual(first[0].history.find(message => message.content === '旧参考图')?.providerContent);
      expect(request[0].history.find(message => message.content === '旧参考图')?.providerContent?.[1]).toMatchObject({ type: 'image_url' });
      expect(state.histories.get(input.sessionId)?.find(message => message.content === '旧参考图')).not.toHaveProperty('providerContent');
    } finally { await host.Close(); }
  });
  it('恢复记录读取失败后清除运行状态，原异常不变，后续消息可继续', async () => {
    const { host, state, input, response, stream, events } = await Fixture();
    const originalRestore = state.RestoreConversationRecorder.bind(host);
    let restores = 0;
    const failure = new Error('isolated presentation read failure');
    const restore = vi.spyOn(state, 'RestoreConversationRecorder').mockImplementation(async (...args) => {
      if (++restores === 2) throw failure;
      return originalRestore(...args);
    });
    try {
      await expect(host.RespondToInteraction(response)).rejects.toBe(failure);
      expect(state.controllers.size).toBe(0);
      expect(state.runtimeControls.size).toBe(0);
      expect(state.runReleases.size).toBe(0);
      expect(host.IsBusy()).toBe(false);
      expect(state.pausedRuns.size).toBe(0);
      expect(events).toContainEqual(expect.objectContaining({ type: 'error', requestId: input.requestId }));
      expect(events).toContainEqual(expect.objectContaining({ type: 'run_released', requestId: input.requestId }));
      expect(stream).toHaveBeenCalledTimes(1);
      restore.mockRestore();
      await expect(host.Send({ ...input, requestId: 'after-restore-failure', content: '继续新问题' })).resolves.toMatchObject({ accepted: true });
      const results = state.histories.get(input.sessionId)?.filter(message => message.tool_call_id === 'question-tool');
      expect(results).toHaveLength(1);
      expect(stream).toHaveBeenCalledTimes(2);
    } finally { restore.mockRestore(); await host.Close(); }
  });

  it('恢复准备读取失败与取消同时发生时只发送取消终态', async () => {
    const { host, state, input, response, events, stream } = await Fixture();
    const originalRestore = state.RestoreConversationRecorder.bind(host);
    let restores = 0;
    const restore = vi.spyOn(state, 'RestoreConversationRecorder').mockImplementation(async (...args) => {
      if (++restores === 2) {
        state.controllers.get(input.requestId)?.abort();
        throw new Error('读取失败与取消同时发生');
      }
      return originalRestore(...args);
    });
    try {
      await expect(host.RespondToInteraction(response)).resolves.toMatchObject({ accepted: true });
      expect(events.filter(event => event.type === 'cancelled')).toHaveLength(1);
      expect(events.filter(event => event.type === 'error')).toHaveLength(0);
      expect(stream).toHaveBeenCalledTimes(1);
      expect(host.IsBusy()).toBe(false);
    } finally { restore.mockRestore(); await host.Close(); }
  });

  it('旧会话投影持续不可读时，结果结算仍能结束原等待点', async () => {
    const { host, state, input, response, events } = await Fixture();
    const originalRestore = state.RestoreConversationRecorder.bind(host);
    let restores = 0;
    const restore = vi.spyOn(state, 'RestoreConversationRecorder').mockImplementation(async (...args) => {
      if (++restores === 1) return originalRestore(...args);
      state.conversationRecorders.delete(input.requestId);
      throw new Error('isolated presentation unavailable');
    });
    try {
      await expect(host.RespondToInteraction(response)).rejects.toThrow('isolated presentation unavailable');
      expect(state.controllers.size).toBe(0);
      expect(state.runtimeControls.size).toBe(0);
      expect(state.pausedRuns.size).toBe(0);
      expect(host.IsBusy()).toBe(false);
      expect(events).toContainEqual(expect.objectContaining({ type: 'conversation_save_error', requestId: input.requestId }));
    } finally { restore.mockRestore(); await host.Close(); }
  });

  it('取消写盘失败仍发终态、保留取消记录、阻断迟到回答，存储恢复后可持久化', async () => {
    const { host, state, events, directory, input, response, stream, options, finishTrace } = await Fixture();
    const save = vi.spyOn(state, 'SaveState').mockImplementation(() => { throw new Error('ENOSPC isolated disk full'); });
    try {
      await expect(host.Cancel(input.requestId)).resolves.toEqual({ cancelled: true });
      expect(state.pausedRuns.get(input.requestId)?.cancelled).toBe(true);
      expect(events).toContainEqual(expect.objectContaining({ type: 'conversation_save_error', requestId: input.requestId }));
      expect(events.filter(event => event.type === 'cancelled')).toHaveLength(1);
      expect(finishTrace).toHaveBeenCalledWith(input.requestId, 'cancelled', expect.any(String));
      await expect(host.RespondToInteraction(response)).rejects.toMatchObject({ code: 'CANCELLED' });
      await host.Cancel(input.requestId);
      expect(events.filter(event => event.type === 'cancelled')).toHaveLength(1);
      expect(state.histories.get(input.sessionId)?.filter(message => message.tool_call_id === 'question-tool')).toHaveLength(1);
      expect((await host.GetSessionAssistantState(input.sessionId)).pendingEvents).toEqual([]);
      expect(stream).toHaveBeenCalledTimes(1);
      save.mockRestore();
      await expect(host.Cancel(input.requestId)).resolves.toEqual({ cancelled: true });
      expect(state.pausedRuns.size).toBe(0);
      await expect(access(join(directory, 'agent-runtime.db'))).resolves.toBeUndefined();
      const restarted = new AgentHost(options);
      try {
        expect((await restarted.GetSessionAssistantState(input.sessionId)).pendingEvents).toEqual([]);
        await expect(restarted.RespondToInteraction(response)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
        expect(stream).toHaveBeenCalledTimes(1);
      } finally { await restarted.Close(); }
    } finally { save.mockRestore(); await host.Close(); }
  });

  it('取消状态保存失败后可以发送新消息，后续保存会清理取消恢复记录', async () => {
    const { host, state, input, stream } = await Fixture();
    const save = vi.spyOn(state, 'SaveState').mockImplementationOnce(() => { throw new Error('ENOSPC isolated'); });
    try {
      await host.Cancel(input.requestId);
      await expect(host.Send({ ...input, requestId: 'after-cancel', content: '处理新问题' })).resolves.toMatchObject({ accepted: true });
      expect(state.pausedRuns.size).toBe(0);
      expect(host.IsBusy()).toBe(false);
      expect(stream).toHaveBeenCalledTimes(2);
    } finally { save.mockRestore(); await host.Close(); }
  });

  it('取消等待恢复的任务时保留已确认的真实结果，不改写成取消或未知', async () => {
    const { host, state, input, stream } = await Fixture();
    const paused = state.pausedRuns.get(input.requestId);
    if (!paused) throw new Error('等待点缺失。');
    const receipt = { ok: true, receipt: { receiptId: 'already-committed' } };
    state.pausedRuns.set(input.requestId, { ...paused, status: 'ready', result: { role: 'tool', tool_call_id: 'question-tool', content: JSON.stringify(receipt) } });
    try {
      await host.Cancel(input.requestId);
      const results = state.histories.get(input.sessionId)?.filter(message => message.tool_call_id === 'question-tool') ?? [];
      expect(results).toHaveLength(1);
      expect(JSON.parse(results[0].content)).toEqual(receipt);
      expect(stream).toHaveBeenCalledTimes(1);
    } finally { await host.Close(); }
  });

  it('会话投影保存失败也不阻断取消终态和资源释放', async () => {
    const { host, input, business, events } = await Fixture();
    business.SaveConversationPresentation.mockRejectedValue(new Error('isolated projection save failed'));
    try {
      await expect(host.Cancel(input.requestId)).resolves.toEqual({ cancelled: true });
      expect(events).toContainEqual(expect.objectContaining({ type: 'cancelled', requestId: input.requestId }));
      expect(events).toContainEqual(expect.objectContaining({ type: 'conversation_save_error', requestId: input.requestId }));
      expect(host.IsBusy()).toBe(false);
    } finally { await host.Close(); }
  });
});
