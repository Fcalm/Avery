import { describe, expect, it, vi } from 'vitest';
import type { ConversationResource, ProfileSnapshotItem, ResumeSnapshot, ResumeWritePort } from '@avery/agent-sdk';
import { ConversationDocumentChanges, CountDocumentLineChanges } from '../../../apps/backend/src/electron/backend/conversation-document-changes';

describe('产物增删行数', () => {
  it.each([
    ['', '', 0, 0], ['', '新增\n第二行\n第三行\n', 3, 0], ['旧\n正文', '', 0, 2],
    ['甲\n乙\n丙', '甲\n新乙\n丙', 1, 1], ['甲\n旧\n丙', '甲\n新\n新二\n丙', 2, 1],
    ['甲\r\n\r\n乙\r\n', '甲\n\n乙\n', 0, 0], ['甲\n乙', '甲\n乙\n', 0, 0],
    ['甲\n\n乙', '甲\n乙', 0, 1], ['甲\n乙\n甲', '甲\n甲\n乙', 1, 1],
    ['甲\n乙\n丙', '丙\n乙\n甲', 2, 2],
  ])('原文 %j → %j', (before, after, added, removed) => {
    expect(CountDocumentLineChanges(before, after)).toEqual({ added, removed });
  });

  it('重复行与重排的位集结果和独立的二维 LCS 一致', () => {
    const sequences: string[][] = [[]];
    for (let length = 1; length <= 4; length++) {
      for (let code = 0; code < 2 ** length; code++) sequences.push(Array.from({ length }, (_, bit) => String((code >> bit) & 1)));
    }
    for (const before of sequences) for (const after of sequences) {
      const lengths = Array.from({ length: before.length + 1 }, () => Array<number>(after.length + 1).fill(0));
      for (let i = 1; i <= before.length; i++) for (let j = 1; j <= after.length; j++) {
        lengths[i][j] = before[i - 1] === after[j - 1] ? lengths[i - 1][j - 1] + 1 : Math.max(lengths[i - 1][j], lengths[i][j - 1]);
      }
      const common = lengths[before.length][after.length];
      expect(CountDocumentLineChanges(before.join('\n'), after.join('\n'))).toEqual({ added: after.length - common, removed: before.length - common });
    }
  });
});

function ResumeHarness(content = '甲\n乙') {
  let current: ResumeSnapshot | null = { id: 'r1', name: '产品经理简历', content, revision: 1, updatedAt: '' };
  const source: ResumeWritePort = {
    AcquireLock: vi.fn(), ReleaseLock: vi.fn(),
    Save: vi.fn(async ({ resume }) => { current = { ...resume, revision: (current?.revision ?? 0) + 1 }; return { id: current.id, revision: current.revision! }; }),
  };
  return { source, read: async () => current, saveInput: (text: string) => ({ resume: { id: 'r1', name: '产品经理简历', content: text, updatedAt: '' } }) };
}

describe('实际写端口产物记录', () => {
  it('多次保存与重启后续轮仍比较首次基线，撤回全部修改统计归零', async () => {
    const harness = ResumeHarness(), changed = vi.fn(), persist = vi.fn();
    const first = new ConversationDocumentChanges(changed, persist);
    const port = first.ResumePort('run1', harness.source, harness.read);
    await port.Save(harness.saveInput('甲\n中间稿\n临时增加'));
    expect(changed.mock.lastCall?.[1]).toMatchObject({ title: '产品经理简历', revision: 2, lineChanges: { added: 2, removed: 1 } });
    const state = JSON.parse(JSON.stringify(first.Snapshot()));
    const restarted = new ConversationDocumentChanges(changed, persist);
    restarted.Restore(state);
    const resumed = restarted.ResumePort('run1', harness.source, harness.read);
    await resumed.Save(harness.saveInput('甲\n最终稿'));
    expect(changed.mock.lastCall?.[1]).toMatchObject({ revision: 3, lineChanges: { added: 1, removed: 1 } });
    await resumed.Save(harness.saveInput('甲\n乙'));
    expect(changed.mock.lastCall?.[1]).toMatchObject({ revision: 4, lineChanges: { added: 0, removed: 0 } });
    expect(persist).toHaveBeenCalledTimes(3);
    restarted.Forget('run1');
    expect(restarted.Snapshot()).toEqual([]);
  });

  it('不同 Run 的基线隔离，保存失败不发布产物也不捕获基线', async () => {
    const harness = ResumeHarness(), changed = vi.fn();
    const tracker = new ConversationDocumentChanges(changed, () => undefined);
    await tracker.ResumePort('one', harness.source, harness.read).Save(harness.saveInput('甲\n乙\n新'));
    await tracker.ResumePort('two', harness.source, harness.read).Save(harness.saveInput('甲\n乙\n新\n新二'));
    expect(changed.mock.lastCall?.[1]).toMatchObject({ lineChanges: { added: 1, removed: 0 } });
    const failed = { ...harness.source, Save: vi.fn(async () => { throw new Error('save failed'); }) };
    await expect(tracker.ResumePort('failed', failed, harness.read).Save(harness.saveInput('失败稿'))).rejects.toThrow('save failed');
    expect(changed).toHaveBeenCalledTimes(2);
    expect(tracker.Snapshot().some((item) => item.requestId === 'failed')).toBe(false);
  });

  it('新建简历以空正文为基线，锁与保存参数直接转交原端口', async () => {
    const harness = ResumeHarness(), changed = vi.fn();
    const port = new ConversationDocumentChanges(changed, () => undefined).ResumePort('new', harness.source, async () => null);
    const lock = { resumeId: 'r1', owner: 'agent' as const, ownerId: 'owner', baseRevision: 1 };
    await port.AcquireLock(lock); await port.ReleaseLock('r1', 'owner');
    await port.Save(harness.saveInput('第一行\n第二行'));
    expect(harness.source.AcquireLock).toHaveBeenCalledWith(lock);
    expect(harness.source.ReleaseLock).toHaveBeenCalledWith('r1', 'owner');
    expect(changed.mock.lastCall?.[1]).toMatchObject({ produced: true, lineChanges: { added: 2, removed: 0 } });
  });

  it('档案按条目分别比较真实快照，多次保存不累计中间稿', async () => {
    let profiles: ProfileSnapshotItem[] = [
      { id: 'p1', category: 'work', title: '工作', content: '旧正文', updatedAt: '' },
      { id: 'p2', category: 'education', title: '教育', content: '保留', updatedAt: '' },
    ];
    const changed = vi.fn<(run: string, resource: ConversationResource) => void>();
    const tracker = new ConversationDocumentChanges(changed, () => undefined);
    const port = tracker.ProfilePort('run', { Save: async (input) => { profiles = input.profiles; return { count: profiles.length }; } }, async () => profiles);
    await port.Save({ profiles: profiles.map((item) => item.id === 'p1' ? { ...item, content: '新正文\n临时行' } : item), actor: 'agent' });
    expect(changed.mock.calls.find(([, item]) => item.id === 'p1')?.[1]).toMatchObject({ lineChanges: { added: 2, removed: 1 } });
    expect(changed.mock.calls.find(([, item]) => item.id === 'p2')?.[1]).toMatchObject({ lineChanges: { added: 0, removed: 0 } });
    await port.Save({ profiles: profiles.map((item) => item.id === 'p1' ? { ...item, content: '最终正文' } : item), actor: 'agent' });
    expect(changed.mock.calls.filter(([, item]) => item.id === 'p1').at(-1)?.[1]).toMatchObject({ lineChanges: { added: 1, removed: 1 } });
  });
});
