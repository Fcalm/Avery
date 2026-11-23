import { createHash } from 'node:crypto';
import { AgentInteractionResponseSchema, type AgentInteractionResponse } from '@avery/contracts';
import { NoticeInteractionOf, type TaskCompletionNotice, type NoticeSubmitResult } from './task-completion';

type BackendCommand = (channel: string, key: string | undefined, ...args: unknown[]) => Promise<unknown>;

/** 通知只提交选择结果；会话、Run 与交互 ID 始终由主进程持有的原提案绑定。 */
export function BuildNoticeResponse(notice: TaskCompletionNotice, payload: unknown): AgentInteractionResponse | undefined {
  const interaction = notice.interaction;
  if (!interaction || !payload || typeof payload !== 'object' || Array.isArray(payload)) return;
  const input = payload as Record<string, unknown>;
  if (Object.keys(input).some((key) => !['action', 'answers'].includes(key))) return;
  const identity = { sessionId: notice.sessionId, requestId: notice.requestId, interactionId: interaction.id };
  let value: unknown;
  if (interaction.kind === 'approval' && ['confirm', 'cancel'].includes(String(input.action)) && !('answers' in input)) {
    value = { ...identity, kind: 'approval', approved: input.action === 'confirm' };
  } else if (interaction.kind === 'question' && input.action === 'cancel' && !('answers' in input)) {
    value = { ...identity, kind: 'cancel' };
  } else if (interaction.kind === 'question' && input.action === 'answer' && input.answers && typeof input.answers === 'object' && !Array.isArray(input.answers)) {
    const answers = input.answers as Record<string, unknown>;
    if (Object.keys(answers).length !== interaction.questions.length) return;
    for (const question of interaction.questions) {
      const answer = answers[question.id];
      if (typeof answer !== 'string' || !answer.trim() || (!question.options.includes('其他') && question.options.length > 0 && !question.options.includes(answer))) return;
    }
    value = { ...identity, kind: 'answer', answers: Object.fromEntries(Object.entries(answers).map(([key, answer]) => [key, String(answer).trim()])) };
  }
  const parsed = AgentInteractionResponseSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

/** 先核对等待点仍有效，再走已有统一交互接口；固定幂等键使重试不能重复批准业务操作。 */
export async function SubmitNoticeInteraction(command: BackendCommand, notice: TaskCompletionNotice, payload: unknown): Promise<NoticeSubmitResult> {
  const response = BuildNoticeResponse(notice, payload);
  if (!response) return { ok: false, message: '请选择或填写全部问题，或返回对话处理。' };
  try {
    const state = await command('agent:get-session-assistant-state', undefined, notice.sessionId) as { ok?: boolean; data?: { pendingEvents?: unknown[]; activeRequestId?: string }; error?: { message?: string } };
    if (!state?.ok) return { ok: false, message: state?.error?.message || '无法核对任务状态，请重试。' };
    const pending = state.data?.pendingEvents?.some((raw) => {
      const event = raw as { requestId?: unknown; sessionId?: unknown };
      const interaction = NoticeInteractionOf(raw);
      return event?.sessionId === notice.sessionId && event.requestId === notice.requestId && interaction?.id === response.interactionId;
    });
    // 提示事件可能早于 Kernel 检查点；原 Run 仍在执行时交由宿主等待释放并核对 ID，不能误判已失效。
    if (!pending && state.data?.activeRequestId !== notice.requestId) return { ok: false, stale: true, message: '此请求已处理或任务已结束，请返回对话查看。' };
    const signature = JSON.stringify({ ...response, ...(response.kind === 'answer' ? { answers: Object.fromEntries(Object.entries(response.answers).sort(([a], [b]) => a.localeCompare(b))) } : {}) });
    const key = `task-notice:${createHash('sha256').update(signature).digest('hex')}`;
    const result = await command('agent:respond-interaction', key, response) as { ok?: boolean; data?: { accepted?: boolean }; error?: { message?: string } };
    return result?.ok && result.data?.accepted === true ? { ok: true } : { ok: false, message: result?.error?.message || '提交失败，请重试或返回对话处理。' };
  } catch {
    return { ok: false, message: '暂时无法连接任务，请重试或返回对话处理。' };
  }
}
