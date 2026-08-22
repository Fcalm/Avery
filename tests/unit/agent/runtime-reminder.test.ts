import { describe, expect, it } from 'vitest';
import { BuildRuntimeReminder, CreateRuntimeReminderMessage, ShouldInjectRuntimeReminder } from '../../../packages/agent-core/src/runtime-reminder';

describe('runtime reminder', () => {
  it('默认场景在首轮、每 5 轮和最后一轮提醒', () => {
    const remindedTurns = Array.from({ length: 30 }, (_, turn) => turn)
      .filter((turn) => ShouldInjectRuntimeReminder(turn, 30, 5));

    expect(remindedTurns).toEqual([0, 5, 10, 15, 20, 25, 29]);
    expect(ShouldInjectRuntimeReminder(3, 30, 5, true)).toBe(true);
  });

  it('正文使用直白英语并由 runtime-reminder 标签完整包裹', () => {
    const content = BuildRuntimeReminder({
      now: Date.UTC(2026, 7, 22, 2, 8),
      timeZone: 'Asia/Shanghai',
      usedTurns: 20,
      maxTurns: 30,
      confirmationMode: 'allow_low_risk',
      finalTurn: false,
    });

    expect(content).toContain('Today is August 22, 2026.');
    expect(content).toContain('Used turns: 20 of 30. Remaining turns: 10.');
    expect(content).toContain('Current confirmation mode: allow low-risk actions.');
    expect(content).toMatch(/^<runtime-reminder>\n/);
    expect(content).toMatch(/The above is the current runtime status\. No response is needed; continue the task\.\n<\/runtime-reminder>$/);
    expect(content.match(/<runtime-reminder>/g)).toHaveLength(1);
    expect(content.match(/<\/runtime-reminder>/g)).toHaveLength(1);
    expect(content).not.toMatch(/createdAt|scenario/i);
  });

  it('最后一轮禁止新工具调用，内部消息仍以 user 角色追加', () => {
    const message = CreateRuntimeReminderMessage({
      now: Date.UTC(2026, 7, 22, 2, 8),
      timeZone: 'Asia/Shanghai',
      usedTurns: 29,
      maxTurns: 30,
      confirmationMode: 'fully_trusted',
      finalTurn: true,
    }, 7);

    expect(message.role).toBe('user');
    expect(message.content).toContain('Do not start new tool calls.');
    expect(message.metadata).toMatchObject({ kind: 'runtime_reminder', injectedAtTurn: 29, reminderRevision: 7 });
  });
});
