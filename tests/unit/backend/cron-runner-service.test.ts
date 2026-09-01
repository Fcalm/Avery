import { describe, expect, it, vi } from 'vitest';
import { CronRunnerService } from '../../../apps/backend/src/electron/backend/services/cron-runner-service';

function CreateHarness(result: Record<string, unknown> = { accepted: true, content: '后台完成', thinkingContent: '', terminal: 'completed', needsAttention: false }) {
  const claim = { task: { id: 'cron-1', title: '工作日投递', message: '执行投递', scenarioId: 'application', resumeId: 'resume-1', schedule: { timeZone: 'Asia/Shanghai' } }, run: { id: 'run-1', scheduledAt: Date.parse('2026-08-29T09:00:00+08:00') } };
  const business = {
    RecoverInterruptedCronRuns: vi.fn(async () => ({ recovered: 0 })), GetEarliestCronRunAt: vi.fn(async () => ({ nextRunAt: null })), ClaimDueCronTasks: vi.fn(async () => [claim]),
    CreateConversation: vi.fn(async () => ({})), AppendConversationMessages: vi.fn(async () => ({})), AttachCronRunConversation: vi.fn(async () => ({})),
    CompleteConversationMessage: vi.fn(async () => ({})), FinishCronRun: vi.fn(async () => ({})),
  };
  const agent = { IsBusy: vi.fn(() => false), SendScheduled: vi.fn(async () => result) };
  const syncOsWake = vi.fn(async () => ({}));
  return { claim, business, agent, syncOsWake, service: new CronRunnerService({ business, agent, syncOsWake }) };
}

describe('Cron Runner 后台会话', () => {
  it('无 Renderer 时仍自行创建会话、保存 user/assistant 消息并完成 CronRun', async () => {
    const harness = CreateHarness();
    const summary = await harness.service.RunDue();
    expect(summary).toMatchObject({ claimed: 1, completed: 1, failed: 0 });
    expect(harness.business.CreateConversation).toHaveBeenCalledOnce();
    expect(harness.business.AppendConversationMessages.mock.calls[0][1]).toEqual(expect.arrayContaining([expect.objectContaining({ role: 'user', content: '执行投递' }), expect.objectContaining({ role: 'assistant' })]));
    expect(harness.agent.SendScheduled).toHaveBeenCalledWith(expect.objectContaining({ scenarioId: 'application', resumeId: 'resume-1' }));
    expect(harness.business.CompleteConversationMessage).toHaveBeenCalledWith(expect.any(String), expect.any(String), '后台完成', undefined);
    expect(harness.business.FinishCronRun).toHaveBeenCalledWith('run-1', 'completed', undefined);
  });

  it('登录或验证码接管信号写 needsAttention，不误记成功', async () => {
    const harness = CreateHarness({ accepted: true, content: '', thinkingContent: '', terminal: 'waiting_user_input', needsAttention: true });
    const summary = await harness.service.RunDue();
    expect(summary.needsAttention).toBe(1);
    expect(harness.business.FinishCronRun).toHaveBeenCalledWith('run-1', 'needsAttention', 'user_action_required');
  });

  it('Agent 持续忙碌超时后消费 occurrence，并按场景记录可诊断原因', async () => {
    const harness = CreateHarness();
    harness.agent.IsBusy.mockReturnValue(true);
    await harness.service.RunDue(1_000);
    const summary = await harness.service.RunDue(1_000 + 30 * 60_000);
    expect(summary.missed).toBe(1);
    expect(harness.business.FinishCronRun).toHaveBeenCalledWith('run-1', 'missed', 'browser_busy');
    expect(harness.agent.SendScheduled).not.toHaveBeenCalled();
    harness.service.Close();
  });
});
