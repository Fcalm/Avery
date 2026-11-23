import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentStateStore } from '../../../apps/backend/src/agent-state-store';
import { AgentStatePersistence } from '../../../apps/backend/src/electron/backend/agent-state-persistence';
import type { AgentStatePatch, AgentStatePort } from '../../../apps/backend/src/infra/agent-state-contract';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function Root() {
  const parent = process.env.AVERY_TEST_ARTIFACT_DIR ?? tmpdir();
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, 'avery-state-')); roots.push(root); return root;
}
const patch = (commitId: string, expectedRevision: number, changes: Partial<AgentStatePatch> = {}): AgentStatePatch => ({ commitId, expectedRevision, rows: [], histories: [], ...changes });
function Port(store: AgentStateStore): AgentStatePort {
  return { ReadAgentState: async options => store.Read(options?.includeHistory !== false), ReadAgentHistory: async id => store.ReadHistory(id), CommitAgentState: vi.fn(async value => store.Commit(value)) };
}

describe('Agent SQLite 状态迁移及事务', () => {
  it('完整迁移旧状态，保留 JSON 原文件，新库后续写入不再读取旧文件', async () => {
    const root = await Root();
    const legacy = { histories: [['s', [{ role: 'user', content: '旧历史' }]], ['empty', []]], pausedRuns: [['r', { status: 'waiting' }]], sessionUsage: [['s', { totalTokens: 7 }]], documentChangeBaselines: [{ id: 'baseline' }] };
    const text = JSON.stringify(legacy);
    await writeFile(join(root, 'agent-state.json'), text);
    let store = new AgentStateStore(root);
    try {
      expect(store.Read().state).toMatchObject(legacy);
      store.Commit(patch('append', 0, { histories: [{ sessionId: 's', from: 1, messages: [{ role: 'assistant', content: '新消息' }] }] }));
      expect(await readFile(join(root, 'agent-state.json'), 'utf8')).toBe(text);
      store.Close();
      await writeFile(join(root, 'agent-state.json'), 'broken legacy file must no longer be read');
      store = new AgentStateStore(root);
      expect((store.Read().state.histories as unknown[][]).find(entry => entry[0] === 's')?.[1]).toEqual([{ role: 'user', content: '旧历史' }, { role: 'assistant', content: '新消息' }]);
    } finally { store.Close(); }
  });

  it('损坏迁移失败保持旧数据，修正后能完整迁移，不留下初始化成功标记', async () => {
    const root = await Root();
    const file = join(root, 'agent-state.json');
    await writeFile(file, '{broken');
    expect(() => new AgentStateStore(root)).toThrow('迁移失败');
    expect(await readFile(file, 'utf8')).toBe('{broken');
    await writeFile(file, JSON.stringify({ histories: [['s', [{ content: '保留' }]]] }));
    const store = new AgentStateStore(root);
    try { expect(store.Read().state.histories).toEqual([['s', [{ content: '保留' }]]]); }
    finally { store.Close(); }
  });

  it('事务部分失败回滚历史及状态，同一提交幂等确认，旧版本不能覆盖新状态', async () => {
    const root = await Root(), store = new AgentStateStore(root);
    try {
      const first = patch('first', 0, { rows: [{ bucket: 'pausedRuns', key: 'r', value: { status: 'waiting' } }], histories: [{ sessionId: 's', from: 0, messages: [{ content: '原文' }] }] });
      expect(store.Commit(first)).toEqual({ revision: 1 });
      expect(store.Commit(first)).toEqual({ revision: 1 });
      expect(() => store.Commit(patch('bad', 1, { rows: [{ bucket: 'pausedRuns', key: 'r', deleted: true }, { bucket: 'unsupported', key: 'x', value: {} }] }))).toThrow();
      expect(store.Read()).toMatchObject({ revision: 1, state: { pausedRuns: [['r', { status: 'waiting' }]] } });
      expect(() => store.Commit(patch('stale', 0))).toThrow('版本冲突');
      store.Commit(patch('compact', 1, { histories: [{ sessionId: 's', from: 0, messages: [{ content: '摘要' }] }], rows: [{ bucket: 'pausedRuns', key: 'r', deleted: true }] }));
      expect(store.Read().state.histories).toEqual([['s', [{ content: '摘要' }]]]);
      expect(store.Read().state.pausedRuns).toEqual([]);
      expect(() => store.Commit(first)).toThrow('版本冲突');
    } finally { store.Close(); }
  });

  it('相同提示词和工具定义仅保存一份，读取时恢复完整快照', async () => {
    const root = await Root(), store = new AgentStateStore(root);
    const instructions = { compiled: '稳定规则'.repeat(100) }, tools = [{ name: 'Read', schema: {} }];
    try {
      store.Commit(patch('snapshots', 0, { rows: ['one', 'two'].map(key => ({ bucket: 'runSnapshots', key, value: { requestId: key, instructions, tools } })) }));
      const db = (store as unknown as { db: { prepare(sql: string): { get(): { count: number } } } }).db;
      expect(db.prepare('SELECT COUNT(*) AS count FROM runtime_shared').get().count).toBe(2);
      expect(store.Read().state.runSnapshots).toEqual(['one', 'two'].map(key => [key, { requestId: key, instructions, tools }]));
      store.Commit(patch('remove', 1, { rows: ['one', 'two'].map(key => ({ bucket: 'runSnapshots', key, deleted: true })) }));
      expect(db.prepare('SELECT COUNT(*) AS count FROM runtime_shared').get().count).toBe(0);
    } finally { store.Close(); }
  });
});

describe('Agent 增量提交与有界候选', () => {
  it('冷启动不搬运历史，普通统计保存不清空未加载会话；首次使用只读对应会话', async () => {
    const root = await Root(), store = new AgentStateStore(root), port = Port(store);
    store.Commit(patch('seed-lazy', 0, { histories: [
      { sessionId: 's', from: 0, messages: [{ content: '原文一' }, { content: '原文二' }] },
      { sessionId: 'other', from: 0, messages: [{ content: '不能丢失其他会话' }] },
    ] }));
    const read = vi.spyOn(port, 'ReadAgentHistory');
    try {
      const writer = new AgentStatePersistence(port), state = await writer.Load();
      expect(state.histories).toEqual([['s', []], ['other', []]]);
      state.sessionUsage = [['s', { totalTokens: 3 }]]; writer.Capture(state); await writer.Flush();
      expect(store.ReadHistory('other')).toEqual([{ content: '不能丢失其他会话' }]);
      const messages = await writer.LoadHistory('s');
      expect(read).toHaveBeenCalledExactlyOnceWith('s');
      state.histories = [['s', [...messages!, { content: '新消息' }]], ['other', []]];
      writer.Capture(state); await writer.Flush();
      expect(vi.mocked(port.CommitAgentState).mock.calls.at(-1)?.[0].histories).toEqual([{ sessionId: 's', from: 2, messages: [{ content: '新消息' }] }]);
      expect(store.ReadHistory('other')).toHaveLength(1);
    } finally { store.Close(); }
  });

  it('取消后的迟到历史读取不更新加载基线，后续请求仍重新读取', async () => {
    const root = await Root(), store = new AgentStateStore(root), port = Port(store);
    store.Commit(patch('seed-cancel', 0, { histories: [{ sessionId: 's', from: 0, messages: [{ content: '原文' }] }] }));
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const original = port.ReadAgentHistory!;
    const read = vi.spyOn(port, 'ReadAgentHistory').mockImplementationOnce(async id => { await gate; return original(id); });
    try {
      const writer = new AgentStatePersistence(port); await writer.Load();
      const controller = new AbortController();
      const pending = writer.LoadHistory('s', controller.signal).catch(error => error);
      controller.abort(); release();
      expect(await pending).toMatchObject({ name: 'AbortError' });
      expect(await writer.LoadHistory('s')).toEqual([{ content: '原文' }]);
      expect(read).toHaveBeenCalledTimes(2);
    } finally { release(); store.Close(); }
  });
  it('只发送当前新增消息和发生变化的统计，不重复传递其他会话历史及快照', async () => {
    const root = await Root(), store = new AgentStateStore(root), port = Port(store);
    try {
      const writer = new AgentStatePersistence(port), state = await writer.Load();
      const first = { role: 'user', content: '原文' };
      state.histories = [['s', [first]], ['other', [{ content: '其他会话'.repeat(2000) }]]];
      state.sessionUsage = [['s', { totalTokens: 3 }]];
      state.runSnapshots = [['r', { instructions: { compiled: '不变' } }]];
      writer.Capture(state); await writer.Flush();
      state.histories = [['s', [first, { role: 'assistant', content: '新消息' }]], ['other', (state.histories as Array<[string, unknown[]]>)[1][1]]];
      (state.sessionUsage as Array<[string, { totalTokens: number }]>)[0][1].totalTokens = 4;
      writer.Capture(state); await writer.Flush();
      const calls = vi.mocked(port.CommitAgentState).mock.calls;
      expect(calls[1][0].histories).toEqual([{ sessionId: 's', from: 1, messages: [{ role: 'assistant', content: '新消息' }] }]);
      expect(calls[1][0].rows).toEqual([{ bucket: 'sessionUsage', key: 's', value: { totalTokens: 4 } }]);
    } finally { store.Close(); }
  });

  it('回执丢失时保留同一补丁，重新确认不重复插入历史', async () => {
    const root = await Root(), store = new AgentStateStore(root);
    let attempts = 0;
    const ids: string[] = [];
    const port: AgentStatePort = { ReadAgentState: async () => store.Read(), CommitAgentState: async value => {
      ids.push(value.commitId); const result = store.Commit(value);
      if (++attempts === 1) throw new Error('lost receipt');
      return result;
    } };
    try {
      const writer = new AgentStatePersistence(port), state = await writer.Load();
      state.histories = [['s', [{ content: '只应保存一次' }]]];
      writer.Capture(state);
      await expect(writer.Flush()).rejects.toThrow('lost receipt');
      await writer.Flush();
      expect(ids[0]).toBe(ids[1]);
      expect(store.Read().state.histories).toEqual([['s', [{ content: '只应保存一次' }]]]);
    } finally { store.Close(); }
  });

  it('慢盘期间只有一个在途事务，后续同键状态合并为最新值', async () => {
    const root = await Root(), store = new AgentStateStore(root);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const port = Port(store), commit = port.CommitAgentState;
    let calls = 0;
    port.CommitAgentState = vi.fn(async value => { if (++calls === 1) await gate; return commit(value); });
    try {
      const writer = new AgentStatePersistence(port), state = await writer.Load();
      state.sessionUsage = [['s', { totalTokens: 1 }]]; writer.Capture(state);
      const first = writer.Flush();
      const barriers: Promise<void>[] = [];
      for (let count = 2; count <= 100; count++) { state.sessionUsage = [['s', { totalTokens: count }]]; writer.Capture(state); barriers.push(writer.Flush()); }
      expect(calls).toBe(1); release(); await first; await Promise.all(barriers);
      expect(calls).toBe(2);
      expect(store.Read().state.sessionUsage).toEqual([['s', { totalTokens: 100 }]]);
    } finally { release(); store.Close(); }
  });
});
